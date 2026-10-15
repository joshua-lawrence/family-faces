"""Grow-up timelines, composite faces and same-age lookalikes for the Portraits tab.

Uses data/attrs.json (attrs.py + age.py) and the eye-aligned crops in data/aligned/.
"""

import hashlib
import json
import threading
from pathlib import Path

import cv2
import numpy as np
from family_faces import config

DATA = config.DATA
CACHE = DATA / "composites"
MORPHS = DATA / "morphs"
MORPH_VERSION = 2   # bump when morph.py's rendering changes, so cached videos are remade
IGNORE = "_ignore"
BANDS = [(0, 3, "Baby & toddler"), (4, 8, "4–8"), (9, 13, "9–13"), (14, 19, "Teens"), (20, 29, "20s"),
         (30, 39, "30s"), (40, 49, "40s"), (50, 59, "50s"), (60, 69, "60s"), (70, 200, "70+")]
MAX_COMPOSITE = 150

_attrs = None


def attrs():
    global _attrs
    if _attrs is None:
        p = DATA / "attrs.json"
        _attrs = {int(k): v for k, v in json.loads(p.read_text()).items()} if p.exists() else {}
    return _attrs


def good(fid, faces):
    """Clear, front-on, decently exposed: worth showing in a filmstrip or averaging."""
    a, f = attrs().get(fid), faces[fid]
    return bool(a and a["frontal"] and f["size"] >= 60 and f["score"] >= 0.7 and a["sharp"] >= 12
                and 60 <= a["bright"] <= 205 and a["contrast"] >= 25)


def smoothed_ages(ids, faces):
    """Estimated age per face. (Blending with nearby album pages was tried and dropped:
    the album isn't chronological enough, and it dragged babies toward their older photos.)"""
    A = attrs()
    return {i: A[i]["age"] for i in ids if i in A}


def timeline(name, order, names, faces):
    """The faces shown in the grow-up strip and video: clear ones, youngest first (or in
    album order), thinned evenly to at most 60."""
    A = attrs()
    fr = [{"id": i, "photo": faces[i]["photo"], "age": A[i]["age"]}
          for i in people_faces(names).get(name, []) if good(i, faces)]
    fr.sort(key=(lambda f: f["age"]) if order == "age" else (lambda f: f["photo"]))
    if len(fr) > 60:
        fr = [fr[round(k * (len(fr) - 1) / 59)] for k in range(60)]
    return fr


_render_locks = {}


def morph_video(name, order, names, faces):
    """Render (or reuse) the morph video for this exact timeline. Returns its URL and the
    time each face appears, or None if there are fewer than two clear faces."""
    from family_faces import morph
    fr = timeline(name, order, names, faces)
    if len(fr) < 2:
        return None
    key = hashlib.sha1(json.dumps([MORPH_VERSION, [f["id"] for f in fr]]).encode()).hexdigest()[:16]
    path, times_path = MORPHS / f"{key}.mp4", MORPHS / f"{key}.json"
    with _render_locks.setdefault(key, threading.Lock()):   # one render per video, even if asked twice
        if not path.exists():
            MORPHS.mkdir(exist_ok=True)
            tmp = MORPHS / f"{key}.part.mp4"
            times = morph.render(fr, tmp, attrs())
            times_path.write_text(json.dumps(times))
            tmp.replace(path)
    return {"url": f"/morphs/{key}.mp4", "times": json.loads(times_path.read_text())}


def band_of(age):
    for lo, hi, label in BANDS:
        if age < hi + 1:   # ages are fractional: 8.6 belongs to 4–8, not a gap
            return label
    return BANDS[-1][2]


def people_faces(names):
    by = {}
    for f, n in names.items():
        if n != IGNORE:
            by.setdefault(n, []).append(int(f))
    return by


