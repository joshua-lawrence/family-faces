"""Lay every face out in 2D so similar-looking faces sit together (UMAP on the ArcFace
embeddings), and pack small thumbnails into one sprite sheet for fast drawing.

Writes data/map.json and data/atlas.jpg. Re-run after embed.py or rotate.py add faces.
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np
import umap
from family_faces import config

DATA = config.DATA
TILE = 48


def main():
    faces = json.loads((DATA / "faces.json").read_text())
    emb = np.load(DATA / "embeddings.npy")
    xy = umap.UMAP(n_neighbors=15, min_dist=0.15, metric="cosine", random_state=7).fit_transform(emb)
    xy = (xy - xy.min(0)) / (xy.max(0) - xy.min(0)).max()   # fit in a unit square, keep aspect

    cols = math.ceil(math.sqrt(len(faces)))
    atlas = np.zeros((math.ceil(len(faces) / cols) * TILE, cols * TILE, 3), np.uint8)
    for f in faces:
        t = cv2.imread(str(DATA / "thumbs" / f"{f['id']}.jpg"))
        if t is not None:
            r, c = divmod(f["id"], cols)
            atlas[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE] = cv2.resize(t, (TILE, TILE), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(DATA / "atlas.jpg"), atlas, [cv2.IMWRITE_JPEG_QUALITY, 82])
    (DATA / "map.json").write_text(json.dumps({
        "xy": [[round(float(a), 4), round(float(b), 4)] for a, b in xy],
        "tile": TILE, "cols": cols,
    }))
    print(f"Mapped {len(faces)} faces; atlas {atlas.shape[1]}x{atlas.shape[0]}")


if __name__ == "__main__":
    main()
