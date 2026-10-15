"""Suggested names: likely (face -> name) pairs with the evidence behind each one.

Three sources, strongest evidence first:
  tag    an unnamed face inside a FamilySearch tag box, for a tagged person not yet on a face in that photo
  only   the only tagged or captioned person still unplaced, in a photo with exactly one unnamed face
  alike  batches: unnamed faces whose best face match is one named person (>= 45%, >= 10 points clear)

Suggestions are rebuilt in a background thread whenever names, photos or people change, and
filtered against the live names on every request, so accepting a suggestion takes it out of the
queue at once. Accepting goes through the normal POST /api/label. "Not this person" answers are kept
in data/suggest-rejections.json so they never come back.

GET  /api/suggest[?source=all|tag|only|alike][&limit=N][&branch=maternal|paternal|all|none]
                             -> {building, error, faces, counts: {tag, only, alike}, total_items, items, ms}
GET  /api/suggest?count=1    -> {building, error, faces, counts}     (faces = how many faces have a suggestion)
POST /api/suggest/unnamed    {faces: [id, ...]}         -> {unnamed: [...]}: the ones still without a name
POST /api/suggest/accept     {faces: [id, ...], name, reject: [id, ...]}
                             name the faces that still have no name, and remember "not <name>" for the faces
                             left out of a batch: one request, so History shows it once and Undo takes back both
                             -> {named: [...], rejected: [...], counts, faces}
POST /api/suggest/reject     {faces: [id, ...], name}   remember "these faces are not <name>"
POST /api/suggest/unreject   {faces: [id, ...], name}   forget that again

"Not this person" answers are saved with app.save_data_file, so they are in History and Undo puts them back
(api_history calls reload_rejections after an undo). Rebuilds wait until the names have been still for a
couple of seconds, so fast naming doesn't keep the server busy rebuilding after every save.

Look-alike batches follow the FamilySearch matching branch the page passes (as Groups and Leftovers do):
only people in that branch are offered, and only faces that branch allows. Tag and only-person
suggestions are direct evidence about one photo, not face matching, so they ignore the branch.
Renaming or merging a person (POST /api/rename -> people.rename) carries their rejections over.
"""

import json
import re
import threading
import time
import traceback
import warnings
from collections import defaultdict

import numpy as np
from PIL import Image

from family_faces.pipeline.cluster import caption_names
from family_faces.familysearch.tags import unique_people_by_id

IGNORE = "_ignore"
TINY = 40                   # px: smaller faces don't count as "unnamed faces" in a photo (as in grouping)
ALIKE_MIN, ALIKE_GAP = 0.45, 0.10
ALIKE_MIN_SIZE, ALIKE_MIN_SCORE = TINY, 0.6
SURE_MIN, SURE_SIZE = 0.55, 60   # batch faces below this match or size start unselected, under "Less sure"
BRANCHES = ("maternal", "paternal", "all", "none")
TAG_IOU = 0.3
BATCH_LIMIT = 60            # faces per batch card; the rest of that person's batch follows
REFS = 4
PID = re.compile(r"^[A-Z0-9]{4}-[A-Z0-9]{3}$")


def _key(name):
    return " ".join((name or "").split()).casefold()


def _first(name):
    words = _key(name).split()
    return words[0] if words else ""


