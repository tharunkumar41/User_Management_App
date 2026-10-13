#!/usr/bin/env python3
"""
Vehicle Identification (v2)

What changed vs v1
------------------
* Every physical vehicle is reported ONCE (simple multi-frame tracker) instead of once per
  sampled frame, so counts are no longer inflated 5-10x.
* Type / colour are decided by voting over all frames of a vehicle, not guessed per frame.
* car/truck/bus duplicates on the same box are merged first (class-agnostic NMS); "truck"/"bus"
  is only reported with strong evidence (the COCO model calls many hatchbacks "truck").
* Auto-rickshaw detection uses colour composition (green body + yellow/orange roof) in
  addition to box shape; works even when the detector says bus/truck.
* Colour uses the body region (below the windshield) and a soft colour distribution, with
  white / gray / black handled separately from real hues.
* Number plate: the plate is localised first, then OCR'd, then validated against plate
  formats. Garbage strings are no longer returned.
* Brand: OCR runs only on crops large enough to be readable, matches whole words / known
  model names with a confidence floor (v1 matched "ram", "kia" inside random OCR noise).
* Reference-photo matching no longer uses a FACE embedder. It uses an image embedder if
  ml_models/image_embedder.tflite exists, otherwise colour + shape similarity.
* Detection also runs on overlapping square tiles of wide frames (the detector input is
  only 320x320, so distant vehicles in 1080p were being missed).

CLI (unchanged):
  vehicle_identification.py <video> [color] [type] [number] [brand] [photo] [max_frames]
"""
import sys
import json
import re
import os
from pathlib import Path
from collections import defaultdict

import cv2
try:
    import anpr as _anpr
except ImportError:
    _anpr = None
try:
    import vehicle_attrs as _vattrs
except ImportError:
    _vattrs = None

import numpy as np
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

MODELS_DIR = Path(__file__).resolve().parent.parent / "ml_models"
OBJ_MODEL = str(MODELS_DIR / "efficientdet_lite0.tflite")
IMG_EMBED_MODEL = MODELS_DIR / "image_embedder.tflite"  # optional (MobileNetV3 embedder)

FOUR_WHEEL = {"car", "truck", "bus"}
TWO_WHEEL = {"motorcycle", "bicycle"}
VEHICLE_LABELS = FOUR_WHEEL | TWO_WHEEL

# Per-class floor for a *single* detection. Tracks (>= MIN_HITS sightings) clean up the rest.
MIN_SCORE = {"car": 0.38, "truck": 0.50, "bus": 0.50, "motorcycle": 0.45, "bicycle": 0.55}
# COCO "truck"/"bus" are over-predicted on small cars -> prior < 1
CLASS_PRIOR = {"car": 1.0, "truck": 0.70, "bus": 0.80, "motorcycle": 1.0, "bicycle": 1.0}

MIN_HITS = 2          # a vehicle must be seen in >= 2 sampled frames (unless video is tiny)
TARGET_FPS = 6        # sampling rate when max_frames allows it
STRICT_PLATE = os.environ.get("PLATE_STRICT", "1") != "0"
DEBUG_DIR = os.environ.get("VEHICLE_DEBUG_DIR")  # set to a folder to dump frames with track ids

BRANDS = [
    "toyota", "honda", "ford", "chevrolet", "bmw", "mercedes", "audi", "volkswagen",
    "hyundai", "kia", "nissan", "mazda", "subaru", "lexus", "jeep", "dodge", "tesla",
    "volvo", "porsche", "jaguar", "ferrari", "suzuki", "mitsubishi", "tata", "mahindra",
    "maruti", "bajaj", "yamaha", "kawasaki", "ducati", "harley", "enfield", "scania",
    "leyland", "renault", "skoda", "datsun", "isuzu", "force",
]
# Model badges (usually printed on the rear) -> brand. Extend freely.
MODEL_TO_BRAND = {
    "swift": "Maruti Suzuki", "dzire": "Maruti Suzuki", "alto": "Maruti Suzuki",
    "baleno": "Maruti Suzuki", "ertiga": "Maruti Suzuki", "wagonr": "Maruti Suzuki",
    "celerio": "Maruti Suzuki", "brezza": "Maruti Suzuki", "ciaz": "Maruti Suzuki",
    "creta": "Hyundai", "verna": "Hyundai", "venue": "Hyundai", "santro": "Hyundai",
    "i10": "Hyundai", "i20": "Hyundai", "grand": None, "seltos": "Kia", "sonet": "Kia",
    "innova": "Toyota", "fortuner": "Toyota", "etios": "Toyota", "corolla": "Toyota",
    "city": "Honda", "amaze": "Honda", "jazz": "Honda", "civic": "Honda",
    "nexon": "Tata", "harrier": "Tata", "safari": "Tata", "tiago": "Tata", "punch": "Tata",
    "indica": "Tata", "nano": "Tata", "bolero": "Mahindra", "scorpio": "Mahindra",
    "thar": "Mahindra", "xuv": "Mahindra", "kwid": "Renault", "duster": "Renault",
    "polo": "Volkswagen", "vento": "Volkswagen", "fiesta": "Ford", "ecosport": "Ford",
    "endeavour": "Ford", "eon": "Hyundai", "ritz": "Maruti Suzuki", "zen": "Maruti Suzuki",
}
BRAND_DISPLAY = {
    "bmw": "BMW", "vw": "Volkswagen", "mercedes": "Mercedes-Benz", "enfield": "Royal Enfield",
    "leyland": "Ashok Leyland", "maruti": "Maruti Suzuki", "harley": "Harley-Davidson",
}

try:
    import pytesseract
    _OCR_OK = True
    if sys.platform == "win32":
        for _c in [
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Tesseract-OCR\tesseract.exe"),
        ]:
            if os.path.isfile(_c):
                pytesseract.pytesseract.tesseract_cmd = _c
                break
    pytesseract.get_tesseract_version()
except Exception as _e:  # pytesseract missing OR tesseract binary missing
    _OCR_OK = False
    print(f"OCR disabled: {_e}", file=sys.stderr, flush=True)


