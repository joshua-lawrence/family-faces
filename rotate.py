"""Rotate the photos orient.py flagged, losslessly, and keep the face data in step.

    uv run python rotate.py            # dry run: list what would change
    uv run python rotate.py --apply

For each photo: back up the original to originals_before_rotation/, bake the final
orientation into the pixels with jpegtran (lossless) and reset the EXIF Orientation tag
to 1, so it displays upright everywhere (including sites that ignore EXIF). Then
re-detect faces in that photo: existing faces keep their ids (and your names), their
boxes/thumbnails/embeddings are refreshed, and newly found faces join the leftovers.
Afterwards run attrs.py, age.py and reembed.py so the new faces get full embeddings.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from insightface.app import FaceAnalysis
from PIL import Image

import library

from embed import DET_SIZE, THUMB, THUMBS, load, thumb
import config

HERE = Path(__file__).resolve().parent
DATA = config.DATA
BACKUP = (HERE if config.LEGACY else config.DATA) / "originals_before_rotation"
EXIF_CW = {1: 0, 3: 180, 6: 90, 8: 270}   # clockwise turn each EXIF orientation applies
SKIP = set(config.SETTINGS.get("rotate_skip", []))   # photos that look sideways but are meant to be (a cartwheel)


def rotate_box(b, deg, w, h):
    """Rotate an [x1,y1,x2,y2] box clockwise by deg inside a w x h image."""
    x1, y1, x2, y2 = b
    if deg == 90:
        return [h - y2, x1, h - y1, x2]
    if deg == 180:
        return [w - x2, h - y2, w - x1, h - y1]
    if deg == 270:
        return [y1, w - x2, y2, w - x1]
    return b


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def fix_file(path, total_cw):
    if total_cw:
        tmp = path.with_suffix(".rot.jpg")
        for mode in ("-perfect", "-trim"):
            r = subprocess.run(["jpegtran", "-copy", "all", mode, "-rotate", str(total_cw),
                                "-outfile", str(tmp), str(path)], capture_output=True)
            if r.returncode == 0:
                break
        else:
            raise RuntimeError(f"jpegtran failed on {path.name}: {r.stderr.decode()}")
        tmp.replace(path)
    subprocess.run(["exiftool", "-q", "-overwrite_original", "-n", "-Orientation=1", str(path)], check=True)


def main(apply):
    orient = json.loads((DATA / "orientation.json").read_text())
    todo = {p: v["rot"] for p, v in orient.items() if v["rot"] and p not in SKIP}
    plan = []
    for photo, rot in sorted(todo.items()):
        exif = Image.open(library.abspath(photo)).getexif().get(274, 1)
        plan.append((photo, rot, (EXIF_CW.get(exif, 0) + rot) % 360))
    print(f"{len(plan)} photos to fix; {sum(1 for p in plan if p[2] == 0)} only need their EXIF tag reset")
    if not apply:
        return

    faces = json.loads((DATA / "faces.json").read_text())
    emb = np.load(DATA / "embeddings.npy")
    clusters = json.loads((DATA / "clusters.json").read_text())
    by_photo = {}
    for f in faces:
        by_photo.setdefault(f["photo"], []).append(f)

    app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition"],
                       providers=config.onnx_providers())
    app.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE), det_thresh=0.5)

    BACKUP.mkdir(exist_ok=True)
    new_embs, added, refreshed = [], 0, 0
    for photo, rot, total in plan:
        path = library.abspath(photo)
        backup = BACKUP / photo.replace("/", "__")
        if not backup.exists():
            shutil.copy2(path, backup)
        old = by_photo.get(photo, [])
        if old:
            # Old boxes are in the old displayed frame; its height comes from the pre-fix image.
            h0, w0 = cv2.imread(str(backup)).shape[:2]
        fix_file(path, total)

        for f in old:
            f["bbox"] = [round(v, 1) for v in rotate_box(f["bbox"], rot, w0, h0)]
        img, scale = load(path)
        unmatched = list(old)
        for det in app.get(img):
            box = [float(v) / scale for v in det.bbox]
            match = max(unmatched, key=lambda f: iou(f["bbox"], box), default=None)
            if match is not None and iou(match["bbox"], box) > 0.3:
                unmatched.remove(match)
                fid = match["id"]
                refreshed += 1
            else:
                fid = len(faces)
                faces.append({"id": fid, "photo": photo})
                new_embs.append(None)
                clusters["unclustered"].append(fid)
                added += 1
            f = faces[fid]
            f.update({"bbox": [round(v, 1) for v in box],
                      "size": round(max(box[2] - box[0], box[3] - box[1])),
                      "score": round(float(det.det_score), 3),
                      "img_w": round(img.shape[1] / scale)})
            vec = det.normed_embedding.astype(np.float32)
            if emb.shape[1] != len(vec):   # combined embeddings: placeholder until reembed.py runs
                vec = np.concatenate([vec, np.zeros(emb.shape[1] - len(vec), np.float32)])
            if fid < len(emb):
                emb[fid] = vec
            else:
                new_embs[fid - len(emb)] = vec
            t = thumb(img, [v * scale for v in box])
            if t is not None:
                cv2.imwrite(str(THUMBS / f"{fid}.jpg"), t, [cv2.IMWRITE_JPEG_QUALITY, 85])
        for f in unmatched:   # not re-found upright: keep the old record, just re-crop its thumbnail
            t = thumb(img, [v * scale for v in f["bbox"]])
            if t is not None:
                cv2.imwrite(str(THUMBS / f"{f['id']}.jpg"), t, [cv2.IMWRITE_JPEG_QUALITY, 85])

    if new_embs:
        emb = np.vstack([emb, np.array(new_embs, dtype=np.float32)])
    (DATA / "faces.json").write_text(json.dumps(faces))
    np.save(DATA / "embeddings.npy", emb)
    (DATA / "clusters.json").write_text(json.dumps(clusters))
    print(f"Rotated {len(plan)} photos. {refreshed} existing faces refreshed, "
          f"{added} new faces found (they're in Leftover faces). Originals backed up to {BACKUP}")


if __name__ == "__main__":
    main("--apply" in sys.argv)
