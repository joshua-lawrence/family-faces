"""Compare face-recognition models on the faces you've already named.

    uv run python -m family_faces.pipeline.bakeoff

1. Cut a standard 112x112 ArcFace-aligned crop of every face from the original photo
   (cached in data/crops112.npy) so every model sees identical input.
2. Embed with: buffalo_l (current, ArcFace R50), antelopev2 (ArcFace R100, Glint360K),
   and AdaFace IR-101 (WebFace12M, built for low-quality faces) if weights are given.
   Embeddings are cached as data/emb_<model>.npy.
3. Score with album-block cross-validation: the album is cut into 5 contiguous chunks and
   each named face is matched only against named faces from the *other* chunks, so a face
   can't be "recognised" just because the same person, outfit and lighting is on the next
   page. That's closer to the real job of naming the leftover faces.
"""

import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from insightface.model_zoo import get_model
from insightface.utils import face_align
from tqdm import tqdm

from family_faces import library
from family_faces import config

HERE = Path(__file__).resolve().parent
DATA = config.DATA
MODELS = Path.home() / ".insightface/models"
ADAFACE = MODELS / "adaface_ir101_webface12m.safetensors"


def crops():
    path = DATA / "crops112.npy"
    attrs = {int(k): v for k, v in json.loads((DATA / "attrs.json").read_text()).items()}
    faces = json.loads((DATA / "faces.json").read_text())
    if path.exists():
        cached = np.load(DATA / "crops112_ids.npy")
        if len(cached) == len(attrs):   # same faces as last time
            return cached, np.load(path)
    by_photo = defaultdict(list)
    for f in faces:
        if f["id"] in attrs:
            by_photo[f["photo"]].append(f["id"])
    ids, out = [], []
    for photo, fids in tqdm(sorted(by_photo.items()), desc="crops"):
        img = cv2.imread(str(library.abspath(photo)))
        for fid in fids:
            out.append(face_align.norm_crop(img, np.array(attrs[fid]["kps"], np.float32), 112))
            ids.append(fid)
    ids, out = np.array(ids), np.stack(out)
    np.save(DATA / "crops112_ids.npy", ids)
    np.save(path, out)
    return ids, out


def normed(x):
    return x / np.linalg.norm(x, axis=1, keepdims=True)


def embed_onnx(name, onnx_path, imgs):
    path = DATA / f"emb_{name}.npy"
    if path.exists() and len(np.load(path, mmap_mode="r")) == len(imgs):
        return np.load(path)
    model = get_model(str(onnx_path), providers=config.onnx_providers())
    model.prepare(ctx_id=0)
    out = np.vstack([model.get_feat(list(imgs[i:i + 64])) for i in tqdm(range(0, len(imgs), 64), desc=name)])
    np.save(path, normed(out))
    return np.load(path)


def embed_adaface(weights, imgs):
    path = DATA / "emb_adaface.npy"
    if path.exists() and len(np.load(path, mmap_mode="r")) == len(imgs):
        return np.load(path)
    import torch
    from family_faces.pipeline import adaface_net
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    net = adaface_net.load(Path(weights), dev)
    out = []
    with torch.no_grad():
        for i in tqdm(range(0, len(imgs), 64), desc="adaface"):
            x = imgs[i:i + 64][..., ::-1].astype(np.float32) / 255.0      # BGR -> RGB, [0, 1]
            x = torch.from_numpy((x - 0.5) / 0.5).permute(0, 3, 1, 2).contiguous().to(dev)
            out.append(net(x).cpu().numpy())
    np.save(path, normed(np.vstack(out)))
    return np.load(path)


def evaluate(embs, ids, faces, names, attrs, folds=5):
    """Album-block cross-validated nearest-named-face accuracy, overall and on hard subsets."""
    lab = np.array([names.get(str(i), "") for i in ids])
    keep = (lab != "") & (lab != "_ignore")
    counts = defaultdict(int)
    for n in lab[keep]:
        counts[n] += 1
    keep &= np.array([counts[n] >= 3 for n in lab])
    idx = np.where(keep)[0]
    order = library.order()
    pos = np.array([order[faces[ids[i]]["photo"]] for i in idx])
    block = np.minimum((pos - pos.min()) * folds // (pos.max() - pos.min() + 1), folds - 1)
    age = np.array([attrs[ids[i]]["age"] for i in idx])
    size = np.array([faces[ids[i]]["size"] for i in idx])
    subsets = {"all": np.ones(len(idx), bool), "children (<10)": age < 10,
               "small faces (<80px)": size < 80, "adults": age >= 20}
    results = {}
    for name, e in embs.items():
        X, y = e[idx], lab[idx]
        hit = np.zeros(len(idx), bool)
        tested = np.zeros(len(idx), bool)
        for b in range(folds):
            test, train = block == b, block != b
            known = set(y[train])
            t = test & np.array([n in known for n in y])   # only people who also appear elsewhere
            if not t.any():
                continue
            sims = X[t] @ X[train].T
            hit[t] = y[train][sims.argmax(1)] == y[t]
            tested |= t
        results[name] = {k: (hit[m & tested].mean(), int((m & tested).sum())) for k, m in subsets.items()}
    return results


def main():
    faces = json.loads((DATA / "faces.json").read_text())
    names = json.loads((DATA / "labels.json").read_text())["names"]
    attrs = {int(k): v for k, v in json.loads((DATA / "attrs.json").read_text()).items()}
    ids, imgs = crops()
    embs = {
        "buffalo_l (current)": embed_onnx("buffalo", MODELS / "buffalo_l/w600k_r50.onnx", imgs),
        "antelopev2": embed_onnx("antelope", MODELS / "antelopev2/glintr100.onnx", imgs),
    }
    if ADAFACE.exists():
        embs["adaface"] = embed_adaface(ADAFACE, imgs)
    keys = list(embs)
    for a in range(len(keys)):
        for b in range(a + 1, len(keys)):
            embs[f"{keys[a]} + {keys[b]}"] = normed(np.hstack([embs[keys[a]], embs[keys[b]]]))
    if len(keys) == 3:
        embs["all three"] = normed(np.hstack([embs[k] for k in keys]))

    res = evaluate(embs, ids, faces, names, attrs)
    subsets = list(next(iter(res.values())))
    print(f"\n{'model':42s}" + "".join(f"{s:>22s}" for s in subsets))
    print(f"{'(faces tested)':42s}" + "".join(f"{next(iter(res.values()))[s][1]:>22d}" for s in subsets))
    for name, r in res.items():
        print(f"{name:42s}" + "".join(f"{r[s][0]:>21.1%} " for s in subsets))
    (DATA / "bakeoff.json").write_text(json.dumps({k: {s: v[0] for s, v in r.items()} for k, r in res.items()}, indent=1))


if __name__ == "__main__":
    main()
