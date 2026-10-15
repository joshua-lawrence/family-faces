"""Home page overview: naming progress, what to do next, recent imports and a photo from the albums.

GET /api/home          -> overview. The heavy parts are cached until the data changes
                          (labels, people, tree, photos or an import); inbox and import state are live.
GET /api/home/photos   -> a fresh random sample of captioned album photos (?n=40)

Also holds the shared, cached facts about people and photos that api/search.py indexes.
Read-only: nothing here writes to the library.
"""

import html
import random
import re
import threading
import unicodedata

import numpy as np

FILES = ("labels.json", "people.json", "tree.json", "photos.json")

# Endpoints other add-ons may provide. The page only asks for them when they exist (no 404s).
OPTIONAL_ROUTES = {
    "suggest": ("/api/suggest/summary", "/api/suggestions/summary", "/api/suggest"),
}


# ---------- text helpers (api/search.py uses the same folding) ----------
def fold(text):
    """Lower case, accents and apostrophes removed, HTML entities decoded: "O’Néil" -> "oneil"."""
    text = unicodedata.normalize("NFKD", html.unescape(str(text or "")))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return re.sub(r"['’‘`]", "", text)


def tokens(text):
    return re.findall(r"[^\W_]+", fold(text))


# ---------- cache keyed on the data on disk ----------
def stamp(app):
    """Changes whenever names, people, the tree, the photo registry or the face data change."""
    out = [app.VERSION, id(app.faces), id(app.labels)]
    for name in FILES:
        try:
            out.append((app.DATA / name).stat().st_mtime_ns)
        except OSError:
            out.append(0)
    return tuple(out)


_cache = {}
_locks = {}
_locks_guard = threading.Lock()


_pending = {}
DEBOUNCE = 2.2


def cached(key, current, build, check=None, fresh=False):
    """Serve the previous cache while inputs settle, then build outside requests.
    Background builders can request fresh dependencies without scheduling another build."""
    hit = _cache.get(key)
    if hit and (hit[0] == current or (key in _pending and not fresh)):
        return hit[1]
    with _locks_guard:
        lock = _locks.setdefault(key, threading.RLock())
    with lock:
        hit = _cache.get(key)
        if hit and hit[0] == current:
            return hit[1]
        if not hit or fresh:
            value = build()
            _cache[key] = (current, value)
            return value
        if key in _pending:
            return hit[1]

        def rebuild():
            import time
            latest, changed = current, time.monotonic()
            try:
                while True:
                    time.sleep(0.1)
                    observed = check() if check else current
                    if observed != latest:
                        latest, changed = observed, time.monotonic()
                    if time.monotonic() - changed >= DEBOUNCE:
                        break
                with lock:
                    if _cache[key][0] != latest:
                        _cache[key] = (latest, build())
            except Exception:
                import traceback
                traceback.print_exc()
            finally:
                _pending.pop(key, None)

        _pending[key] = current
        threading.Thread(target=rebuild, daemon=True, name="home-" + key).start()
        return hit[1]


# ---------- shared facts ----------
def _snapshot(app):
    """Consistent copies of the in-memory data. The app's lock is held only for the copy."""
    with app.lock:
        return dict(app.labels["names"]), app.faces, app.emb


_reps = {"key": None, "by": {}}   # name -> (that person's face ids, chosen face); only rebuilt for changed people


def representatives(app, names, faces, emb):
    """name -> face to show for that person. The same choice as the app's representative_faces()
    (their clearest face that looks most like the rest of them), but worked out from a copy of the
    names, outside the app's lock, and only for people whose faces changed since last time."""
    by = {}
    for fid, n in names.items():
        if n != app.IGNORE:
            by.setdefault(n, []).append(int(fid))
    old = _reps["by"] if _reps["key"] == (id(faces), id(emb)) else {}
    good = app.portraits.good
    out = {}
    for n, ids in by.items():
        prev = old.get(n)
        if prev and prev[0] == ids:
            out[n] = prev
            continue
        pick = [i for i in ids if good(i, faces)] or ids
        out[n] = (ids, pick[int(np.argmax(emb[pick] @ emb[ids].mean(0)))])
    _reps.update(key=(id(faces), id(emb)), by=out)
    return {n: v[1] for n, v in out.items()}


def _photo_key(app, current):
    return (app.VERSION, id(app.faces), current[-1])


def photo_facts(app, current=None, fresh=False):
    """Per photo: caption, date, source, faces left to right. Changes only when photos are added."""
    current = current or stamp(app)

    def build():
        by_photo = {}
        for f in app.faces:
            by_photo.setdefault(f["photo"], []).append(f)
        out = []
        for p in app.library.photos():
            fs = sorted(by_photo.get(p["path"], []), key=lambda f: f["bbox"][0])
            source = p.get("source") or ""
            out.append({"path": p["path"], "caption": p.get("caption") or "", "date": p.get("date") or "",
                        "source": source, "batch": p.get("batch") or "", "order": p.get("order", 0),
                        "album": source != "FamilySearch" and not p.get("memory_id"),
                        "faces": [f["id"] for f in fs]})
        return out
    return cached("photos", _photo_key(app, current), build, lambda: _photo_key(app, stamp(app)), fresh)