def progress(pct):
    print(f"PROGRESS:{int(pct)}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- geometry
def iou(a, b):
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    iw = max(0, min(ax2, bx2) - max(a["x"], b["x"]))
    ih = max(0, min(ay2, by2) - max(a["y"], b["y"]))
    inter = iw * ih
    if inter <= 0:
        return 0.0
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def containment(small, big):
    """Fraction of `small` that lies inside `big`."""
    iw = max(0, min(small["x"] + small["w"], big["x"] + big["w"]) - max(small["x"], big["x"]))
    ih = max(0, min(small["y"] + small["h"], big["y"] + big["h"]) - max(small["y"], big["y"]))
    return (iw * ih) / max(1, small["w"] * small["h"])


def center(b):
    return (b["x"] + b["w"] / 2.0, b["y"] + b["h"] / 2.0)


def is_plausible_box(family, bbox, fw, fh):
    w, h = bbox["w"], bbox["h"]
    if w < 40 or h < 30:
        return False
    ratio = (w * h) / max(1, fw * fh)
    if ratio < 0.004 or ratio > 0.92:
        return False
    ar = w / max(h, 1)
    if family == "four":
        return 0.55 <= ar <= 4.5
    return 0.25 <= ar <= 3.5


# --------------------------------------------------------------------------- detection
def make_detector():
    opts = vision.ObjectDetectorOptions(
        base_options=python.BaseOptions(model_asset_path=OBJ_MODEL),
        running_mode=vision.RunningMode.IMAGE,
        score_threshold=0.30,
        max_results=25,
        category_allowlist=sorted(VEHICLE_LABELS),
    )
    return vision.ObjectDetector.create_from_options(opts)


def _windows(fw, fh):
    wins = [(0, 0, fw, fh)]
    if fw > fh * 1.3:                      # wide frame -> add overlapping square tiles
        side = fh
        for x in np.linspace(0, fw - side, 3).astype(int):
            wins.append((int(x), 0, side, side))
    elif fh > fw * 1.3:                    # tall (phone portrait) frame
        side = fw
        for y in np.linspace(0, fh - side, 3).astype(int):
            wins.append((0, int(y), side, side))
    return wins


def raw_detect(detector, frame):
    fh, fw = frame.shape[:2]
    out = []
    for wi, (wx, wy, ww, wh) in enumerate(_windows(fw, fh)):
        sub = np.ascontiguousarray(cv2.cvtColor(frame[wy:wy + wh, wx:wx + ww], cv2.COLOR_BGR2RGB))
        res = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=sub))
        for det in res.detections or []:
            if not det.categories:
                continue
            cat = det.categories[0]
            label = (cat.category_name or "").lower()
            if label not in VEHICLE_LABELS:
                continue
            bb = det.bounding_box
            x1, y1 = bb.origin_x + wx, bb.origin_y + wy
            x2, y2 = x1 + bb.width, y1 + bb.height
            if wi > 0:  # tile: drop boxes cut by an *interior* tile edge (partial vehicles)
                m = 3
                if (bb.origin_x <= m and wx > 0) or (bb.origin_x + bb.width >= ww - m and wx + ww < fw):
                    continue
                if (bb.origin_y <= m and wy > 0) or (bb.origin_y + bb.height >= wh - m and wy + wh < fh):
                    continue
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(fw, x2), min(fh, y2)
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            out.append({"cls": label, "score": float(cat.score),
                        "bbox": {"x": int(x1), "y": int(y1), "w": int(x2 - x1), "h": int(y2 - y1)}})
    return out


def merge_detections(dets):
    """Class-agnostic NMS inside a family; keep per-class scores of the merged box."""
    groups = []
    for d in sorted(dets, key=lambda x: -x["score"]):
        fam = "four" if d["cls"] in FOUR_WHEEL else "two"
        placed = False
        for g in groups:
            if g["family"] != fam:
                continue
            ov = iou(d["bbox"], g["bbox"])
            if ov >= 0.5 or containment(d["bbox"], g["bbox"]) >= 0.9:
                g["cls_scores"][d["cls"]] = max(g["cls_scores"].get(d["cls"], 0), d["score"])
                placed = True
                break
        if not placed:
            groups.append({"family": fam, "bbox": d["bbox"], "score": d["score"],
                           "cls_scores": {d["cls"]: d["score"]}})
    return groups


# --------------------------------------------------------------------------- appearance
def body_region(bgr):
    """Region below the windshield: hood / door / bumper (best place to read paint colour)."""
    h, w = bgr.shape[:2]
    roi = bgr[int(h * 0.42):int(h * 0.84), int(w * 0.15):int(w * 0.85)]
    return roi if roi.size else bgr


def _soft_achromatic(v_med):
    """White / gray / black membership from median brightness, blended near the boundaries."""
    def ramp(x, lo, hi):
        return float(np.clip((x - lo) / float(hi - lo), 0.0, 1.0))
    white = ramp(v_med, 150, 180)
    black = 1.0 - ramp(v_med, 80, 110)
    gray = max(0.0, 1.0 - white - black)
    tot = (white + gray + black) or 1.0
    return {"white": white / tot, "gray": gray / tot, "black": black / tot}


def color_distribution(bgr):
    """Soft distribution over colour names for one crop.

    Vivid colours (red/green/blue...) win when they clearly cover the body region; otherwise the
    median brightness decides white vs gray(silver) vs black, which is far more stable than
    counting pixels (dark grille/tyres/glass are present on every car).
    """
    roi = body_region(bgr)
    if roi.shape[1] > 120:
        s = 120.0 / roi.shape[1]
        roi = cv2.resize(roi, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0].astype(int), hsv[..., 1].astype(int), hsv[..., 2].astype(int)
    spec = (V > 248) & (S < 30)                       # glare
    valid = ~spec
    n = max(1, int(valid.sum()))
    chrom = (S >= 75) & (V >= 70) & valid
    hue = {
        "red": ((H <= 8) | (H >= 170)), "orange": (H >= 9) & (H <= 20),
        "yellow": (H >= 21) & (H <= 34), "green": (H >= 35) & (H <= 85),
        "blue": (H >= 86) & (H <= 130), "purple": (H >= 131) & (H <= 169),
    }
    chroma = {}
    for name, m in hue.items():
        sel = chrom & m
        if name == "orange":
            brown = int((sel & (V < 140)).sum())
            chroma["brown"] = brown / n
            chroma["orange"] = (int(sel.sum()) - brown) / n
        else:
            chroma[name] = int(sel.sum()) / n
    warm = int(((H >= 5) & (H <= 32) & (S >= 16) & (S < 75) & (V >= 70) & valid).sum()) / n
    top_name = max(chroma, key=chroma.get)
    dist = {}
    if chroma[top_name] >= 0.25:                       # clearly coloured body
        dist[top_name] = chroma[top_name]
        rest = 1.0 - chroma[top_name]
        for k, v in chroma.items():
            if k != top_name and v > 0.02:
                dist[k] = v
        vm = float(np.median(V[valid])) if valid.any() else 128.0
        for k, v in _soft_achromatic(vm).items():
            dist[k] = dist.get(k, 0.0) + rest * v * 0.5
    elif warm >= 0.40 and 70 <= float(np.median(V[valid])) <= 205:   # champagne / beige / tan
        dist["beige"] = warm
        vm = float(np.median(V[valid]))
        for k, v in _soft_achromatic(vm).items():
            dist[k] = dist.get(k, 0.0) + (1.0 - warm) * v * 0.5
    else:
        vm = float(np.median(V[valid])) if valid.any() else 128.0
        ach = _soft_achromatic(vm)
        c_tot = sum(chroma.values())
        for k, v in ach.items():
            dist[k] = v * (1.0 - c_tot)
        for k, v in chroma.items():
            if v > 0.02:
                dist[k] = v
    tot = sum(dist.values()) or 1.0
    return {k: v / tot for k, v in dist.items() if v / tot > 0.005}


def auto_signal(bgr, bbox):
    """Delhi-style CNG auto-rickshaw: green lower body + yellow/orange canopy, compact box."""
    h, w = bgr.shape[:2]
    if h < 40 or w < 40:
        return False
    ar = bbox["w"] / max(1, bbox["h"])
    if not (0.6 <= ar <= 1.5):
        return False
    hsv = cv2.cvtColor(cv2.resize(bgr, (96, 96)), cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    green = ((H >= 38) & (H <= 85) & (S >= 90) & (V >= 50)).mean()
    yellow = ((H >= 12) & (H <= 38) & (S >= 80) & (V >= 80)).mean()
    return bool(green >= 0.12 and yellow >= 0.05)


def track_hist(bgr):
    hsv = cv2.cvtColor(cv2.resize(bgr, (64, 64)), cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4], [0, 180, 0, 256, 0, 256])
    return cv2.normalize(hist, hist).flatten().astype(np.float32)


