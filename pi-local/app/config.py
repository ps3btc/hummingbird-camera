"""Configuration management for hummingbird camera system."""
import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables
env_path = Path(__file__).parent.parent / '.env'
load_dotenv(env_path)

class Config:
    """Centralized configuration."""
    
    # Cloudflare
    CLOUDFLARE_ACCOUNT_ID = os.getenv('CLOUDFLARE_ACCOUNT_ID')
    CLOUDFLARE_API_TOKEN = os.getenv('CLOUDFLARE_API_TOKEN')
    CLOUDFLARE_R2_BUCKET = os.getenv('CLOUDFLARE_R2_BUCKET', 'hummingbird-captures')
    CLOUDFLARE_WORKER_URL = os.getenv('CLOUDFLARE_WORKER_URL')
    
    # Mailjet
    MAILJET_API_KEY = os.getenv('MAILJET_API_KEY')
    MAILJET_SECRET_KEY = os.getenv('MAILJET_SECRET_KEY')
    ALERT_EMAIL_TO = os.getenv('ALERT_EMAIL_TO', 'hareesh.nagarajan@gmail.com')
    ALERT_EMAIL_FROM = os.getenv('ALERT_EMAIL_FROM', 'alerts@loglinearexplorations.online')
    
    # Camera & Detection
    CAMERA_RESOLUTION = os.getenv('CAMERA_RESOLUTION', '640x480')
    CAMERA_WIDTH = int(CAMERA_RESOLUTION.split('x')[0])
    CAMERA_HEIGHT = int(CAMERA_RESOLUTION.split('x')[1])
    MOTION_THRESHOLD = int(os.getenv('MOTION_THRESHOLD', 25))
    MOTION_MIN_AREA = int(os.getenv('MOTION_MIN_AREA', 5000))
    CAPTURE_COOLDOWN_SEC = int(os.getenv('CAPTURE_COOLDOWN_SEC', 5))
    DETECTION_CONF_THRESHOLD = float(os.getenv('DETECTION_CONF_THRESHOLD', 0.45))
    
    # Paths
    BASE_DIR = Path(__file__).parent.parent
    CAPTURES_DIR = BASE_DIR / 'captures'
    LOGS_DIR = BASE_DIR / 'logs'
    MODELS_DIR = BASE_DIR / 'app' / 'models'
    
    # Flask
    FLASK_HOST = os.getenv('FLASK_HOST', '0.0.0.0')
    FLASK_PORT = int(os.getenv('FLASK_PORT', 80))
    
    # COCO class IDs for animals/birds (subset of common ones)
    BIRD_CLASS_IDS = [14, 15, 16, 17, 18, 19, 20, 21, 22, 23]  # Various birds
    ANIMAL_CLASS_IDS = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]  # Animals
    HUMAN_CLASS_ID = 0
    
    @classmethod
    def validate(cls):
        """Validate required configuration."""
        required = [
            'CLOUDFLARE_ACCOUNT_ID',
            'CLOUDFLARE_API_TOKEN',
            'CLOUDFLARE_WORKER_URL',
            'MAILJET_API_KEY',
            'MAILJET_SECRET_KEY'
        ]
        missing = [k for k in required if not getattr(cls, k)]
        if missing:
            raise ValueError(f"Missing required config: {', '.join(missing)}")
