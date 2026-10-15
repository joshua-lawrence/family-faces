"""People cleanup: possible duplicate names, side-by-side compare, and "check these" conflicts.

GET  /api/people/duplicates             -> {pairs: [pair...], dismissed: [[a, b]...], ignored: faces named _ignore}
GET  /api/people/compare?a=&b=&n=6      -> one pair for any two people (same shape as a duplicates pair)
GET  /api/people/checks?name=           -> {conflicts: [{photo, caption, faces: [{id, bbox, img_w, name, mine}]}]}
GET  /api/people/not-duplicates         -> {pairs: [[a, b], ...]}  pairs marked "Different people"
POST /api/people/not-duplicate {a, b, undo?}  remember (or forget) that a and b are different people
POST /api/people/merge-backup {keep, drop}    snapshot of both people, taken just before the page merges
                                               them with the existing /api/rename endpoint
GET  /api/people/conflict-ok            -> {groups: [{photo, faces, name, at}]}  "Both correct" photos
POST /api/people/conflict-ok {name, photo, faces} or {name, photo?, undo: true}
                                               mark a conflict photo as fine (a photo of a photo), or undo
POST /api/people/remove-names {name, faces}   take `name` off these faces and keep them out of their group
                                               (like /api/reject) -> {removed, newly_rejected}
POST /api/people/restore-names {name, faces, unreject}   undo of remove-names: names faces that are still
                                               unnamed and un-rejects only the ids remove-names rejected

data/not-duplicates.json: {"pairs": [["A", "B"], ...]}   (each pair sorted)
data/conflict-ok.json: {"groups": [{"photo": p, "faces": [ids], "name": n, "at": iso}]}  a conflict whose named
    faces all sit inside one saved group is not a conflict (keyed on face ids, so it survives renames)
data/people-merges/<time>.json: what each merge changed, so it can be undone by hand.
"""

import json
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from itertools import combinations

import numpy as np

IGNORE = "_ignore"
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "junior", "senior"}
SUFFIX_LABEL = {"jr": "Jr.", "junior": "Jr.", "sr": "Sr.", "senior": "Sr.", "ii": "II", "iii": "III", "iv": "IV"}
FS_ID = re.compile(r"\(\s*[A-Z0-9]{4}-[A-Z0-9]{3,4}\s*\)")
FACE_SAME = 0.6        # average faces this alike are flagged even when the names differ
FACE_UNLIKE = 0.3      # below this, faces argue against a weak name match


def register(routes, app):
    tools = Tools(app)
    routes["GET"]["/api/people/duplicates"] = tools.duplicates
    routes["GET"]["/api/people/compare"] = tools.compare
    routes["GET"]["/api/people/checks"] = tools.checks
    routes["GET"]["/api/people/not-duplicates"] = lambda q: {"pairs": sorted(tools.dismissed())}
    routes["POST"]["/api/people/not-duplicate"] = tools.not_duplicate
    routes["POST"]["/api/people/merge-backup"] = tools.merge_backup
    routes["GET"]["/api/people/conflict-ok"] = lambda q: {"groups": tools.conflict_ok()}
    routes["POST"]["/api/people/conflict-ok"] = tools.mark_conflict_ok
    routes["POST"]["/api/people/remove-names"] = tools.remove_names
    routes["POST"]["/api/people/restore-names"] = tools.restore_names


# ---------- names ----------

def name_key(name):
    """(comparable key, suffixes, had an FS ID suffix, written last-first) for a display name."""
    had_id = bool(FS_ID.search(name))
    n = FS_ID.sub(" ", name)
    n = unicodedata.normalize("NFKD", n)
    n = "".join(c for c in n if not unicodedata.combining(c)).casefold()
    n = re.sub(r"['\u2018\u2019\u02bb\u02bc`.]", "", n)   # O'Brien = OBrien, Jr. = Jr, Ka\u02bbahu = Kaahu
    reversed_ = False
    parts = [p.strip() for p in n.split(",") if p.strip()]
    if len(parts) > 1:
        # "Smith, John", "Smith, John, Jr." and "Smith, Jr., John" are last name first; "John Smith, Jr." is not.
        names = [p for p in parts if not set(re.findall(r"[a-z0-9]+", p)) <= SUFFIXES]
        if len(names) == 2 and parts[0] == names[0]:
            rest = [p for p in parts if p not in names]
            n, reversed_ = " ".join([names[1], names[0], *rest]), True
    tokens = re.findall(r"[a-z0-9]+", n)
    suffixes = tuple(sorted({SUFFIX_LABEL[t] for t in tokens if t in SUFFIXES}))
    tokens = [t for t in tokens if t not in SUFFIXES]
    return " ".join(tokens), suffixes, had_id, reversed_


