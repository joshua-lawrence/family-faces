"""Check names: a queue of named faces that are probably wrong, most suspicious first.

For every named face (people with at least 3 named faces), compare:
  fit   = mean similarity to the 3 closest OTHER faces with the same name (not in the same photo)
  other = similarity to the closest other person's average face
A face is a likely mistake when someone else matches better (other > fit), when it barely
matches its own person (fit < 0.30), or when its name is on two faces in the same photo.
Faces named recently (History) can be checked first. "Looks right" marks are kept in
data/check-ok.json (face id -> the name that was confirmed) and hide that face until its name changes.

GET  /api/check?window=day|week|all&sort=suspicious|recent|name|other|fit|photo&limit=N
POST /api/check/ok {faces: [...]}       mark as looks right
POST /api/check/unok {faces: [...]}     take the mark back
Renaming or removing names goes through /api/label, so History and undo cover it.
"""

import json
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta

import numpy as np

IGNORE = "_ignore"
WINDOWS = {"day": timedelta(days=1), "week": timedelta(days=7), "all": None}
# sort keys for the queue; ties fall back to most suspicious first
SORTS = {
    "suspicious": lambda it, t: -it["score"],
    "recent": lambda it, t: -t.get(it["face"], 0),                  # named most recently first
    "name": lambda it, t: it["name"].casefold(),                    # by the name on the face, A-Z
    "other": lambda it, t: it["other_name"].casefold(),             # by who it looks like, A-Z
    "fit": lambda it, t: it["fit"] if it["fit"] is not None else -1,  # least like its own person first
    "photo": lambda it, t: it["photo"],                             # photo by photo
}


