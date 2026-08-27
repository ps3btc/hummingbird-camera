"""Main orchestrator for hummingbird camera system."""
import cv2
import time
import json
import logging
import signal
import sys
from datetime import datetime
from pathlib import Path
from threading import Thread, Event

from app.config import Config
from app.capture import MotionCapture
from app.detector import ObjectDetector
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

class HummingbirdCamera:
    """Main system orchestrator."""
    
    def __init__(self):
        self.running = Event()
        self.running.set()
        
        # Initialize components
        self.capture = MotionCapture()
        self.detector = ObjectDetector()
        self.uploader = CloudflareUploader()
        self.notifier = MailjetNotifier()
        
        # Statistics
        self.stats = {
            'captures': 0,
            'uploads': 0,
            'alerts': 0,
            'detections': 0,
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
                'model_type': (self.detector.model_type or 'motion-only'),
                'inference_ms': self.detector.inference_time,
                'r2_file_count': self.uploader.get_file_count(),
            }
            
            with open(STATUS_FILE, 'w') as f:
                json.dump(status, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to write status file: {e}")
    
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
                else:
                    detection_result = self.detector.detect(frame)
                    has_any_object = len(detection_result['detections']) > 0
                
                # Process detections
                
                if has_any_object:
                    self.stats['detections'] += 1
                    self.stats['last_detection'] = datetime.now().isoformat()
                    
                    # Upload if any object detected (bird, animal, or human)
                    metadata = {
                        'detections': detection_result['detections'],
                        'has_bird': detection_result['has_bird'],
                        'has_animal': detection_result['has_animal'],
                        'has_human': detection_result['has_human'],
                        'inference_ms': detection_result['inference_ms']
                    }
                    
                    if self.uploader.upload_image(filepath, metadata):
                        self.stats['uploads'] += 1
                    
                    # Send email alert only for animals/birds (excluding humans)
                    if detection_result['has_animal'] or detection_result['has_bird']:
                        if not detection_result['has_human']:
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