def detail(name, names, faces, emb):
    by = people_faces(names)
    ids = by.get(name, [])
    if not ids:
        return {"name": name, "faces": []}
    ages = smoothed_ages(ids, faces)
    timeline_all = sorted(({"id": i, "age": ages[i], "photo": faces[i]["photo"], "good": good(i, faces)}
                           for i in ages), key=lambda x: x["age"])

    # Same-age lookalikes: compare this person's faces in each age band with everyone
    # else's faces in that same band (mean ArcFace embedding per person per band).
    def band_sets(person_ids):
        ag = smoothed_ages(person_ids, faces)
        sets = {}
        for i, a in ag.items():
            sets.setdefault(band_of(a), []).append(i)
        return sets

    mine = band_sets(ids)
    others = {n: band_sets(v) for n, v in by.items() if n != name and len(v) >= 3}
    bands = []
    for lo, hi, label in BANDS:
        mids = mine.get(label, [])
        if not mids:
            continue
        entry = {"label": label, "n": len(mids), "good": sum(good(i, faces) for i in mids), "like": []}
        if len(mids) >= 2:
            c = emb[mids].mean(0)
            c /= np.linalg.norm(c)
            scores = []
            for n, sets in others.items():
                oids = sets.get(label, [])
                if len(oids) >= 2:
                    oc = emb[oids].mean(0)
                    scores.append((float(c @ oc / np.linalg.norm(oc)), n, len(oids)))
            scores.sort(reverse=True)
            entry["like"] = [{"name": n, "sim": round(s, 3), "n": k} for s, n, k in scores[:3]]
        bands.append(entry)
    return {"name": name, "faces": timeline_all, "bands": bands,
            "timelines": {o: timeline(name, o, names, faces) for o in ("age", "album")},
            "photos": len({faces[i]["photo"] for i in ids})}


def _normalised(fid):
    """Aligned crop with its face brightness/contrast evened out, so dark and bright
    scans average together without one dominating."""
    img = cv2.imread(str(DATA / "aligned" / f"{fid}.jpg")).astype(np.float32) / 255
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    centre = lab[90:260, 60:196, 0]
    lab[..., 0] = np.clip((lab[..., 0] - centre.mean()) / (centre.std() + 1e-6) * 17 + 58, 0, 100)
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def _average(ids):
    acc = None
    for fid in ids:
        im = _normalised(fid)
        acc = im if acc is None else acc + im
    return acc / len(ids)


def _finish(img):
    """Averaging flattens contrast and colour; stretch the face's tones back out and
    restore some colour so the composite reads like a photo, not a ghost."""
    lab = cv2.cvtColor(img.astype(np.float32), cv2.COLOR_BGR2LAB)
    lo, hi = np.percentile(lab[60:290, 30:226, 0], [1, 99.5])
    lab[..., 0] = np.clip((lab[..., 0] - lo) / max(hi - lo, 1e-6) * 92 + 4, 0, 100)
    lab[..., 1:] *= 1.35
    return np.clip(cv2.cvtColor(lab, cv2.COLOR_LAB2BGR) * 255, 0, 255).astype(np.uint8)


def composite(name, band, names, faces, blend=None):
    """JPEG bytes of the averaged face for a person (optionally one age band), or a
    50/50 blend of two people. Cached on disk by the exact set of faces used."""
    by = people_faces(names)

    def pick(person):
        ids = [i for i in by.get(person, []) if good(i, faces)]
        if band and band != "all":
            ages = smoothed_ages(by.get(person, []), faces)
            ids = [i for i in ids if band_of(ages.get(i, -1)) == band]
        if len(ids) > MAX_COMPOSITE:   # keep the clearest ones
            ids = sorted(ids, key=lambda i: -attrs()[i]["sharp"])[:MAX_COMPOSITE]
        return sorted(ids)

    sets = [pick(name)] + ([pick(blend)] if blend else [])
    if not all(sets):
        return None
    key = hashlib.sha1(json.dumps(sets).encode()).hexdigest()[:16]
    path = CACHE / f"{key}.jpg"
    if not path.exists():
        CACHE.mkdir(exist_ok=True)
        img = _finish(sum(_average(s) for s in sets) / len(sets))
        cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return path.read_bytes()


def gallery(names, faces):
    by = people_faces(names)
    out = [{"name": n, "faces": len(v), "good": sum(good(i, faces) for i in v)} for n, v in by.items()]
    return sorted((p for p in out if p["good"] >= 3), key=lambda p: -p["faces"])
