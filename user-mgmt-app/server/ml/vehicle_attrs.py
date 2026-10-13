#!/usr/bin/env python3
"""
Vehicle TYPE + COLOR classifiers (counterpart to ANPR for plates).

Type  -> YOLOv8 on the vehicle crop (much better car/truck/bus/motorcycle than EfficientDet alone)
Color -> K-means on body pixels (ignore wheels, glass, extreme highlights)

Install:  python -m pip install ultralytics
"""
from __future__ import annotations

import sys
from pathlib import Path
from collections import Counter

import cv2
import numpy as np

MODELS = Path(__file__).resolve().parent.parent / "ml_models"
YOLO_CANDIDATES = [
    MODELS / "yolov8s.pt",
    MODELS / "yolov8n.pt",
    Path("yolov8s.pt"),
    Path("yolov8n.pt"),
]

VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle", "bicycle"}

# HSV centers for body colors (H 0-180 OpenCV)
COLOR_DEFS = [
    # name, H range(s), S min, V range
    ("red",    [(0, 10), (170, 179)], 80, (50, 255)),
    ("orange", [(11, 22)], 80, (50, 255)),
    ("yellow", [(23, 38)], 80, (60, 255)),
    ("green",  [(39, 85)], 50, (40, 255)),
    ("blue",   [(90, 130)], 50, (40, 255)),
    ("purple", [(131, 160)], 40, (40, 255)),
    ("white",  [(0, 179)], 0, (180, 255)),   # low S handled below
    ("black",  [(0, 179)], 0, (0, 55)),
    ("gray",   [(0, 179)], 0, (56, 179)),
    ("brown",  [(10, 25)], 40, (40, 160)),
]

_yolo = None
_yolo_name = None
_yolo_failed = False


def _load_yolo():
    global _yolo, _yolo_name, _yolo_failed
    if _yolo is not None or _yolo_failed:
        return _yolo
    try:
        from ultralytics import YOLO
    except ImportError:
        print("[vehicle_attrs] ultralytics not installed — type stays detector default", file=sys.stderr)
        _yolo_failed = True
        return None
    for w in YOLO_CANDIDATES:
        if Path(w).exists():
            _yolo = YOLO(str(w))
            _yolo_name = str(w)
            print(f"[vehicle_attrs] YOLO type model: {_yolo_name}", file=sys.stderr, flush=True)
            return _yolo
    try:
        _yolo = YOLO("yolov8n.pt")
        _yolo_name = "yolov8n.pt"
        print("[vehicle_attrs] YOLO type model downloaded: yolov8n.pt", file=sys.stderr, flush=True)
        return _yolo
    except Exception as e:
        print(f"[vehicle_attrs] YOLO load failed: {e}", file=sys.stderr)
        _yolo_failed = True
        return None


