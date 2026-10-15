"""Estimate age for every face and save an eye-aligned portrait crop of it.

Re-detects faces (with landmarks + InsightFace's age model) and matches them to the
existing face records by box overlap, so face ids and names are untouched.

Writes data/attrs.json  {face_id: {"age", "sex", "kps": [[x, y] x5], "frontal", "sharp", "bright", "contrast"}}
(age.py then replaces "age" with a better CLIP-based estimate)
and data/aligned/<id>.jpg (256x320, eyes and mouth in the same place in every crop),
which the Portraits tab uses for grow-up filmstrips and composite faces.
"""

import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from insightface.app import FaceAnalysis
from tqdm import tqdm

import library
from embed import DET_SIZE, load
import config

HERE = Path(__file__).resolve().parent
DATA = config.DATA
ALIGNED = DATA / "aligned"
W, H = 256, 320

# ArcFace's 5-point template (112x112), re-centred and scaled into a looser portrait frame
# that keeps hair and chin: eyes land 42% of the way down.
ARCFACE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                    [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)
TEMPLATE = (ARCFACE - [56.0, 51.6]) * 1.45 + [W / 2, H * 0.42]


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def is_frontal(kps):
    (lx, ly), (rx, ry), (nx, ny), _, _ = kps
    eye_dist = np.hypot(rx - lx, ry - ly)
    return bool(eye_dist > 0 and abs(nx - (lx + rx) / 2) / eye_dist < 0.22)


def crop_quality(crop):
    """Sharpness and exposure of the central face area of an aligned crop."""
    g = cv2.cvtColor(crop[90:260, 60:196], cv2.COLOR_BGR2GRAY)
    return {"sharp": round(float(cv2.Laplacian(g, cv2.CV_64F).var()), 1),
            "bright": round(float(g.mean()), 1), "contrast": round(float(g.std()), 1)}


def aligned_crop(img, kps):
    """256x320 portrait crop with the eyes and mouth in the standard place."""
    m, _ = cv2.estimateAffinePartial2D(np.asarray(kps, np.float32), TEMPLATE, method=cv2.LMEDS)
    return cv2.warpAffine(img, m, (W, H), flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REPLICATE)


def main():
    ALIGNED.mkdir(parents=True, exist_ok=True)
    faces = json.loads((DATA / "faces.json").read_text())
    by_photo = defaultdict(list)
    for f in faces:
        by_photo[f["photo"]].append(f)

    app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "genderage"],
                       providers=config.onnx_providers())
    app.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE), det_thresh=0.5)

    attrs = {}
    for photo, fs in tqdm(sorted(by_photo.items())):
        img, scale = load(library.abspath(photo))
        if img is None:
            continue
        dets = app.get(img)
        for f in fs:
            box = [v * scale for v in f["bbox"]]
            best = max(dets, key=lambda d: iou(d.bbox, box), default=None)
            if best is None or iou(best.bbox, box) < 0.3:
                continue
            kps = best.kps.astype(np.float32)
            crop = aligned_crop(img, kps)
            cv2.imwrite(str(ALIGNED / f"{f['id']}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
            attrs[f["id"]] = {
                "age": int(best.age), "sex": "M" if best.sex == "M" else "F",
                "kps": [[round(float(x) / scale, 1), round(float(y) / scale, 1)] for x, y in kps],
                "frontal": is_frontal(kps),
                **crop_quality(crop),
            }
    (DATA / "attrs.json").write_text(json.dumps(attrs))
    print(f"{len(attrs)} of {len(faces)} faces got an age and an aligned crop; "
          f"{sum(a['frontal'] for a in attrs.values())} are roughly front-on")


def fill_missing(progress=lambda stage, done, total: None):
    """Give faces that have no attrs yet (the FamilySearch import's) their eye/mouth points, aligned crop and
    quality, using the import's worker processes. Their ages are marked pending for age.py. Returns
    (filled, unmatched)."""
    import pipeline
    ALIGNED.mkdir(parents=True, exist_ok=True)
    faces = json.loads((DATA / "faces.json").read_text())
    path = DATA / "attrs.json"
    attrs = json.loads(path.read_text()) if path.exists() else {}
    by_photo = defaultdict(list)
    for f in faces:
        if str(f["id"]) not in attrs:
            by_photo[f["photo"]].append(f)
    if not by_photo:
        return 0, 0
    total = sum(len(v) for v in by_photo.values())
    filled = unmatched = done = 0

    def save():
        tmp = DATA / "attrs.json.tmp"
        tmp.write_text(json.dumps(attrs))
        tmp.replace(path)

    pool = pipeline._pool()
    try:
        photos = list(by_photo)
        futs = pool.map(pipeline._redetect, photos, [[f["bbox"] for f in by_photo[p]] for p in photos], chunksize=4)
        for photo, res in zip(photos, futs):
            for f, r in zip(by_photo[photo], res):
                done += 1
                if r is None:
                    unmatched += 1
                    continue
                (ALIGNED / f"{f['id']}.jpg").write_bytes(r["aligned"])
                attrs[str(f["id"])] = r["attrs"]
                filled += 1
            if done % 500 < len(res):
                progress("Finding eyes for faces without them", done, total)
            if filled and filled % 4000 < len(res):
                save()
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        save()
    return filled, unmatched


if __name__ == "__main__":
    main()
