#!/usr/bin/env python3
"""
Face Detection on video + person re-identification (v2)

Why v1 returned so few frames / merged different people
-------------------------------------------------------
1. BlazeFace *short-range* squeezes the WHOLE frame to 128x128 px. In a 1080p frame a
   face has to be ~35-40 % of the frame width to survive that, so faces of normal
   "meeting / street / CCTV" size were simply never detected (often 0 of 40 frames).
   -> v2 scans the frame in overlapping square tiles at 3 scales, so every face is seen at a
      size the model can handle, then merges duplicates (NMS).
2. Face crops were resized to 112x112 WITHOUT alignment, but MobileFaceNet/ArcFace expects
   eyes/nose/mouth at fixed positions. Unaligned crops of different people scored 0.47 (above
   the 0.42 match threshold) -> two different men became "Person 1".
   -> v2 aligns each face with the detector's landmarks first. Different people now score
      ~0.0-0.15, the same person 0.4-0.8, so the match threshold (0.35) has a wide margin.
3. Frames were sampled blindly (every N-th frame, 40 max) and a face was matched only against
   the running mean embedding.
   -> v2 samples evenly in time, matches against centroid AND best members, forbids two faces
      of one frame from being the same person, ignores faces too small to identify, and merges
      clusters that were split by a bad first sample.

CLI (unchanged):  face_detection.py <video_path> [max_frames]
Env: FACE_TIME_BUDGET (seconds, default 240) stops sampling early and returns what was found.
"""
import sys
import os
import json
import time
from pathlib import Path

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision
import onnxruntime as ort

MODELS_DIR = Path(__file__).resolve().parent.parent / "ml_models"
FACE_MODEL = str(MODELS_DIR / "blazeface_short_range.tflite")
ARC_MODEL = str(MODELS_DIR / "w600k_mbf.onnx")  # MobileFaceNet 512-d

TIME_BUDGET = float(os.environ.get("FACE_TIME_BUDGET", "240"))

DET_CONF = 0.5          # BlazeFace confidence (on tiles)
MIN_FACE_PX = 36        # below this the embedding is unreliable -> counted but not identified
MIN_NEW_PERSON_PX = 48  # only reasonably large faces may start a NEW person
MATCH_THRESH = 0.35     # aligned embeddings: other people <= ~0.15, same person >= ~0.4
MERGE_THRESH = 0.45     # final pass: merge clusters whose centroids are this similar
TILE_FRACS = (1.0, 0.5, 0.25)   # tile side as a fraction of min(frame_w, frame_h)
MIN_TILE = 200
# Quality gates. The raw (un-normalised) MobileFaceNet embedding norm is a face-quality signal:
# real faces measured 15-28, background clutter that BlazeFace mistakes for faces mostly < 14.
NORM_MIN = float(os.environ.get("FACE_NORM_MIN", "14.5"))          # per-face gate
NEW_PERSON_NORM = float(os.environ.get("FACE_NEW_NORM", "15.0"))   # needed to START a person
COHESION_MIN = 0.50       # a real person's faces stay close to their centroid
SINGLE_NORM_MIN = 18.0    # a person seen in only ONE sampled frame must be a clearly good face
SINGLE_SCORE_MIN = 0.70
FEW_SIGHTINGS = 5         # clusters with fewer sightings than this need a clearly good face
FEW_NORM_MIN = 17.0
# "Weak" faces (small / blurry / turned) are too noisy to START a person or move a centroid, but when one
# clearly matches somebody already identified it is still a valid sighting -> list it under that person.
JOIN_MIN_PX = 28
JOIN_NORM_MIN = 11.0
WEAK_JOIN_SIM = 0.45

# ArcFace 112x112 template: left eye, right eye, nose tip, mouth centre
TEMPLATE = np.array([[38.29, 51.70], [73.53, 51.50], [56.03, 71.74], [56.14, 92.28]], np.float32)


def progress(pct):
    # stderr only — stdout must stay pure JSON for the Node runner
    print(f"PROGRESS:{int(pct)}", file=sys.stderr, flush=True)