def edit_distance(a, b, limit=2):
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        if min(cur) > limit:
            return limit + 1
        prev = cur
    return prev[-1]


def deletions(word, depth=2):
    out, frontier = {word}, {word}
    for _ in range(depth):
        frontier = {w[:i] + w[i + 1:] for w in frontier for i in range(len(w))}
        out |= frontier
    return out


def year(text):
    m = re.search(r"\b(1[6-9]\d\d|20\d\d)\b", text or "")
    return int(m.group(1)) if m else None


class Tools:
    def __init__(self, app):
        self.app = app
        self._by_photo = (None, None)
        self._dupes = (None, None)   # (data stamp, result): possible duplicates are worked out once per change

    # ---------- shared data ----------

    def faces_by_photo(self):
        faces = self.app.faces
        if self._by_photo[0] is not faces:
            index = defaultdict(list)
            for f in faces:
                index[f["photo"]].append(f)
            self._by_photo = (faces, index)
        return self._by_photo[1]

    def snapshot(self):
        """Everything the pair finder needs, read once under the app lock."""
        app = self.app
        names = dict(app.labels["names"])   # a copy: the pair finder may run outside the lock
        hidden = app.hidden_import_people()
        tree = app.tree.load()
        identities = app.people.load()
        by = defaultdict(list)
        for fid, n in names.items():
            if n != IGNORE:
                by[n].append(int(fid))
        sources = app.source_photos_by_person()
        visible = (set(by) | set(sources) | set(tree.get("people", {}))) - hidden
        return {"by": by, "sources": sources, "visible": visible, "tree": tree, "identities": identities,
                "ignored": sum(1 for n in names.values() if n == IGNORE)}

    def dismissed(self):
        path = self.app.DATA / "not-duplicates.json"
        if not path.exists():
            return set()
        return {tuple(sorted(p)) for p in json.loads(path.read_text()).get("pairs", []) if len(p) == 2}

    # ---------- per-person facts ----------

    def person(self, name, snap, n_faces, cache):
        if name in cache:
            return cache[name]
        app = self.app
        ids = snap["by"].get(name, [])
        tree_info = snap["tree"].get("people", {}).get(name)
        identity = snap["identities"].get(name, {})
        fs = identity.get("familysearch") or {}
        born = year((tree_info or {}).get("born")) or year((fs.get("birth") or {}).get("date"))
        died = year((tree_info or {}).get("died")) or year((fs.get("death") or {}).get("date"))
        album_photos = {app.faces[i]["photo"] for i in ids}
        source = snap["sources"].get(name, [])
        centroid = None
        sample = []
        if ids:
            vecs = app.emb[ids]
            c = vecs.mean(0)
            centroid = c / (np.linalg.norm(c) or 1)
            # Most typical faces first: clear ones, one per photo; then fill up with whatever is left.
            sims = vecs @ centroid
            ranked = sorted(range(len(ids)), key=lambda k: (not app.portraits.good(ids[k], app.faces), -sims[k]))
            seen = set()
            for k in ranked:
                f = ids[k]
                if app.faces[f]["photo"] not in seen:
                    seen.add(app.faces[f]["photo"])
                    sample.append(f)
                if len(sample) >= n_faces:
                    break
            sample += [ids[k] for k in ranked if ids[k] not in sample][:n_faces - len(sample)]
        info = {
            "name": name, "faces": len(ids), "photos": len(album_photos | {p["path"] for p in source}),
            "in_tree": tree_info is not None, "familysearch_id": identity.get("familysearch_id", ""),
            "born": born, "died": died, "sample": sample,
            "source_sample": [p["path"] for p in source[:n_faces]] if not sample else [],
            "_centroid": centroid, "_photos": album_photos,
        }
        cache[name] = info
        return info

    @staticmethod
    def public(info):
        return {k: v for k, v in info.items() if not k.startswith("_")}

    # ---------- pairs ----------

    def candidate_pairs(self, snap):
        """{(a, b): [reason, ...]} from names; face-only pairs are added by the caller."""
        visible = sorted(snap["visible"])
        keys = {n: name_key(n) for n in visible}
        out = defaultdict(list)
        groups = defaultdict(list)
        for n, k in keys.items():
            if k[0]:
                groups[k[0].replace(" ", "")].append(n)    # "Mary Ann", "Mary-Ann" and "Maryann" together
        for members in groups.values():
            for a, b in combinations(sorted(members), 2):
                ka, kb = keys[a], keys[b]
                if ka[1] and kb[1] and ka[1] != kb[1]:
                    continue          # Jr. and Sr.: father and son
                if ka[0] != kb[0] and ka[1] == kb[1] and ka[2] == kb[2]:
                    out[(a, b)].append({"kind": "name", "strength": 3,
                                        "text": "Same name apart from spaces or hyphens"})
                elif ka[1] != kb[1]:
                    suffix = (ka[1] or kb[1])[0]
                    out[(a, b)].append({"kind": "name", "strength": 2, "text": f"Same name apart from “{suffix}”"})
                elif ka[2] != kb[2]:
                    out[(a, b)].append({"kind": "name", "strength": 3, "text": "Same name, one with a FamilySearch ID added"})
                elif ka[3] != kb[3]:
                    out[(a, b)].append({"kind": "name", "strength": 3, "text": "Same name written last name first"})
                else:
                    out[(a, b)].append({"kind": "name", "strength": 3,
                                        "text": "Same name apart from capitals, accents or punctuation"})
        # Spelling: keys within 2 edits (deletion index keeps this fast for thousands of names).
        index = defaultdict(set)
        for k in groups:
            if len(k) >= 4:
                for d in deletions(k, 2):
                    index[d].add(k)
        close = set()
        for ks in index.values():
            if 1 < len(ks) < 40:
                close.update(combinations(sorted(ks), 2))
        for ka, kb in close:
            if re.sub(r"\d", "", ka) == re.sub(r"\d", "", kb):
                continue              # "Daughter 1" and "Daughter 2"
            d = edit_distance(ka, kb, 2)
            if d > 2:
                continue
            for a in groups[ka]:
                for b in groups[kb]:
                    if keys[a][1] and keys[b][1] and keys[a][1] != keys[b][1]:
                        continue
                    pair = tuple(sorted((a, b)))
                    out[pair].append({"kind": "spelling", "strength": 1,
                                      "text": f"Spelled {d} letter{'s' if d > 1 else ''} differently"})
        # Middle names: "Rose Hart" and "Rose Ellen Hart".
        by_ends = defaultdict(list)
        for n, k in keys.items():
            toks = k[0].split()
            if len(toks) >= 2:
                by_ends[(toks[0], toks[-1])].append(n)
        for members in by_ends.values():
            for a, b in combinations(sorted(members), 2):
                ta, tb = set(keys[a][0].split()), set(keys[b][0].split())
                if ta != tb and (ta < tb or tb < ta) and not (keys[a][1] and keys[b][1] and keys[a][1] != keys[b][1]):
                    out[(a, b)].append({"kind": "middle", "strength": 1,
                                        "text": "Same first and last name, one with a middle name"})
        return out

    def relations(self, tree):
        linked, parents_of = set(), defaultdict(set)
        for p, c in tree.get("parents", []):
            linked.add(frozenset((p, c)))
            parents_of[c].add(p)
        for a, b in tree.get("partners", []):
            linked.add(frozenset((a, b)))
        return linked, parents_of

    def judge(self, a, b, reasons, snap, n_faces, cache, linked, parents_of, force=False):
        """The pair to show, or None when the evidence says these are different people."""
        A, B = self.person(a, snap, n_faces, cache), self.person(b, snap, n_faces, cache)
        sim = None
        if A["_centroid"] is not None and B["_centroid"] is not None:
            sim = round(float(A["_centroid"] @ B["_centroid"]), 3)
        name_strength = max((r["strength"] for r in reasons), default=0)
        together = len(A["_photos"] & B["_photos"])
        siblings = bool(parents_of.get(a, set()) & parents_of.get(b, set()))
        related = frozenset((a, b)) in linked
        ids_differ = A["familysearch_id"] and B["familysearch_id"] and \
            A["familysearch_id"].upper() != B["familysearch_id"].upper()
        gap = abs(A["born"] - B["born"]) if A["born"] and B["born"] else None
        reasons = list(reasons)
        if name_strength and gap is not None and gap <= 1:
            reasons.append({"kind": "born", "strength": 2, "text": f"Both born {A['born']}" if not gap
                            else f"Born a year apart ({min(A['born'], B['born'])} and {max(A['born'], B['born'])})"})
        if sim is not None and sim >= FACE_SAME:
            reasons.append({"kind": "face", "strength": 2, "text": f"Faces look {round(sim * 100)}% alike"})
        strength = max((r["strength"] for r in reasons), default=0)
        if not force:
            if not reasons or related or (gap is not None and gap > 5):
                return None
            if (strength <= 1 or not name_strength) and (together or siblings):
                return None           # a weak hint, or faces alone, but the two appear side by side
            if siblings and not any(r["kind"] in ("name", "middle") for r in reasons):
                return None           # brothers and sisters with different first names (Dale and Gail)
            if strength <= 1 and ((sim is not None and sim < FACE_UNLIKE) or (ids_differ and (gap is None or gap > 2))):
                return None
            if name_strength == 2 and together:   # "John" and "John Jr." in the same photo: father and son
                return None
        cautions = []
        if related:
            cautions.append("Linked to each other in the family tree")
        if siblings:
            cautions.append("Listed as siblings in the family tree")
        if together:
            cautions.append(f"Both named in {together} of the same photo{'s' if together > 1 else ''}")
        if sim is not None and sim < FACE_UNLIKE:
            cautions.append("Their faces don’t look alike")
        if ids_differ:
            cautions.append(f"Linked to different FamilySearch records ({A['familysearch_id']} and {B['familysearch_id']})")
        if gap and gap > 1:
            cautions.append(f"Born {min(A['born'], B['born'])} and {max(A['born'], B['born'])}")
        return {"a": self.public(A), "b": self.public(B), "similarity": sim, "reasons": reasons,
                "cautions": cautions, "keep": self.suggest_keep(A, B), "strength": strength}

    @staticmethod
    def suggest_keep(A, B):
        def score(p):
            n = p["name"]
            return (p["in_tree"] * 4 + bool(p["familysearch_id"]) * 2 + (not FS_ID.search(n)) * 3
                    + (n != n.lower()) + min(p["faces"], 200) / 100 + len(n.split()) * 0.1)
        return A["name"] if score(A) >= score(B) else B["name"]

    # ---------- endpoints ----------

    def duplicates(self, q):
        """Cached until names, people, the tree or the "different people" list change; worked out from a copy
        taken under the lock, so saves from other tabs don't wait for it."""
        app = self.app
        with app.lock:
            key = (app.data_stamp(), app._stamp(app.DATA / "not-duplicates.json"))
            if self._dupes[0] == key:
                return self._dupes[1]
            snap = self.snapshot()
            dismissed = self.dismissed()
            emb = app.emb
        result = self._duplicates(snap, dismissed, emb)
        self._dupes = (key, result)
        return result

    def _duplicates(self, snap, dismissed, emb):
        if True:
            linked, parents_of = self.relations(snap["tree"])
            cands = self.candidate_pairs(snap)
            # Face-only pairs: average faces of two people this alike.
            names = sorted(n for n in snap["visible"] if snap["by"].get(n))
            if len(names) > 1:
                cents = np.stack([emb[snap["by"][n]].mean(0) for n in names])
                cents /= np.maximum(np.linalg.norm(cents, axis=1, keepdims=True), 1e-9)
                sims = cents @ cents.T
                ii, jj = np.where(np.triu(sims >= FACE_SAME, 1))
                for i, j in zip(ii.tolist(), jj.tolist()):
                    cands.setdefault((names[i], names[j]), [])
            cache, pairs = {}, []
            for (a, b), reasons in cands.items():
                if (a, b) in dismissed:
                    continue
                pair = self.judge(a, b, reasons, snap, 4, cache, linked, parents_of)
                if pair:
                    pairs.append(pair)
        pairs.sort(key=lambda p: (-p["strength"], -(p["similarity"] if p["similarity"] is not None else -1),
                                  p["a"]["name"]))
        return {"pairs": pairs, "dismissed": sorted(dismissed), "ignored": snap["ignored"]}

    def compare(self, q):
        a, b = (q.get("a") or "").strip(), (q.get("b") or "").strip()
        if not a or not b or a == b:
            raise ValueError("Choose two different people to compare.")
        try:
            n = max(1, min(12, int(q.get("n") or 6)))
        except ValueError:
            n = 6
        with self.app.lock:
            snap = self.snapshot()
            for name in (a, b):
                if name not in snap["visible"] and name not in snap["by"]:
                    raise ValueError(f"No one is called {name} any more. Reload the page.")
            linked, parents_of = self.relations(snap["tree"])
            a, b = sorted((a, b))
            reasons = self.candidate_pairs({**snap, "visible": {a, b}}).get((a, b), [])
            pair = self.judge(a, b, reasons, snap, n, {}, linked, parents_of, force=True)
            pair["dismissed"] = (a, b) in self.dismissed()
        return pair

    def checks(self, q):
        """Photos where two or more faces carry this name: at most one of them can be right."""
        name = q.get("name", "")
        app = self.app
        with app.lock:
            ids = [int(f) for f, n in app.labels["names"].items() if n == name]
            per_photo = defaultdict(list)
            for i in ids:
                per_photo[app.faces[i]["photo"]].append(i)
            by_photo = self.faces_by_photo()
            ok = self.ok_index()
            out, hidden = [], 0
            for photo, mine in per_photo.items():
                if len(mine) < 2:
                    continue
                if any(set(mine) <= g for g in ok.get(photo, ())):
                    hidden += 1
                    continue
                fs = sorted(by_photo.get(photo, []), key=lambda f: f["bbox"][0])
                out.append({"photo": photo, "caption": app.captions.get(photo, ""),
                            "faces": [{"id": f["id"], "bbox": [round(v, 1) for v in f["bbox"]], "img_w": f.get("img_w"),
                                       "name": app.labels["names"].get(str(f["id"])), "mine": f["id"] in mine}
                                      for f in fs]})
        out.sort(key=lambda c: c["photo"])
        return {"name": name, "conflicts": out, "marked_fine": hidden}

    def not_duplicate(self, body):
        a, b = str(body.get("a", "")).strip(), str(body.get("b", "")).strip()
        if not a or not b or a == b:
            raise ValueError("Choose two different people.")
        pair = tuple(sorted((a, b)))
        path = self.app.DATA / "not-duplicates.json"
        self.app.describe(f"Showed {pair[0]} and {pair[1]} in possible duplicates again" if body.get("undo")
                          else f"Marked {pair[0]} and {pair[1]} as different people")
        self.app.journal_note(counts={"people": 2})
        with self.app.lock:
            pairs = self.dismissed()
            if body.get("undo"):
                pairs.discard(pair)
            else:
                pairs.add(pair)
            self.app.save_data_file(path, json.dumps({"pairs": [list(p) for p in sorted(pairs)]}, indent=1))
        return {"ok": True, "dismissed": len(pairs)}

    def merge_backup(self, body):
        keep, drop = str(body.get("keep", "")).strip(), str(body.get("drop", "")).strip()
        if not keep or not drop or keep == drop:
            raise ValueError("Choose which name to keep.")
        app = self.app
        with app.lock:
            tree = app.tree.load()
            identities = app.people.load()
            record = {
                "at": datetime.now(timezone.utc).isoformat(), "keep": keep, "drop": drop,
                "faces_named_drop": sorted(int(f) for f, n in app.labels["names"].items() if n == drop),
                "tree": {n: tree["people"].get(n) for n in (keep, drop)},
                "tree_links": {k: [p for p in tree.get(k, []) if drop in p] for k in ("parents", "partners")},
                "people": {n: identities.get(n) for n in (keep, drop)},
            }
            folder = app.DATA / "people-merges"
            folder.mkdir(exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            target = folder / f"{stamp}.json"
            target.write_text(json.dumps(record, indent=1))
        return {"ok": True, "backup": target.name, "faces": len(record["faces_named_drop"])}

    # ---------- "Both correct": a photo that really shows someone twice ----------

    def conflict_ok(self):
        path = self.app.DATA / "conflict-ok.json"
        if not path.exists():
            return []
        return [g for g in json.loads(path.read_text()).get("groups", [])
                if isinstance(g, dict) and g.get("photo") and isinstance(g.get("faces"), list)]

    def ok_index(self):
        index = defaultdict(list)
        for g in self.conflict_ok():
            index[g["photo"]].append({int(f) for f in g["faces"]})
        return index

    def mark_conflict_ok(self, body):
        name, photo = str(body.get("name", "")).strip(), str(body.get("photo", "")).strip()
        if not name:
            raise ValueError("Choose a person.")
        app = self.app
        path = app.DATA / "conflict-ok.json"
        with app.lock:
            groups = self.conflict_ok()
            if body.get("undo"):
                keep = [g for g in groups if not (g.get("name") == name and (not photo or g["photo"] == photo))]
                changed = len(groups) - len(keep)
                groups = keep
            else:
                try:
                    faces = sorted({int(f) for f in body.get("faces") or []})
                except (TypeError, ValueError):
                    raise ValueError("Those faces aren’t valid. Reload the page and try again.")
                if len(faces) < 2 or not photo:
                    raise ValueError("Choose a photo with two or more faces.")
                names = app.labels["names"]
                if any(f < 0 or f >= len(app.faces) or app.faces[f]["photo"] != photo or names.get(str(f)) != name
                       for f in faces):
                    raise ValueError(f"These faces aren’t all named {name} any more. Reload the page.")
                groups = [g for g in groups if not (g["photo"] == photo and set(g["faces"]) <= set(faces))]
                groups.append({"photo": photo, "faces": faces, "name": name,
                               "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
                changed = 1
                app.journal_note(faces=faces)
            if body.get("undo"):
                app.describe(f"Listed {changed:,} photo{'' if changed == 1 else 's'} of {name} to check again")
            else:
                app.describe(f"Marked a photo as correctly showing {name} more than once")
            app.save_data_file(path, json.dumps({"groups": groups}, indent=1))
        return {"ok": True, "changed": changed}

    # ---------- Keep left / Both wrong, with a full undo ----------

    @staticmethod
    def face_ids(body):
        try:
            ids = [int(f) for f in body.get("faces") or []]
        except (TypeError, ValueError):
            raise ValueError("Those faces aren’t valid. Reload the page and try again.")
        if not ids:
            raise ValueError("Choose at least one face.")
        return ids

    def remove_names(self, body):
        """Like /api/reject, but only for faces still named `name`, and says which ids it newly rejected."""
        name, ids = str(body.get("name", "")).strip(), self.face_ids(body)
        app = self.app
        with app.lock:
            names, rejected, sources = app.labels["names"], app.labels["rejected"], app.labels.get("sources", {})
            known = set(rejected)
            removed, newly = [], []
            for f in ids:
                if names.get(str(f)) != name:
                    continue                  # renamed meanwhile: leave it alone
                names.pop(str(f))
                sources.pop(str(f), None)
                removed.append(f)
                if f not in known:
                    rejected.append(f)
                    known.add(f)
                    newly.append(f)
            if removed:
                app.describe(f"Removed the name {name} from {len(removed):,} face{'' if len(removed) == 1 else 's'}")
                app.save()
        if not removed:
            raise ValueError(f"These faces aren’t named {name} any more. Reload the page.")
        return {"ok": True, "removed": removed, "newly_rejected": newly}

    def restore_names(self, body):
        """Undo remove_names: name the faces again (only those still unnamed) and un-reject what it rejected."""
        name, ids = str(body.get("name", "")).strip(), self.face_ids(body)
        if not name:
            raise ValueError("Choose a person.")
        try:
            unreject = {int(f) for f in body.get("unreject") or []} & set(ids)
        except (TypeError, ValueError):
            unreject = set()
        app = self.app
        with app.lock:
            names = app.labels["names"]
            restored, skipped = [], []
            for f in ids:
                if str(f) in names and names[str(f)] != name:
                    skipped.append(f)         # someone named it since: don't overwrite
                    continue
                names[str(f)] = name
                restored.append(f)
            back = unreject & set(restored)
            if back:
                rejected = app.labels["rejected"]
                rejected[:] = [f for f in rejected if f not in back]
            app.save()
        return {"ok": True, "restored": restored, "skipped": skipped}
