"""Find photos that display sideways or upside down, using faces as the signal.

Each photo (as displayed, i.e. with its EXIF orientation applied) is run through the
face detector at 0/90/180/270 degrees clockwise; the rotation where faces come out upright
and most confidently detected wins. Writes data/orientation.json: {photo: {"rot": deg, "scores": [...]}}.
Photos with no detectable faces can't be judged and get rot 0.
"""

import json
from pathlib import Path

import cv2
import numpy as np
from insightface.app import FaceAnalysis
from tqdm import tqdm

import library
import config

HERE = Path(__file__).resolve().parent
ROTS = [None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE]


def upright_score(faces):
    total = 0.0
    for f in faces:
        if f.det_score < 0.6:
            continue
        (lx, ly), (rx, ry), (nx, ny), (ml, mly), (mr, mry) = f.kps
        eye_y, mouth_y = (ly + ry) / 2, (mly + mry) / 2
        eye_x, mouth_x = (lx + rx) / 2, (ml + mr) / 2
        down = mouth_y - eye_y
        if down > 0 and abs(mouth_x - eye_x) < down and lx < rx:   # eyes above mouth, not mirrored
            total += float(f.det_score)
    return round(total, 3)


def main():
    app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection"],
                       providers=config.onnx_providers())
    app.prepare(ctx_id=0, det_size=(640, 640), det_thresh=0.5)
    out = {}
    for rel in tqdm([p["path"] for p in library.photos()]):
        img = cv2.imread(str(library.abspath(rel)))
        s = 1200 / max(img.shape[:2])
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        scores = [upright_score(app.get(img if r is None else cv2.rotate(img, r))) for r in ROTS]
        best = int(np.argmax(scores))
        # Only call it rotated when the winning orientation is clearly better than as-is.
        rot = best * 90 if best and scores[best] >= 0.7 and scores[best] > 1.5 * scores[0] + 0.3 else 0
        out[rel] = {"rot": rot, "scores": scores}
    (config.DATA / "orientation.json").write_text(json.dumps(out, indent=0))
    flagged = {k: v for k, v in out.items() if v["rot"]}
    nofaces = sum(1 for v in out.values() if max(v["scores"]) == 0)
    print(f"{len(flagged)} photos need rotating; {nofaces} have no clear faces and weren't judged")


if __name__ == "__main__":
    main()
