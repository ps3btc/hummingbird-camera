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

HEARTBEAT_INTERVAL = 600  # 10 minutes


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
            uptime_seconds = (datetime.now() - self.camera.stats['start_time']).total_seconds()
            
            payload = {
                'status': 'alive',
                'uptime_seconds': int(uptime_seconds),
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
            'start_time': datetime.now()
        }
        
        # Motion-only mode (when no AI model could be loaded)
        self.motion_only = False
        
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
                frame_count += 1
                self.stats['captures'] += 1
                self.stats['last_capture'] = datetime.now().isoformat()
                
                # Run object detection (skip in motion-only mode)
                if self.motion_only:
                    detection_result = {
                        'detections': [],
                        'has_bird': False,
                        'has_animal': False,
                        'has_human': False,
                        'inference_ms': 0.0
                    }
                    has_any_object = True  # motion capture itself is the trigger
                    openai_result = None
                else:
                    detection_result = self.detector.detect(frame)
                    has_any_object = len(detection_result['detections']) > 0
                    
                    # OpenAI verification: if local model detected something, verify with GPT-4o-mini
                    openai_result = None
                    if has_any_object and self.openai:
                        self.stats['openai_calls'] += 1
                        openai_result = self.openai.analyze(filepath)
                        
                        # Use OpenAI results if it returned detections
                        if openai_result and openai_result.get('detections'):
                            detection_result = {
                                'detections': openai_result['detections'],
                                'has_bird': openai_result['has_bird'],
                                'has_animal': openai_result['has_animal'],
                                'has_human': openai_result['has_human'],
                                'inference_ms': openai_result['inference_ms']
                            }
                            logger.info(
                                f"OpenAI verified: {len(openai_result['detections'])} objects | "
                                f"{openai_result.get('scene_description', '')[:80]}"
                            )
                        elif openai_result and not openai_result.get('detections'):
                            # OpenAI saw nothing — likely a false positive from local model
                            logger.info("OpenAI found nothing — treating as false positive")
                            has_any_object = False
                
                # Process detections
                
                if has_any_object:
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
                            
                            # Email threshold: 99% for local-only, 80% if OpenAI confirmed
                            email_threshold = 0.80 if openai_result else 0.99
                            
                            if max_animal_conf >= email_threshold:
                                self.notifier.send_alert(
                                    filepath,
                                    detection_result['detections'],
                                    detection_result['has_bird'],
                                    detection_result['has_animal']
                                )
                                self.stats['alerts'] += 1
                
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
