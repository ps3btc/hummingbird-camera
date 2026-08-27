"""Motion detection and image capture module."""
import cv2
import numpy as np
from datetime import datetime
from pathlib import Path
import logging
from app.config import Config

logger = logging.getLogger(__name__)

class MotionCapture:
    """Handles motion detection and image capture from Raspberry Pi camera."""
    
    def __init__(self):
        self.camera = None
        self.camera_lib = None  # 'picamera2' or 'picamera'
        self.prev_frame = None
        self.cooldown_active = False
        self.last_capture_time = None
        Config.CAPTURES_DIR.mkdir(parents=True, exist_ok=True)
        
    def initialize_camera(self):
        """Initialize the Raspberry Pi camera."""
        try:
            # Try picamera2 first (newer)
            from picamera2 import Picamera2
            self.camera = Picamera2()
            config = self.camera.create_preview_configuration(
                main={"size": (Config.CAMERA_WIDTH, Config.CAMERA_HEIGHT)}
            )
            self.camera.configure(config)
            self.camera.start()
            self.camera_lib = 'picamera2'
            logger.info("Camera initialized with picamera2")
            return True
        except ImportError:
            try:
                # Fallback to picamera (legacy)
                from picamera.array import PiRGBArray
                from picamera import PiCamera
                self.camera = PiCamera()
                self.camera.resolution = (Config.CAMERA_WIDTH, Config.CAMERA_HEIGHT)
                self.camera.framerate = 30
                self.raw_capture = PiRGBArray(self.camera, size=(Config.CAMERA_WIDTH, Config.CAMERA_HEIGHT))
                self.camera_lib = 'picamera'
                logger.info("Camera initialized with picamera (legacy)")
                return True
            except Exception as e:
                logger.error(f"Failed to initialize camera: {e}")
                return False
    
    def detect_motion(self, frame):
        """Detect motion by comparing frames."""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)
        
        if self.prev_frame is None:
            self.prev_frame = gray
            return False
        
        frame_delta = cv2.absdiff(self.prev_frame, gray)
        thresh = cv2.threshold(frame_delta, Config.MOTION_THRESHOLD, 255, cv2.THRESH_BINARY)[0]
        thresh = cv2.dilate(thresh, None, iterations=2)
        
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        motion_detected = False
        for contour in contours:
            if cv2.contourArea(contour) > Config.MOTION_MIN_AREA:
                motion_detected = True
                break
        
        self.prev_frame = gray
        return motion_detected
    
    def capture_image(self):
        """Capture an image from the camera."""
        if self.cooldown_active:
            logger.debug("Capture cooldown active, skipping")
            return None
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"capture_{timestamp}.jpg"
        filepath = Config.CAPTURES_DIR / filename
        
        try:
            # Capture frame
            if self.camera_lib == 'picamera2':
                frame = self.camera.capture_array()
                frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
            else:
                frame = np.empty((Config.CAMERA_HEIGHT, Config.CAMERA_WIDTH, 3), dtype=np.uint8)
                self.camera.capture(frame, 'bgr')
            
            # Save image
            cv2.imwrite(str(filepath), frame)
            logger.info(f"Image captured: {filename}")
            
            # Set cooldown
            self.cooldown_active = True
            self.last_capture_time = datetime.now()
            
            return filepath, frame
            
        except Exception as e:
            logger.error(f"Failed to capture image: {e}")
            return None
    
    def check_cooldown(self):
        """Check if capture cooldown has expired."""
        if self.cooldown_active and self.last_capture_time:
            elapsed = (datetime.now() - self.last_capture_time).total_seconds()
            if elapsed >= Config.CAPTURE_COOLDOWN_SEC:
                self.cooldown_active = False
                logger.debug("Capture cooldown expired")
    
    def cleanup(self):
        """Release camera resources."""
        if self.camera:
            try:
                if hasattr(self.camera, 'stop'):
                    self.camera.stop()
                else:
                    self.camera.close()
                logger.info("Camera released")
            except Exception as e:
                logger.error(f"Error releasing camera: {e}")
