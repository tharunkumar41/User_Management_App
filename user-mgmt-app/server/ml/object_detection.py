#!/usr/bin/env python3
"""
Object detection — YOLOv8 with strict confidence + NMS to reduce false positives.

Install:
  python -m pip install ultralytics
Optional higher accuracy (recommended):
  # downloads automatically on first use if missing
  # or place server/ml_models/yolov8s.pt yourself
"""
import sys
import json
import os
from pathlib import Path
from collections import defaultdict

import cv2
import numpy as np

MODELS = Path(__file__).resolve().parent.parent / "ml_models"

# Prefer larger models first (better accuracy)
YOLO_WEIGHTS = [
    MODELS / "yolov8m.pt",
    MODELS / "yolov8s.pt",
    MODELS / "yolov8n.pt",
    Path("yolov8s.pt"),
    Path("yolov8n.pt"),
]

# Global floor — raise via env OBJECT_CONF (e.g. 0.55)
DEFAULT_CONF = float(os.environ.get("OBJECT_CONF", "0.50"))

# Classes that are often confused — need higher score to accept
STRICT_CLASS_CONF = {
    "sink": 0.70,       # bottles/cups often misread as sink at low conf
    "toilet": 0.70,
    "oven": 0.65,
    "microwave": 0.65,
    "refrigerator": 0.60,
    "tv": 0.55,
    "laptop": 0.55,
    "book": 0.55,
    "vase": 0.60,
    "cup": 0.50,
    "bowl": 0.50,
    "bottle": 0.45,     # bottles OK a bit lower if YOLO is sure
    "wine glass": 0.55,
    "chair": 0.50,
    "dining table": 0.55,
    "person": 0.40,
    "car": 0.45,
    "truck": 0.55,
    "bus": 0.50,
    "motorcycle": 0.50,
    "dog": 0.50,
    "cat": 0.50,
    "horse": 0.60,
}

# Drop these unless confidence is very high (frequent false alarms)
RARE_OR_NOISY = {
    "toothbrush", "hair drier", "scissors", "kite", "frisbee",
    "skis", "snowboard", "sports ball", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "parking meter",
}


def progress(pct):
    print(f"PROGRESS:{int(pct)}", file=sys.stderr, flush=True)


def _fmt_ms(ms):
    s = int(ms) // 1000
    return f"{s // 60:02d}:{s % 60:02d}"