class Suggestions:
    def __init__(self, app):
        self.app = app
        self.rej_path = app.DATA / "suggest-rejections.json"
        self.sizes_path = app.DATA / "suggest-photo-sizes.json"
        self.lock = threading.Lock()          # guards the fields below and the rejections file
        self.cache = None                     # last finished build
        self.building_sig = None
        self.error = None
        self.error_sig = None                 # don't retry a failed build until the data changes
        self.rejected = self._load_rejections()
        self.rej_version = 0                  # bumps on every reject/unreject, so the next build sees it
        self.sizes = self._load_sizes()
        self._sizes_dirty = False
        self.renamed = {}                     # old name -> rej_version at the rename (hides stale cached items)
        self.scopes = {}                      # branch -> (signature, scope)

    # ---------- persistence
    def rename(self, old, new):
        """Carry "not <old>" answers over to <new> after a rename or merge, so they don't come back."""
        new = (new or "").strip()
        if not old or not new or old == new:
            return
        with self.lock:
            moved = {(f, n) for f, n in self.rejected if n == old}
            self.rejected = (self.rejected - moved) | {(f, new) for f, _ in moved}
            self.rej_version += 1
            self.renamed[old] = self.rej_version
            if moved:
                self._save_rejections()

    def _load_rejections(self):
        try:
            doc = json.loads(self.rej_path.read_text())
            return {(int(f), n) for f, names in doc.get("pairs", {}).items() for n in names}
        except (OSError, ValueError, AttributeError):
            return set()

    def _save_rejections(self):
        pairs = defaultdict(list)
        for f, n in sorted(self.rejected, key=lambda p: (p[0], p[1])):
            pairs[str(f)].append(n)
        self.app.save_data_file(self.rej_path, json.dumps({"version": 1, "pairs": pairs}, indent=1))

    def reload_rejections(self, kinds=None):
        """An undo or redo rewrote suggest-rejections.json: read it again."""
        if kinds is not None and "file:suggest-rejections.json" not in kinds:
            return
        with self.lock:
            self.rejected = self._load_rejections()
            self.rej_version += 1

    def _load_sizes(self):
        try:
            return json.loads(self.sizes_path.read_text())
        except (OSError, ValueError):
            return {}

    def photo_size(self, path):
        """Upright (width, height) of a photo, or None if its orientation is uncertain or it can't be read.
        Cached in data/suggest-photo-sizes.json (keyed on file size and time)."""
        try:
            full = self.app.library.abspath(path)
            st = full.stat()
        except (OSError, ValueError):
            return None
        stamp = [st.st_mtime_ns, st.st_size]
        hit = self.sizes.get(path)
        if hit and hit[2:] == stamp:
            return hit[:2] if hit[0] else None
        size = [0, 0]
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                with Image.open(full) as im:
                    # Tag boxes and face boxes can only be compared on upright files (as in the tag import).
                    if im.getexif().get(274, 1) in (0, 1):
                        size = list(im.size)
        except Exception:
            pass
        self.sizes[path] = size + stamp
        self._sizes_dirty = True
        return size if size[0] else None

    # ---------- when to rebuild
    def signature(self):
        app = self.app

        def stamp(p):
            try:
                return p.stat().st_mtime_ns
            except OSError:
                return 0
        return (id(app.faces), app.VERSION, self.rej_version, len(app.labels["names"]), stamp(app.labels_path),
                stamp(app.library.PATH), stamp(app.people.PATH), stamp(app.DATA / "tree.json"),
                stamp(app.DATA / "familysearch-matching.json"))

    def scope(self, branch):
        """The FamilySearch matching scope for a branch (None = the saved setting), cached per data version."""
        full = self.signature()
        sig = (full[1],) + full[5:]          # photos, people, tree and the matching setting; not names
        hit = self.scopes.get(branch)
        if hit and hit[0] == sig:
            return hit[1]
        scope = self.app.load_scope(branch)
        self.scopes[branch] = (sig, scope)
        return scope

    SETTLE = 2.0   # seconds the data must stay unchanged before a rebuild starts (one rebuild per burst of saves)

    def ensure(self):
        """Start a rebuild in the background if the data changed since the last one, once it has stopped
        changing for SETTLE seconds (the last build is served meanwhile; view() filters it by the live names)."""
        sig = self.signature()
        now = time.monotonic()
        with self.lock:
            if (self.cache and self.cache["sig"] == sig) or self.building_sig == sig or self.error_sig == sig:
                return
            if self.building_sig is not None:      # a build is running; it re-checks when done
                return
            if self.cache is not None:
                if getattr(self, "_seen", (None,))[0] != sig:
                    self._seen = (sig, now)
                wait = self.SETTLE - (now - self._seen[1])
                if wait > 0:
                    if not getattr(self, "_timer", None):
                        self._timer = threading.Timer(wait + 0.05, self._recheck)
                        self._timer.daemon = True
                        self._timer.start()
                    return
            self.building_sig = sig
        threading.Thread(target=self._run, args=(sig,), daemon=True).start()

    def _recheck(self):
        with self.lock:
            self._timer = None
        try:
            self.ensure()
        except Exception:
            traceback.print_exc()

    def _run(self, sig):
        try:
            t = time.time()
            built = self.build()
            built["sig"], built["ms"] = sig, round((time.time() - t) * 1000)
            with self.lock:
                self.cache, self.error, self.error_sig = built, None, None
        except Exception as exc:
            traceback.print_exc()
            with self.lock:
                self.error, self.error_sig = str(exc), sig
        finally:
            with self.lock:
                self.building_sig = None
        if self._sizes_dirty:
            self._sizes_dirty = False
            try:
                tmp = self.sizes_path.with_suffix(".tmp")
                tmp.write_text(json.dumps(self.sizes))
                tmp.replace(self.sizes_path)
            except OSError:
                pass
        if not self.error and self.signature() != sig:
            self.ensure()

    # ---------- the build
    def build(self):
        app = self.app
        with app.lock:
            names = dict(app.labels["names"])
            removed = set(app.labels.get("rejected", []))
            faces, emb = app.faces, app.emb
            photos = list(app.library.photos())
            captions = dict(app.captions)
            identities = app.people.load()
            hidden = app.hidden_import_people()
        with self.lock:
            rejected = set(self.rejected)

        by_photo = defaultdict(list)
        for f in faces:
            by_photo[f["photo"]].append(f)
        named_by = defaultdict(list)
        n_faces = min(len(faces), len(emb))
        for fid, n in names.items():
            if n != IGNORE and int(fid) < n_faces:   # an import may be adding faces this copy doesn't have yet
                named_by[n].append(int(fid))
        visible = lambda n: bool(n) and n != IGNORE and n not in hidden

        # Library names for tagged people, the way the People page links source photos.
        by_id = unique_people_by_id(identities)
        aliases = defaultdict(set)
        for owner, info in identities.items():
            for a in info.get("aliases", []):
                aliases[_key(a)].add(owner)

        def tag_name(tag):
            n = by_id.get(tag.get("familysearch_id")) or tag.get("resolved")
            owners = aliases.get(_key(n), set())
            if n not in identities and len(owners) == 1:
                n = next(iter(owners))
            return n or None

        # First names of people already named on faces, to read names out of captions.
        first_names = defaultdict(set)
        for n in named_by:
            if visible(n):
                first_names[_first(n)].add(n)
                for a in identities.get(n, {}).get("aliases", []):
                    first_names[_first(a)].add(n)

        def words(n):
            out = set(_key(n).split())
            for a in identities.get(n, {}).get("aliases", []):
                out.update(_key(a).split())
            return out

        # Face matching against everyone who has named faces, hidden and out-of-branch people included:
        # a face that looks most like one of them must not be offered to a runner-up. So unlike
        # app.person_prototypes (which leaves them out) the branch scope isn't applied here; view()
        # applies it to what is offered (people in the branch, faces the branch allows). That is
        # stricter than Groups, never looser.
        pnames = sorted(named_by)
        rows, starts = [], []
        for n in pnames:
            starts.append(sum(map(len, rows)))
            rows.append(app.sample_faces(named_by[n]))   # steady samples: one more name moves at most one
        starts = np.array(starts, dtype=int)
        protos = emb[[i for r in rows for i in r]] if pnames else None
        col = {n: i for i, n in enumerate(pnames)}

        def sims(ids):
            return np.vstack([app.per_person_sims(ids[i:i + 4096], pnames, starts, protos)
                              for i in range(0, len(ids), 4096)])

        unnamed = [f["id"] for f in faces if str(f["id"]) not in names]
        best = np.full(len(faces), -1, int)
        best_s = np.zeros(len(faces), np.float32)
        second_s = np.zeros(len(faces), np.float32)
        if unnamed and len(pnames) > 1:
            for i in range(0, len(unnamed), 4096):
                ids = unnamed[i:i + 4096]
                chunk = app.per_person_sims(ids, pnames, starts, protos)
                part = np.argpartition(-chunk, 1, axis=1)[:, :2]
                a, b = chunk[np.arange(len(ids))[:, None], part].T
                best[ids] = np.where(b > a, part[:, 1], part[:, 0])
                best_s[ids], second_s[ids] = np.maximum(a, b), np.minimum(a, b)

        singles, used_faces = [], set()

        # (a) FamilySearch tag boxes over unnamed faces
        for p in photos:
            boxed = [t for t in p.get("tags", []) if t.get("box_units") == "fraction" and t.get("box")]
            fs = by_photo.get(p["path"], [])
            open_faces = [f for f in fs if str(f["id"]) not in names]
            if not boxed or not open_faces:
                continue
            placed = {names.get(str(f["id"])) for f in fs} - {None}
            pairs = []
            for t in boxed:
                n = tag_name(t)
                if not visible(n) or n in placed:
                    continue
                try:
                    x1, y1, x2, y2 = (float(v) for v in t["box"])
                except (TypeError, ValueError):
                    continue
                if not (0 <= x1 < x2 <= 1.001 and 0 <= y1 < y2 <= 1.001):
                    continue
                size = self.photo_size(p["path"])
                if not size:
                    break
                W, H = size
                for f in open_faces:
                    if abs(f.get("img_w", W) - W) > 2 or (f["id"], n) in rejected:
                        continue
                    a, b, c, d = f["bbox"]
                    a, c, b, d = a / W, c / W, b / H, d / H
                    cx, cy = (a + c) / 2, (b + d) / 2
                    inside = x1 <= cx <= x2 and y1 <= cy <= y2
                    inter = max(0, min(c, x2) - max(a, x1)) * max(0, min(d, y2) - max(b, y1))
                    union = (c - a) * (d - b) + (x2 - x1) * (y2 - y1) - inter
                    iou = inter / union if union > 0 else 0
                    if inside or iou > TAG_IOU:
                        pairs.append((iou, inside, f, n, [round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4)], t))
            # One person per face and one face per person: the best overlap wins.
            taken_f, taken_n = set(), set()
            for iou, inside, f, n, box, t in sorted(pairs, key=lambda x: (-x[0], -x[2]["size"])):
                if f["id"] in taken_f or n in taken_n:
                    continue
                taken_f.add(f["id"]); taken_n.add(n)
                pid = identities.get(n, {}).get("familysearch_id") or t.get("familysearch_id") or ""
                singles.append({"kind": "tag", "face": f["id"], "name": n, "photo": p["path"],
                                "bbox": f["bbox"], "img_w": f.get("img_w"), "box": box,
                                "iou": round(iou, 2), "tag_name": t.get("name") or n,
                                "pid": pid if PID.match(pid) else "",
                                "source_url": t.get("source_url") or p.get("source_url", "")})
                used_faces.add(f["id"])

        # (b) the only person still to place, in a photo with exactly one unnamed (non-tiny) face
        for p in photos:
            fs = by_photo.get(p["path"], [])
            open_faces = [f for f in fs if str(f["id"]) not in names and f["size"] >= TINY]
            if len(open_faces) != 1 or open_faces[0]["id"] in used_faces:
                continue
            tagged = []
            for t in p.get("tags", []):
                n = tag_name(t)
                if n and n != IGNORE and n not in tagged:
                    tagged.append(n)
            cap = captions.get(p["path"], "") or ""
            if not tagged and not cap:
                continue
            placed = {names.get(str(f["id"])) for f in fs} - {None, IGNORE}
            context = set().union(*(words(n) for n in list(placed) + tagged)) if placed or tagged else set()
            mentioned, unsure, from_caption = list(tagged), False, set()
            for token in sorted(caption_names(cap)):
                token = token.casefold()
                if token in context:            # "Ann" when Ann Ward is already here
                    continue
                owners = first_names.get(token, set())
                if len(owners) == 1:
                    n = next(iter(owners))
                    if n not in mentioned:
                        mentioned.append(n)
                        from_caption.add(n)
                elif len(owners) > 1:
                    unsure = True               # "Ann" could be two people: don't guess
            left = [n for n in mentioned if n not in placed]
            if unsure or len(left) != 1 or not visible(left[0]):
                continue
            f, n = open_faces[0], left[0]
            if (f["id"], n) in rejected:
                continue
            singles.append({"kind": "only", "face": f["id"], "name": n, "photo": p["path"],
                            "bbox": f["bbox"], "img_w": f.get("img_w"),
                            "tagged": tagged[:12], "placed": sorted(placed)[:12],
                            "caption": cap if n in from_caption else "", "from_tag": n in tagged,
                            "source_url": p.get("source_url", "")})
            used_faces.add(f["id"])

        # Evidence from the faces themselves: how much each suggested face looks like the name,
        # and whether someone else is a clearly better match.
        if singles and len(pnames):
            rows = sims([s["face"] for s in singles])
            for s, row in zip(singles, rows):
                s["sim"] = round(float(row[col[s["name"]]]), 3) if s["name"] in col else None
                b = int(np.argmax(row))
                s["best"] = None
                if pnames[b] != s["name"] and row[b] >= 0.4 and (s["sim"] is None or row[b] - s["sim"] >= 0.08):
                    s["best"] = [pnames[b], round(float(row[b]), 3)]
        else:
            for s in singles:
                s["sim"], s["best"] = None, None
        # A caption's first name is weaker evidence than a tag: keep it only if the face agrees.
        singles = [s for s in singles if s["kind"] != "only" or s["from_tag"]
                   or (s["sim"] is not None and s["sim"] >= 0.3 and not s["best"])]

        # (c) look-alike batches
        batches = {}
        if len(pnames) > 1:
            single_for = {s["face"] for s in singles}     # each face sits in one place in the queue
            photo_names = defaultdict(set)
            for fid, n in names.items():
                photo_names[faces[int(fid)]["photo"]].add(n)
            cands = defaultdict(list)
            for fid in unnamed:
                f = faces[fid]
                if best[fid] < 0 or fid in removed or f["size"] < ALIKE_MIN_SIZE or f["score"] < ALIKE_MIN_SCORE:
                    continue
                if best_s[fid] < ALIKE_MIN or best_s[fid] - second_s[fid] < ALIKE_GAP:
                    continue
                n = pnames[best[fid]]
                if (fid, n) in rejected or not visible(n) or n in photo_names[f["photo"]] or fid in single_for:
                    continue
                cands[n].append((float(best_s[fid]), float(best_s[fid] - second_s[fid]), fid))
            for n, found in cands.items():
                found.sort(reverse=True)
                seen_photo, keep = set(), []
                for s, gap, fid in found:          # one person can't be two faces in one photo
                    ph = faces[fid]["photo"]
                    if ph in seen_photo:
                        continue
                    seen_photo.add(ph)
                    sure = s >= SURE_MIN and faces[fid]["size"] >= SURE_SIZE
                    keep.append([fid, round(s, 3), round(gap, 3), sure])
                keep.sort(key=lambda r: (not r[3], -r[1]))     # the less sure ones last
                batches[n] = {"kind": "alike", "name": n, "faces": keep, "refs": self.refs(n, named_by[n], faces, emb)}

        return {"singles": singles, "batches": batches, "built": time.time()}

    def refs(self, name, ids, faces, emb):
        """Up to 4 clear faces of this person that look most like the rest of them."""
        if not ids:
            return []
        good = [i for i in ids if faces[i]["score"] >= 0.7 and faces[i]["size"] >= 80] or ids
        c = emb[ids].mean(0)
        order = np.argsort(-(emb[good] @ c))
        return [int(good[i]) for i in order[:REFS]]

    # ---------- what the page sees: the last build, filtered by the live names
    def view(self, count_only=False, source="all", limit=None, branch=None):
        self.ensure()
        app = self.app
        scope = self.scope(branch)
        with self.lock:
            cache, error, building = self.cache, self.error, self.building_sig is not None
            rejected = set(self.rejected)
            # Names renamed since this build: their cached items are stale (accepting would bring the old name back).
            gone = {n for n, v in self.renamed.items() if cache and cache["sig"][2] < v}
        if cache is None:
            return {"building": building or not error, "error": error, "faces": 0,
                    "counts": {"tag": 0, "only": 0, "alike": 0}, "items": []}
        with app.lock:
            names = dict(app.labels["names"])
        faces = app.faces
        photo_names = defaultdict(set)
        for fid, n in names.items():
            if int(fid) < len(faces):
                photo_names[faces[int(fid)]["photo"]].add(n)
        open_ = lambda fid, n: str(fid) not in names and (fid, n) not in rejected and n not in gone
        items, counts, total = [], {"tag": 0, "only": 0, "alike": 0}, set()
        copies_of = {}   # the same image imported twice (two FamilySearch memories): one card, both faces
        for s in cache["singles"]:
            if open_(s["face"], s["name"]) and s["name"] not in photo_names[s["photo"]]:
                total.add(s["face"])
                same = (s["kind"], s["name"], tuple(round(float(v)) for v in s.get("bbox") or ()), s.get("img_w"),
                        None if s.get("sim") is None else round(float(s["sim"]), 3)) if s.get("bbox") else None
                if same and same in copies_of:
                    first = copies_of[same]
                    if first is not None:
                        first.setdefault("copies", []).append({"face": s["face"], "photo": s["photo"]})
                    continue
                counts[s["kind"]] += 1
                item = None if count_only else dict(s, key=f'{s["kind"]}:{s["face"]}:{s["name"]}')
                if same:
                    copies_of[same] = item
                if item is not None:
                    items.append(item)
        batches = []
        for n, b in cache["batches"].items():
            if not scope.allows_name(n):
                continue
            live = [row for row in b["faces"] if open_(row[0], n) and scope.allows_face(faces[row[0]])
                    and n not in photo_names[faces[row[0]]["photo"]]]
            if not live:
                continue
            counts["alike"] += len(live)
            total.update(r[0] for r in live)
            if not count_only:
                batches.append(dict(b, key=f"alike:{n}", faces=live[:BATCH_LIMIT], total=len(live)))
        out = {"building": building, "error": error, "faces": len(total), "counts": counts,
               "ms": cache.get("ms"), "built": cache["built"], "branch": scope.branch}
        if count_only:
            return out
        # Strongest first: tag boxes, then only-person, each by how much the face looks like the name.
        rank = lambda s: -(s["sim"] if s["sim"] is not None else 0.35) + (0.25 if s.get("best") else 0)
        items.sort(key=lambda s: ({"tag": 0, "only": 1}[s["kind"]], rank(s), s["photo"], s["face"]))
        batches.sort(key=lambda b: (-b["total"], b["name"]))
        chosen = [i for i in items + batches if source == "all" or i["kind"] == source]
        out["total_items"], out["items"] = len(chosen), chosen[:limit]
        return out

    def unnamed(self, body):
        """Which of these faces still have no name (and, given a name, which still have that one):
        checked just before accepting or undoing, so a page left open can't overwrite or clear a
        name set somewhere else in the meantime."""
        ids, name = body.get("faces"), body.get("name")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 5000 or \
                any(not isinstance(f, int) or isinstance(f, bool) or not 0 <= f < len(self.app.faces) for f in ids):
            raise ValueError("Choose the faces to check.")
        with self.app.lock:
            names = self.app.labels["names"]
            return {"unnamed": [f for f in ids if str(f) not in names],
                    "same": [f for f in ids if isinstance(name, str) and names.get(str(f)) == name.strip()]}

    def _ids(self, ids, what="Choose the faces to update."):
        if not isinstance(ids, list) or not len(ids) <= 5000 or \
                any(not isinstance(f, int) or isinstance(f, bool) or not 0 <= f < len(self.app.faces) for f in ids):
            raise ValueError(what)
        return list(dict.fromkeys(ids))

    def set_rejected(self, body, add):
        name, ids = body.get("name"), body.get("faces")
        if not isinstance(name, str) or not name.strip() or len(name) > 300:
            raise ValueError("Choose the person these faces are not.")
        ids = self._ids(ids)
        if not ids:
            raise ValueError("Choose the faces to update.")
        n = len(ids)
        self.app.describe(f"Marked {n:,} face{'' if n == 1 else 's'} as not {name}" if add
                          else f"Took back “not {name}” for {n:,} face{'' if n == 1 else 's'}")
        self.app.journal_note(faces=ids)
        with self.lock:
            pairs = {(f, name) for f in ids}
            self.rejected = (self.rejected | pairs) if add else (self.rejected - pairs)
            self.rej_version += 1
            self._save_rejections()
        return self.view(count_only=True)

    def accept(self, body):
        """Name the faces that still have no name and remember "not <name>" for the faces left out of the batch,
        all in one change (one History entry, one Undo)."""
        name, app = body.get("name"), self.app
        if not isinstance(name, str) or not name.strip() or name.strip().startswith("_") or len(name) > 200:
            raise ValueError("Choose the name to save.")
        name = name.strip()
        ids = self._ids(body.get("faces"), "Choose the faces to name.")
        reject = [f for f in self._ids(body.get("reject") or [], "Choose the faces to leave out.") if f not in ids]
        if not ids and not reject:
            raise ValueError("Choose the faces to name.")
        with app.lock:
            names, sources = app.labels["names"], app.labels.get("sources", {})
            named = [f for f in ids if str(f) not in names]   # never overwrite a name set somewhere else
            for f in named:
                names[str(f)] = name
                sources.pop(str(f), None)
            if named:
                app.save()
            if reject:
                with self.lock:
                    self.rejected |= {(f, name) for f in reject}
                    self.rej_version += 1
                    self._save_rejections()
        if named:
            app.describe(f"Named {len(named):,} face{'' if len(named) == 1 else 's'} as {name}"
                         + (f"; marked {len(reject):,} as not {name}" if reject else ""))
        elif reject:
            app.describe(f"Marked {len(reject):,} face{'' if len(reject) == 1 else 's'} as not {name}")
        app.journal_note(faces=named + reject)
        return {**self.view(count_only=True), "named": named, "rejected": reject}


