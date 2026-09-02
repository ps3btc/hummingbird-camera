"""Main orchestrator for hummingbird camera system."""
import cv2
import time
import json
import logging
import signal
import sys
import requests
from datetime import datetime
from pathlib import Path
from threading import Thread, Event

from app.config import Config
from app.capture import MotionCapture
from app.detector import ObjectDetector
from app.openai_detector import OpenAIVisionDetector
from app.uploader import CloudflareUploader
from app.notifier import MailjetNotifier

# Ensure logs directory exists before setting up logging
Config.LOGS_DIR.mkdir(parents=True, exist_ok=True)

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    handlers=[
        logging.FileHandler(Config.LOGS_DIR / 'system.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('main')

# Status file path for dashboard
STATUS_FILE = Config.BASE_DIR / 'status.json'

HEARTBEAT_INTERVAL = 60  # 1 minute
MAX_LOCAL_CAPTURES = 100  # Keep only the most recent local captures on disk


class HeartbeatSender:
    """Sends periodic heartbeats to Cloudflare Worker."""
    
    def __init__(self, camera_ref):
        self.camera = camera_ref
        self.thread = None
        self.stop_event = Event()
    
    def start(self):
        """Start heartbeat thread."""
        self.thread = Thread(target=self._run, daemon=True)
        self.thread.start()
        logger.info(f"Heartbeat sender started (interval: {HEARTBEAT_INTERVAL}s)")
    
    def stop(self):
        """Stop heartbeat thread."""
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)
    
    def _run(self):
        """Send heartbeats periodically."""
        # Send initial heartbeat immediately
        self._send_heartbeat()
        
        while not self.stop_event.is_set():
            self.stop_event.wait(HEARTBEAT_INTERVAL)
            if not self.stop_event.is_set():
                self._send_heartbeat()
    
    def _send_heartbeat(self):
        """Send a single heartbeat to the Worker."""
        try:
            url = f"{Config.CLOUDFLARE_WORKER_URL}/heartbeat"
            app_uptime_seconds = (datetime.now() - self.camera.stats['start_time']).total_seconds()
            
            # Get system uptime from /proc/uptime (Pi hardware uptime)
            system_uptime_seconds = 0
            try:
                with open('/proc/uptime', 'r') as f:
                    system_uptime_seconds = int(float(f.readline().split()[0]))
            except Exception:
                pass
            
            payload = {
                'status': 'alive',
                'app_uptime_seconds': int(app_uptime_seconds),
                'system_uptime_seconds': system_uptime_seconds,
                'captures': self.camera.stats['captures'],
                'uploads': self.camera.stats['uploads'],
                'detections': self.camera.stats['detections'],
                'motion_only': self.camera.motion_only,
                'timestamp': datetime.now().isoformat(),
            }
            
            headers = {}
            if Config.CLOUDFLARE_API_TOKEN:
                headers['Authorization'] = f"Bearer {Config.CLOUDFLARE_API_TOKEN}"
            
            resp = requests.post(url, json=payload, headers=headers, timeout=10)
            if resp.status_code == 200:
                logger.debug("Heartbeat sent successfully")
            else:
                logger.warning(f"Heartbeat failed: HTTP {resp.status_code}")
        except Exception as e:
            logger.warning(f"Heartbeat error: {e}")

class HummingbirdCamera:
    """Main system orchestrator."""
    
    def __init__(self):
        self.running = Event()
        self.running.set()
        
        # Initialize components
        self.capture = MotionCapture()
        self.detector = ObjectDetector()
        self.openai = OpenAIVisionDetector() if Config.OPENAI_ENABLED else None
        self.uploader = CloudflareUploader()
        self.notifier = MailjetNotifier()
        self.heartbeat = HeartbeatSender(self)
        
        # Statistics
        self.stats = {
            'captures': 0,
            'uploads': 0,
            'alerts': 0,
            'detections': 0,
            'openai_calls': 0,
            'openai_skipped': 0,
            'openai_log_uploads': 0,
            'start_time': datetime.now()
        }
        # Capped ring buffer of recent OpenAI calls (for status/dashboard).
        # Each entry: {timestamp, filename, mode, local_detections, openai_result, skip_reason}
        self.openai_log = []
        self.OPENAI_LOG_MAX = 50
        
        # Motion-only mode (when no AI model could be loaded)
        self.motion_only = False
        
        # For image similarity check (to skip duplicate OpenAI calls)
        self.prev_histogram = None
        self.SIMILARITY_THRESHOLD = 0.92  # 92% similar = skip OpenAI
        # Track whether the last OpenAI-verified frame had a real bird/animal/human.
        # If it did, never skip the next frame on similarity alone — the bird may
        # still be there and we must not miss it.
        self._prev_frame_had_detection = False
        
        # Signal handlers
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals."""
        logger.info(f"Received signal {signum}, shutting down...")
        self.running.clear()
    
    def initialize(self):
        """Initialize all system components."""
        logger.info("Initializing Hummingbird Camera System...")
        
        # Validate configuration
        try:
            Config.validate()
            logger.info("Configuration validated")
        except ValueError as e:
            logger.error(f"Configuration error: {e}")
            return False
        
        # Initialize camera
        if not self.capture.initialize_camera():
            logger.error("Failed to initialize camera")
            return False
        
        # Load detection model (degrade gracefully to motion-only mode)
        if not self.detector.load_model():
            logger.warning(
                "Detection model unavailable - running in MOTION-ONLY mode "
                "(motion captures are saved/uploaded without AI classification, "
                "no email alerts)")
            self.motion_only = True
        
        # Create directories
        Config.CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
        Config.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        
        logger.info("System initialized successfully")
        if self.openai:
            logger.info(f"OpenAI vision verification enabled (model: {Config.OPENAI_MODEL})")
        
        # Start heartbeat sender
        self.heartbeat.start()
        
        return True
    
    def _write_status_file(self):
        """Write current status to JSON file for dashboard to read."""
        try:
            uptime_seconds = (datetime.now() - self.stats['start_time']).total_seconds()
            hours, remainder = divmod(int(uptime_seconds), 3600)
            minutes, seconds = divmod(remainder, 60)
            uptime_str = f'{hours}h {minutes}m {seconds}s'
            
            status = {
                'running': True,
                'uptime': uptime_str,
                'stats': {
                    'captures': self.stats['captures'],
                    'uploads': self.stats['uploads'],
                    'alerts': self.stats['alerts'],
                    'detections': self.stats['detections'],
                },
                'last_detection': self.stats.get('last_detection'),
                'last_capture': self.stats.get('last_capture'),
                'model_type': self._get_model_type(),
                'inference_ms': self.detector.inference_time,
                'r2_file_count': self.uploader.get_file_count(),
            }
            
            with open(STATUS_FILE, 'w') as f:
                json.dump(status, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to write status file: {e}")
    
    def _get_model_type(self):
        """Get a string describing the loaded detection models."""
        if self.motion_only:
            return 'motion-only'
        if hasattr(self.detector, 'models') and self.detector.models:
            types = [m[1] for m in self.detector.models]
            return '+'.join(types)
        return 'unknown'

    def _cleanup_old_captures(self):
        """Delete oldest local captures, keeping only the most recent MAX_LOCAL_CAPTURES."""
        try:
            captures_dir = Config.CAPTURES_DIR
            if not captures_dir.exists():
                return

            files = sorted(
                captures_dir.glob('*.jpg'),
                key=lambda f: f.stat().st_mtime,
                reverse=True,
            )

            if len(files) <= MAX_LOCAL_CAPTURES:
                return

            deleted = 0
            for old_file in files[MAX_LOCAL_CAPTURES:]:
                try:
                    old_file.unlink()
                    deleted += 1
                except Exception as e:
                    logger.warning(f"Failed to delete old capture {old_file.name}: {e}")

            if deleted > 0:
                logger.info(f"Cleaned up {deleted} old captures (keeping {MAX_LOCAL_CAPTURES})")
        except Exception as e:
            logger.error(f"Failed to cleanup old captures: {e}")
    
    def _compute_histogram(self, frame):
        """Compute color histogram for similarity comparison."""
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [50, 60], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        return hist
    
    def _is_similar_to_previous(self, frame):
        """Check if frame is too similar to previous frame (likely duplicate)."""
        if self.prev_histogram is None:
            return False
        
        current_hist = self._compute_histogram(frame)
        similarity = cv2.compareHist(self.prev_histogram, current_hist, cv2.HISTCMP_CORREL)
        
        return similarity > self.SIMILARITY_THRESHOLD
    
    def _update_previous_histogram(self, frame):
        """Store current frame's histogram for next comparison."""
        self.prev_histogram = self._compute_histogram(frame)

    def _record_openai_decision(
        self,
        filepath,
        openai_called,
        openai_result,
        skip_reason,
        mode,
        local_detections,
    ):
        """Append a structured entry to the in-memory OpenAI decision log.

        Each entry captures the full decision context for one captured frame,
        whether OpenAI was called or skipped (and why). Capped at OPENAI_LOG_MAX
        entries so memory stays bounded.
        """
        try:
            entry = {
                'timestamp': datetime.now().isoformat(),
                'filename': filepath.name,
                'mode': mode,
                'local_detections': local_detections,
                'openai_called': openai_called,
                'openai_result': openai_result,
                'skip_reason': skip_reason,
            }
            self.openai_log.append(entry)
            if len(self.openai_log) > self.OPENAI_LOG_MAX:
                self.openai_log = self.openai_log[-self.OPENAI_LOG_MAX:]
        except Exception as e:
            logger.error(f"Failed to record openai decision: {e}")

    def get_openai_log(self):
        """Return a copy of the openai_log ring buffer, newest first."""
        return list(reversed(self.openai_log))
    
    def run(self):
        """Main processing loop."""
        logger.info("Starting main processing loop...")
        
        frame_count = 0
        last_status_log = time.time()
        
        while self.running.is_set():
            try:
                # Check cooldown
                self.capture.check_cooldown()
                
                # Capture frame
                result = self.capture.capture_image()
                if result is None:
                    time.sleep(0.1)
                    continue
                
                filepath, frame = result

                cv2.imwrite(filepath, frame)

                # Prune old captures to keep disk usage bounded
                self._cleanup_old_captures()

                frame_count += 1
                self.stats['captures'] += 1
                self.stats['last_capture'] = datetime.now().isoformat()
                
                # Run object detection (motion-only: skip local; otherwise: local first)
                local_detections_summary = None
                if self.motion_only:
                    detection_result = {
                        'detections': [],
                        'has_bird': False,
                        'has_animal': False,
                        'has_human': False,
                        'inference_ms': 0.0
                    }
                    has_any_object = True  # motion capture itself is the trigger
                    logger.info(
                        f"Capture #{self.stats['captures']} | mode=motion-only | "
                        f"trigger=motion — will call OpenAI"
                    )
                else:
                    detection_result = self.detector.detect(frame)
                    has_any_object = len(detection_result['detections']) > 0

                    if has_any_object:
                        local_detections_summary = []
                        for det in detection_result['detections']:
                            name = det.get('class_name', 'unknown')
                            conf = det.get('confidence', 0)
                            local_detections_summary.append(f"{name} {conf*100:.1f}%")
                        logger.info(
                            f"Capture #{self.stats['captures']} | mode=local+openai | "
                            f"local detected: {', '.join(local_detections_summary)} — will call OpenAI"
                        )
                    else:
                        logger.info(
                            f"Capture #{self.stats['captures']} | mode=local+openai | "
                            f"no local detection — will NOT call OpenAI"
                        )

                # OpenAI verification: runs in BOTH motion-only and local-AI modes.
                # Trigger: has_any_object (true if motion fired, or local model detected something)
                openai_result = None
                openai_called = False
                skip_reason = None

                if not self.openai:
                    skip_reason = 'openai-disabled'
                elif not has_any_object:
                    skip_reason = 'no-detection'
                else:
                    # Be smart: only skip on similarity if the previous frame was a
                    # confirmed clear (no bird/animal/human). If the previous frame
                    # had a real detection, always send — the subject may still be in
                    # frame and we must not miss it.
                    is_similar = self._is_similar_to_previous(frame)
                    should_skip = is_similar and not self._prev_frame_had_detection

                    if should_skip:
                        skip_reason = 'similar-to-previous-clear'
                        self.stats['openai_skipped'] += 1
                        logger.info(
                            f"OpenAI | SKIPPED (saved call): {filepath.name} | "
                            f"reason={skip_reason} | "
                            f"prev_frame_had_detection={self._prev_frame_had_detection} | "
                            f"total_skipped={self.stats['openai_skipped']}"
                        )
                        self._update_previous_histogram(frame)
                    else:
                        self.stats['openai_calls'] += 1
                        openai_called = True
                        reason_note = (
                            "first capture"
                            if self.prev_histogram is None
                            else "frame differs from previous"
                            if not is_similar
                            else "prev had detection, must verify"
                        )
                        logger.info(
                            f"OpenAI | CALLING #{self.stats['openai_calls']}: {filepath.name} | "
                            f"reason={reason_note}"
                        )
                        openai_result = self.openai.analyze(filepath)
                        self._update_previous_histogram(frame)

                        # Track whether this frame had a real detection so the next
                        # similarity check knows whether it's safe to skip.
                        self._prev_frame_had_detection = bool(
                            openai_result and (
                                openai_result.get('has_bird')
                                or openai_result.get('has_animal')
                                or openai_result.get('has_human')
                            )
                        )

                        # Log the response clearly
                        if openai_result and openai_result.get('detections'):
                            n = len(openai_result['detections'])
                            logger.info(
                                f"OpenAI | call #{self.stats['openai_calls']} RESULT: "
                                f"{n} detection(s) | "
                                f"bird={openai_result.get('has_bird')} "
                                f"animal={openai_result.get('has_animal')} "
                                f"human={openai_result.get('has_human')} | "
                                f"scene='{openai_result.get('scene_description','')[:80]}'"
                            )
                            # Adopt OpenAI's verdict as the canonical detection_result
                            detection_result = {
                                'detections': openai_result['detections'],
                                'has_bird': openai_result['has_bird'],
                                'has_animal': openai_result['has_animal'],
                                'has_human': openai_result['has_human'],
                                'inference_ms': openai_result['inference_ms']
                            }
                        else:
                            logger.info(
                                f"OpenAI | call #{self.stats['openai_calls']} RESULT: "
                                f"no detections (clear) | "
                                f"scene='{(openai_result or {}).get('scene_description','')[:80]}'"
                            )
                            has_any_object = False

                # Record this decision in the OpenAI log (whether called or skipped)
                self._record_openai_decision(
                    filepath=filepath,
                    openai_called=openai_called,
                    openai_result=openai_result,
                    skip_reason=skip_reason,
                    mode='motion-only' if self.motion_only else 'local+openai',
                    local_detections=local_detections_summary,
                )

                # Determine if we should upload to R2
                # - Regular gallery: only when OpenAI confirmed a real detection
                #   (or, if OpenAI disabled, when local model detected something)
                # - OpenAI log: every actual OpenAI call (so you can audit what was sent)
                should_upload = False
                should_upload_openai_log = openai_called

                if self.openai:
                    should_upload = (
                        has_any_object
                        and openai_result is not None
                        and bool(openai_result.get('detections'))
                    )
                else:
                    should_upload = has_any_object

                if should_upload:
                    self.stats['detections'] += 1
                    self.stats['last_detection'] = datetime.now().isoformat()

                    # Build metadata for R2
                    metadata = {
                        'detections': detection_result['detections'],
                        'has_bird': detection_result['has_bird'],
                        'has_animal': detection_result['has_animal'],
                        'has_human': detection_result['has_human'],
                        'inference_ms': detection_result['inference_ms']
                    }

                    # Add OpenAI metadata if available
                    if openai_result:
                        metadata['openai'] = {
                            'scene_description': openai_result.get('scene_description', ''),
                            'interesting': openai_result.get('interesting', ''),
                            'model': Config.OPENAI_MODEL
                        }

                    if self.uploader.upload_image(filepath, metadata):
                        self.stats['uploads'] += 1

                    # Send email alert for animals/birds with high confidence
                    if detection_result['has_animal'] or detection_result['has_bird']:
                        if not detection_result['has_human']:
                            # Check max animal/bird confidence
                            max_animal_conf = 0.0
                            for det in detection_result['detections']:
                                name = det.get('class_name', '').lower()
                                if name != 'person':
                                    max_animal_conf = max(max_animal_conf, det.get('confidence', 0))

                            # Email threshold: 80% since OpenAI confirmed
                            email_threshold = 0.80

                            if max_animal_conf >= email_threshold:
                                self.notifier.send_alert(
                                    filepath,
                                    detection_result['detections'],
                                    detection_result['has_bird'],
                                    detection_result['has_animal']
                                )
                                self.stats['alerts'] += 1
                elif has_any_object and self.openai and (not openai_result or not openai_result.get('detections')):
                    # Local model detected something but OpenAI didn't confirm
                    # Image stays on Pi, not uploaded to R2 (but it WAS uploaded to openai-log)
                    logger.info(
                        f"Capture #{self.stats['captures']} | OpenAI did not confirm — "
                        f"image kept on Pi only (already in openai-log)"
                    )

                # Upload every OpenAI call to the openai-log prefix for the Other tab
                if should_upload_openai_log and openai_result is not None:
                    if self.uploader.upload_to_openai_log(filepath, {
                        'mode': 'motion-only' if self.motion_only else 'local+openai',
                        'local_detections': local_detections_summary,
                        'openai': {
                            'scene_description': openai_result.get('scene_description', ''),
                            'interesting': openai_result.get('interesting', ''),
                            'has_bird': openai_result.get('has_bird', False),
                            'has_animal': openai_result.get('has_animal', False),
                            'has_human': openai_result.get('has_human', False),
                            'detections': openai_result.get('detections', []),
                            'model': Config.OPENAI_MODEL,
                            'inference_ms': openai_result.get('inference_ms', 0),
                            'call_number': self.stats['openai_calls'],
                        }
                    }):
                        self.stats['openai_log_uploads'] += 1
                
                # Write status file for dashboard
                self._write_status_file()
                
                # Log status every 30 seconds
                if time.time() - last_status_log >= 30:
                    uptime = (datetime.now() - self.stats['start_time']).total_seconds() / 60
                    logger.info(
                        f"Status | Uptime: {uptime:.1f}min | "
                        f"Captures: {self.stats['captures']} | "
                        f"Detections: {self.stats['detections']} | "
                        f"OpenAI: {self.stats['openai_calls']} | "
                        f"Uploads: {self.stats['uploads']} | "
                        f"Alerts: {self.stats['alerts']}"
                    )
                    last_status_log = time.time()
                
                # Small delay to prevent CPU overload
                time.sleep(0.5)
                
            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received")
                break
            except Exception as e:
                logger.error(f"Error in main loop: {e}", exc_info=True)
                time.sleep(1)
        
        self.shutdown()
    
    def shutdown(self):
        """Clean shutdown."""
        logger.info("Shutting down system...")
        
        # Stop heartbeat
        self.heartbeat.stop()
        
        # Cleanup camera
        self.capture.cleanup()
        
        # Log final stats
        uptime = (datetime.now() - self.stats['start_time']).total_seconds() / 60
        logger.info(
            f"Final stats | Uptime: {uptime:.1f}min | "
            f"Captures: {self.stats['captures']} | "
            f"Detections: {self.stats['detections']} | "
            f"Uploads: {self.stats['uploads']} | "
            f"Alerts: {self.stats['alerts']}"
        )
        
        logger.info("System shutdown complete")

def main():
    """Entry point."""
    system = HummingbirdCamera()
    
    if not system.initialize():
        logger.error("System initialization failed")
        sys.exit(1)
    
    system.run()

if __name__ == '__main__':
    main()
