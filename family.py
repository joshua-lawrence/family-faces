"""Family faces: average faces generation by generation along the family tree.

Every group average gives each *person* equal weight (each person is first reduced to
their own average face), so someone with 600 photos doesn't drown out someone with 10.
"""

import hashlib
import json
import threading
from collections import defaultdict

import cv2
import numpy as np

import portraits
import tree

VERSION = 1   # bump when the look of family composites/videos changes
# Which photos stand for each person. Old generations are mostly photographed old and young
# ones as children, so comparing at the same stage of life separates family look from ageing.
AGES = {"all": (0, 200), "child": (0, 12.99), "adult": (20, 50.99)}
NAMES_UP = {1: "Parents", 2: "Grandparents", 3: "Great-grandparents"}
NAMES_DOWN = {1: "Children", 2: "Grandchildren", 3: "Great-grandchildren"}


def gen_label(k, up):
    names = NAMES_UP if up else NAMES_DOWN
    if k in names:
        return names[k]
    return f"{k - 2}× great-{'grandparents' if up else 'grandchildren'}"


def relations():
    T = tree.load()
    par, kids, partners = defaultdict(set), defaultdict(set), defaultdict(set)
    for p, c in T["parents"]:
        par[c].add(p)
        kids[p].add(c)
    for a, b in T["partners"]:
        partners[a].add(b)
        partners[b].add(a)
    return T, par, kids, partners


def levels(name, links, max_gen=8):
    out, cur = [], {name}
    for _ in range(max_gen):
        nxt = set().union(*(links[c] for c in cur)) if cur else set()
        if not nxt:
            break
        out.append(sorted(nxt))
        cur = nxt
    return out


def lines_up(name, par, has, limit=4):
    """Direct lines of descent ending at name, oldest first; the best-photographed first."""
    paths = []

    def walk(n, path):
        if not par[n]:
            if len(path) > 1:
                paths.append(path[::-1])
            return
        for p in sorted(par[n]):
            walk(p, path + [p])
    walk(name, [name])
    paths.sort(key=lambda p: (-sum(has(n) for n in p), -len(p)))
    return paths[:limit]


def _in_range(i, ages):
    lo, hi = AGES.get(ages, AGES["all"])
    return lo <= portraits.attrs()[i]["age"] <= hi


def _photo_counts(names, faces, ages="all"):
    return {n: sum(portraits.good(i, faces) and _in_range(i, ages) for i in ids)
            for n, ids in portraits.people_faces(names).items()}


_person_cache = {}


def person_face(name, names, faces, ages="all"):
    """A person's own average face (float BGR, 320x256, exposure-normalised), or None."""
    ids = [i for i in portraits.people_faces(names).get(name, []) if portraits.good(i, faces) and _in_range(i, ages)]
    if len(ids) < 2:
        return None
    ids = tuple(sorted(sorted(ids, key=lambda i: -portraits.attrs()[i]["sharp"])[:60]))
    if (name, ids) not in _person_cache:
        _person_cache[(name, ids)] = portraits._average(ids)
    return _person_cache[(name, ids)]


def group_image(members, names, faces, ages="all"):
    """Equal-weight average of several people's faces as a finished uint8 image, or None."""
    imgs = [img for img in (person_face(n, names, faces, ages) for n in members) if img is not None]
    if not imgs:
        return None
    return portraits._finish(sum(imgs) / len(imgs))


def group_jpg(members, names, faces, ages="all"):
    ids = portraits.people_faces(names)
    key = hashlib.sha1(json.dumps([VERSION, ages, sorted((n, len(ids.get(n, []))) for n in members)]).encode()).hexdigest()[:16]
    path = portraits.CACHE / f"group-{key}.jpg"
    if not path.exists():
        img = group_image(members, names, faces, ages)
        if img is None:
            return None
        portraits.CACHE.mkdir(exist_ok=True)
        cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return path.read_bytes()


def detail(name, names, faces, ages="all"):
    T, par, kids, _ = relations()
    if name not in T["people"]:
        return {"name": name, "inTree": False}
    counts = _photo_counts(names, faces, ages)
    has = lambda n: counts.get(n, 0) >= 2
    level = lambda people, k, up: {"label": gen_label(k, up), "people": people,
                                   "withPhotos": [n for n in people if has(n)]}
    return {
        "name": name, "inTree": True, "self": has(name),
        "up": [level(p, k + 1, True) for k, p in enumerate(levels(name, par))],
        "down": [level(p, k + 1, False) for k, p in enumerate(levels(name, kids))],
        "lines": [[{"name": n, "photos": has(n)} for n in line] for line in lines_up(name, par, has)],
    }


def branches(names, faces, ages="all"):
    """Each couple in the tree with the average face of everyone descended from them."""
    T, par, kids, _ = relations()
    counts = _photo_counts(names, faces, ages)
    has = lambda n: counts.get(n, 0) >= 2
    out = []
    for a, b in T["partners"]:
        desc = sorted({n for root in (a, b) for lvl in levels(root, kids) for n in lvl})
        withp = [n for n in desc if has(n)]
        if len(withp) >= 3 and (has(a) or has(b)):
            out.append({"couple": [a, b], "descendants": withp, "generations": len(levels(a, kids))})
    out.sort(key=lambda x: -len(x["descendants"]))
    return out[:12]


_render_locks = {}


def generations_video(name, names, faces, ages="all"):
    """Morph video through the generation averages: oldest ancestors -> name -> descendants."""
    import morph
    d = detail(name, names, faces, ages)
    if not d.get("inTree"):
        return None
    steps = [(lvl["label"], lvl["withPhotos"]) for lvl in reversed(d["up"]) if lvl["withPhotos"]]
    if d["self"]:
        steps.append((name, [name]))
    steps += [(lvl["label"], lvl["withPhotos"]) for lvl in d["down"] if lvl["withPhotos"]]
    if len(steps) < 2:
        return None
    ids = portraits.people_faces(names)
    key = hashlib.sha1(json.dumps([VERSION, ages, portraits.MORPH_VERSION,
                                   [(l, sorted((n, len(ids.get(n, []))) for n in m)) for l, m in steps]]).encode()).hexdigest()[:16]
    path, times_path = portraits.MORPHS / f"gen-{key}.mp4", portraits.MORPHS / f"gen-{key}.json"
    with _render_locks.setdefault(key, threading.Lock()):
        if not path.exists():
            portraits.MORPHS.mkdir(exist_ok=True)
            imgs = [cv2.resize(group_image(m, names, faces, ages), (morph.W, morph.H), interpolation=cv2.INTER_CUBIC)
                    for _, m in steps]
            texts = [l if len(m) == 1 and l == m[0] else f"{l} ({len(m)})" for l, m in steps]
            tmp = portraits.MORPHS / f"gen-{key}.part.mp4"
            times = morph.render_images(imgs, texts, tmp, hold=24, morph=45, linger=45)
            times_path.write_text(json.dumps(times))
            tmp.replace(path)
    return {"url": f"/morphs/{path.name}", "times": json.loads(times_path.read_text()),
            "steps": [{"label": l, "people": m} for l, m in steps]}