def register(routes, app):
    engine = Suggestions(app)
    app.suggestions = engine

    # Renames and merges go through people.rename (POST /api/rename): carry rejections over.
    people = app.people
    original = getattr(people.rename, "_suggest_original", people.rename)

    def rename(old, new, *args, **kwargs):
        result = original(old, new, *args, **kwargs)
        app.suggestions.rename(old, new)
        return result
    rename._suggest_original = original
    people.rename = rename

    def get(q):
        source = q.get("source", "all")
        if source not in ("all", "tag", "only", "alike"):
            raise ValueError("Choose a suggestion source: all, tag, only or alike.")
        branch = q.get("branch") or None
        if branch is not None and branch not in BRANCHES:
            raise ValueError("Choose a FamilySearch matching branch: maternal, paternal, all or none.")
        try:
            limit = max(1, min(5000, int(q["limit"]))) if q.get("limit") else None
        except ValueError:
            raise ValueError("The limit must be a number.")
        return engine.view(count_only=q.get("count") == "1", source=source, limit=limit, branch=branch)

    routes["GET"]["/api/suggest"] = get
    if getattr(app, "journal", None):
        app.journal.on_revert.append(engine.reload_rejections)
    routes["POST"]["/api/suggest/unnamed"] = engine.unnamed
    routes["POST"]["/api/suggest/accept"] = engine.accept
    routes["POST"]["/api/suggest/reject"] = lambda body: engine.set_rejected(body, True)
    routes["POST"]["/api/suggest/unreject"] = lambda body: engine.set_rejected(body, False)
    engine.ensure()     # warm up while the server starts
