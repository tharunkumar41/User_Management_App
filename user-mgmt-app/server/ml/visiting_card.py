#!/usr/bin/env python3
"""Visiting Card Reader: OCR via Tesseract CLI (no pytesseract/pandas) + Pillow."""
import sys
import json
import re
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageOps, ImageFilter, ImageEnhance
except ImportError:
    print(json.dumps({"error": "Pillow not installed. Run: python -m pip install Pillow"}))
    sys.exit(1)

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")
PHONE_RE = re.compile(r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}")
URL_RE = re.compile(r"(?:https?://|www\.)[^\s]+", re.I)


def find_tesseract():
    env = os.environ.get("TESSERACT_CMD") or os.environ.get("TESSDATA_PREFIX")
    candidates = []
    which = shutil.which("tesseract")
    if which:
        candidates.append(which)
    if sys.platform == "win32":
        candidates.extend([
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Tesseract-OCR\tesseract.exe"),
        ])
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def run_ocr(image_path, tesseract_cmd):
    """Call tesseract CLI; returns text. Avoids pytesseract → pandas import chain."""
    cmd = [
        tesseract_cmd,
        str(image_path),
        "stdout",
        "--oem", "3",
        "--psm", "6",
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except FileNotFoundError:
        raise RuntimeError("Tesseract executable not found")
    except subprocess.TimeoutExpired:
        raise RuntimeError("OCR timed out")
    if proc.returncode != 0 and not proc.stdout.strip():
        err = (proc.stderr or "").strip() or f"tesseract exit {proc.returncode}"
        raise RuntimeError(err)
    return proc.stdout or ""


def extract_fields(text: str) -> dict:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    emails = EMAIL_RE.findall(text)
    phones = PHONE_RE.findall(text)
    urls = URL_RE.findall(text)

    name = None
    company = None
    title = None
    address_lines = []
    skip_words = {"tel", "phone", "mobile", "email", "fax", "www", "http", "https", "cell"}

    for ln in lines:
        low = ln.lower()
        if any(w in low for w in skip_words):
            continue
        if EMAIL_RE.search(ln) or PHONE_RE.search(ln) or URL_RE.search(ln):
            continue
        words = ln.split()
        if not name and 1 <= len(words) <= 4 and not any(c.isdigit() for c in ln):
            if ln[0].isupper() or all(w[0].isupper() for w in words if w):
                name = ln
                continue
        if not company and len(words) >= 1 and (
            any(k in low for k in ["ltd", "inc", "llc", "pvt", "corp", "company", "technologies", "solutions", "systems"])
            or len(words) >= 2
        ):
            company = ln
            continue
        if not title and len(words) <= 5 and any(
            k in low
            for k in ["manager", "director", "ceo", "cto", "engineer", "developer", "consultant", "officer", "head", "lead", "founder"]
        ):
            title = ln
            continue
        if any(c.isdigit() for c in ln) and len(ln) > 8:
            address_lines.append(ln)

    if not name and lines:
        for ln in lines:
            if not EMAIL_RE.search(ln) and not PHONE_RE.search(ln) and len(ln.split()) <= 4:
                name = ln
                break

    return {
        "name": name,
        "title": title,
        "company": company,
        "emails": list(dict.fromkeys(emails)),
        "phones": list(dict.fromkeys(p.strip() for p in phones if len(re.sub(r"\D", "", p)) >= 7)),
        "websites": list(dict.fromkeys(urls)),
        "address": " ".join(address_lines) if address_lines else None,
        "raw_text": text.strip(),
        "lines": lines,
    }


def preprocess(img: Image.Image) -> Image.Image:
    img = ImageOps.exif_transpose(img)
    img = img.convert("L")
    w, h = img.size
    if max(w, h) < 1000:
        scale = 1000 / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
    img = ImageOps.autocontrast(img)
    img = img.filter(ImageFilter.SHARPEN)
    return img


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: visiting_card.py <image_path>"}))
        sys.exit(1)
    path = Path(sys.argv[1])
    if not path.exists():
        print(json.dumps({"error": f"File not found: {path}"}))
        sys.exit(1)

    tess = find_tesseract()
    if not tess:
        print(json.dumps({
            "error": "Tesseract OCR is not installed or not on PATH. "
                     "Install from https://github.com/UB-Mannheim/tesseract/wiki "
                     "and restart the server."
        }))
        sys.exit(1)

    try:
        img = Image.open(path)
    except Exception as e:
        print(json.dumps({"error": f"Could not read image: {e}"}))
        sys.exit(1)

    processed = preprocess(img)

    # Write temp PNG for tesseract CLI
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        processed.save(tmp_path, format="PNG")
        try:
            text = run_ocr(tmp_path, tess)
        except Exception as e:
            print(json.dumps({"error": f"OCR failed: {e}"}))
            sys.exit(1)

        if len(text.strip()) < 10:
            enhanced = ImageEnhance.Contrast(processed).enhance(2.0)
            enhanced.save(tmp_path, format="PNG")
            try:
                text = run_ocr(tmp_path, tess)
            except Exception:
                pass
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    result = extract_fields(text)
    result["success"] = True
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
