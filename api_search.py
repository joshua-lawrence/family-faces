"""Search people (names, other names, family-tree years) and photos (captions, file names).

GET /api/search?q=ann[&people=8&photos=6]
    -> {"q", "ms", "people": {"total", "items": [...]}, "photos": {"total", "items": [...]}}

Every query word must match the start of a word ("an wa" finds "Ann Marie Ward").
People are ranked on how well the name matches (whole name, then names that start with the query,
then other words; a match on another name counts almost as much as the same match on the main name)
then by photo count within each match tier.

The index lives in memory, built from api_home's cached facts. When names, people, the tree or photos
change it is rebuilt after the inputs have been stable for two seconds (only the half that changed).
Search serves the previous index with updating=true while the rebuild is pending.
Pages and actions (Groups, Export GEDCOM ...) are matched in the browser.
"""

import bisect
import re
import threading
import time
import traceback

import api_home as facts

DEBOUNCE = 2.2


def _postings(rows, fields):
    post = {}
    for i, row in enumerate(rows):
        for field in fields:
            for tok in row[field]:
                post.setdefault(tok, set()).add(i)
    return sorted(post), post


def _prefix(vocab, post, tok):
    """Rows with a word starting with tok."""
    lo = bisect.bisect_left(vocab, tok)
    hi = bisect.bisect_left(vocab, tok + "\uffff")
    out = set()
    for word in vocab[lo:hi]:
        out |= post[word]
    return out


def _starts(words, tok):
    return any(w.startswith(tok) for w in words)


def _hits(vocab, post, qt):
    hits = None
    for t in qt:
        rows = _prefix(vocab, post, t)
        hits = rows if hits is None else hits & rows
        if not hits:
            break
    return hits or ()


def _name_tier(words, key, qt, qs):
    """4 whole name, 3 the name starts with the query, 2 every query word starts a word, else None."""
    if key == qs:
        return 4
    if key.startswith(qs):
        return 3
    if all(_starts(words, t) for t in qt):
        return 2
    return None


class PeopleIndex:
    def __init__(self, people):
        self.source = people
        self.rows = []
        for p in people.values():
            words = facts.tokens(p["name"])
            alias_words = [facts.tokens(a) for a in p["aliases"]]
            self.rows.append({**p, "words": words, "key": " ".join(words),
                              "alias_words": alias_words, "alias_keys": [" ".join(a) for a in alias_words],
                              "all_alias": [t for a in alias_words for t in a],
                              "metadata": facts.tokens(f"{p['born']} {p['died']} {p['fsid']}")})
        self.vocab, self.post = _postings(self.rows, ("words", "all_alias", "metadata"))

    def search(self, qt, limit):
        qs = " ".join(qt)
        ranked = []
        for i in _hits(self.vocab, self.post, qt):
            p = self.rows[i]
            tier, alias, words = _name_tier(p["words"], p["key"], qt, qs), None, p["words"]
            for a, aw, ak in zip(p["aliases"], p["alias_words"], p["alias_keys"]):
                t = _name_tier(aw, ak, qt, qs)
                if t is not None and (tier is None or t - 0.5 > tier):
                    tier, alias, words = t - 0.5, a, aw
            if tier is None:   # the words are split across the name and another name: weakest match
                tier = 0
            exact = sum(t in words for t in qt)
            ranked.append((-tier, -p["photos"], -exact, p["name"], p, tier, alias))
        ranked.sort(key=lambda r: r[:4])
        items = [{"name": p["name"], "alias": alias, "aliases": p["aliases"][:3], "born": p["born"], "died": p["died"],
                  "tree": p["tree"], "photos": p["photos"], "faces": p["faces"], "rep": p["rep"], "src": p["src"],
                  "hidden": p["hidden"], "tier": tier} for _, _, _, _, p, tier, alias in ranked[:limit]]
        return {"total": len(ranked), "items": items}