def _fmt_dur(ms):
    s = max(0, int(ms) // 1000)
    return f"{s}s" if s < 60 else f"{s // 60}m {s % 60}s"


def build_segments(timestamps_ms, gap_ms=2500, sample_interval_ms=1000):
    if not timestamps_ms:
        return []
    ts = sorted(set(int(x) for x in timestamps_ms))
    segs, start, prev = [], ts[0], ts[0]
    for t in ts[1:]:
        if t - prev > gap_ms:
            dur = sample_interval_ms if prev == start else max(0, prev - start)
            segs.append({
                "start_ms": start, "end_ms": prev, "duration_ms": dur,
                "start_time": _fmt_ms(start), "end_time": _fmt_ms(prev),
                "duration": _fmt_dur(dur),
            })
            start = t
        prev = t
    dur = sample_interval_ms if prev == start else max(0, prev - start)
    segs.append({
        "start_ms": start, "end_ms": prev, "duration_ms": dur,
        "start_time": _fmt_ms(start), "end_time": _fmt_ms(prev),
        "duration": _fmt_dur(dur),
    })
    return segs


def label_matches_search(label, search):
    if not search:
        return True
    lab = label.lower().strip()
    q = search.lower().strip()
    if lab == q or q in lab.split() or lab in q.split():
        return True
    aliases = {
        "people": "person", "man": "person", "woman": "person",
        "bike": "bicycle", "motorbike": "motorcycle",
        "bottles": "bottle", "cellphone": "cell phone", "mobile": "cell phone",
        "sofa": "couch", "tv": "tv", "television": "tv",
    }
    q2 = aliases.get(q, q)
    return lab == q2 or q2 in lab.split()


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    return inter / max(1e-6, area_a + area_b - inter)


def nms(dets, iou_thresh=0.45):
    dets = sorted(dets, key=lambda d: -d["score"])
    keep = []
    for d in dets:
        if any(iou(d["xyxy"], k["xyxy"]) >= iou_thresh for k in keep):
            continue
        keep.append(d)
    return keep


def accept_detection(label, score, xyxy, fw, fh):
    """Class-aware gates to cut false positives."""
    min_conf = STRICT_CLASS_CONF.get(label, DEFAULT_CONF)
    if score < min_conf:
        return False
    if label in RARE_OR_NOISY and score < 0.65:
        return False

    x1, y1, x2, y2 = xyxy
    w, h = max(0, x2 - x1), max(0, y2 - y1)
    if w < 20 or h < 20:
        return False
    area_ratio = (w * h) / max(1, fw * fh)
    if area_ratio < 0.0015:
        return False

    ar = w / max(h, 1)

    # Geometry sanity for common confusions
    if label == "bottle":
        # bottles are taller than wide
        if ar > 0.85 or h < 30:
            return False
        if score < 0.45:
            return False
    if label == "sink":
        # sinks are wide; reject tall thin boxes (often bottles)
        if ar < 1.0 or area_ratio < 0.01:
            return False
        if score < 0.70:
            return False
    if label in ("cup", "wine glass"):
        if ar > 1.4:
            return False
    if label == "person":
        if area_ratio < 0.003:
            return False

    return True


def load_yolo():
    try:
        from ultralytics import YOLO
    except ImportError:
        return None, None
    for w in YOLO_WEIGHTS:
        if Path(w).exists():
            return YOLO(str(w)), str(w)
    # Prefer s over n for accuracy (auto-download ~22MB)
    prefer = os.environ.get("YOLO_MODEL", "yolov8s.pt")
    return YOLO(prefer), prefer


def detect_yolo(model, frame_bgr, conf):
    res = model.predict(
        frame_bgr,
        conf=conf,
        iou=0.5,
        verbose=False,
        imgsz=640,
        max_det=30,
    )
    out = []
    if not res:
        return out
    r0 = res[0]
    names = r0.names or {}
    if r0.boxes is None:
        return out
    for b in r0.boxes:
        cls_id = int(b.cls.item())
        label = str(names.get(cls_id, cls_id)).lower()
        score = float(b.conf.item())
        x1, y1, x2, y2 = [int(v) for v in b.xyxy[0].tolist()]
        out.append({"label": label, "score": score, "xyxy": (x1, y1, x2, y2)})
    return out


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: object_detection.py <video> [search] [max_frames]"}))
        sys.exit(1)
    video_path = Path(sys.argv[1])
    search = (sys.argv[2] if len(sys.argv) > 2 else "") or ""
    search = search.strip().lower()
    if search in ("", "-", "none", "null"):
        search = ""
    try:
        max_frames = max(1, int(sys.argv[3])) if len(sys.argv) > 3 and str(sys.argv[3]).isdigit() else 40
    except ValueError:
        max_frames = 40

    if not video_path.exists():
        print(json.dumps({"error": f"File not found: {video_path}"}))
        sys.exit(1)

    progress(2)
    yolo, model_name = load_yolo()
    if yolo is None:
        print(json.dumps({
            "error": "YOLOv8 not installed. Run: python -m pip install ultralytics"
        }))
        sys.exit(1)
    print(f"Using YOLO: {model_name} conf>={DEFAULT_CONF}", file=sys.stderr)

    progress(8)
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(json.dumps({"error": "Could not open video"}))
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    step = max(1, total // max_frames) if total > 0 else max(1, int(fps))
    sample_interval_ms = int(step / fps * 1000)

    out_dir = video_path.parent / f"{video_path.stem}_objects"
    out_dir.mkdir(exist_ok=True)

    by_label = defaultdict(lambda: {"count": 0, "max_conf": 0.0, "frames": [], "timestamps": []})
    frame_idx = sampled = rejected = 0

    # Run detector slightly below DEFAULT_CONF then apply class gates
    predict_conf = max(0.25, DEFAULT_CONF - 0.15)

    while sampled < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % step != 0:
            frame_idx += 1
            continue

        dets = detect_yolo(yolo, frame, conf=predict_conf)
        dets = nms(dets, 0.45)
        ts_ms = int((frame_idx / fps) * 1000)
        fh, fw = frame.shape[:2]

        for d in dets:
            label, score, xyxy = d["label"], d["score"], d["xyxy"]
            if not label_matches_search(label, search):
                continue
            if not accept_detection(label, score, xyxy, fw, fh):
                rejected += 1
                continue
            x1, y1, x2, y2 = xyxy
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(fw, x2), min(fh, y2)
            crop = frame[y1:y2, x1:x2]
            if crop.size == 0:
                continue
            cname = f"{label.replace(' ', '_')}_f{frame_idx}_{sampled}.jpg"
            cv2.imwrite(str(out_dir / cname), crop)
            entry = {
                "label": label,
                "score": round(score, 3),
                "frame_index": frame_idx,
                "timestamp_ms": ts_ms,
                "timestamp": _fmt_ms(ts_ms),
                "crop_url": f"/uploads/vision/{out_dir.name}/{cname}",
                "bbox": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
            }
            by_label[label]["count"] += 1
            by_label[label]["max_conf"] = max(by_label[label]["max_conf"], score)
            by_label[label]["timestamps"].append(ts_ms)
            if len(by_label[label]["frames"]) < 12:
                by_label[label]["frames"].append(entry)

        frame_idx += 1
        sampled += 1
        progress(8 + int(88 * sampled / max_frames))

    cap.release()
    progress(96)

    # Require label to appear in enough frames when video is long (stability)
    min_hits = 1 if sampled < 8 else 2
    objects = []
    for label, data in sorted(by_label.items(), key=lambda x: -x[1]["count"]):
        if data["count"] < min_hits and data["max_conf"] < 0.65:
            continue  # one-off weak sightings dropped
        segs = build_segments(
            data["timestamps"],
            gap_ms=max(2500, sample_interval_ms * 2),
            sample_interval_ms=sample_interval_ms,
        )
        objects.append({
            "label": label,
            "count": data["count"],
            "max_confidence": round(data["max_conf"], 3),
            "first_seen": _fmt_ms(min(data["timestamps"])) if data["timestamps"] else None,
            "last_seen": _fmt_ms(max(data["timestamps"])) if data["timestamps"] else None,
            "total_duration_ms": sum(s["duration_ms"] for s in segs),
            "total_duration": _fmt_dur(sum(s["duration_ms"] for s in segs)),
            "segments": segs,
            "frames": data["frames"],
        })

    print(json.dumps({
        "success": True,
        "backend": "yolo",
        "model": model_name,
        "confidence_floor": DEFAULT_CONF,
        "video": video_path.name,
        "fps": fps,
        "total_frames_sampled": sampled,
        "rejected_low_quality": rejected,
        "search": search or None,
        "unique_labels": len(objects),
        "objects": objects,
        "reference_match": {"enabled": False},
        "tip": "For even higher accuracy: set YOLO_MODEL=yolov8m.pt or OBJECT_CONF=0.55 in server env",
    }, ensure_ascii=False))
    progress(100)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
