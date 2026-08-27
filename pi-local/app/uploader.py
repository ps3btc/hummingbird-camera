"""Cloudflare R2 image uploader with FIFO management."""
import requests
import logging
import json
from pathlib import Path
from datetime import datetime
from app.config import Config

logger = logging.getLogger(__name__)

MAX_FILES_LIMIT = 19500  # Stay below 20,000 free tier limit

class CloudflareUploader:
    """Handles image uploads to Cloudflare R2 via Worker API."""
    
    def __init__(self):
        self.worker_url = Config.CLOUDFLARE_WORKER_URL
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'Bearer {Config.CLOUDFLARE_API_TOKEN}'
        })
    
    def upload_image(self, image_path: Path, metadata: dict = None) -> bool:
        """
        Upload an image to Cloudflare R2.
        
        Args:
            image_path: Path to the image file
            metadata: Optional metadata dict (detections, timestamp, etc.)
        
        Returns:
            bool: True if upload successful
        """
        if not image_path.exists():
            logger.error(f"Image file not found: {image_path}")
            return False
        
        try:
            # Check file count and enforce FIFO if needed
            if not self._check_and_enforce_limit():
                logger.warning("Failed to enforce file limit")
                return False
            
            # Prepare upload
            with open(image_path, 'rb') as f:
                files = {'file': (image_path.name, f, 'image/jpeg')}
                
                # Add metadata
                if metadata is None:
                    metadata = {}
                metadata['timestamp'] = datetime.now().isoformat()
                metadata['filename'] = image_path.name
                
                data = {'metadata': json.dumps(metadata)}
                
                response = self.session.post(
                    f"{self.worker_url}/upload",
                    files=files,
                    data=data,
                    timeout=30
                )
            
            if response.status_code == 200:
                result = response.json()
                logger.info(f"Upload successful: {image_path.name} -> {result.get('key')}")
                return True
            else:
                logger.error(f"Upload failed: {response.status_code} - {response.text}")
                return False
                
        except Exception as e:
            logger.error(f"Upload error: {e}")
            return False
    
    def _check_and_enforce_limit(self) -> bool:
        """Check file count and delete oldest if approaching limit."""
        try:
            # Get current file count
            response = self.session.get(f"{self.worker_url}/count", timeout=10)
            
            if response.status_code != 200:
                logger.warning(f"Could not check file count: {response.status_code}")
                return True  # Proceed anyway
            
            data = response.json()
            count = data.get('count', 0)
            
            logger.debug(f"Current R2 file count: {count}")
            
            # If approaching limit, delete oldest files
            if count >= MAX_FILES_LIMIT:
                logger.warning(f"File count {count} >= {MAX_FILES_LIMIT}, enforcing FIFO deletion")
                
                # Delete enough files to stay under limit
                files_to_delete = count - MAX_FILES_LIMIT + 10  # Delete 10 at a time for efficiency
                
                for _ in range(files_to_delete):
                    if not self._delete_oldest():
                        logger.error("Failed to delete oldest file")
                        return False
                
                logger.info(f"Deleted {files_to_delete} old files")
            
            return True
            
        except Exception as e:
            logger.error(f"Error checking file limit: {e}")
            return True  # Proceed anyway
    
    def _delete_oldest(self) -> bool:
        """Delete the oldest file from R2."""
        try:
            response = self.session.delete(f"{self.worker_url}/oldest", timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                logger.info(f"Deleted oldest file: {data.get('key')}")
                return True
            else:
                logger.error(f"Delete failed: {response.status_code}")
                return False
                
        except Exception as e:
            logger.error(f"Delete error: {e}")
            return False
    
    def get_file_count(self) -> int:
        """Get current file count from R2."""
        try:
            response = self.session.get(f"{self.worker_url}/count", timeout=10)
            if response.status_code == 200:
                return response.json().get('count', 0)
        except Exception as e:
            logger.error(f"Error getting file count: {e}")
        
        return -1