class PhotoIndex:
    def __init__(self, photos):
        self.source = photos
        self.rows = []
        for p in photos:
            base = p["path"].rsplit("/", 1)[-1].rsplit(".", 1)[0]
            cap = facts.tokens(p["caption"])
            self.rows.append({**p, "cap": cap, "capkey": " ".join(cap), "file": facts.tokens(base),
                              "file_caption": bool(re.search(r"\.(?:jpe?g|tiff?|png|heic|webp)$", p["caption"].strip(), re.I))})
        self.vocab, self.post = _postings(self.rows, ("cap", "file"))

    def search(self, qt, limit):
        qs = " ".join(qt)
        ranked = []
        for i in _hits(self.vocab, self.post, qt):
            p = self.rows[i]
            cap = p["cap"]
            if cap and p["capkey"].startswith(qs):
                tier = 3
            elif all(_starts(cap, t) for t in qt):
                tier = 2
            else:
                tier = 1
            if p["file_caption"]:
                tier = 1
            score = 3 * sum(t in cap for t in qt) + (4 if p["album"] else 0) + (1 if p["faces"] else 0) - len(cap) / 40
            ranked.append((-tier, -score, p["order"], p, tier))
        ranked.sort(key=lambda r: r[:3])
        items = [{"path": p["path"], "caption": p["caption"], "date": p["date"], "source": p["source"],
                  "album": p["album"], "face": p["faces"][0] if p["faces"] else None, "faces": len(p["faces"]),
                  "tier": tier} for _, _, _, p, tier in ranked[:limit]]
        return {"total": len(ranked), "items": items}


_state = {"index": None, "stamp": None, "building": None}   # index = (PeopleIndex, PhotoIndex)
_lock = threading.Lock()


def _build(app):
    current = facts.stamp(app)   # taken first: data that changes during the build triggers another
    people, photos = facts.people_facts(app, current, fresh=True), facts.photo_facts(app, current, fresh=True)
    old = _state["index"]
    pi = old[0] if old and old[0].source is people else PeopleIndex(people)
    fi = old[1] if old and old[1].source is photos else PhotoIndex(photos)
    _state.update(index=(pi, fi), stamp=current)


def _rebuild(app, done):
    try:
        # Keep checking disk stamps so writes reset the delay even without another search.
        current, changed = facts.stamp(app), time.monotonic()
        while _state["index"] is not None:
            time.sleep(0.1)
            latest = facts.stamp(app)
            if latest != current:
                current, changed = latest, time.monotonic()
            if time.monotonic() - changed >= DEBOUNCE:
                break
        _build(app)
    except Exception:
        traceback.print_exc()
    finally:
        with _lock:
            _state["building"] = None
        done.set()


def index(app):
    """Serve the old index immediately; wait only when no index exists yet."""
    current = facts.stamp(app)
    if _state["stamp"] == current:
        return _state["index"]
    with _lock:
        if _state["stamp"] == current:
            return _state["index"]
        done = _state["building"]
        if done is None:
            done = _state["building"] = threading.Event()
            threading.Thread(target=_rebuild, args=(app, done), daemon=True).start()
    if _state["index"] is None:
        done.wait()
    if _state["index"] is None:
        raise ValueError("Search couldn’t read the library. Check the server log, then try again.")
    return _state["index"]


def _limit(value, default, top=50):
    try:
        return max(0, min(top, int(value)))
    except (TypeError, ValueError):
        return default


def search(app, q):
    start = time.perf_counter()
    text = (q.get("q") or "")[:200]
    qt = facts.tokens(text)[:8]
    empty = {"total": 0, "items": []}
    people, photos = index(app) if qt else (None, None)
    out = {"q": text,
           "people": people.search(qt, _limit(q.get("people"), 8)) if qt else empty,
           "photos": photos.search(qt, _limit(q.get("photos"), 6)) if qt else empty}
    out["updating"] = bool(qt and _state["stamp"] != facts.stamp(app))
    out["ms"] = round((time.perf_counter() - start) * 1000, 1)
    return out


def register(routes, app):
    routes["GET"]["/api/search"] = lambda q: search(app, q)
    # Build the index now so the first search is instant.
    threading.Thread(target=lambda: index(app), daemon=True).start()