def sharpness(bgr):
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


# --------------------------------------------------------------------------- tracking
class Track:
    _next = 1

    def __init__(self):
        self.id = Track._next
        Track._next += 1
        self.obs = []

    @property
    def last(self):
        return self.obs[-1]

    def predicted_bbox(self, sample_i):
        last = self.last
        gap = sample_i - last["sample_i"]
        b = dict(last["bbox"])
        if len(self.obs) >= 2:
            prev = self.obs[-2]
            dt = max(1, last["sample_i"] - prev["sample_i"])
            (cx1, cy1), (cx0, cy0) = center(last["bbox"]), center(prev["bbox"])
            b["x"] = int(b["x"] + (cx1 - cx0) / dt * gap)
            b["y"] = int(b["y"] + (cy1 - cy0) / dt * gap)
        return b


def color_overlap(a, b):
    return sum(min(a.get(k, 0.0), b.get(k, 0.0)) for k in set(a) | set(b))


def track_color(t, last_n=5):
    agg = defaultdict(float)
    obs = t.obs[-last_n:]
    for o in obs:
        for k, v in o["color_dist"].items():
            agg[k] += v / len(obs)
    return agg


def associate(tracks, dets, sample_i, max_gap=3):
    pairs = []
    for ti, t in enumerate(tracks):
        if sample_i - t.last["sample_i"] > max_gap:
            continue
        pred = t.predicted_bbox(sample_i)
        tcol = track_color(t)
        for di, d in enumerate(dets):
            if d["family"] != t.last["family"]:
                continue
            ov = max(iou(pred, d["bbox"]), iou(t.last["bbox"], d["bbox"]))
            (px, py), (dx, dy) = center(pred), center(d["bbox"])
            diag = max(1.0, max(np.hypot(pred["w"], pred["h"]), np.hypot(d["bbox"]["w"], d["bbox"]["h"])))
            cd = np.hypot(px - dx, py - dy) / diag
            hs = float(cv2.compareHist(t.last["hist"], d["hist"], cv2.HISTCMP_CORREL))
            if ov < 0.10 and cd > 0.55:
                continue
            if hs < 0.30 and ov < 0.5:
                continue
            # a white car must never inherit a dark car's track (paint colour doesn't change)
            if color_overlap(tcol, d["color_dist"]) < 0.35 and ov < 0.75:
                continue
            sc = 0.5 * ov + 0.3 * (1 - min(cd, 1.0)) + 0.2 * max(hs, 0.0)
            pairs.append((sc, ti, di))
    pairs.sort(reverse=True)
    used_t, used_d, out = set(), set(), []
    for sc, ti, di in pairs:
        if ti in used_t or di in used_d or sc < 0.25:
            continue
        used_t.add(ti)
        used_d.add(di)
        out.append((ti, di))
    return out, used_d


# --------------------------------------------------------------------------- plate OCR
_PLATE_IN = re.compile(r"^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$")          # DL2CAW3266, TN30AB1234
_PLATE_BH = re.compile(r"^\d{2}BH\d{4}[A-Z]{1,2}$")                  # 22BH1234AA
_STATE_CODES = {  # RTO state / UT prefixes, used to reject OCR noise
    "AN", "AP", "AR", "AS", "BR", "CH", "CG", "DD", "DL", "DN", "GA", "GJ", "HP", "HR", "JH", "JK",
    "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK",
    "TN", "TR", "TS", "UK", "UP", "WB",
}
_TO_DIGIT = {"O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2", "S": "5", "B": "8", "G": "6", "T": "7"}
_TO_ALPHA = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G"}


def _coerce_indian(text):
    """Fix position-dependent OCR confusions for AA NN [A-Z]{1,3} NNNN plates."""
    t = re.sub(r"[^A-Z0-9]", "", text.upper())
    for n_series in (2, 1, 3):
        for n_dist in (2, 1):
            length = 2 + n_dist + n_series + 4
            if len(t) < length:
                continue
            for start in range(0, len(t) - length + 1):
                s = t[start:start + length]
                cand = []
                for i, ch in enumerate(s):
                    if i < 2:
                        cand.append(_TO_ALPHA.get(ch, ch))
                    elif i < 2 + n_dist:
                        cand.append(_TO_DIGIT.get(ch, ch))
                    elif i < 2 + n_dist + n_series:
                        cand.append(_TO_ALPHA.get(ch, ch))
                    else:
                        cand.append(_TO_DIGIT.get(ch, ch))
                c = "".join(cand)
                if _PLATE_IN.match(c) and c[:2] in _STATE_CODES:
                    return c
    if _PLATE_BH.match(t):
        return t
    return None


def plate_candidates_bright(bgr):
    """Plates are light (white/yellow) rectangles on the lower-middle of the vehicle."""
    h, w = bgr.shape[:2]
    zone = bgr[int(h * 0.45):, int(w * 0.12):int(w * 0.88)]
    if zone.size == 0:
        return []
    scale = min(4.0, max(1.0, 500.0 / zone.shape[1]))
    z = cv2.resize(zone, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale > 1 else zone
    hsv = cv2.cvtColor(z, cv2.COLOR_BGR2HSV)
    Hh, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    thr = max(120, np.percentile(V, 92) * 0.8)
    mask = (((V >= thr) & (S < 70)) | ((Hh >= 15) & (Hh <= 35) & (S >= 100) & (V >= 110))).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, int(z.shape[1] * 0.03)), 5)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3)))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    gray = cv2.cvtColor(z, cv2.COLOR_BGR2GRAY)
    edges = cv2.convertScaleAbs(cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3))
    H, W = z.shape[:2]
    cands = []
    for c in cnts:
        x, y, cw, ch = cv2.boundingRect(c)
        if ch < 14 or not (0.12 * W <= cw <= 0.70 * W) or not (2.0 <= cw / ch <= 6.5):
            continue
        fill = cv2.contourArea(c) / float(cw * ch)
        if fill < 0.55:
            continue
        cands.append((fill * float(edges[y:y + ch, x:x + cw].mean()), (x, y, cw, ch)))
    cands.sort(reverse=True)
    out = []
    for _, (x, y, cw, ch) in cands[:2]:
        px, py = int(cw * 0.03), int(ch * 0.10)
        out.append(z[max(0, y - py):min(H, y + ch + py), max(0, x - px):min(W, x + cw + px)])
    return out


def plate_candidates(bgr):
    h, w = bgr.shape[:2]
    scale = min(3.0, max(1.0, 480.0 / max(w, 1)))
    img = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC) if scale > 1 else bgr
    H, W = img.shape[:2]
    gray = cv2.bilateralFilter(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 9, 50, 50)
    sob = cv2.convertScaleAbs(cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3))
    _, th = cv2.threshold(sob, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, int(W * 0.06)), 5))
    closed = cv2.morphologyEx(th, cv2.MORPH_CLOSE, k)
    closed = cv2.erode(closed, None, iterations=1)
    closed = cv2.dilate(closed, None, iterations=2)
    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cands = []
    for c in cnts:
        x, y, cw, ch = cv2.boundingRect(c)
        if ch < 14 or cw < 50:
            continue
        ar = cw / ch
        if not (2.0 <= ar <= 6.8):
            continue
        if not (0.08 * W <= cw <= 0.75 * W):
            continue
        if (y + ch / 2) < 0.35 * H:                      # plates sit in the lower part
            continue
        fill = cv2.contourArea(c) / float(cw * ch)
        cands.append((fill * cw * ch, (x, y, cw, ch)))
    cands.sort(reverse=True)
    out = plate_candidates_bright(bgr)
    for _, (x, y, cw, ch) in cands[:1]:
        px, py = int(cw * 0.04), int(ch * 0.12)
        out.append(img[max(0, y - py):min(H, y + ch + py), max(0, x - px):min(W, x + cw + px)])
    return out


