"""OpenAI GPT-4o-mini vision detector — cloud-based verification."""
import requests
import base64
import json
import logging
import time
from pathlib import Path
from app.config import Config

logger = logging.getLogger(__name__)

# Structured prompt for wildlife detection
VISION_PROMPT = """Analyze this outdoor camera image for wildlife detection.

Return a JSON object with this exact structure:
{
  "detections": [
    {
      "class_name": "species or object name (e.g. 'hummingbird', 'robin', 'cat', 'person')",
      "category": "bird" | "animal" | "human" | "other",
      "confidence": 0.0-1.0,
      "bbox": [x1, y1, x2, y2],
      "notes": "optional behavior or detail"
    }
  ],
  "scene_description": "brief scene summary",
  "has_bird": true/false,
  "has_animal": true/false,
  "has_human": true/false,
  "interesting": "any notable behavior or observation"
}

Rules:
- bbox coordinates are pixel values in the original image (640x480)
- confidence is your certainty (0.0-1.0)
- Only include detections you're confident about (confidence >= 0.5)
- For birds, try to identify the species (hummingbird, sparrow, robin, etc.)
- For animals, identify the species if possible (cat, dog, squirrel, etc.)
- category must be one of: "bird", "animal", "human", "other"
- Return ONLY valid JSON, no markdown or extra text"""


class OpenAIVisionDetector:
    """Sends images to GPT-4o-mini for wildlife detection verification."""

    API_URL = 'https://api.openai.com/v1/chat/completions'

    def __init__(self):
        self.api_key = Config.OPENAI_API_KEY
        self.model = Config.OPENAI_MODEL
        self.session = requests.Session()
        self.session.headers.update({
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json'
        })
        self.inference_time = 0.0

    def analyze(self, image_path: Path) -> dict:
        """
        Send image to OpenAI for analysis.

        Returns:
            dict with keys:
                - detections: list of {class_name, category, confidence, bbox, notes}
                - has_bird: bool
                - has_animal: bool
                - has_human: bool
                - scene_description: str
                - interesting: str
                - inference_ms: float
        """
        empty = {
            'detections': [],
            'has_bird': False,
            'has_animal': False,
            'has_human': False,
            'scene_description': '',
            'interesting': '',
            'inference_ms': 0.0
        }

        if not self.api_key:
            logger.warning("OpenAI API key not configured")
            return empty

        try:
            # Encode image to base64
            with open(image_path, 'rb') as f:
                img_b64 = base64.b64encode(f.read()).decode('utf-8')

            payload = {
                'model': self.model,
                'messages': [
                    {
                        'role': 'user',
                        'content': [
                            {'type': 'text', 'text': self.VISION_PROMPT},
                            {
                                'type': 'image_url',
                                'image_url': {
                                    'url': f'data:image/jpeg;base64,{img_b64}',
                                    'detail': 'low'  # low detail = fewer tokens
                                }
                            }
                        ]
                    }
                ],
                'max_tokens': 500,
                'temperature': 0.1  # low temperature for consistent results
            }

            start = time.time()
            response = self.session.post(self.API_URL, json=payload, timeout=30)
            elapsed = (time.time() - start) * 1000

            if response.status_code != 200:
                logger.error(f"OpenAI API error {response.status_code}: {response.text[:200]}")
                empty['inference_ms'] = round(elapsed, 1)
                return empty

            data = response.json()
            content = data['choices'][0]['message']['content']

            # Parse the JSON response
            result = self._parse_response(content)
            result['inference_ms'] = round(elapsed, 1)

            logger.info(
                f"OpenAI analysis in {result['inference_ms']}ms | "
                f"birds={result['has_bird']} animals={result['has_animal']} "
                f"humans={result['has_human']} | {len(result['detections'])} objects | "
                f"{result.get('scene_description', '')[:60]}"
            )

            # Log token usage for cost tracking
            usage = data.get('usage', {})
            if usage:
                logger.debug(
                    f"OpenAI tokens: {usage.get('prompt_tokens', 0)} in, "
                    f"{usage.get('completion_tokens', 0)} out"
                )

            return result

        except requests.exceptions.Timeout:
            logger.error("OpenAI API timeout (30s)")
            return empty
        except Exception as e:
            logger.error(f"OpenAI analysis error: {e}")
            return empty

    def _parse_response(self, content: str) -> dict:
        """Parse the OpenAI response, handling markdown code blocks."""
        empty = {
            'detections': [],
            'has_bird': False,
            'has_animal': False,
            'has_human': False,
            'scene_description': '',
            'interesting': ''
        }

        try:
            # Strip markdown code blocks if present
            text = content.strip()
            if text.startswith('```'):
                # Remove ```json ... ``` wrapper
                lines = text.split('\n')
                lines = [l for l in lines if not l.strip().startswith('```')]
                text = '\n'.join(lines)

            parsed = json.loads(text)

            # Normalize detections
            detections = []
            for det in parsed.get('detections', []):
                if not isinstance(det, dict):
                    continue
                detections.append({
                    'class_name': str(det.get('class_name', 'unknown')),
                    'category': str(det.get('category', 'other')),
                    'confidence': float(det.get('confidence', 0)),
                    'bbox': det.get('bbox', []),
                    'notes': str(det.get('notes', ''))
                })

            return {
                'detections': detections,
                'has_bird': bool(parsed.get('has_bird', False)),
                'has_animal': bool(parsed.get('has_animal', False)),
                'has_human': bool(parsed.get('has_human', False)),
                'scene_description': str(parsed.get('scene_description', '')),
                'interesting': str(parsed.get('interesting', ''))
            }

        except (json.JSONDecodeError, KeyError, ValueError) as e:
            logger.error(f"Failed to parse OpenAI response: {e}")
            logger.debug(f"Raw response: {content[:500]}")
            return empty

    # Class-level prompt constant
    VISION_PROMPT = VISION_PROMPT
