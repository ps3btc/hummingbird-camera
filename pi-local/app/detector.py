"""Ensemble object detection module — runs all available models and merges results."""
import cv2
import numpy as np
import logging
import time
from pathlib import Path
from app.config import Config

logger = logging.getLogger(__name__)


class ObjectDetector:
    """
    Ensemble detector: loads ALL available models (ultralytics, tflite, opencv)
    and runs them on each frame. If the first model finds nothing, skip the rest
    to save compute. Otherwise merge results via IoU matching.
    """

    # ── Class ID mappings (all normalized to COCO names) ──────────

    # COCO 80-class names (0-indexed for ultralytics)
    COCO_80 = {
        0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 4: "airplane",
        5: "bus", 6: "train", 7: "truck", 8: "boat", 9: "traffic light",
        10: "fire hydrant", 11: "stop sign", 12: "parking meter", 13: "bench",
        14: "bird", 15: "cat", 16: "dog", 17: "horse", 18: "sheep", 19: "cow",
        20: "elephant", 21: "bear", 22: "zebra", 23: "giraffe", 24: "backpack",
        25: "umbrella", 26: "handbag", 27: "tie", 28: "suitcase", 29: "frisbee",
        30: "skis", 31: "snowboard", 32: "sports ball", 33: "kite",
        34: "baseball bat", 35: "baseball glove", 36: "skateboard",
        37: "surfboard", 38: "tennis racket", 39: "bottle", 40: "wine glass",
        41: "cup", 42: "fork", 43: "knife", 44: "spoon", 45: "bowl",
        46: "banana", 47: "apple", 48: "sandwich", 49: "orange", 50: "broccoli",
        51: "carrot", 52: "hot dog", 53: "pizza", 54: "donut", 55: "cake",
        56: "chair", 57: "couch", 58: "potted plant", 59: "bed",
        60: "dining table", 61: "toilet", 62: "tv", 63: "laptop", 64: "mouse",
        65: "remote", 66: "keyboard", 67: "cell phone", 68: "microwave",
        69: "oven", 70: "toaster", 71: "sink", 72: "refrigerator", 73: "book",
        74: "clock", 75: "vase", 76: "scissors", 77: "teddy bear",
        78: "hair drier", 79: "toothbrush"
    }

    # COCO 1-based (SSD MobileNet TF COCO output)
    COCO_1BASED = {
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

    VOC_CLASSES = [
        "background", "aeroplane", "bicycle", "bird", "boat", "bottle",
        "bus", "car", "cat", "chair", "cow", "diningtable", "dog",
        "horse", "motorbike", "person", "pottedplant", "sheep", "sofa",
        "train", "tvmonitor"
    ]

    # Animals of interest (normalized class names)
    ANIMAL_NAMES = {"bird", "cat", "dog", "horse", "sheep", "cow",
                    "elephant", "bear", "zebra", "giraffe"}
    BIRD_NAMES = {"bird"}
    HUMAN_NAMES = {"person"}

    # IoU threshold for considering two boxes as the same object
    IOU_THRESHOLD = 0.35

    # Confidence thresholds by class type (higher = fewer false positives)
    # Single model: require very high confidence
    # Multi-model agreement: can accept lower confidence
    CONF_THRESHOLD_SINGLE = {
        'human': 0.95,    # 95% for humans
        'bird': 0.90,     # 90% for birds (small, hard to detect)
        'animal': 0.90,   # 90% for other animals
    }
    # With 2+ model agreement, accept lower confidence
    CONF_THRESHOLD_ENSEMBLE = {
        'human': 0.75,    # 75% if 2+ models agree
        'bird': 0.70,     # 70% if 2+ models agree
        'animal': 0.70,   # 70% if 2+ models agree
    }

    def __init__(self):
        self.models = []          # list of (model, type_str, variant_str, extra_info)
        self.inference_time = 0.0

    # ── Loading ────────────────────────────────────────────────────

    def load_model(self):
        """Try to load ALL available models. Returns True if at least one loads."""
        self._try_load_ultralytics()
        self._try_load_tflite()
        self._try_load_opencv_dnn()

        if not self.models:
            logger.error("No detection model could be loaded!")
            return False

        names = [m[1] for m in self.models]
        logger.info(f"Ensemble ready with {len(self.models)} model(s): {', '.join(names)}")
        return True

    def _try_load_ultralytics(self):
        """Try to load YOLOv8n via ultralytics."""
        try:
            from ultralytics import YOLO
            model_path = Config.MODELS_DIR / 'yolov8n.pt'

            if not model_path.exists():
                logger.info("Downloading YOLOv8n model...")
                model_path.parent.mkdir(parents=True, exist_ok=True)
                model = YOLO('yolov8n.pt')
                model.save(str(model_path))
                logger.info(f"YOLOv8n model saved to {model_path}")

            model = YOLO(str(model_path))
            class_names = model.names  # {0: 'person', 1: 'bicycle', ...}
            self.models.append((model, 'ultralytics', None, class_names))
            logger.info("Ultralytics YOLOv8n loaded (ensemble member)")
        except Exception as e:
            logger.warning(f"Ultralytics YOLO not available: {e}")

    def _try_load_tflite(self):
        """Try to load TFLite model."""
        try:
            import tflite_runtime.interpreter as tflite
            model_path = Config.MODELS_DIR / 'yolov8n-int8.tflite'

            if not model_path.exists():
                logger.warning(f"TFLite model not found at {model_path}")
                return

            interpreter = tflite.Interpreter(model_path=str(model_path))
            interpreter.allocate_tensors()
            self.models.append((interpreter, 'tflite', None, None))
            logger.info("TFLite model loaded (ensemble member)")
        except Exception as e:
            logger.warning(f"TFLite runtime not available: {e}")

    def _try_load_opencv_dnn(self):
        """Try to load OpenCV DNN models (TF COCO and/or Caffe VOC)."""
        # TF COCO
        pb_path = Config.MODELS_DIR / 'ssd_mobilenet_v1_coco.pb'
        pbtxt_path = Config.MODELS_DIR / 'ssd_mobilenet_v1_coco.pbtxt'
        if pb_path.exists() and pbtxt_path.exists():
            try:
                if hasattr(cv2.dnn, 'readNetFromTensorflow'):
                    net = cv2.dnn.readNetFromTensorflow(str(pb_path), str(pbtxt_path))
                    self.models.append((net, 'opencv', 'tf_coco', None))
                    logger.info("SSD MobileNet v1 COCO loaded via OpenCV DNN (ensemble member)")
            except Exception as e:
                logger.warning(f"Failed to load TF COCO model: {e}")

        # Caffe VOC
        proto_path = Config.MODELS_DIR / 'MobileNetSSD_deploy.prototxt'
        caffemodel_path = Config.MODELS_DIR / 'MobileNetSSD_deploy.caffemodel'
        if proto_path.exists() and caffemodel_path.exists():
            try:
                if hasattr(cv2.dnn, 'readNetFromCaffe'):
                    net = cv2.dnn.readNetFromCaffe(str(proto_path), str(caffemodel_path))
                    self.models.append((net, 'opencv', 'caffe_voc', None))
                    logger.info("MobileNet-SSD Caffe VOC loaded (ensemble member)")
            except Exception as e:
                logger.warning(f"Failed to load Caffe model: {e}")

    # ── Detection ──────────────────────────────────────────────────

    def detect(self, frame):
        """
        Ensemble detection: run all models, merge via IoU.
        Short-circuit: if the first model finds nothing, skip the rest.
        """
        empty = {
            'detections': [],
            'has_bird': False,
            'has_animal': False,
            'has_human': False,
            'inference_ms': 0.0
        }

        if not self.models:
            logger.error("No model loaded")
            return empty

        start = time.time()
        all_detections = []   # raw detections from all models
        model_summaries = []  # per-model summary for logging

        for i, (model, mtype, variant, extra) in enumerate(self.models):
            if mtype == 'ultralytics':
                dets = self._run_ultralytics(model, frame, extra)
            elif mtype == 'tflite':
                dets = self._run_tflite(model, frame)
            elif mtype == 'opencv':
                dets = self._run_opencv(model, frame, variant)
            else:
                dets = []

            model_summaries.append(f"{mtype}:{len(dets)}")

            # Short-circuit: if first model found nothing, skip the rest
            if i == 0 and len(dets) == 0:
                logger.info(f"First model ({mtype}) found nothing — skipping remaining models")
                break

            all_detections.extend(dets)

        # Merge overlapping detections from different models
        merged = self._merge_detections(all_detections)

        elapsed = (time.time() - start) * 1000
        self.inference_time = round(elapsed, 1)

        # Build result
        result = {
            'detections': merged,
            'has_bird': False,
            'has_animal': False,
            'has_human': False,
            'inference_ms': self.inference_time
        }

        for det in merged:
            name = det['class_name'].lower()
            if name in self.HUMAN_NAMES:
                result['has_human'] = True
            if name in self.BIRD_NAMES:
                result['has_bird'] = True
                result['has_animal'] = True
            elif name in self.ANIMAL_NAMES:
                result['has_animal'] = True

        models_str = '+'.join(model_summaries)
        logger.info(
            f"Detection in {self.inference_time}ms [{models_str}] | "
            f"birds={result['has_bird']} animals={result['has_animal']} "
            f"humans={result['has_human']} | {len(merged)} merged objects"
        )
        return result

    # ── Individual model runners ───────────────────────────────────

    def _run_ultralytics(self, model, frame, class_names):
        """Run ultralytics YOLO, return list of normalized detections."""
        detections = []
        try:
            results = model(frame, conf=0.25, verbose=False)
            for r in results:
                for box in r.boxes:
                    cls_id = int(box.cls[0])
                    conf = float(box.conf[0])
                    cls_name = class_names.get(cls_id, f"class_{cls_id}")
                    bbox = box.xyxy[0].tolist()
                    detections.append({
                        'class_id': cls_id,
                        'class_name': cls_name,
                        'confidence': round(conf, 3),
                        'bbox': [float(v) for v in bbox],
                        'source': 'ultralytics'
                    })
        except Exception as e:
            logger.error(f"Ultralytics detection error: {e}")
        return detections

    def _run_tflite(self, interpreter, frame):
        """Run TFLite model, return list of normalized detections."""
        detections = []
        try:
            input_details = interpreter.get_input_details()
            output_details = interpreter.get_output_details()

            input_shape = input_details[0]['shape']
            resized = cv2.resize(frame, (input_shape[1], input_shape[2]))
            input_data = np.expand_dims(resized, axis=0).astype(np.float32) / 255.0

            interpreter.set_tensor(input_details[0]['index'], input_data)
            interpreter.invoke()

            output_data = interpreter.get_tensor(output_details[0]['index'])
            logger.debug(f"TFLite raw output shape: {output_data.shape}")
            # TFLite post-processing depends on model — placeholder
        except Exception as e:
            logger.error(f"TFLite detection error: {e}")
        return detections

    def _run_opencv(self, net, frame, variant):
        """Run OpenCV DNN model, return list of normalized detections."""
        detections = []
        try:
            h, w = frame.shape[:2]

            if variant == 'caffe_voc':
                blob = cv2.dnn.blobFromImage(frame, 0.007843, (300, 300), 127.5)
            else:
                blob = cv2.dnn.blobFromImage(frame, size=(300, 300), swapRB=True)

            net.setInput(blob)
            raw = net.forward()

            for i in range(raw.shape[2]):
                confidence = float(raw[0, 0, i, 2])
                if confidence < 0.25:  # low threshold for ensemble gathering
                    continue

                cls_id_raw = int(raw[0, 0, i, 1])

                if variant == 'caffe_voc':
                    cls_name = self.VOC_CLASSES[cls_id_raw] if cls_id_raw < len(self.VOC_CLASSES) else f"class_{cls_id_raw}"
                else:
                    cls_name = self.COCO_1BASED.get(cls_id_raw, f"class_{cls_id_raw}")

                box = raw[0, 0, i, 3:7] * np.array([w, h, w, h])
                bbox = box.astype("int").tolist()

                detections.append({
                    'class_id': cls_id_raw,
                    'class_name': cls_name,
                    'confidence': round(confidence, 3),
                    'bbox': [float(v) for v in bbox],
                    'source': f'opencv_{variant}'
                })
        except Exception as e:
            logger.error(f"OpenCV DNN detection error: {e}")
        return detections

    # ── Ensemble merging ───────────────────────────────────────────

    def _merge_detections(self, detections):
        """
        Merge detections from multiple models using IoU.
        Requires ensemble agreement OR very high single-model confidence.
        This minimizes false positives.
        """
        if not detections:
            return []

        # Group by overlapping regions (IoU >= threshold)
        clusters = []  # each cluster is a list of detections for the same object
        
        for det in detections:
            placed = False
            for cluster in clusters:
                # Check if this detection overlaps with any detection in the cluster
                for existing in cluster:
                    if self._compute_iou(det['bbox'], existing['bbox']) >= self.IOU_THRESHOLD:
                        cluster.append(det)
                        placed = True
                        break
                if placed:
                    break
            
            if not placed:
                clusters.append([det])

        # For each cluster, decide if it's a real detection
        result = []
        for cluster in clusters:
            # Get unique sources (models) in this cluster
            sources = set(d.get('source', '?') for d in cluster)
            num_models = len(sources)
            
            # Pick the detection with highest confidence as the representative
            cluster.sort(key=lambda d: d['confidence'], reverse=True)
            best = dict(cluster[0])  # copy
            
            # Determine class type for threshold selection
            cls_name = best['class_name'].lower()
            if cls_name in self.HUMAN_NAMES:
                class_type = 'human'
            elif cls_name in self.BIRD_NAMES:
                class_type = 'bird'
            elif cls_name in self.ANIMAL_NAMES:
                class_type = 'animal'
            else:
                class_type = 'other'  # non-animal objects (not used for alerts)
            
            # Decision logic:
            # - If 2+ models agree: use lower threshold (ensemble confidence)
            # - If only 1 model: use very high threshold (single model must be very sure)
            if num_models >= 2:
                threshold = self.CONF_THRESHOLD_ENSEMBLE.get(class_type, 0.80)
                if best['confidence'] >= threshold:
                    best['ensemble_count'] = num_models
                    result.append(best)
            else:
                # Single model — must be extremely confident
                threshold = self.CONF_THRESHOLD_SINGLE.get(class_type, 0.95)
                if best['confidence'] >= threshold:
                    result.append(best)

        # Clean up internal fields
        for d in result:
            d.pop('source', None)
            d.pop('ensemble_count', None)

        return result

    @staticmethod
    def _compute_iou(box_a, box_b):
        """Compute Intersection over Union for two bboxes [x1, y1, x2, y2]."""
        try:
            xa = max(box_a[0], box_b[0])
            ya = max(box_a[1], box_b[1])
            xb = min(box_a[2], box_b[2])
            yb = min(box_a[3], box_b[3])

            inter = max(0, xb - xa) * max(0, yb - ya)
            if inter == 0:
                return 0.0

            area_a = max(0, box_a[2] - box_a[0]) * max(0, box_a[3] - box_a[1])
            area_b = max(0, box_b[2] - box_b[0]) * max(0, box_b[3] - box_b[1])
            union = area_a + area_b - inter

            return inter / union if union > 0 else 0.0
        except Exception:
            return 0.0

    # ── Drawing (for dashboard) ────────────────────────────────────

    def draw_detections(self, frame, detections):
        """Draw bounding boxes on frame for local dashboard."""
        annotated = frame.copy()
        for det in detections:
            bbox = [int(v) for v in det['bbox']]
            cls_name = det['class_name']
            conf = det['confidence']

            if cls_name.lower() == 'person':
                color = (0, 0, 255)    # Red for humans
            elif cls_name.lower() == 'bird':
                color = (0, 255, 0)    # Green for birds
            else:
                color = (0, 165, 255)  # Orange for other animals

            cv2.rectangle(annotated, (bbox[0], bbox[1]), (bbox[2], bbox[3]), color, 2)
            label = f"{cls_name} {conf:.0%}"
            cv2.putText(annotated, label, (bbox[0], bbox[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

        return annotated
