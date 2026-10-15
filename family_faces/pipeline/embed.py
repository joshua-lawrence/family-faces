"""Detect every face in the album and compute its ArcFace embedding.

Writes data/faces.json (one record per face), data/embeddings.npy (L2-normalised,
row-aligned with faces.json) and a thumbnail per face in data/thumbs/.
Resumable: images already processed are skipped.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from insightface.app import FaceAnalysis
from tqdm import tqdm

from family_faces import library
from family_faces import config

DATA = config.DATA
THUMBS = DATA / "thumbs"
DET_SIZE = 1024          # higher than the 640 default so small faces in group shots are found
MAX_SIDE = 2400          # downscale huge scans before detection
THUMB = 160


def load(path):
    img = cv2.imread(str(path))
    if img is None:
        return None, 1.0
    h, w = img.shape[:2]
    scale = min(1.0, MAX_SIDE / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img, scale


def thumb(img, bbox):
    x1, y1, x2, y2 = bbox
    cx, cy, s = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1) * 0.8
    h, w = img.shape[:2]
    crop = img[max(0, int(cy - s)):min(h, int(cy + s)), max(0, int(cx - s)):min(w, int(cx + s))]
    return cv2.resize(crop, (THUMB, THUMB), interpolation=cv2.INTER_AREA) if crop.size else None


def main():
    THUMBS.mkdir(parents=True, exist_ok=True)
    faces_path, emb_path = DATA / "faces.json", DATA / "embeddings.npy"
    # After reembed.py, embeddings.npy holds the combined buffalo_l + AdaFace vectors and the
    # detector's own buffalo_l vectors live in embeddings_buffalo_detect.npy.
    det_path = DATA / "embeddings_buffalo_detect.npy"
    upgraded = det_path.exists()
    faces = json.loads(faces_path.read_text()) if faces_path.exists() else []
    src = det_path if upgraded else emb_path
    embs = list(np.load(src)) if src.exists() else []
    done_path = DATA / "done.json"
    done = set(json.loads(done_path.read_text())) if done_path.exists() else set()

    app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"],
                       providers=config.onnx_providers())
    app.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE), det_thresh=0.5)

    limit = int(sys.argv[1]) if len(sys.argv) > 1 else None
    todo = [p["path"] for p in library.photos() if p["path"] not in done][:limit]

    def save():
        faces_path.write_text(json.dumps(faces))
        done_path.write_text(json.dumps(sorted(done)))
        det = np.array(embs, dtype=np.float32).reshape(-1, 512)
        if not upgraded:
            np.save(emb_path, det)
            return
        np.save(det_path, det)
        combined = np.load(emb_path)
        if len(combined) < len(det):   # new faces: zero-padded until reembed.py runs
            new = det[len(combined):]
            combined = np.vstack([combined, np.hstack([new, np.zeros_like(new)])])
        np.save(emb_path, combined)

    for i, rel in enumerate(tqdm(todo, desc="photos")):
        img, scale = load(library.abspath(rel))
        if img is not None:
            for f in app.get(img):
                fid = len(faces)
                bbox = [float(v) for v in f.bbox]
                t = thumb(img, bbox)
                if t is not None:
                    cv2.imwrite(str(THUMBS / f"{fid}.jpg"), t, [cv2.IMWRITE_JPEG_QUALITY, 85])
                faces.append({
                    "id": fid,
                    "photo": rel,
                    "bbox": [round(v / scale, 1) for v in bbox],   # original-image pixels
                    "size": round(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / scale),
                    "score": round(float(f.det_score), 3),
                    "img_w": round(img.shape[1] / scale),
                })
                embs.append(f.normed_embedding.astype(np.float32))
        done.add(rel)
        if i % 100 == 99:
            save()
    save()
    print(f"{len(done)} photos processed, {len(faces)} faces total")
    if upgraded:
        print("Next: attrs.py, age.py and reembed.py, then cluster.py and map.py")


if __name__ == "__main__":
    main()
