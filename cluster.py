"""Group faces by identity and attach caption-derived name hints.

Writes data/clusters.json. Labels live in data/labels.json and are stored per
face, so re-running this (e.g. with a different threshold) never loses names.

    uv run python cluster.py [threshold] [--only-unnamed]

--only-unnamed groups just the faces that have no name yet (named and ignored faces
are left out), and clears the "removed from group" marks, which only made sense for
the old groups. Stop serve.py first: it keeps labels in memory.
"""

import collections
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from sklearn.cluster import AgglomerativeClustering

import library
from familysearch_scope import load_scope
import config

HERE = Path(__file__).resolve().parent
DATA = config.DATA
ONLY_UNNAMED = "--only-unnamed" in sys.argv
THRESHOLD = 0.65   # cosine distance; lower = stricter
MIN_SCORE, MIN_SIZE = 0.6, 40   # weaker detections skip clustering and go to the leftovers queue

NOT_NAMES = set("""
A An And At By For From In Of On Our The To With Me My Mr Mrs Ms Dr Front Back Row Left Right
Christmas Easter Thanksgiving Birthday Halloween Sunday Monday Tuesday Wednesday Thursday Friday Saturday
January February March April May June July August September October November December
Church Family Families Reunion House Home Yard Tree Trip Party Wedding Farewell Mission Day Days
Years Year Old Weeks Months Card Dolls Cabbage Patch Learned Going Went Leaving Picture Photo
""".split())


def caption_names(text):
    names = set()
    for tok in re.findall(r"\b[A-Z][a-zA-Z]+(?:'s)?", text):
        tok = re.sub(r"'s$", "", tok)
        if tok not in NOT_NAMES and len(tok) > 1:
            names.add(tok)
    return names


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    threshold = float(args[0]) if args else THRESHOLD
    labels_path = DATA / "labels.json"
    named = set()
    if ONLY_UNNAMED and labels_path.exists():
        labels_doc = json.loads(labels_path.read_text())
        named = {int(f) for f in labels_doc["names"]}
        labels_doc["rejected"] = []
        labels_path.write_text(json.dumps(labels_doc, indent=1))
    print(build(named, threshold))


def build(named=frozenset(), threshold=THRESHOLD, scope=None, data_dir=None, output=None):
    """Group every face not in `named` and write data/clusters.json. Returns a summary line."""
    data = Path(data_dir) if data_dir is not None else DATA
    faces = json.loads((data / "faces.json").read_text())
    emb = np.load(data / "embeddings.npy")
    captions = library.captions()
    scope = scope or load_scope()
    eligible = {f['id'] for f in faces if scope.allows_face(f)}
    captions = {p: c for p, c in captions.items()
                if p not in scope.source_paths or p in scope.allowed_paths}
    good = np.array([f["score"] >= MIN_SCORE and f["size"] >= MIN_SIZE
                     and f["id"] not in named and f['id'] in eligible for f in faces])
    ids = np.where(good)[0]
    labels = (AgglomerativeClustering(n_clusters=None, metric="cosine", linkage="average",
                                     distance_threshold=threshold).fit_predict(emb[ids])
              if len(ids) > 1 else np.arange(len(ids)))

    groups = collections.defaultdict(list)
    for fid, lab in zip(ids, labels):
        groups[lab].append(int(fid))

    # Caption name hints: names that are over-represented in this cluster's photos.
    photo_names = {p: caption_names(c) for p, c in captions.items() if c}
    global_df = collections.Counter(n for ns in photo_names.values() for n in ns)
    n_captioned = len(photo_names)

    clusters = []
    for members in groups.values():
        if len(members) < 2:
            continue
        centroid = emb[members].mean(0)
        centroid /= np.linalg.norm(centroid)
        sims = emb[members] @ centroid
        order = np.argsort(-sims)
        members = [members[i] for i in order]
        photos = sorted({faces[m]["photo"] for m in members})
        capped = [p for p in photos if p in photo_names]
        df = collections.Counter(n for p in capped for n in photo_names[p])
        hints = []
        for name, k in df.items():
            lift = (k / len(capped)) / (global_df[name] / n_captioned)
            if lift > 1.5:
                hints.append((name, k, k * math.log(lift)))
        hints.sort(key=lambda h: -h[2])
        clusters.append({
            "faces": members,
            "sims": [round(float(s), 3) for s in sims[order]],
            "photos": len(photos),
            "captioned": len(capped),
            "hints": [[n, k] for n, k, _ in hints[:4]],
        })

    clusters.sort(key=lambda c: -len(c["faces"]))
    for i, c in enumerate(clusters):
        c["id"] = i
    clustered = {f for c in clusters for f in c["faces"]}
    unclustered = [f['id'] for f in faces
                   if f['id'] in eligible and f['id'] not in clustered and f['id'] not in named]
    destination = Path(output) if output is not None else data / 'clusters.json'
    tmp = destination.with_suffix('.tmp')
    tmp.write_text(json.dumps({
        "threshold": threshold,
        "face_count": len(faces),
        "familysearch_matching": scope.summary(),
        "clusters": clusters,
        "unclustered": unclustered,
    }))
    tmp.replace(destination)
    return (f"{len(clusters)} clusters covering {len(clustered)} faces; "
            f"{len(unclustered)} unnamed faces left for one-by-one review")


if __name__ == "__main__":
    main()
