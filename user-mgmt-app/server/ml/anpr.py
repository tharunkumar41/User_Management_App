#!/usr/bin/env python3
"""Dedicated ANPR - optimized for speed (fewer OCR passes)."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import cv2
import numpy as np

MODELS = Path(__file__).resolve().parent.parent / "ml_models"
PLATE_YOLO = MODELS / "license_plate_yolo.pt"

INDIA_PLATE_RE = re.compile(r"^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$")
GENERIC_PLATE_RE = re.compile(r"^[A-Z0-9]{5,12}$")

_easyocr_reader = None
_plate_yolo = None
_plate_yolo_tried = False


def plate_norm(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def _get_easyocr():
    global _easyocr_reader
    if _easyocr_reader is False:
        return None
    if _easyocr_reader is not None:
        return _easyocr_reader
    try:
        import easyocr
        print("[anpr] loading EasyOCR (first time may take 30-60s)...", file=sys.stderr, flush=True)
        _easyocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
        print("[anpr] EasyOCR ready", file=sys.stderr, flush=True)
        return _easyocr_reader
    except Exception as e:
        print(f"[anpr] EasyOCR unavailable: {e}", file=sys.stderr, flush=True)
        _easyocr_reader = False
        return None


def _get_plate_yolo():
    global _plate_yolo, _plate_yolo_tried
    if _plate_yolo_tried:
        return _plate_yolo
    _plate_yolo_tried = True
    if not PLATE_YOLO.exists():
        return None
    try:
        from ultralytics import YOLO
        _plate_yolo = YOLO(str(PLATE_YOLO))
        return _plate_yolo
    except Exception:
        return None


def _score_plate_text(text: str) -> float:
    t = plate_norm(text)
    if len(t) < 5 or len(t) > 12:
        return 0.0
    score = 0.3
    if INDIA_PLATE_RE.match(t):
        score += 0.5
    elif GENERIC_PLATE_RE.match(t):
        score += 0.25
    letters = sum(c.isalpha() for c in t)
    digits = sum(c.isdigit() for c in t)
    if letters >= 2 and digits >= 2:
        score += 0.15
    return min(score, 1.0)


def _upscale(img, min_w=220):
    h, w = img.shape[:2]
    if w >= min_w:
        return img
    scale = min_w / max(1, w)
    return cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def localize_plates_cv(bgr, max_candidates=4):
    if bgr is None or bgr.size == 0:
        return []
    H, W = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.bilateralFilter(gray, 9, 15, 15)
    rect = cv2.getStructuringElement(cv2.MORPH_RECT, (13, 5))
    blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, rect)
    thresh = cv2.adaptiveThreshold(
        blackhat, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, -2
    )
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, rect, iterations=1)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cands = []
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        if w < 40 or h < 12:
            continue
        ar = w / max(h, 1)
        if ar < 1.8 or ar > 7.5:
            continue
        area = w * h
        if area < 0.002 * H * W or area > 0.35 * H * W:
            continue
        cy = y + h / 2
        if cy < 0.30 * H:
            continue
        pad = int(0.08 * h)
        box = (max(0, x - pad), max(0, y - pad), min(W, x + w + pad), min(H, y + h + pad))
        cands.append((ar * (cy / H), box))
    cands.sort(key=lambda x: -x[0])
    # Always include lower band
    band = (int(0.12 * W), int(0.50 * H), int(0.88 * W), int(0.98 * H))
    boxes = [band] + [b for _, b in cands[:max_candidates]]
    return boxes[: max_candidates + 1]


def localize_plates_yolo(bgr):
    model = _get_plate_yolo()
    if model is None or bgr is None:
        return []
    try:
        res = model.predict(bgr, conf=0.25, verbose=False, imgsz=416)
    except Exception:
        return []
    boxes = []
    H, W = bgr.shape[:2]
    if not res or res[0].boxes is None:
        return boxes
    for b in res[0].boxes:
        x1, y1, x2, y2 = [int(v) for v in b.xyxy[0].tolist()]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(W, x2), min(H, y2)
        if x2 - x1 > 20 and y2 - y1 > 8:
            boxes.append((x1, y1, x2, y2))
    return boxes


def ocr_plate_roi(roi_bgr):
    if roi_bgr is None or roi_bgr.size == 0:
        return []
    roi = _upscale(roi_bgr, 220)
    results = []
    reader = _get_easyocr()
    if reader is not None:
        try:
            g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            g = cv2.equalizeHist(g)
            # Single variant only (speed)
            reads = reader.readtext(g, detail=1, paragraph=False)
            for _box, text, conf in reads:
                t = plate_norm(text)
                if len(t) >= 4:
                    results.append((t, float(conf) * _score_plate_text(t)))
        except Exception as e:
            print(f"[anpr] easyocr: {e}", file=sys.stderr, flush=True)

    if not results:
        try:
            import pytesseract
            from PIL import Image
            g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            if g.shape[1] < 180:
                g = cv2.resize(g, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
            cfg = "--oem 3 --psm 7 -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
            text = pytesseract.image_to_string(Image.fromarray(g), config=cfg)
            t = plate_norm(text)
            if len(t) >= 5:
                results.append((t, 0.4 * _score_plate_text(t)))
        except Exception:
            pass
    return results


def read_plate_from_vehicle(crop_bgr):
    if crop_bgr is None or crop_bgr.size == 0:
        return None, 0.0
    boxes = localize_plates_yolo(crop_bgr)[:2] + localize_plates_cv(crop_bgr, max_candidates=2)
    best_text, best_score = None, 0.0
    seen = set()
    for (x1, y1, x2, y2) in boxes[:4]:
        roi = crop_bgr[y1:y2, x1:x2]
        if roi.size == 0:
            continue
        for text, score in ocr_plate_roi(roi):
            if text in seen:
                continue
            seen.add(text)
            if score > best_score:
                best_text, best_score = text, score
        if best_score >= 0.55:
            break  # good enough - stop early
    if best_text and best_score >= 0.25:
        return best_text, float(best_score)
    return None, 0.0


def read_plates_from_crops(crops):
    """Use at most 2 best crops for speed."""
    votes = {}
    used = 0
    for crop in crops:
        if crop is None or used >= 2:
            continue
        used += 1
        text, score = read_plate_from_vehicle(crop)
        if not text:
            continue
        votes[text] = max(votes.get(text, 0.0), score) + 0.05
    if not votes:
        return None, 0.0
    best = max(votes.items(), key=lambda x: x[1])
    return best[0], float(best[1])