class Checker:
    def __init__(self, app):
        self.app = app
        self.ok_path = app.DATA / "check-ok.json"
        self.ok = json.loads(self.ok_path.read_text()) if self.ok_path.exists() else {}
        self.result, self.sig, self.building, self.error = None, None, False, None
        self.lock = threading.Lock()

    # ---- cache key: names + face count change -> recompute
    def signature(self):
        names = self.app.labels["names"]
        return (len(self.app.faces), len(names), hash(frozenset(names.items())))

    def ensure(self):
        sig = self.signature()
        with self.lock:
            if self.sig == sig or self.building:
                return
            self.building = True
        threading.Thread(target=self._run, args=(sig,), daemon=True).start()

    def _run(self, sig):
        try:
            res = self.build()
            with self.lock:
                self.result, self.sig, self.error = res, sig, None
        except Exception as exc:   # keep the page usable; show why
            with self.lock:
                self.error = str(exc)
        finally:
            with self.lock:
                self.building = False

    def build(self):
        app = self.app
        with app.lock:
            names = dict(app.labels["names"])
            faces, emb = app.faces, app.emb
        by = defaultdict(list)
        for k, n in names.items():
            f = int(k)
            if n and n != IGNORE and f < len(emb):
                by[n].append(f)
        people = sorted(n for n, ids in by.items() if len(ids) >= 3)
        if not people:
            return {"items": [], "refs": {}}
        idx = {n: i for i, n in enumerate(people)}
        sums = np.stack([emb[by[n]].sum(0) for n in people]).astype(np.float32)
        cents = sums / np.linalg.norm(sums, axis=1, keepdims=True)
        refs = {}
        items = []
        for n in people:
            ids = np.array(by[n])
            E = emb[ids]
            photos = np.array([faces[f]["photo"] for f in ids])
            S = E @ E.T
            S[photos[:, None] == photos[None, :]] = np.nan      # itself and its own photo can't vouch for it
            k = min(3, len(ids) - 1)
            top = -np.sort(-np.nan_to_num(S, nan=-9), axis=1)[:, :k]   # best k real matches
            top[top < -8] = np.nan
            with np.errstate(all="ignore"):
                fit = np.nanmean(top, axis=1)                    # nan: no other photo of this person to compare
            O = E @ cents.T
            O[:, idx[n]] = -1
            best = O.argmax(1)
            other = O[np.arange(len(ids)), best]
            # same name on two faces in one photo: one of them must be wrong
            counts = defaultdict(int)
            for p in photos:
                counts[p] += 1
            order = np.argsort(-(E @ cents[idx[n]]))
            refs[n] = [int(ids[i]) for i in order[:4]]
            for j, f in enumerate(ids):
                conflict = counts[photos[j]] > 1
                known = not np.isnan(fit[j])
                if not (conflict or known and (other[j] > fit[j] or fit[j] < 0.30)):
                    continue
                reason = ("conflict" if conflict else "other" if other[j] > fit[j] else "weak")
                items.append({"face": int(f), "name": n, "fit": round(float(fit[j]), 3) if known else None,
                              "other_name": people[best[j]], "other": round(float(other[j]), 3),
                              "reason": reason, "photo": faces[f]["photo"],
                              "score": round(float(other[j] - (fit[j] if known else 0.3)) + (0.5 if conflict else 0), 3)})
        items.sort(key=lambda x: -x["score"])
        for it in items:
            refs.setdefault(it["other_name"], [])
        return {"items": items, "refs": refs, "built": time.time()}

    # ---- when was each face last named (from History): {face id: timestamp}, for the window and "recent" sort
    def named_times(self):
        hist = self.app.DATA / "history.jsonl"
        out = {}
        if not hist.exists():
            return out
        for line in hist.read_text().splitlines():
            try:
                e = json.loads(line)
                t = datetime.fromisoformat(e["time"]).timestamp()
                added = e.get("changes", {}).get("labels", {}).get("names", {}).get("d", {})
                out.update((int(k), t) for k, v in added.items() if isinstance(v, dict) and v.get("a"))
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
        return out

    def view(self, q):
        self.ensure()
        with self.lock:
            res, building, error = self.result, self.building, self.error
        if res is None:
            return {"building": True, "error": error, "items": [], "counts": {}}
        names = self.app.labels["names"]
        window = q.get("window", "week")
        since = WINDOWS.get(window, WINDOWS["week"])
        sort = q.get("sort") if q.get("sort") in SORTS else "suspicious"
        times = self.named_times() if since or sort == "recent" else {}
        cutoff = (datetime.now().astimezone() - since).timestamp() if since else None
        live = [it for it in res["items"]
                if names.get(str(it["face"])) == it["name"] and self.ok.get(str(it["face"])) != it["name"]]
        shown = [it for it in live if cutoff is None or times.get(it["face"], 0) >= cutoff]
        if sort != "suspicious":   # items are already most suspicious first; a stable sort keeps that for ties
            shown.sort(key=lambda it: SORTS[sort](it, times))
        counts = {"shown": len(shown), "all": len(live),
                  "conflict": sum(it["reason"] == "conflict" for it in shown),
                  "other": sum(it["reason"] == "other" for it in shown),
                  "weak": sum(it["reason"] == "weak" for it in shown)}
        limit = max(1, min(int(q.get("limit", 60) or 60), 500))
        page = shown[:limit]
        need = {it["name"] for it in page} | {it["other_name"] for it in page}
        return {"building": building, "error": error, "items": page, "counts": counts, "window": window, "sort": sort,
                "refs": {n: res["refs"].get(n, []) for n in need}}

    def mark(self, body, ok):
        ids = [int(f) for f in body.get("faces", [])]
        if not ids:
            raise ValueError("Choose the faces to update.")
        with self.app.lock:
            names = self.app.labels["names"]
            for f in ids:
                if ok and names.get(str(f)):
                    self.ok[str(f)] = names[str(f)]
                else:
                    self.ok.pop(str(f), None)
            tmp = self.ok_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.ok))
            tmp.replace(self.ok_path)
        return {"ok": True, "faces": len(ids)}


def register(routes, app):
    checker = Checker(app)
    routes["GET"]["/api/check"] = checker.view
    routes["POST"]["/api/check/ok"] = lambda body: checker.mark(body, True)
    routes["POST"]["/api/check/unok"] = lambda body: checker.mark(body, False)
