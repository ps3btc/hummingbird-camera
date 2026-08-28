"""Mailjet email notification service."""
import requests
import logging
from datetime import datetime
from pathlib import Path
from app.config import Config

logger = logging.getLogger(__name__)

class MailjetNotifier:
    """Handles email alerts via Mailjet API."""
    
    def __init__(self):
        self.api_key = Config.MAILJET_API_KEY
        self.secret_key = Config.MAILJET_SECRET_KEY
        self.base_url = 'https://api.mailjet.com/v3.1'
        
    def send_alert(self, image_path: Path, detections: list, has_bird: bool, has_animal: bool):
        """
        Send email alert for animal/bird detection (excluding humans).
        
        Args:
            image_path: Path to the captured image
            detections: List of detection dicts
            has_bird: Whether birds were detected
            has_animal: Whether animals were detected
        """
        # Build detection summary
        animals = []
        for det in detections:
            if det['class_id'] != 0:  # Not human
                animals.append(f"{det['class_name']} ({det['confidence']:.0%})")
        
        if not animals:
            logger.debug("No animals/birds to report")
            return
        
        subject = self._build_subject(has_bird, has_animal, len(animals))
        html_body = self._build_html(image_path, animals, has_bird, has_animal)
        text_body = self._build_text(image_path, animals, has_bird, has_animal)
        
        # Send via Mailjet
        try:
            image_b64 = self._encode_image(image_path)
            
            message = {
                'From': {
                    'Email': Config.ALERT_EMAIL_FROM,
                    'Name': 'Hummingbird Camera'
                },
                'To': [{
                    'Email': Config.ALERT_EMAIL_TO,
                    'Name': 'User'
                }],
                'Subject': subject,
                'TextPart': text_body,
                'HTMLPart': html_body,
            }
            
            # Only attach image if encoding succeeded
            if image_b64:
                message['Attachments'] = [{
                    'ContentType': 'image/jpeg',
                    'Filename': image_path.name,
                    'Base64Content': image_b64
                }]
            
            payload = {'Messages': [message]}
            
            response = requests.post(
                f'{self.base_url}/send',
                auth=(self.api_key, self.secret_key),
                json=payload,
                timeout=30
            )
            
            if response.status_code == 200:
                logger.info(f"Alert email sent: {subject}")
            else:
                logger.error(f"Email send failed: {response.status_code} - {response.text}")
                
        except Exception as e:
            logger.error(f"Email send error: {e}")
    
    def _build_subject(self, has_bird: bool, has_animal: bool, count: int) -> str:
        """Build email subject line."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        
        if has_bird and count == 1:
            return f"🐦 Hummingbird detected at {timestamp}"
        elif has_bird:
            return f"🐦 Bird detected at {timestamp}"
        elif has_animal:
            return f"🦊 Animal detected at {timestamp}"
        else:
            return f"📷 Motion detected at {timestamp}"
    
    def _build_html(self, image_path: Path, animals: list, has_bird: bool, has_animal: bool) -> str:
        """Build HTML email body."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        animal_list = '<br>'.join([f"• {a}" for a in animals])
        
        emoji = "🐦" if has_bird else "🦊" if has_animal else "📷"
        
        html = f"""
        <html>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
                <h1 style="color: white; margin: 0;">{emoji} Hummingbird Camera Alert</h1>
            </div>
            
            <div style="padding: 20px;">
                <h2 style="color: #333;">Detection Summary</h2>
                <p style="color: #666; font-size: 14px;">Detected at: <strong>{timestamp}</strong></p>
                
                <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <h3 style="margin-top: 0; color: #333;">Detected Animals:</h3>
                    <p style="color: #666;">{animal_list}</p>
                </div>
                
                <p style="color: #666;">See attached image for details.</p>
                
                <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
                <p style="color: #999; font-size: 12px; text-align: center;">
                    Hummingbird Camera System | Raspberry Pi
                </p>
            </div>
        </body>
        </html>
        """
        return html
    
    def _build_text(self, image_path: Path, animals: list, has_bird: bool, has_animal: bool) -> str:
        """Build plain text email body."""
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        animal_list = '\n'.join([f"• {a}" for a in animals])
        
        text = f"""
Hummingbird Camera Alert
========================

Detected at: {timestamp}

Detected Animals:
{animal_list}

See attached image for details.

---
Hummingbird Camera System | Raspberry Pi
        """
        return text
    
    def _encode_image(self, image_path: Path) -> str:
        """Encode image to base64 for email attachment."""
        import base64
        try:
            if not image_path.exists():
                logger.warning(f"Image file not found for attachment: {image_path}")
                return ""
            
            with open(image_path, 'rb') as f:
                data = f.read()
                if not data:
                    logger.warning(f"Image file is empty: {image_path}")
                    return ""
                return base64.b64encode(data).decode('utf-8')
        except Exception as e:
            logger.error(f"Failed to encode image for attachment: {e}")
            return ""