# ----------------------------------------------------------------------------- geometry
def iou(a, b):
    ix = max(0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def containment(small, big):
    ix = max(0, min(small[0] + small[2], big[0] + big[2]) - max(small[0], big[0]))
    iy = max(0, min(small[1] + small[3], big[1] + big[3]) - max(small[1], big[1]))
    return (ix * iy) / max(1, small[2] * small[3])


# ----------------------------------------------------------------------------- detection
def make_tiles(fw, fh):
    base = min(fw, fh)
    tiles, seen = [], set()
    for f in TILE_FRACS:
        t = int(base * f)
        t = base if base < MIN_TILE else max(MIN_TILE, t)
        t = min(t, fw, fh)
        stride = max(1, int(t * 0.5))
        xs = list(range(0, max(1, fw - t + 1), stride))
        ys = list(range(0, max(1, fh - t + 1), stride))
        if xs[-1] != fw - t:
            xs.append(fw - t)
        if ys[-1] != fh - t:
            ys.append(fh - t)
        for y in ys:
            for x in xs:
                if (x, y, t) not in seen:
                    seen.add((x, y, t))
                    tiles.append((x, y, t, t))
    return tiles


def plausible_landmarks(kp, box_w):
    """kp: right-eye, left-eye, nose, mouth (+ears). Reject geometry no real frontal-ish face has."""
    e1, e2, nose, mouth = kp[0], kp[1], kp[2], kp[3]
    eye_dist = abs(e1[0] - e2[0])
    eye_y = (e1[1] + e2[1]) / 2.0
    if eye_dist < 0.20 * box_w:                    # extreme profile / garbage
        return False
    if not (eye_y < nose[1] < mouth[1]):
        return False
    lo, hi = min(e1[0], e2[0]), max(e1[0], e2[0])
    if not (lo - 0.15 * eye_dist <= nose[0] <= hi + 0.15 * eye_dist):
        return False
    return True


def detect_faces(detector, frame_bgr, tiles):
    fh, fw = frame_bgr.shape[:2]
    rgb = np.ascontiguousarray(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
    cands = []
    for (tx, ty, tw, th) in tiles:
        sub = np.ascontiguousarray(rgb[ty:ty + th, tx:tx + tw])
        res = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=sub))
        for d in res.detections or []:
            bb = d.bounding_box
            m = 2
            # a box cut by an INTERIOR tile edge is a partial face — the neighbouring tile has it whole
            if (bb.origin_x <= m and tx > 0) or (bb.origin_x + bb.width >= tw - m and tx + tw < fw):
                continue
            if (bb.origin_y <= m and ty > 0) or (bb.origin_y + bb.height >= th - m and ty + th < fh):
                continue
            if bb.width < 24 or bb.height < 24:
                continue
            ar = bb.width / float(bb.height)
            if not (0.6 <= ar <= 1.6):
                continue
            score = float(d.categories[0].score) if d.categories else 0.0
            kp = np.array([[k.x * tw + tx, k.y * th + ty] for k in d.keypoints], np.float32)
            if len(kp) < 4 or not plausible_landmarks(kp, bb.width):
                continue
            cands.append({
                "box": (bb.origin_x + tx, bb.origin_y + ty, bb.width, bb.height),
                "score": score, "kp": kp,
            })
    # NMS across tiles / scales
    cands.sort(key=lambda c: -c["score"])
    keep = []
    for c in cands:
        dup = False
        for k in keep:
            if iou(c["box"], k["box"]) >= 0.35 or containment(c["box"], k["box"]) >= 0.6 \
                    or containment(k["box"], c["box"]) >= 0.6:
                dup = True
                break
        if not dup:
            keep.append(c)
    # clip to frame
    for c in keep:
        x, y, w, h = c["box"]
        x1, y1 = max(0, x), max(0, y)
        x2, y2 = min(fw, x + w), min(fh, y + h)
        c["box"] = (int(x1), int(y1), int(x2 - x1), int(y2 - y1))
    return [c for c in keep if c["box"][2] > 4 and c["box"][3] > 4]