def people_facts(app, current=None, fresh=False):
    """name -> what the app knows about that person: aliases, tree years, counts, avatar, hidden."""
    def build():
        names, faces, emb = _snapshot(app)
        reps = representatives(app, names, faces, emb)
        photos = app.library.photos()
        identities = app.people.load()
        tree = app.tree.load()
        hidden = app.familysearch_cleanup.hidden_names(identities, tree, photos, faces, names)
        photo_sets, face_counts = {}, {}
        for fid, n in names.items():
            if n == app.IGNORE:
                continue
            face_counts[n] = face_counts.get(n, 0) + 1
            photo_sets.setdefault(n, set()).add(faces[int(fid)]["photo"])
        source_rep = {}
        for n, linked in app.source_photos_by_person().items():
            photo_sets.setdefault(n, set()).update(p["path"] for p in linked)
            if linked:
                source_rep[n] = linked[0]["path"]
        everyone = set(photo_sets) | set(tree["people"]) | set(identities)
        out = {}
        for n in everyone:
            info = identities.get(n, {})
            t = tree["people"].get(n)
            out[n] = {"name": n, "aliases": [a for a in info.get("aliases", []) if a and a != n],
                      "born": (t or {}).get("born", ""), "died": (t or {}).get("died", ""), "tree": t is not None,
                      "faces": face_counts.get(n, 0), "photos": len(photo_sets.get(n, ())),
                      "rep": reps.get(n), "src": source_rep.get(n) if reps.get(n) is None else None,
                      "hidden": n in hidden, "fsid": info.get("familysearch_id", "")}
        return out
    return cached("people", current or stamp(app), build, lambda: stamp(app), fresh)


# ---------- the overview ----------
def _batch_date(batch):
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", batch)
    return m.group(0) if m else ""


def _overview(app, photos, facts):
    names, faces, _ = _snapshot(app)
    album_paths = {p["path"] for p in photos if p["album"]}
    c = {"total": len(faces), "named": 0, "ignored": 0, "done": 0, "album_total": 0, "album_named": 0, "fs_total": 0, "fs_named": 0}
    for f in faces:
        n = names.get(str(f["id"]))
        album = f["photo"] in album_paths
        c["album_total" if album else "fs_total"] += 1
        if n:
            c["done"] += 1
            if n == app.IGNORE:
                c["ignored"] += 1
            else:
                c["named"] += 1
                c["album_named" if album else "fs_named"] += 1
    with_faces = [p for p in photos if p["faces"]]
    done = [p for p in with_faces if all(str(i) in names for i in p["faces"])]
    pc = {"total": len(photos), "with_faces": len(with_faces), "fully_named": len(done),
          "album_with_faces": sum(p["album"] for p in with_faces), "album_fully_named": sum(p["album"] for p in done)}
    with app.lock:
        imports = app.imports_overview()
    imports.sort(key=lambda b: b["batch"], reverse=True)
    for b in imports:
        b["date"] = _batch_date(b["batch"])
    visible = [p for p in facts.values() if not p["hidden"]]
    return {"faces": c, "photos": pc, "imports": imports[:4], "imports_total": len(imports),
            "people": {"named": sum(1 for p in visible if p["faces"]), "tree": sum(1 for p in visible if p["tree"]),
                       "visible": len(visible)}}


def _album_pool(app, current=None):
    current = current or stamp(app)
    def build():
        photos = photo_facts(app, fresh=True)
        pool = [p for p in photos if p["album"] and p["caption"].strip()]
        return pool if len(pool) >= 12 else [p for p in photos if p["caption"].strip()]
    return cached("album-pool", _photo_key(app, current), build, lambda: _photo_key(app, stamp(app)))


def album_sample(app, n=40, exclude="", current=None):
    """Random captioned album photos, with the names on their faces left to right."""
    pool = [p for p in _album_pool(app, current) if p["path"] != exclude]
    pick = random.sample(pool, min(n, len(pool)))
    with app.lock:
        names = {str(i): app.labels["names"].get(str(i)) for p in pick for i in p["faces"]}
    return [{"path": p["path"], "caption": p["caption"], "date": p["date"], "source": p["source"],
             "face": p["faces"][0] if p["faces"] else None,
             "names": [names[str(i)] for i in p["faces"] if names.get(str(i)) not in (None, app.IGNORE)]}
            for p in pick]


def home(app, q):
    current = stamp(app)
    overview = cached("overview", current,
                      lambda: _overview(app, photo_facts(app, fresh=True), people_facts(app, fresh=True)),
                      lambda: stamp(app))
    state = app.import_state
    optional = {kind: next((r for r in routes if r in app.PLUGIN_ROUTES["GET"]), None)
                for kind, routes in OPTIONAL_ROUTES.items()}
    return {**overview, "v": app.VERSION, "key": current, "updating": _cache["overview"][0] != current,
            "inbox": {"count": len(app.pipeline.inbox_files()), "running": bool(state.get("running")),
                      "stage": state.get("stage", ""), "done": state.get("done", 0), "total": state.get("total", 0)},
            "album_photos": album_sample(app, 40, current=current),
            "routes": optional}


def register(routes, app):
    routes["GET"]["/api/home"] = lambda q: home(app, q)
    routes["GET"]["/api/home/photos"] = lambda q: {"photos": album_sample(app, _count(q.get("n")), q.get("not", ""))}


def _count(value, default=40):
    try:
        return max(1, min(100, int(value)))
    except (TypeError, ValueError):
        return default
