"""Switch every face's fingerprint to the combined buffalo_l + AdaFace embedding.

    uv run python reembed.py

bakeoff.py showed this combination makes about a quarter fewer mistakes on children and
small faces than buffalo_l alone, with the same similarity scale (so the app's thresholds
still hold). Run after embed.py/attrs.py whenever faces are added; then cluster.py and map.py.

Faces that attrs.py couldn't re-find (a handful) keep their original buffalo_l vector,
zero-padded. The original detector-time embeddings are kept in embeddings_buffalo_detect.npy.
"""

import json
import shutil

import numpy as np

from bakeoff import ADAFACE, DATA, MODELS, crops, embed_adaface, embed_onnx, normed


def main():
    faces = json.loads((DATA / "faces.json").read_text())
    original = DATA / "embeddings_buffalo_detect.npy"
    if not original.exists():
        shutil.copy2(DATA / "embeddings.npy", original)
    old = np.load(original)

    ids, imgs = crops()
    combined = normed(np.hstack([embed_onnx("buffalo", MODELS / "buffalo_l/w600k_r50.onnx", imgs),
                                 embed_adaface(ADAFACE, imgs)]))
    out = np.hstack([old, np.zeros_like(old)])            # fallback for faces without a crop
    out[ids] = combined
    np.save(DATA / "embeddings.npy", out.astype(np.float32))
    print(f"{len(ids)} of {len(faces)} faces now use buffalo_l + AdaFace ({out.shape[1]}-d)")


if __name__ == "__main__":
    main()