# ----------------------------------------------------------------------------- embedding
class FaceEmbedder:
    def __init__(self, model_path):
        self.sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.input_name = self.sess.get_inputs()[0].name

    def embed_aligned(self, rgb_frame, kp):
        """Similarity-align to the ArcFace template using eyes / nose / mouth, then embed."""
        eyes = sorted([kp[0], kp[1]], key=lambda p: p[0])
        src = np.array([eyes[0], eyes[1], kp[2], kp[3]], np.float32)
        M, _ = cv2.estimateAffinePartial2D(src, TEMPLATE, method=cv2.LMEDS)
        if M is None:
            return None
        face = cv2.warpAffine(rgb_frame, M, (112, 112), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_REPLICATE)
        x = ((face.astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[np.newaxis]
        out = self.sess.run(None, {self.input_name: x})[0][0].astype(np.float32)
        n = float(np.linalg.norm(out))
        return (out / n, n) if n > 1e-8 else (None, 0.0)


# ----------------------------------------------------------------------------- clustering
class Person:
    def __init__(self):
        self.obs = []      # strong sightings (define the identity)
        self.weak = []     # weak sightings that matched this identity

    @property
    def centroid(self):
        c = np.mean([o["emb"] for o in self.obs], axis=0)
        n = np.linalg.norm(c)
        return c / n if n > 1e-8 else c

    def similarity(self, emb):
        sims = np.array([float(np.dot(emb, o["emb"])) for o in self.obs])
        top = np.sort(sims)[-3:]
        return max(float(np.dot(emb, self.centroid)), float(top.mean()))


def blur_score(bgr):
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())



def build_segments(timestamps_ms, gap_ms=2500):
    """Group consecutive sightings into presence intervals with duration."""
    if not timestamps_ms:
        return []
    ts = sorted(set(int(x) for x in timestamps_ms))
    segs = []
    start = prev = ts[0]
    for t in ts[1:]:
        if t - prev > gap_ms:
            segs.append({
                "start_ms": start,
                "end_ms": prev,
                "duration_ms": max(0, prev - start),
                "start_time": _fmt_ms(start),
                "end_time": _fmt_ms(prev),
                "duration": _fmt_dur(max(0, prev - start)),
            })
            start = t
        prev = t
    segs.append({
        "start_ms": start,
        "end_ms": prev,
        "duration_ms": max(0, prev - start),
        "start_time": _fmt_ms(start),
        "end_time": _fmt_ms(prev),
        "duration": _fmt_dur(max(0, prev - start)),
    })
    return segs


def _fmt_ms(ms):
    s = int(ms) // 1000
    return f"{s // 60:02d}:{s % 60:02d}"


def _fmt_dur(ms):
    s = max(0, int(ms) // 1000)
    if s < 60:
        return f"{s}s"
    return f"{s // 60}m {s % 60}s"


def embed_reference_face(detector, embedder, image_path):
    """Return L2-normalised embedding of the best face in a reference photo, or None."""
    img = cv2.imread(str(image_path))
    if img is None:
        return None, "Could not read reference image"
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    tiles = make_tiles(img.shape[1], img.shape[0])
    dets = detect_faces(detector, img, tiles)
    if not dets:
        # full-frame try without tiles
        dets = detect_faces(detector, img, [(0, 0, img.shape[1], img.shape[0])])
    if not dets:
        return None, "No face found in reference image"
    # largest face
    dets = sorted(dets, key=lambda d: d["box"][2] * d["box"][3], reverse=True)
    emb, norm = embedder.embed_aligned(rgb, dets[0]["kp"])
    if emb is None:
        return None, "Could not embed reference face"
    return emb, None



def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: face_detection.py <video_path> [max_frames] [reference_image]"}))
        sys.exit(1)
    video_path = Path(sys.argv[1])
    try:
        max_frames = max(1, int(sys.argv[2])) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 60
    except ValueError:
        max_frames = 60
    # reference may be argv[2] if not digits, or argv[3]
    ref_path = None
    if len(sys.argv) > 2 and not sys.argv[2].isdigit():
        ref_path = Path(sys.argv[2])
    elif len(sys.argv) > 3 and sys.argv[3]:
        ref_path = Path(sys.argv[3])
    if not video_path.exists():
        print(json.dumps({"error": f"File not found: {video_path}"}))
        sys.exit(1)
    if ref_path and not ref_path.exists():
        print(json.dumps({"error": f"Reference image not found: {ref_path}"}))
        sys.exit(1)

    t0 = time.time()
    progress(2)
    detector = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=python.BaseOptions(model_asset_path=FACE_MODEL),
        running_mode=vision.RunningMode.IMAGE,
        min_detection_confidence=DET_CONF,
    ))
    embedder = FaceEmbedder(ARC_MODEL)
    ref_emb = None
    if ref_path:
        ref_emb, ref_err = embed_reference_face(detector, embedder, ref_path)
        if ref_err:
            print(json.dumps({"error": ref_err}))
            sys.exit(1)
    progress(5)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(json.dumps({"error": "Could not open video"}))
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total > 0:
        n_samples = min(max_frames, total)
        targets = sorted({int(round(i * (total - 1) / max(1, n_samples - 1))) for i in range(n_samples)}) \
            if n_samples > 1 else [0]
    else:                                   # unknown length: one frame per second
        targets = [int(i * fps) for i in range(max_frames)]
    tset = set(targets)

    out_dir = video_path.parent / f"{video_path.stem}_faces"
    out_dir.mkdir(exist_ok=True)
    for old in out_dir.glob("*.jpg"):
        try:
            old.unlink()
        except OSError:
            pass

    persons = []
    tiles = None
    faces_total = small_skipped = low_quality = 0
    frame_idx = sampled = 0
    last_target = targets[-1]
    while frame_idx <= last_target:
        if frame_idx not in tset:
            if not cap.grab():
                break
            frame_idx += 1
            continue
        ret, frame = cap.read()
        if not ret:
            break
        if tiles is None:
            tiles = make_tiles(frame.shape[1], frame.shape[0])
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        dets = detect_faces(detector, frame, tiles)
        ts_ms = int((frame_idx / fps) * 1000)

        items = []
        for d in dets:
            x, y, w, h = d["box"]
            faces_total += 1
            weak = False
            if min(w, h) < MIN_FACE_PX:
                if min(w, h) < JOIN_MIN_PX:
                    small_skipped += 1
                    continue
                weak = True
            emb, norm = embedder.embed_aligned(rgb, d["kp"])
            if emb is None:
                continue
            if norm < NORM_MIN:                     # blurry / clutter
                if norm < JOIN_NORM_MIN:
                    low_quality += 1
                    continue
                weak = True
            pad = 0.25
            px, py = int(w * pad), int(h * pad)
            x1, y1 = max(0, x - px), max(0, y - py)
            x2, y2 = min(frame.shape[1], x + w + px), min(frame.shape[0], y + h + py)
            crop = frame[y1:y2, x1:x2].copy()
            if crop.size == 0:
                continue
            items.append({
                "emb": emb, "norm": norm, "weak": weak, "crop": crop, "frame_index": frame_idx, "timestamp_ms": ts_ms,
                "bbox": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
                "face_size": int(min(w, h)), "confidence": d["score"],
                "quality": d["score"] * min(w, h) * np.log1p(blur_score(crop)),
            })

        # one-to-one greedy assignment inside the frame (one person can't appear twice in a frame)
        used_p = set()
        for weak_pass in (False, True):
            pairs = []
            for ii, it in enumerate(items):
                if it["weak"] != weak_pass:
                    continue
                need = WEAK_JOIN_SIM if weak_pass else MATCH_THRESH
                for pi, p in enumerate(persons):
                    if pi in used_p or not p.obs:
                        continue
                    sv = p.similarity(it["emb"])
                    if sv >= need:
                        pairs.append((sv, ii, pi))
            pairs.sort(reverse=True)
            done = set()
            for sv, ii, pi in pairs:
                if ii in done or pi in used_p:
                    continue
                items[ii]["sim"] = sv
                (persons[pi].weak if weak_pass else persons[pi].obs).append(items[ii])
                done.add(ii)
                used_p.add(pi)
            for ii, it in enumerate(items):
                if it["weak"] != weak_pass or ii in done:
                    continue
                if weak_pass:
                    small_skipped += 1 if it["face_size"] < MIN_FACE_PX else 0
                    low_quality += 1 if it["norm"] < NORM_MIN else 0
                elif it["face_size"] >= MIN_NEW_PERSON_PX and it["norm"] >= NEW_PERSON_NORM:
                    p = Person()
                    p.obs.append(it)
                    persons.append(p)
                    used_p.add(len(persons) - 1)
                else:
                    small_skipped += 1          # too small to start a new identity safely

        frame_idx += 1
        sampled += 1
        progress(5 + int(88 * sampled / len(targets)))
        if time.time() - t0 > TIME_BUDGET:
            print("time budget reached, returning partial result", file=sys.stderr, flush=True)
            break
    cap.release()
    progress(95)

    # ---- merge clusters that are really the same person (e.g. split by a poor first sample)
    merged = True
    while merged and len(persons) > 1:
        merged = False
        best = (MERGE_THRESH, None, None)
        for i in range(len(persons)):
            for j in range(i + 1, len(persons)):
                s = float(np.dot(persons[i].centroid, persons[j].centroid))
                if s > best[0]:
                    # never merge people who are visible in the same frame
                    fi = {o["frame_index"] for o in persons[i].obs + persons[i].weak}
                    fj = {o["frame_index"] for o in persons[j].obs + persons[j].weak}
                    if not (fi & fj):
                        best = (s, i, j)
        if best[1] is not None:
            persons[best[1]].obs.extend(persons[best[2]].obs)
            persons[best[1]].weak.extend(persons[best[2]].weak)
            del persons[best[2]]
            merged = True

    # ---- drop clusters that look like clutter rather than a person
    kept, dropped = [], 0
    for p in persons:
        c = p.centroid
        cohesion = float(np.mean([float(np.dot(c, o["emb"])) for o in p.obs]))
        mean_norm = float(np.mean([o["norm"] for o in p.obs]))
        if len(p.obs) == 1:
            o = p.obs[0]
            ok = o["norm"] >= SINGLE_NORM_MIN and o["confidence"] >= SINGLE_SCORE_MIN
        elif len(p.obs) < FEW_SIGHTINGS:      # a few sightings: must be a clearly good face
            ok = cohesion >= COHESION_MIN and mean_norm >= FEW_NORM_MIN
        else:                                 # many sightings: a consistent identity is enough
            ok = cohesion >= COHESION_MIN
        if ok:
            kept.append(p)
        else:
            dropped += 1
    persons = kept

    persons.sort(key=lambda p: -len(p.obs))
    out_persons = []
    for pid, p in enumerate(persons, start=1):
        obs = sorted(p.obs + p.weak, key=lambda o: o["frame_index"])
        best = max(p.obs, key=lambda o: o["quality"])
        frames = []
        for o in obs:
            name = f"p{pid}_f{o['frame_index']}.jpg"
            cv2.imwrite(str(out_dir / name), o["crop"])
            frames.append({
                "frame_index": o["frame_index"],
                "timestamp_ms": o["timestamp_ms"],
                "bbox": o["bbox"],
                "confidence": round(o["confidence"], 3),
                "face_size": o["face_size"],
                "low_quality": bool(o["weak"]),
                "match_similarity": round(o["sim"], 3) if "sim" in o else None,
                "crop_url": f"/uploads/vision/{out_dir.name}/{name}",
            })
        rep = f"/uploads/vision/{out_dir.name}/p{pid}_f{best['frame_index']}.jpg"
        out_persons.append({
            "id": pid,
            "frame_count": len(frames),
            "first_seen_ms": frames[0]["timestamp_ms"],
            "last_seen_ms": frames[-1]["timestamp_ms"],
            "frames": frames,
            "representative_crop": rep,
        })


    # ---- reference-image mode: keep only the matching person + presence segments
    reference_match = None
    if ref_emb is not None:
        REF_THRESH = float(os.environ.get("FACE_REF_THRESH", "0.38"))
        scored = []
        for p in out_persons:
            # average similarity of strong embeddings vs reference
            sims = []
            # reload not available; use match_similarity on frames if present, else skip
            # Use representative: we stored frames with match_similarity only for weak? 
            # Compute from observation quality ranking - need emb in obs
            pass
        # Re-score from persons list before crops-only out_persons
        scored = []
        for pid, p in enumerate(persons, start=1):
            if not p.obs:
                continue
            sims = [float(np.dot(ref_emb, o["emb"])) for o in p.obs]
            best_sim = max(sims) if sims else 0.0
            mean_sim = float(np.mean(sims)) if sims else 0.0
            scored.append((mean_sim, best_sim, pid, p))
        scored.sort(key=lambda x: -x[0])
        matched_persons = []
        for mean_sim, best_sim, pid, p in scored:
            if mean_sim < REF_THRESH and best_sim < REF_THRESH + 0.05:
                continue
            obs = sorted(p.obs + p.weak, key=lambda o: o["frame_index"])
            frames = []
            for o in obs:
                # filter weak that don't match ref if emb present
                if "emb" in o:
                    s = float(np.dot(ref_emb, o["emb"]))
                    if s < REF_THRESH - 0.05:
                        continue
                name = f"ref_f{o['frame_index']}.jpg"
                cv2.imwrite(str(out_dir / name), o["crop"])
                frames.append({
                    "frame_index": o["frame_index"],
                    "timestamp_ms": o["timestamp_ms"],
                    "timestamp": _fmt_ms(o["timestamp_ms"]),
                    "bbox": o["bbox"],
                    "confidence": round(o["confidence"], 3),
                    "match_similarity": round(float(np.dot(ref_emb, o["emb"])), 3) if "emb" in o else None,
                    "crop_url": f"/uploads/vision/{out_dir.name}/{name}",
                })
            if not frames:
                continue
            ts_list = [f["timestamp_ms"] for f in frames]
            segs = build_segments(ts_list, gap_ms=int(2500 * (60 / max(1, sampled)) if sampled else 2500))
            total_dur = sum(s["duration_ms"] for s in segs)
            # if single-frame segments, estimate duration as sample interval
            if total_dur == 0 and frames:
                # approximate: each isolated sighting counts as one sample interval
                sample_interval = int(1000 * (total / max(1, sampled)) / max(1, fps) * fps) if False else 0
                # use gap between targets approx
                if len(targets) >= 2:
                    sample_interval = int((targets[1] - targets[0]) / fps * 1000)
                else:
                    sample_interval = int(1000)
                for s in segs:
                    if s["duration_ms"] == 0:
                        s["duration_ms"] = sample_interval
                        s["duration"] = _fmt_dur(sample_interval)
                total_dur = sum(s["duration_ms"] for s in segs)
            matched_persons.append({
                "id": pid,
                "match_score": round(mean_sim, 3),
                "best_similarity": round(best_sim, 3),
                "frame_count": len(frames),
                "first_seen_ms": frames[0]["timestamp_ms"],
                "last_seen_ms": frames[-1]["timestamp_ms"],
                "first_seen": _fmt_ms(frames[0]["timestamp_ms"]),
                "last_seen": _fmt_ms(frames[-1]["timestamp_ms"]),
                "total_duration_ms": total_dur,
                "total_duration": _fmt_dur(total_dur),
                "segments": segs,
                "frames": frames,
                "representative_crop": frames[0]["crop_url"],
            })
        out_persons = matched_persons
        reference_match = {
            "enabled": True,
            "threshold": REF_THRESH,
            "persons_matched": len(matched_persons),
            "total_duration_ms": sum(p["total_duration_ms"] for p in matched_persons),
            "total_duration": _fmt_dur(sum(p["total_duration_ms"] for p in matched_persons)),
        }
    else:
        # still attach segments for each person in general mode
        for p in out_persons:
            ts_list = [f["timestamp_ms"] for f in p.get("frames") or []]
            segs = build_segments(ts_list)
            total_dur = sum(s["duration_ms"] for s in segs)
            if total_dur == 0 and segs and len(targets) >= 2:
                sample_interval = int((targets[1] - targets[0]) / fps * 1000)
                for s in segs:
                    if s["duration_ms"] == 0:
                        s["duration_ms"] = sample_interval
                        s["duration"] = _fmt_dur(sample_interval)
                total_dur = sum(s["duration_ms"] for s in segs)
            p["segments"] = segs
            p["total_duration_ms"] = total_dur
            p["total_duration"] = _fmt_dur(total_dur)
            p["first_seen"] = _fmt_ms(p["first_seen_ms"]) if p.get("first_seen_ms") is not None else None
            p["last_seen"] = _fmt_ms(p["last_seen_ms"]) if p.get("last_seen_ms") is not None else None
        reference_match = {"enabled": False}

    print(json.dumps({
        "success": True,
        "video": str(video_path.name),
        "fps": fps,
        "total_frames_sampled": sampled,
        "faces_detected": faces_total,
        "faces_too_small_to_identify": small_skipped,
        "faces_rejected_low_quality": low_quality,
        "uncertain_clusters_dropped": dropped,
        "persons_found": len(out_persons),
        "persons": out_persons,
        "reference_match": reference_match,
        "embedder": "mobilefacenet_w600k_mbf (landmark-aligned)",
        "detector": "blazeface_short_range (tiled multi-scale)",
        "partial": bool(time.time() - t0 > TIME_BUDGET),
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