def _ocr_plate_img(roi):
    g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, None, fx=80.0 / max(g.shape[0], 1), fy=80.0 / max(g.shape[0], 1), interpolation=cv2.INTER_CUBIC)
    g = cv2.createCLAHE(2.0, (4, 4)).apply(g)
    texts = []
    for variant in (cv2.threshold(g, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)[1],
                    cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 25, 8)):
        if variant.mean() < 110:      # white-on-dark -> invert
            variant = 255 - variant
        variant = cv2.copyMakeBorder(variant, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
        for psm in (7,):
            cfg = f"--oem 3 --psm {psm} -c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
            try:
                texts.append(pytesseract.image_to_string(variant, config=cfg))
            except Exception:
                pass
    return texts



# Optional EasyOCR - much better than Tesseract on real plates when installed
_easyocr_reader = None

def _get_easyocr():
    global _easyocr_reader
    if _easyocr_reader is False:
        return None
    if _easyocr_reader is not None:
        return _easyocr_reader
    try:
        import easyocr
        _easyocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
        return _easyocr_reader
    except Exception as e:
        print(f"EasyOCR unavailable: {e}", file=sys.stderr, flush=True)
        _easyocr_reader = False
        return None


def read_plate_easyocr(crops):
    reader = _get_easyocr()
    if reader is None:
        return None
    best, best_score = None, 0.0
    for crop in crops:
        if crop is None or crop.size == 0:
            continue
        h, w = crop.shape[:2]
        # focus lower half (where plates usually are)
        roi = crop[int(h * 0.45):, :]
        if roi.size == 0:
            roi = crop
        if min(roi.shape[:2]) < 20:
            continue
        # upscale small plates
        if roi.shape[1] < 200:
            scale = 200 / max(1, roi.shape[1])
            roi = cv2.resize(roi, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        try:
            results = reader.readtext(roi, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", detail=1)
        except Exception:
            try:
                results = reader.readtext(roi, detail=1)
            except Exception:
                continue
        for (_bbox, text, conf) in results:
            cand = plate_norm(text)
            if 5 <= len(cand) <= 12 and conf > best_score:
                best, best_score = cand, float(conf)
    return best if best_score >= 0.25 else None

def read_plate(crops):
    """Return (plate, valid) from best crops, voting over all OCR variants."""
    if not _OCR_OK:
        return None
    votes = defaultdict(int)
    generic = defaultdict(int)
    for crop in crops[:2]:
        if crop.shape[1] < 150:       # too small to hold a legible plate
            continue
        if votes and max(votes.values()) >= 2:   # already confident
            break
        for roi in plate_candidates(crop):
            for raw in _ocr_plate_img(roi):
                clean = re.sub(r"[^A-Z0-9]", "", raw.upper())
                p = _coerce_indian(clean)
                if p:
                    votes[p] += 1
                elif 6 <= len(clean) <= 11 and re.search(r"[A-Z]", clean) and len(re.findall(r"\d", clean)) >= 3:
                    generic[clean] += 1
    if votes:
        return max(votes.items(), key=lambda kv: kv[1])[0]
    if not STRICT_PLATE and generic:
        return max(generic.items(), key=lambda kv: kv[1])[0]
    return None


# --------------------------------------------------------------------------- brand OCR
def _lev1(a, b):
    """True when edit distance <= 1."""
    if abs(len(a) - len(b)) > 1:
        return False
    if a == b:
        return True
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) <= 1
    if len(a) > len(b):
        a, b = b, a
    for i in range(len(b)):
        if b[:i] + b[i + 1:] == a:
            return True
    return False


def read_brand(crops):
    """
    Brand from badge/grille text (EasyOCR preferred, Tesseract fallback).
    Looks at upper-front of vehicle crop where logos/names usually are.
    """
    hits = defaultdict(float)
    display = {b: BRAND_DISPLAY.get(b, b.title()) for b in BRANDS}
    # also map common spellings
    aliases = {
        "vw": "volkswagen", "chevy": "chevrolet", "benz": "mercedes",
        "mercedesbenz": "mercedes", "marutisuzuki": "maruti", "maruti": "maruti",
        "royal enfield": "enfield", "royalenfield": "enfield", "hero": "hero",
        "ashokleyland": "leyland", "leyland": "leyland",
    }

    def consider(text, conf):
        raw = (text or "").lower()
        tok = re.sub(r"[^a-z0-9]", "", raw)
        if len(tok) < 3:
            return
        # multi-word brands in full line
        line = re.sub(r"[^a-z0-9\s]", " ", raw)
        for phrase, canon in [("royal enfield", "enfield"), ("mercedes benz", "mercedes"),
                              ("land rover", "jaguar"), ("range rover", "jaguar")]:
            if phrase in line:
                hits[display.get(canon, canon.title())] += conf
                return
        if tok in aliases:
            b = aliases[tok]
            hits[display.get(b, b.title())] += conf
            return
        if tok in MODEL_TO_BRAND and MODEL_TO_BRAND[tok]:
            hits[MODEL_TO_BRAND[tok]] += conf
            return
        for b in BRANDS:
            if tok == b or (len(b) >= 4 and b in tok) or (len(tok) >= 4 and tok in b):
                hits[display.get(b, b.title())] += conf
                return
            if len(b) >= 5 and len(tok) >= 5 and _lev1(tok, b) and conf >= 0.5:
                hits[display.get(b, b.title())] += conf * 0.8
                return

    for crop in (crops or [])[:3]:
        if crop is None or getattr(crop, "size", 0) == 0:
            continue
        h, w = crop.shape[:2]
        if w < 80:
            continue
        # Badge / emblem regions: upper third, center front, grille band
        rois = [
            crop[0:int(h * 0.40), int(w * 0.15):int(w * 0.85)],           # upper body
            crop[int(h * 0.15):int(h * 0.45), int(w * 0.25):int(w * 0.75)],  # grille/center
            crop[0:int(h * 0.25), :],                                       # very top (badge)
        ]
        for roi in rois:
            if roi is None or roi.size == 0 or min(roi.shape[:2]) < 20:
                continue
            # upscale
            if roi.shape[1] < 300:
                sc = 300.0 / roi.shape[1]
                roi = cv2.resize(roi, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
            # EasyOCR
            try:
                import anpr as _anpr_mod
                reader = _anpr_mod._get_easyocr() if hasattr(_anpr_mod, "_get_easyocr") else None
            except Exception:
                reader = None
            if reader is not None:
                try:
                    g = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
                    for (_box, text, conf) in reader.readtext(g, detail=1, paragraph=False):
                        consider(text, float(conf))
                except Exception:
                    pass
            # Tesseract fallback
            if _OCR_OK:
                try:
                    g = cv2.createCLAHE(2.0, (8, 8)).apply(cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY))
                    data = pytesseract.image_to_data(
                        g, config="--oem 3 --psm 11", output_type=pytesseract.Output.DICT
                    )
                    for txt, conf in zip(data["text"], data["conf"]):
                        try:
                            conf = float(conf)
                        except Exception:
                            continue
                        if conf < 50:
                            continue
                        consider(txt, conf / 100.0)
                except Exception:
                    pass

    if not hits:
        return None
    best, score = max(hits.items(), key=lambda kv: kv[1])
    return best if score >= 0.35 else None


# --------------------------------------------------------------------------- photo match
def make_embedder():
    if not IMG_EMBED_MODEL.exists():
        return None
    try:
        return vision.ImageEmbedder.create_from_options(vision.ImageEmbedderOptions(
            base_options=python.BaseOptions(model_asset_path=str(IMG_EMBED_MODEL)),
            running_mode=vision.RunningMode.IMAGE, l2_normalize=True))
    except Exception as e:
        print(f"image embedder disabled: {e}", file=sys.stderr, flush=True)
        return None


def _embed(embedder, bgr):
    rgb = np.ascontiguousarray(cv2.cvtColor(cv2.resize(bgr, (224, 224)), cv2.COLOR_BGR2RGB))
    res = embedder.embed(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    return np.asarray(res.embeddings[0].embedding, dtype=np.float32) if res.embeddings else None


def _descriptor(bgr):
    roi = body_region(bgr)
    hsv = cv2.cvtColor(cv2.resize(roi, (64, 48)), cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [12, 6, 6], [0, 180, 0, 256, 0, 256])
    hist = cv2.normalize(hist, hist, norm_type=cv2.NORM_L1).flatten().astype(np.float32)
    return hist, color_distribution(bgr)


def photo_similarity(q, c, q_is_emb=False):
    if q_is_emb:
        qa, ca = q, c
        if qa is None or ca is None:
            return None
        return float(np.dot(qa, ca) / (np.linalg.norm(qa) * np.linalg.norm(ca) + 1e-9))
    qh, qd = q
    ch, cd = c
    bc = float(np.sum(np.sqrt(qh * ch)))                       # Bhattacharyya coefficient 0..1
    names = set(qd) | set(cd)
    cs = sum(min(qd.get(k, 0), cd.get(k, 0)) for k in names)   # colour-name overlap 0..1
    return round(0.5 * bc + 0.5 * cs, 4)


def query_crop(detector, photo_bgr):
    """If the reference photo contains a vehicle, use only that vehicle."""
    try:
        gs = merge_detections(raw_detect(detector, photo_bgr))
        gs = [g for g in gs if g["score"] >= 0.4]
        if gs:
            g = max(gs, key=lambda g: g["bbox"]["w"] * g["bbox"]["h"])
            b = g["bbox"]
            return photo_bgr[b["y"]:b["y"] + b["h"], b["x"]:b["x"] + b["w"]]
    except Exception:
        pass
    return photo_bgr


# --------------------------------------------------------------------------- track summary
COLOR_ALIASES = {"grey": "gray", "silver": "gray", "gold": "beige", "golden": "beige", "champagne": "beige",
                 "tan": "beige", "cream": "beige", "maroon": "red", "cyan": "blue", "dark": "black"}



def plate_norm(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


# OCR often confuses these pairs
_OCR_CONFUSION = {
    "0": "O", "O": "0",
    "1": "I", "I": "1", "L": "1",
    "2": "Z", "Z": "2",
    "5": "S", "S": "5",
    "8": "B", "B": "8",
    "6": "G", "G": "6",
    "D": "0",  # sometimes
}


def _chars_eq(a, b):
    if a == b:
        return True
    return _OCR_CONFUSION.get(a) == b or _OCR_CONFUSION.get(b) == a


def plate_similarity(detected, query):
    """0..1 similarity tolerant to OCR confusions and length skew."""
    d, q = plate_norm(detected), plate_norm(query)
    if not q or not d:
        return 0.0
    if q == d:
        return 1.0
    if q in d or d in q:
        return 0.92

    # Align on the longer string with sliding window
    if len(d) < len(q):
        d, q = q, d  # ensure d is longer or equal for window? better try both
        d, q = plate_norm(detected), plate_norm(query)

    def score_pair(a, b):
        # a,b same length preferred
        if not a or not b:
            return 0.0
        if len(a) == len(b):
            ok = sum(1 for x, y in zip(a, b) if _chars_eq(x, y))
            return ok / len(a)
        # sliding window of shorter inside longer
        short, long = (a, b) if len(a) <= len(b) else (b, a)
        best = 0.0
        for i in range(len(long) - len(short) + 1):
            window = long[i:i + len(short)]
            ok = sum(1 for x, y in zip(short, window) if _chars_eq(x, y))
            best = max(best, ok / len(short))
        # length penalty
        pen = abs(len(a) - len(b)) / max(len(a), len(b))
        return best * (1.0 - 0.15 * pen)

    s1 = score_pair(d, q)
    # also compare last N digits/letters (state code prefix often OCR-wrong)
    if len(q) >= 4 and len(d) >= 4:
        s1 = max(s1, score_pair(d[-4:], q[-4:]) * 0.9)
        s1 = max(s1, score_pair(d[-6:], q[-6:]) * 0.95 if len(q) >= 6 and len(d) >= 6 else 0)
    return s1


def plate_match(detected, query, threshold=0.75):
    """Match plate with OCR-tolerant similarity (default >= 75%)."""
    q = plate_norm(query)
    if not q:
        return True
    d = plate_norm(detected)
    if not d:
        return False
    return plate_similarity(d, q) >= threshold


TYPE_ALIASES = {
    "car": {"car"},
    "cars": {"car"},
    "sedan": {"car"},
    "hatchback": {"car"},
    "suv": {"car", "truck"},
    "jeep": {"car", "truck"},
    "van": {"car", "truck", "bus"},
    "truck": {"truck"},
    "lorry": {"truck"},
    "pickup": {"truck", "car"},
    "bus": {"bus"},
    "motorcycle": {"motorcycle"},
    "bike": {"motorcycle", "bicycle"},
    "motorbike": {"motorcycle"},
    "scooter": {"motorcycle"},
    "bicycle": {"bicycle"},
    "cycle": {"bicycle"},
    "auto": {"motorcycle", "car"},  # heuristic class may be car/motorcycle
    "auto-rickshaw": {"motorcycle", "car"},
    "three-wheeler": {"motorcycle", "car"},
}


def type_match(detected, query):
    q = (query or "").strip().lower()
    d = (detected or "").strip().lower()
    if not q:
        return True
    if not d:
        return False
    if q == d or q in d or d in q:
        return True
    allowed = TYPE_ALIASES.get(q, {q})
    return d in allowed


def brand_match(detected, query):
    q = (query or "").strip().lower()
    d = (detected or "").strip().lower()
    if not q:
        return True
    if not d:
        return False
    if q in d or d in q:
        return True
    # common short forms
    aliases = {
        "vw": "volkswagen", "chevy": "chevrolet", "benz": "mercedes",
        "mercedes-benz": "mercedes", "maruti": "suzuki", "hero": "hero",
    }
    q2 = aliases.get(q, q)
    d2 = aliases.get(d, d)
    return q2 in d2 or d2 in q2


def color_match(vehicle, query):
    """STRICT: primary paint color only. Candidates are never enough for a match."""
    q = norm_color(query)
    if not q:
        return True
    for token in q.replace("-", " ").split():
        token = norm_color(token)
        if token in {"red", "blue", "green", "yellow", "orange", "white", "black",
                     "gray", "grey", "brown", "purple", "silver", "maroon"}:
            q = "red" if token == "maroon" else ("gray" if token == "grey" else token)
            break
    primary = norm_color(vehicle.get("color") or "")
    if not primary or primary == "unknown":
        return False
    if primary == q:
        return True
    # tight synonyms only
    if q in {"gray", "grey", "silver"} and primary in {"gray", "grey", "silver"}:
        return True
    if q == "white" and primary == "white":
        return True
    if q == "black" and primary == "black":
        return True
    return False


def passes_filters(v, filter_color, filter_type, filter_number, filter_brand,
                   apply_plate=True, apply_brand=True):
    """ALL non-empty filters must match (AND)."""
    if filter_color and not color_match(v, filter_color):
        return False
    if filter_type and not type_match(v.get("type"), filter_type):
        return False
    if filter_number:
        if apply_plate:
            if not plate_match(v.get("number_plate"), filter_number):
                return False
        # if apply_plate is False (no OCR anywhere), skip plate criterion
    if filter_brand:
        if apply_brand:
            if not brand_match(v.get("brand"), filter_brand):
                return False
    return True


def norm_color(c):
    c = (c or "").strip().lower()
    return COLOR_ALIASES.get(c, c)


def fit_size_model(tracks):
    """height ~ a*bottom_y + b for four-wheelers: lets us tell 'bigger than a car at this distance'."""
    xs, ys = [], []
    for t in tracks:
        for o in t.obs:
            if o["family"] == "four":
                xs.append(o["bbox"]["y"] + o["bbox"]["h"])
                ys.append(o["bbox"]["h"])
    if len(xs) < 40:
        return None
    xs, ys = np.array(xs, float), np.array(ys, float)
    keep = np.ones(len(xs), bool)
    for _ in range(3):
        a, b = np.polyfit(xs[keep], ys[keep], 1)
        res = ys - (a * xs + b)
        sd = res[keep].std() or 1.0
        keep = np.abs(res) <= 1.5 * sd
        if keep.sum() < 20:
            return None
    if a <= 0:
        return None
    return (a, b)


def size_ratio(obs, model):
    if model is None:
        return None
    a, b = model
    r = [o["bbox"]["h"] / max(8.0, a * (o["bbox"]["y"] + o["bbox"]["h"]) + b) for o in obs]
    return float(np.median(r))


def summarize_track(t, fw, fh, size_model=None):
    obs = t.obs
    family = obs[0]["family"]
    w_area = np.array([o["bbox"]["w"] * o["bbox"]["h"] for o in obs], dtype=float)
    w_area = w_area / (w_area.sum() or 1.0)

    # ----- type
    if family == "two":
        sc = defaultdict(float)
        for o in obs:
            for k, v in o["cls_scores"].items():
                sc[k] += v
        vtype = "motorcycle" if sc.get("motorcycle", 0) >= sc.get("bicycle", 0) else "bicycle"
    else:
        n = len(obs)
        avg = {c: sum(o["cls_scores"].get(c, 0.0) for o in obs) / n for c in FOUR_WHEEL}
        auto_ratio = sum(1 for o in obs if o["auto"]) / n
        if auto_ratio >= 0.4:
            vtype = "auto"
        else:
            vtype = "car"
            ratio = size_ratio(obs, size_model)
            # fixed camera: a real truck/bus is clearly taller than cars at the same distance.
            # Without a usable size model we demand much stronger detector evidence instead.
            big_enough = (ratio >= 1.35) if ratio is not None else None
            t_need, b_need = (0.60, 0.55) if big_enough else (0.78, 0.72)
            if big_enough is False or n < 3:
                t_need = b_need = 9.9
            if avg["truck"] >= t_need and avg["truck"] >= 1.4 * avg["car"]:
                vtype = "truck"
            elif avg["bus"] >= b_need and avg["bus"] >= 1.4 * avg["car"]:
                vtype = "bus"

    # ----- colour (area-weighted soft vote)
    agg = defaultdict(float)
    for wgt, o in zip(w_area, obs):
        for k, v in o["color_dist"].items():
            agg[k] += wgt * v
    ranked = sorted(agg.items(), key=lambda kv: -kv[1])
    color = ranked[0][0] if ranked and ranked[0][1] >= 0.18 else "unknown"
    candidates = [k for k, v in ranked if v >= 0.25][:3] or ([color] if color != "unknown" else [])
    v_hi = float(np.mean([o["v_hi"] for o in obs]))
    if color == "gray" and v_hi >= 150 and "white" not in candidates:
        candidates.append("white")           # shaded white cars read as gray
    if color == "gray" and float(np.mean([o["v_med"] for o in obs])) < 95 and "black" not in candidates:
        candidates.append("black")
    # shadowed white and sunlit silver are visually the same -> keep both as candidates
    if color in ("white", "gray"):
        other = "gray" if color == "white" else "white"
        if agg.get(other, 0) >= 0.15 and other not in candidates:
            candidates.append(other)

    if vtype == "auto":
        color, candidates = "green", ["green", "yellow"]

    # ----- best crops (large, sharp, confident)
    best = sorted([o for o in obs if o.get("crop") is not None], key=lambda o: -o["quality"])
    return {
        "type": vtype, "color": color, "color_candidates": candidates,
        "score": float(np.mean([o["score"] for o in obs])),
        "best": best[0], "top": best[:3], "obs": obs,
    }


# --------------------------------------------------------------------------- main
def main():
    # Windows cp1252 cannot print some Unicode; force UTF-8 stdout for JSON
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: vehicle_identification.py <video_path> [color] [type] [number] [brand] [photo_path] [max_frames]"}))
        sys.exit(1)
    video_paths = [Path(x.strip()) for x in sys.argv[1].split("||") if x.strip()]
    arg = lambda i: (sys.argv[i] if len(sys.argv) > i else "") or ""
    filter_color = norm_color(arg(2))
    filter_type = arg(3).strip().lower()
    filter_number = re.sub(r"[^A-Z0-9]", "", arg(4).upper())
    filter_brand = arg(5).strip().lower()
    photo_path = Path(arg(6)) if arg(6) else None
    try:
        max_frames = max(1, int(arg(7))) if arg(7) else 40
    except ValueError:
        max_frames = 40

    if not video_paths:
        print(json.dumps({"error": "No video path provided"}))
        sys.exit(1)
    for _vp in video_paths:
        if not _vp.exists():
            print(json.dumps({"error": f"File not found: {_vp}"}))
            sys.exit(1)
    video_path = video_paths[0]

    progress(2)
    detector = make_detector()
    progress(4)

    # ---- reference photo
    embedder, q_emb, q_desc = None, None, None
    if photo_path and photo_path.exists():
        qimg = cv2.imread(str(photo_path))
        if qimg is not None:
            qcrop = query_crop(detector, qimg)
            embedder = make_embedder()
            if embedder is not None:
                q_emb = _embed(embedder, qcrop)
            if q_emb is None:
                q_desc = _descriptor(qcrop)
    progress(6)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(json.dumps({"error": "Could not open video"}))
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    step = max(1, int(round(fps / TARGET_FPS)))
    if total > 0 and total // step > max_frames:
        step = int(np.ceil(total / float(max_frames)))
    expected = min(max_frames, (total // step) if total > 0 else max_frames) or 1

    if DEBUG_DIR:
        Path(DEBUG_DIR).mkdir(parents=True, exist_ok=True)
    out_dir = video_path.parent / f"{video_path.stem}_vehicles"
    out_dir.mkdir(exist_ok=True)
    for old in out_dir.glob("*.jpg"):       # don't accumulate crops from earlier runs
        try:
            old.unlink()
        except OSError:
            pass

    tracks, frame_idx, sampled = [], 0, 0
    raw_count = 0
    fw = fh = 0
    while sampled < max_frames:
        if frame_idx % step != 0:
            if not cap.grab():
                break
            frame_idx += 1
            continue
        ret, frame = cap.read()
        if not ret:
            break
        fh, fw = frame.shape[:2]
        groups = merge_detections(raw_detect(detector, frame))

        dets = []
        for g in groups:
            bbox = g["bbox"]
            if not is_plausible_box(g["family"], bbox, fw, fh):
                continue
            top_cls = max(g["cls_scores"], key=lambda c: g["cls_scores"][c] * CLASS_PRIOR.get(c, 1))
            if g["cls_scores"][top_cls] < MIN_SCORE.get(top_cls, 0.45):
                continue
            crop = frame[bbox["y"]:bbox["y"] + bbox["h"], bbox["x"]:bbox["x"] + bbox["w"]]
            if crop.size == 0:
                continue
            dets.append({
                "family": g["family"], "bbox": bbox, "cls_scores": g["cls_scores"],
                "score": g["score"], "frame_index": frame_idx, "sample_i": sampled,
                "timestamp_ms": int(frame_idx / fps * 1000), "crop": crop,
                "hist": track_hist(crop), "color_dist": color_distribution(crop),
                "auto": g["family"] == "four" and auto_signal(crop, bbox),
                "sharp": sharpness(crop),
            })
            _v = cv2.cvtColor(body_region(crop), cv2.COLOR_BGR2HSV)[..., 2]
            dets[-1]["v_med"], dets[-1]["v_hi"] = float(np.median(_v)), float(np.percentile(_v, 75))
            dets[-1]["quality"] = (dets[-1]["score"] * float(np.sqrt(bbox["w"] * bbox["h"]))
                                   * float(np.log1p(dets[-1]["sharp"])))
        raw_count += len(dets)

        pairs, used_d = associate(tracks, dets, sampled)
        ids = {}
        for ti, di in pairs:
            tracks[ti].obs.append(dets[di])
            ids[di] = tracks[ti].id
        for di, d in enumerate(dets):
            if di not in used_d:
                t = Track()
                t.obs.append(d)
                tracks.append(t)
                ids[di] = t.id
        if DEBUG_DIR and sampled % 4 == 0:
            dbg = frame.copy()
            for di, d in enumerate(dets):
                b = d["bbox"]
                cv2.rectangle(dbg, (b["x"], b["y"]), (b["x"] + b["w"], b["y"] + b["h"]), (0, 255, 0), 3)
                cv2.putText(dbg, f"#{ids[di]}", (b["x"] + 4, b["y"] + 36), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (0, 0, 255), 3)
            cv2.imwrite(str(Path(DEBUG_DIR) / f"s{sampled:03d}.jpg"), cv2.resize(dbg, None, fx=0.5, fy=0.5))

        # keep memory low: only the 6 best crops per track keep their pixels
        for t in tracks:
            with_crop = [o for o in t.obs if o.get("crop") is not None]
            if len(with_crop) > 6:
                for o in sorted(with_crop, key=lambda o: -o["quality"])[6:]:
                    o["crop"] = None

        frame_idx += 1
        sampled += 1
        progress(6 + int(70 * sampled / expected))
    cap.release()
    progress(78)

    min_hits = MIN_HITS if sampled >= 6 else 1
    good = [t for t in tracks if len(t.obs) >= min_hits]

    # ---- per-vehicle summary + expensive OCR on best crops only
    size_model = fit_size_model(good)
    vehicles = []
    # Sort tracks by quality so we OCR the best ones first; cap ANPR count for speed
    MAX_ANPR = int(__import__("os").environ.get("MAX_ANPR", "8"))
    ranked = []
    for t in good:
        if not any(o.get("crop") is not None for o in t.obs):
            continue
        ranked.append(t)
    # prefer tracks with more observations
    ranked.sort(key=lambda tr: -len(tr.obs))

    print(f"[vehicle] summarizing {len(ranked)} tracks, ANPR on top {min(MAX_ANPR, len(ranked))}", file=sys.stderr, flush=True)
    # Preload EasyOCR once so the UI does not look frozen at 78%
    if _anpr is not None and ranked:
        progress(79)
        try:
            _anpr._get_easyocr()
        except Exception:
            pass
        progress(80)

    for i, t in enumerate(ranked):
        s = summarize_track(t, fw, fh, size_model)
        top_crops = [o["crop"] for o in s["top"] if o.get("crop") is not None][:3]
        plate, plate_conf = None, 0.0
        # Progress during slow OCR phase (78% -> 96%)
        progress(78 + int(18 * (i + 1) / max(1, len(ranked))))
        do_anpr = i < MAX_ANPR
        if do_anpr and _anpr is not None and top_crops:
            try:
                plate, plate_conf = _anpr.read_plates_from_crops(top_crops)
            except Exception as _e:
                print(f"ANPR error: {_e}", file=sys.stderr, flush=True)
        if do_anpr and not plate and top_crops:
            try:
                plate = read_plate(top_crops)
            except Exception:
                plate = None
        brand = None
        if filter_brand or i < 8:  # brand OCR when filtering or for sample display
            try:
                brand = read_brand(top_crops)
            except Exception:
                brand = None
        # If user asked for a specific plate, accept near-OCR matches as that plate
        if filter_number and plate and plate_match(plate, filter_number):
            plate = plate_norm(plate)
        elif filter_number and not plate:
            # last-chance: OCR again looking for query characters only
            try:
                for crop in top_crops[:3]:
                    if crop is None:
                        continue
                    for roi in plate_candidates(crop):
                        for raw in _ocr_plate_img(roi):
                            cand = plate_norm(raw)
                            if plate_match(cand, filter_number):
                                plate = cand
                                break
                        if plate:
                            break
                    if plate:
                        break
            except Exception:
                pass
        if filter_brand and brand and not brand_match(brand, filter_brand):
            # keep detected brand; filter will drop if not matching
            pass

        b = s["best"]

        # Refine TYPE (YOLO) + COLOR (body k-means) — like ANPR for attributes
        best_crop = b.get("crop") if isinstance(b, dict) else None
        if best_crop is None and top_crops:
            best_crop = top_crops[0]
        if _vattrs is not None and best_crop is not None:
            try:
                attrs = _vattrs.refine_vehicle_attrs(best_crop, s.get("type"), s.get("color"), extra_crops=top_crops)
                if attrs.get("type"):
                    s["type"] = attrs["type"]
                if attrs.get("color") and attrs["color"] != "unknown":
                    s["color"] = attrs["color"]
                if attrs.get("color_candidates"):
                    s["color_candidates"] = attrs["color_candidates"]
                s["type_confidence"] = attrs.get("type_confidence")
                s["color_confidence"] = attrs.get("color_confidence")
                s["type_backend"] = attrs.get("type_backend")
                s["color_backend"] = attrs.get("color_backend")
            except Exception as _ae:
                print(f"attrs refine error: {_ae}", file=sys.stderr, flush=True)

        cname = f"{s['type']}_{s['color']}_v{t.id}.jpg"
        cv2.imwrite(str(out_dir / cname), b["crop"])
        sim = None
        if q_emb is not None and embedder is not None:
            sims = [photo_similarity(q_emb, _embed(embedder, c), True) for c in top_crops]
            sims = [x for x in sims if x is not None]
            sim = max(sims) if sims else None
        elif q_desc is not None:
            sims = [photo_similarity(q_desc, _descriptor(c)) for c in top_crops]
            sim = max(sims) if sims else None

        vehicles.append({
                "source_video": video_path.name,
            "track_id": t.id,
            "type": s["type"],
            "type_confidence": s.get("type_confidence"),
            "type_backend": s.get("type_backend"),
            "color": s["color"],
            "color_confidence": s.get("color_confidence"),
            "color_backend": s.get("color_backend"),
            "color_candidates": s["color_candidates"],
            "number_plate": plate,
            "plate_confidence": round(plate_conf, 3) if plate else None,
            "brand": brand,
            "score": round(s["score"], 3),
            "photo_similarity": sim,
            "bbox": b["bbox"],
            "frame_index": b["frame_index"],
            "timestamp_ms": b["timestamp_ms"],
            "first_seen_ms": min(o["timestamp_ms"] for o in t.obs),
            "last_seen_ms": max(o["timestamp_ms"] for o in t.obs),
            "appearances": len(t.obs),
            "crop_url": f"/uploads/vision/{out_dir.name}/{cname}",
        })
        progress(80 + int(16 * (i + 1) / max(1, len(ranked))))

    progress(97)

    # ---- Filters
    # Type + color: always strict (model outputs these).
    # Plate + brand: only enforced when OCR actually read something on at least one vehicle.
    #   Otherwise OCR miss would wipe all results (common failure mode).
    active_filters = {
        "color": filter_color or None,
        "type": filter_type or None,
        "number": filter_number or None,
        "brand": filter_brand or None,
    }
    any_filter = any(active_filters.values())
    warnings = []

    any_plate_ocr = any(v.get("number_plate") for v in vehicles)
    any_brand_ocr = any(v.get("brand") for v in vehicles)
    apply_plate = bool(filter_number) and any_plate_ocr
    apply_brand = bool(filter_brand) and any_brand_ocr

    if filter_number and not any_plate_ocr:
        warnings.append(
            "Plate filter ignored: no number plate could be read from the video "
            "(need a clearer, closer view of the plate). Showing type/color matches only."
        )
    if filter_brand and not any_brand_ocr:
        warnings.append(
            "Brand filter ignored: no brand badge/text could be read. Showing other matches only."
        )

    filtered = [
        v for v in vehicles
        if passes_filters(v, filter_color, filter_type, filter_number, filter_brand,
                          apply_plate=apply_plate, apply_brand=apply_brand)
    ]

    # If plate OCR exists but nothing matched the query, keep empty (true miss)
    # All plates OCR actually read (for UI transparency)
    plates_detected = sorted({
        plate_norm(v.get("number_plate"))
        for v in vehicles
        if v.get("number_plate")
    })

    if filter_number and any_plate_ocr:
        scored = []
        for v in vehicles:
            pl = v.get("number_plate")
            if not pl:
                continue
            scored.append((plate_similarity(pl, filter_number), plate_norm(pl), v.get("type"), v.get("color")))
        scored.sort(key=lambda x: -x[0])
        closest = [
            {"plate": pl, "similarity": round(sim, 3), "type": typ, "color": col}
            for sim, pl, typ, col in scored[:8]
        ]
        if not any(s[0] >= 0.75 for s in scored):
            top = ", ".join(f"{c['plate']} ({int(c['similarity']*100)}%)" for c in closest[:5])
            warnings.append(
                f"No plate matched '{filter_number}' at >=75% similarity. "
                f"Closest OCR reads: {top or 'none'}. "
                f"Try the closest plate text, or a clearer plate crop."
            )
    else:
        closest = []

    has_photo = q_emb is not None or q_desc is not None
    if has_photo:
        floor = 0.40 if q_emb is not None else 0.55
        before = len(filtered)
        filtered = [v for v in filtered if v["photo_similarity"] is not None and v["photo_similarity"] >= floor]
        filtered = sorted(filtered, key=lambda x: -(x["photo_similarity"] or 0))
        if before and not filtered:
            warnings.append("Reference photo filter removed all candidates (similarity too low).")

    summary_source = filtered if any_filter else vehicles
    summary = defaultdict(lambda: {"count": 0, "samples": []})
    for v in summary_source:
        key = f"{v['type']}|{v['color']}|{v.get('brand') or 'unknown'}"
        summary[key]["count"] += 1
        if len(summary[key]["samples"]) < 3:
            summary[key]["samples"].append(v)

    # Multi-video: process remaining paths via recursive self-calls (single-path each)
    multi_results = []
    if len(video_paths) > 1:
        import subprocess
        for extra in video_paths[1:]:
            cmd = [
                sys.executable, str(Path(__file__).resolve()),
                str(extra),
                arg(2), arg(3), arg(4), arg(5),
                arg(6),
                str(max_frames),
            ]
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
                out = proc.stdout or ""
                for line in reversed(out.splitlines()):
                    if line.strip().startswith("{"):
                        multi_results.append(json.loads(line.strip()))
                        break
            except Exception as e:
                multi_results.append({"error": str(e), "video": extra.name})

    all_matching = list(filtered)
    all_vehicles = list(vehicles)
    all_summary = list(summary.items()) if hasattr(summary, "items") else []
    videos_meta = [video_path.name]
    for mr in multi_results:
        if mr.get("error"):
            continue
        videos_meta.append(mr.get("video"))
        all_matching.extend(mr.get("matching_vehicles") or [])
        all_vehicles.extend(mr.get("vehicles") or mr.get("matching_vehicles") or [])
        for s in (mr.get("summary") or []):
            # summary is list of dicts in final form
            pass

    print(json.dumps({
        "success": True,
        "anpr": True if _anpr is not None else False,
        "video": video_path.name,
        "videos": videos_meta,
        "video_count": len(videos_meta),
        "fps": fps,
        "total_frames_sampled": sampled,
        "vehicles_detected": len(vehicles),          # now = unique vehicles
        "raw_detections": raw_count,
        "filter_warnings": warnings if "warnings" in dir() else [],
        "vehicles_total": len(vehicles),
        "plates_detected": plates_detected if "plates_detected" in dir() else [],
        "closest_plates": closest if "closest" in dir() else [],
        "ocr_stats": {
            "plates_read": sum(1 for v in vehicles if v.get("number_plate")),
            "brands_read": sum(1 for v in vehicles if v.get("brand")),
        },
        "filters_applied": {
            "color": filter_color or None, "type": filter_type or None,
            "number": filter_number or None, "brand": filter_brand or None,
            "photo_match": bool(has_photo),
        },
        "matching_vehicles": all_matching[:80],
        "vehicles_detected": len(all_vehicles),
        "summary": [
            {"type": k.split("|")[0], "color": k.split("|")[1],
             "brand": k.split("|")[2] if k.split("|")[2] != "unknown" else None,
             "count": s["count"], "samples": s["samples"]}
            for k, s in sorted(summary.items(), key=lambda x: -x[1]["count"])
        ],
    }, ensure_ascii=True))
    progress(100)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
