"""YOLO-based object detection module optimized for Raspberry Pi 3."""
import cv2
import numpy as np
import logging
import time
from pathlib import Path
from app.config import Config

logger = logging.getLogger(__name__)


class ObjectDetector:
    """Lightweight object detection using YOLOv8n or TFLite fallback."""

    # COCO class names relevant to our use case
    BIRD_CLASS_IDS = set(range(14, 24))       # 14-23: various bird classes in COCO
    ANIMAL_CLASS_IDS = set(range(14, 28))      # 14-27: birds + various animals
    HUMAN_CLASS_ID = 0

    def __init__(self):
        self.model = None
        self.model_type = None  # 'ultralytics', 'tflite', or 'opencv'
        self.opencv_variant = None  # 'tf_coco' or 'caffe_voc'
        self.class_names = []
        self.inference_time = 0.0

    def load_model(self):
        """Load the best available detection model for the platform."""
        # Strategy 1: Try ultralytics YOLOv8n (best accuracy)
        if self._load_ultralytics():
            return True

        # Strategy 2: Try TFLite model (fastest on ARM)
        if self._load_tflite():
            return True

        # Strategy 3: Try OpenCV DNN with MobileNet-SSD (fallback)
        if self._load_opencv_dnn():
            return True

        logger.error("No detection model could be loaded!")
        return False

    def _load_ultralytics(self):
        """Load YOLOv8n via ultralytics."""
        try:
            from ultralytics import YOLO
            model_path = Config.MODELS_DIR / 'yolov8n.pt'

            if not model_path.exists():
                logger.info("Downloading YOLOv8n model...")
                model_path.parent.mkdir(parents=True, exist_ok=True)
                model = YOLO('yolov8n.pt')
                model.save(str(model_path))
                logger.info(f"YOLOv8n model saved to {model_path}")

            self.model = YOLO(str(model_path))
            self.model_type = 'ultralytics'
            self.class_names = self.model.names
            logger.info("YOLOv8n model loaded via ultralytics")
            return True
        except Exception as e:
            logger.warning(f"Ultralytics YOLO not available: {e}")
            return False

    def _load_tflite(self):
        """Load a TFLite YOLO model for ARM optimization."""
        try:
            import tflite_runtime.interpreter as tflite
            model_path = Config.MODELS_DIR / 'yolov8n-int8.tflite'

            if not model_path.exists():
                logger.warning(f"TFLite model not found at {model_path}")
                return False

            self.model = tflite.Interpreter(model_path=str(model_path))
            self.model.allocate_tensors()
            self.model_type = 'tflite'
            logger.info("TFLite model loaded")
            return True
        except Exception as e:
            logger.warning(f"TFLite runtime not available: {e}")
            return False

    def _load_opencv_dnn(self):
        """Load detection model via OpenCV DNN as fallback."""
        try:
            # Preferred: SSD MobileNet v1 COCO frozen graph.
            # This is the exact model from OpenCV's official tutorial and
            # requires OpenCV 4.x (5.0 dropped the needed TF graph handling).
            pb_path = Config.MODELS_DIR / 'ssd_mobilenet_v1_coco.pb'
            pbtxt_path = Config.MODELS_DIR / 'ssd_mobilenet_v1_coco.pbtxt'
            if pb_path.exists() and pbtxt_path.exists():
                if hasattr(cv2.dnn, 'readNetFromTensorflow'):
                    self.model = cv2.dnn.readNetFromTensorflow(str(pb_path), str(pbtxt_path))
                    self.model_type = 'opencv'
                    self.opencv_variant = 'tf_coco'
                    logger.info("SSD MobileNet v1 COCO loaded via OpenCV DNN (TensorFlow)")
                    return True

            # Alternative: Caffe MobileNet-SSD VOC (needs OpenCV 4.x too)
            proto_path = Config.MODELS_DIR / 'MobileNetSSD_deploy.prototxt'
            model_path = Config.MODELS_DIR / 'MobileNetSSD_deploy.caffemodel'
            if proto_path.exists() and model_path.exists():
                if hasattr(cv2.dnn, 'readNetFromCaffe'):
                    self.model = cv2.dnn.readNetFromCaffe(str(proto_path), str(model_path))
                    self.model_type = 'opencv'
                    self.opencv_variant = 'caffe_voc'
                    logger.info("MobileNet-SSD loaded via OpenCV DNN (Caffe)")
                    return True

            logger.warning(
                "No compatible detection model found in %s "
                "(need ssd_mobilenet_v1_coco.pb + .pbtxt)", Config.MODELS_DIR)
            return False
        except Exception as e:
            logger.warning(f"OpenCV DNN fallback failed: {e}")
            return False

    def detect(self, frame):
        """
        Run object detection on a frame.

        Returns:
            dict with keys:
                - detections: list of {class_id, class_name, confidence, bbox}
                - has_bird: bool
                - has_animal: bool (includes birds)
                - has_human: bool
                - inference_ms: float
        """
        result = {
            'detections': [],
            'has_bird': False,
            'has_animal': False,
            'has_human': False,
            'inference_ms': 0.0
        }

        if self.model is None:
            logger.error("No model loaded")
            return result

        start = time.time()

        if self.model_type == 'ultralytics':
            result = self._detect_ultralytics(frame)
        elif self.model_type == 'tflite':
            result = self._detect_tflite(frame)
        elif self.model_type == 'opencv':
            result = self._detect_opencv(frame)

        elapsed = (time.time() - start) * 1000
        result['inference_ms'] = round(elapsed, 1)
        self.inference_time = result['inference_ms']

        logger.info(
            f"Detection in {result['inference_ms']}ms | "
            f"birds={result['has_bird']} animals={result['has_animal']} humans={result['has_human']} | "
            f"{len(result['detections'])} objects"
        )
        return result

    def _detect_ultralytics(self, frame):
        """Run detection using ultralytics YOLO."""
        result = {
            'detections': [],
            'has_bird': False,
            'has_animal': False,
            'has_human': False,
            'inference_ms': 0.0
        }

        results = self.model(frame, conf=Config.DETECTION_CONF_THRESHOLD, verbose=False)

        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                cls_name = self.class_names.get(cls_id, f"class_{cls_id}")

                detection = {
                    'class_id': cls_id,
                    'class_name': cls_name,
                    'confidence': round(conf, 3),
                    'bbox': box.xyxy[0].tolist()
                }
                result['detections'].append(detection)

                if cls_id == self.HUMAN_CLASS_ID:
                    result['has_human'] = True
                if cls_id in self.BIRD_CLASS_IDS:
                    result['has_bird'] = True
                    result['has_animal'] = True
                elif cls_id in self.ANIMAL_CLASS_IDS:
                    result['has_animal'] = True

        return result

    def _detect_tflite(self, frame):
        """Run detection using TFLite interpreter."""
        # TFLite YOLO requires custom post-processing
        # This is a simplified implementation
        result = {
            'detections': [],
            'has_bird': False,
            'has_animal': False,
            'has_human': False,
            'inference_ms': 0.0
        }

        input_details = self.model.get_input_details()
        output_details = self.model.get_output_details()

        # Preprocess
        input_shape = input_details[0]['shape']
        resized = cv2.resize(frame, (input_shape[1], input_shape[2]))
        input_data = np.expand_dims(resized, axis=0).astype(np.float32) / 255.0

        self.model.set_tensor(input_details[0]['index'], input_data)
        self.model.invoke()

        output_data = self.model.get_tensor(output_details[0]['index'])
        # Post-processing depends on model output format
        logger.debug(f"TFLite raw output shape: {output_data.shape}")

        return result

    # COCO label map (1-based class IDs as output by SSD MobileNet COCO)
    COCO_CLASSES = {
        1: "person", 2: "bicycle", 3: "car", 4: "motorcycle", 5: "airplane",
        6: "bus", 7: "train", 8: "truck", 9: "boat", 10: "traffic light",
        11: "fire hydrant", 13: "stop sign", 14: "parking meter", 15: "bench",
        16: "bird", 17: "cat", 18: "dog", 19: "horse", 20: "sheep", 21: "cow",
        22: "elephant", 23: "bear", 24: "zebra", 25: "giraffe", 27: "backpack",
        28: "umbrella", 31: "handbag", 32: "tie", 33: "suitcase", 34: "frisbee",
        35: "skis", 36: "snowboard", 37: "sports ball", 38: "kite",
        39: "baseball bat", 40: "baseball glove", 41: "skateboard",
        42: "surfboard", 43: "tennis racket", 44: "bottle", 46: "wine glass",
        47: "cup", 48: "fork", 49: "knife", 50: "spoon", 51: "bowl",
        52: "banana", 53: "apple", 54: "sandwich", 55: "orange", 56: "broccoli",
        57: "carrot", 58: "hot dog", 59: "pizza", 60: "donut", 61: "cake",
        62: "chair", 63: "couch", 64: "potted plant", 65: "bed",
        67: "dining table", 70: "toilet", 72: "tv", 73: "laptop", 74: "mouse",
        75: "remote", 76: "keyboard", 77: "cell phone", 78: "microwave",
        79: "oven", 80: "toaster", 81: "sink", 82: "refrigerator", 84: "book",
        85: "clock", 86: "vase", 87: "scissors", 88: "teddy bear",
        89: "hair drier", 90: "toothbrush"
    }
    COCO_ANIMAL_IDS = set(range(16, 26))  # 16-25: bird, cat, dog, ..., giraffe

    def _detect_opencv(self, frame):
        """Run detection using OpenCV DNN (SSD MobileNet)."""
        result = {
            'detections': [],
            'has_bird': False,
            'has_animal': False,
            'has_human': False,
            'inference_ms': 0.0
        }

        h, w = frame.shape[:2]

        if self.opencv_variant == 'caffe_voc':
            blob = cv2.dnn.blobFromImage(frame, 0.007843, (300, 300), 127.5)
        else:
            # SSD MobileNet v1 COCO preprocessing (OpenCV tutorial recipe)
            blob = cv2.dnn.blobFromImage(frame, size=(300, 300), swapRB=True)
        self.model.setInput(blob)
        detections = self.model.forward()

        # MobileNet-SSD VOC class mapping (used only with caffe_voc variant)
        VOC_CLASSES = [
            "background", "aeroplane", "bicycle", "bird", "boat", "bottle",
            "bus", "car", "cat", "chair", "cow", "diningtable", "dog",
            "horse", "motorbike", "person", "pottedplant", "sheep", "sofa",
            "train", "tvmonitor"
        ]

        for i in range(detections.shape[2]):
            confidence = detections[0, 0, i, 2]
            if confidence < Config.DETECTION_CONF_THRESHOLD:
                continue

            cls_id = int(detections[0, 0, i, 1])
            if self.opencv_variant == 'caffe_voc':
                cls_name = VOC_CLASSES[cls_id] if cls_id < len(VOC_CLASSES) else f"class_{cls_id}"
                is_human = (cls_name == "person")
                is_bird = (cls_name == "bird")
                is_animal = cls_name in ("bird", "cat", "dog", "cow", "horse", "sheep")
            else:
                cls_name = self.COCO_CLASSES.get(cls_id, f"class_{cls_id}")
                is_human = (cls_id == 1)
                is_bird = (cls_id == 16)
                is_animal = cls_id in self.COCO_ANIMAL_IDS

            box = detections[0, 0, i, 3:7] * np.array([w, h, w, h])
            bbox = box.astype("int").tolist()

            detection = {
                'class_id': cls_id,
                'class_name': cls_name,
                'confidence': round(confidence, 3),
                'bbox': bbox
            }
            result['detections'].append(detection)

            if is_human:
                result['has_human'] = True
            if is_bird:
                result['has_bird'] = True
            if is_animal:
                result['has_animal'] = True

        return result

    def draw_detections(self, frame, detections):
        """Draw bounding boxes on frame for local dashboard."""
        annotated = frame.copy()
        for det in detections:
            bbox = [int(v) for v in det['bbox']]
            cls_name = det['class_name']
            conf = det['confidence']

            # Color coding (works for both COCO 1-based and YOLO 0-based IDs)
            if det['class_id'] in (0, 1) and cls_name == 'person':
                color = (0, 0, 255)  # Red for humans
            elif cls_name in ('bird',) or (det['class_id'] in self.BIRD_CLASS_IDS and self.model_type == 'ultralytics'):
                color = (0, 255, 0)  # Green for birds
            else:
                color = (0, 165, 255)  # Orange for other animals

            cv2.rectangle(annotated, (bbox[0], bbox[1]), (bbox[2], bbox[3]), color, 2)
            label = f"{cls_name} {conf:.0%}"
            cv2.putText(annotated, label, (bbox[0], bbox[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

        return annotated