def classify_type(crop_bgr, fallback: str = "car") -> tuple[str, float]:
    """
    Classify vehicle type from crop using YOLO.
    Returns (type, confidence).
    """
    if crop_bgr is None or crop_bgr.size == 0:
        return fallback, 0.0
    model = _load_yolo()
    if model is None:
        return fallback, 0.0
    try:
        h, w = crop_bgr.shape[:2]
        # pad small crops
        img = crop_bgr
        if min(h, w) < 64:
            scale = 128 / max(1, min(h, w))
            img = cv2.resize(crop_bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        res = model.predict(img, conf=0.20, verbose=False, imgsz=320, classes=[1, 2, 3, 5, 7])
        # COCO: 1 bicycle, 2 car, 3 motorcycle, 5 bus, 7 truck
    except Exception as e:
        print(f"[vehicle_attrs] type predict error: {e}", file=sys.stderr)
        return fallback, 0.0

    if not res or res[0].boxes is None or len(res[0].boxes) == 0:
        return fallback, 0.0

    names = res[0].names or {}
    best_label, best_score, best_area = fallback, 0.0, 0
    ih, iw = img.shape[:2]
    for b in res[0].boxes:
        cls_id = int(b.cls.item())
        label = str(names.get(cls_id, "")).lower()
        if label not in VEHICLE_CLASSES:
            continue
        score = float(b.conf.item())
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        area = max(0, x2 - x1) * max(0, y2 - y1)
        # prefer larger box in crop (the main vehicle)
        rank = score * (0.5 + 0.5 * (area / max(1, ih * iw)))
        if rank > best_score * (0.5 + 0.5 * (best_area / max(1, ih * iw))) or area > best_area * 1.2:
            best_label, best_score, best_area = label, score, area

    # Geometry fallback corrections
    if best_label == "truck" and best_score < 0.55:
        # weak truck on car-shaped crop -> car
        ar = crop_bgr.shape[1] / max(1, crop_bgr.shape[0])
        if 0.9 <= ar <= 2.2:
            best_label = "car"
    if best_label == "bus" and best_score < 0.50:
        best_label = "car"

    return best_label, float(best_score)



def _color_from_hsv(h, s, v):
    """Map one HSV pixel to a paint-color name."""
    h, s, v = int(h), int(s), int(v)
    # Strong chromatic first (paint colors)
    if s >= 50:
        if h <= 12 or h >= 168:
            return "red"
        if 13 <= h <= 25:
            return "orange" if s >= 90 and v >= 80 else "brown"
        if 26 <= h <= 40:
            return "yellow"
        if 41 <= h <= 88:
            return "green"
        if 89 <= h <= 135:
            return "blue"
        if 136 <= h <= 167:
            return "purple"
    # Weak chroma / neutrals
    if v <= 45:
        return "black"
    if s <= 45:
        if v >= 175:
            return "white"
        if v >= 95:
            return "gray"
        return "black"
    # mid sat neutrals
    if v <= 55:
        return "black"
    if v >= 170 and s < 60:
        return "white"
    return "gray"


def _sample_body_pixels(bgr):
    """
    Sample body paint pixels from several ROIs.
    Avoid: bottom wheels/road, top sky, left/right edges, very dark, specular white.
    Prefer mid-height door / fender panels.
    """
    if bgr is None or bgr.size == 0:
        return None
    h, w = bgr.shape[:2]
    if h < 16 or w < 16:
        return None

    # Resize for stable sampling
    scale = 160 / max(h, w)
    if scale < 1.0:
        bgr = cv2.resize(bgr, (max(16, int(w * scale)), max(16, int(h * scale))), interpolation=cv2.INTER_AREA)
        h, w = bgr.shape[:2]

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    H, S, V = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

    # ROI bands (y0,y1,x0,x1) relative 0-1 — door/side panels
    bands = [
        (0.25, 0.65, 0.15, 0.85),  # main body
        (0.30, 0.55, 0.20, 0.80),  # upper doors
        (0.40, 0.70, 0.25, 0.75),  # lower doors (not wheels)
        (0.20, 0.45, 0.30, 0.70),  # hood/roof area if frontal
    ]
    collected = []
    for y0, y1, x0, x1 in bands:
        ya, yb = int(y0 * h), int(y1 * h)
        xa, xb = int(x0 * w), int(x1 * w)
        if yb <= ya or xb <= xa:
            continue
        region = hsv[ya:yb, xa:xb]
        mask = (
            (region[:, :, 2] > 30) &
            (region[:, :, 2] < 245) &  # drop specular
            ~((region[:, :, 1] < 25) & (region[:, :, 2] > 200))  # drop pure glare
        )
        pix = region[mask]
        if len(pix):
            collected.append(pix)

    if not collected:
        flat = hsv.reshape(-1, 3)
        return flat[:: max(1, len(flat) // 1500)]

    pixels = np.concatenate(collected, axis=0)
    if len(pixels) > 3000:
        idx = np.linspace(0, len(pixels) - 1, 3000, dtype=int)
        pixels = pixels[idx]
    return pixels


def classify_color(crop_bgr):
    """
    Primary vehicle paint color from crop.
    Returns (primary, candidates, confidence).
    """
    pixels = _sample_body_pixels(crop_bgr)
    if pixels is None or len(pixels) < 30:
        return "unknown", [], 0.0

    # Classify every sampled pixel
    names = [_color_from_hsv(p[0], p[1], p[2]) for p in pixels]
    counts = Counter(names)
    total = sum(counts.values()) or 1

    # Boost chromatic paints: if red/blue/etc. is meaningful, prefer over gray/black road noise
    chromatic = {"red", "blue", "green", "yellow", "orange", "purple", "brown"}
    chrom_frac = sum(counts.get(c, 0) for c in chromatic) / total

    scores = {}
    for name, cnt in counts.items():
        frac = cnt / total
        w = frac
        if name in chromatic:
            w *= 1.35  # prefer real paint colors
        if name in ("gray", "black") and chrom_frac >= 0.18:
            w *= 0.65  # demote neutral if clear paint present
        scores[name] = w

    ordered = sorted(scores.items(), key=lambda x: -x[1])
    primary = ordered[0][0]
    conf = min(1.0, float(ordered[0][1]))
    candidates = [n for n, s in ordered if s >= 0.10][:4]

    # Special case: white vs gray — if many near-white pixels
    whiteish = sum(1 for p in pixels if int(p[1]) < 40 and int(p[2]) >= 160) / total
    blackish = sum(1 for p in pixels if int(p[2]) <= 55) / total
    if whiteish >= 0.35 and primary in ("gray", "white"):
        primary = "white"
        conf = max(conf, whiteish)
    if blackish >= 0.40 and primary in ("black", "gray"):
        primary = "black"
        conf = max(conf, blackish)

    return primary, candidates, conf


def classify_color_multi(crops):
    """Vote color across several crops of the same vehicle."""
    votes = Counter()
    weights = Counter()
    for crop in crops:
        if crop is None or getattr(crop, "size", 0) == 0:
            continue
        name, cands, conf = classify_color(crop)
        if name == "unknown":
            continue
        votes[name] += conf
        weights[name] += 1
        for c in cands[1:3]:
            votes[c] += conf * 0.25
    if not votes:
        return "unknown", [], 0.0
    primary, score = votes.most_common(1)[0]
    total = sum(votes.values()) or 1
    conf = score / total
    candidates = [n for n, _ in votes.most_common(4)]
    return primary, candidates, float(conf)


def refine_vehicle_attrs(crop_bgr, current_type: str, current_color: str, extra_crops=None):
    """
    Re-estimate type + color from crop(s).
    """
    vtype, tconf = classify_type(crop_bgr, fallback=current_type or "car")
    crops = [crop_bgr]
    if extra_crops:
        crops.extend([c for c in extra_crops if c is not None])
    color, cands, cconf = classify_color_multi(crops)
    if color == "unknown" and current_color and current_color != "unknown":
        color = current_color
        cands = list(dict.fromkeys([current_color] + (cands or [])))
    return {
        "type": vtype,
        "type_confidence": round(tconf, 3),
        "color": color,
        "color_candidates": cands,
        "color_confidence": round(cconf, 3),
        "type_backend": "yolo" if _yolo is not None else "detector",
        "color_backend": "body_pixel_vote",
    }


if __name__ == "__main__":
    import json
    img = cv2.imread(sys.argv[1]) if len(sys.argv) > 1 else None
    if img is None:
        print("Usage: vehicle_attrs.py <vehicle_crop.jpg>")
        sys.exit(1)
    print(json.dumps(refine_vehicle_attrs(img, "car", "unknown"), indent=2))
