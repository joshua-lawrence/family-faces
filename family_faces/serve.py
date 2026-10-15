"""Local review app: name clusters, fix mistakes, sweep up leftover faces.

    uv run python serve.py     ->  http://localhost:8765

Labels are saved to data/labels.json after every change:
    {"names": {face_id: "Person Name" | "_ignore"}, "rejected": [face_id, ...]}
"""

import contextlib
import hashlib
import json
import shutil
import warnings

# Library deprecation notices (scikit-image via InsightFace, scikit-learn) print once per face during imports
# and bury real errors; they change nothing for this app.
warnings.filterwarnings("ignore", category=FutureWarning)
import sys
import os
import re
import subprocess
import threading
import traceback
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np
from PIL import Image

from family_faces import family
from family_faces.familysearch import upload as familysearch_upload
from family_faces.familysearch import tags as familysearch_tags
from family_faces.familysearch import cleanup as familysearch_cleanup
from family_faces.familysearch.hints import group_source_hints, photo_name_hints
from family_faces.familysearch.scope import load_scope
from family_faces import library
from family_faces.pipeline import matching_groups
from family_faces import people
from family_faces import photo_gallery
from family_faces import people_filters
from family_faces.pipeline import inbox as pipeline
from family_faces import portraits
from family_faces import tree
from family_faces import config

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"   # review.html and the scripts and styles it loads
DATA = config.DATA
PORT = int(os.environ.get("PORT", 8765))   # PORT=8770 python serve.py: another port (for a copy of the library)


def hold_data_lock():
    """One server per library. A second copy on the same data folder would keep its own
    in-memory names and overwrite this one's saves, so it refuses to start instead."""
    import fcntl
    fh = open(DATA / ".server.lock", "a+")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.seek(0)
        where = fh.read().strip()
        sys.exit(f"The app is already running for this library{f' at {where}' if where else ''}. "
                 "Use that window, or quit the other copy first: only one copy can save changes.")
    fh.seek(0)
    fh.truncate()
    fh.write(f"http://localhost:{PORT} (process {os.getpid()})\n")
    fh.flush()
    return fh   # keep it open: the lock lasts as long as this process


if __name__ == "__main__":   # before loading anything, so a second copy changes nothing
    DATA_LOCK = hold_data_lock()

IGNORE = "_ignore"

def load_json(name, default):
    path = DATA / name
    return json.loads(path.read_text()) if path.exists() else default


def load_embeddings():
    path = DATA / "embeddings.npy"
    return np.load(path) if path.exists() else np.zeros((0, 512), dtype=np.float32)


EMPTY_CLUSTERS = {"clusters": [], "unclustered": []}   # a library that hasn't been scanned yet
faces = load_json("faces.json", [])
emb = load_embeddings()
clusters = load_json("clusters.json", EMPTY_CLUSTERS)
captions = library.captions()
labels_path = DATA / "labels.json"
labels = json.loads(labels_path.read_text()) if labels_path.exists() else {"names": {}, "rejected": []}
lock = threading.Lock()
labels_rev = 0   # bumped on every save of labels.json (and reload), so caches of derived data know when to refresh


class Conflict(ValueError):
    """The data changed since the page loaded it: POST answers 409 with this message."""
    status = 409


# The change journal (api/history.py sets this at startup). Every POST request is one
# transaction, so all the files it rewrites become one undoable History entry.
journal = None


def journal_tx(action=None):
    return journal.transaction(action) if journal else contextlib.nullcontext()


def describe(action):
    """Plain-words name of the change this request is making, for History and the undo toast."""
    if journal:
        journal.describe(action)


def journal_note(counts=None, faces=None):
    """Counts and face ids for this request's History entry, when its changes are in plug-in files."""
    if journal:
        journal.note(counts=counts, faces=faces)


def tree_version():
    """Changes whenever tree.json does; the page sends it back so a save can't overwrite newer edits."""
    try:
        return hashlib.sha1(tree.PATH.read_bytes()).hexdigest()[:16]
    except FileNotFoundError:
        return "none"


uploads = familysearch_upload.Uploads(library.ROOT, DATA)


def upload_snapshot(photo):
    """Copy current labels for a preview; call under the app lock."""
    item = library.by_path().get(photo)
    if not item:
        raise ValueError('Choose a photo from the album.')
    return {'photo': dict(item), 'identities': people.load(),
            'faces': [dict(f, name=labels['names'].get(str(f['id']))) for f in faces if f['photo'] == photo]}


def data_version():
    """Changes whenever the face data is rewritten, so the page can bust cached thumbnails and photos."""
    return int(max(((DATA / n).stat().st_mtime for n in ("faces.json", "clusters.json", "map.json", "photos.json", "people.json", "tree.json") if (DATA / n).exists()), default=0))


VERSION = data_version()


def reload_data():
    """Pick up faces/fingerprints/groups/captions rewritten by an import (call under lock)."""
    global faces, emb, clusters, captions, VERSION, labels, labels_rev
    labels_rev += 1
    library.reload()
    labels = json.loads(labels_path.read_text()) if labels_path.exists() else {"names": {}, "rejected": []}
    faces = load_json("faces.json", [])
    emb = load_embeddings()
    clusters = load_json("clusters.json", EMPTY_CLUSTERS)
    captions = library.captions()
    VERSION = data_version()
    portraits._attrs = None
    family._person_cache.clear()
    _people_layout_cache.clear()


# ---- importing new photos from the Inbox (runs in a background thread)
import_state = {"running": False, "stage": "", "done": 0, "total": 0, "report": None, "error": None}
LAST_IMPORT = DATA / "last-import.json"   # the latest import's report, shown on the Imports page


def last_import():
    try:
        return json.loads(LAST_IMPORT.read_text())
    except (OSError, ValueError):
        return None


def run_import():
    def progress(stage, done, total):
        import_state.update(stage=stage, done=done, total=total)

    def apply(names, sources):
        # pipeline.run has just saved the new faces and fingerprints: load them in the same locked step
        # that names them, so no request ever sees names for faces this server doesn't know yet.
        with lock:
            reload_data()
            labels["names"].update({str(k): v for k, v in names.items()})
            labels.setdefault("sources", {}).update({str(k): v for k, v in sources.items()})
            save()

    try:
        with journal_tx("Imported new photos from the Inbox"):   # the whole run is one History entry
            with lock:
                known = (set(labels["names"].values()) - {IGNORE}) | set(tree.load()["people"])
            report = pipeline.run(progress, known, apply)
            if report["added"]:
                with lock:
                    reload_data()   # the new faces, before anyone can name them
                    # Face ids never change on import, so faces taken out of their groups stay out of them.
                    keep_out = {int(f) for f in labels["names"]} | set(labels.get("rejected", []))
                report["groups"] = pipeline.regroup_and_map(keep_out, progress)
                with lock:
                    reload_data()
        report["finished"] = datetime.now().astimezone().isoformat(timespec="seconds")
        try:
            save_data_file(LAST_IMPORT, json.dumps(report, indent=1))
        except OSError:
            pass
        import_state.update(running=False, stage="Done", report=report)
    except Exception as e:
        traceback.print_exc()
        import_state.update(running=False, stage="Failed", error=str(e))


def run_regroup():
    """Regroup the unnamed faces and rebuild the map now (an import does this at its end)."""
    def progress(stage, done, total):
        import_state.update(stage=stage, done=done, total=total)
    try:
        with lock:
            keep_out = {int(f) for f in labels["names"]} | set(labels.get("rejected", []))
        summary = pipeline.regroup_and_map(keep_out, progress)
        # each family branch's groups are cached (matching_groups.py) and never rebuilt on their own: set them
        # aside (with any splits made in them), so the Groups page builds them again from the new grouping
        old = DATA / "matching-groups"
        if old.exists() and any(old.iterdir()):
            keep = DATA / "backups" / f"matching-groups-{datetime.now():%Y%m%d-%H%M%S}"
            keep.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old), str(keep))
        with lock:
            reload_data()
        import_state.update(running=False, stage="Regrouped", regrouped=summary)
    except Exception as e:
        traceback.print_exc()
        import_state.update(running=False, stage="Failed", error=str(e))


_warm = {"started": False}


def warm_up_import():
    """Photos are waiting in the Inbox: load the face-finding libraries in the background now, so pressing
    Process new photos doesn't stall the app for several seconds while they load."""
    if _warm["started"] or import_state["running"]:
        return
    _warm["started"] = True

    def run():
        try:
            import insightface.app  # noqa: F401
            import torch  # noqa: F401
        except Exception:
            pass
    threading.Thread(target=run, name="warm up import", daemon=True).start()


IMPORT_PAGE_SIZE = 24
_import_index = {"faces": None, "by_photo": {}}


def import_faces_by_photo():
    """Faces grouped by photo, left to right. Rebuilt only when an import replaces the face list."""
    if _import_index["faces"] is not faces:
        by_photo = {}
        for f in faces:
            by_photo.setdefault(f["photo"], []).append(f)
        for fs in by_photo.values():
            fs.sort(key=lambda f: f["bbox"][0])
        _import_index.update(faces=faces, by_photo=by_photo)
    return _import_index["by_photo"]


def import_batch_photos(batch):
    return [p for p in library.photos() if p["batch"] == batch]


def import_has_unnamed(photo, by_photo):
    names = labels["names"]
    return any(str(f["id"]) not in names for f in by_photo.get(photo["path"], ()))


def import_counts(items, by_photo):
    """Progress for one import: faces named, skipped and still to name, and photos still to finish."""
    names = labels["names"]
    c = {"photos": len(items), "faces": 0, "named": 0, "skipped": 0, "unnamed": 0, "unnamed_photos": 0, "awaiting": 0}
    for p in items:
        fs = by_photo.get(p["path"], ())
        left = 0
        for f in fs:
            n = names.get(str(f["id"]))
            if n is None:
                left += 1
            elif n == IGNORE:
                c["skipped"] += 1
            else:
                c["named"] += 1
        c["faces"] += len(fs)
        c["unnamed"] += left
        c["unnamed_photos"] += left > 0
        c["awaiting"] += sum(1 for t in p.get("tags", []) if not t.get("resolved"))
    return c


def imports_overview():
    batches = {}
    for p in library.photos():
        if p["batch"] != library.ALBUM:
            batches.setdefault(p["batch"], []).append(p)
    by_photo = import_faces_by_photo()
    return [{"batch": b, **import_counts(items, by_photo)} for b, items in sorted(batches.items(), reverse=True)]


def import_cards(items, by_photo):
    """One card per photo: its faces left to right, their names and, for each unnamed face, the names
    from the photo's notes (best face match first) and up to 3 other look-alikes. People already
    named in the same photo are left out of both."""
    names, sources = labels["names"], labels.get("sources", {})
    unnamed = [f["id"] for p in items for f in by_photo.get(p["path"], ()) if str(f["id"]) not in names]
    rows, pnames = {}, []
    if unnamed:
        pnames, starts, protos = person_prototypes()
        if pnames:
            rows = dict(zip(unnamed, per_person_sims(unnamed, pnames, starts, protos)))
    pidx = {n: i for i, n in enumerate(pnames)}
    out = []
    for p in items:
        fs = by_photo.get(p["path"], [])
        used = {names[str(f["id"])] for f in fs if str(f["id"]) in names} - {IGNORE}
        # Names from the photo's notes not yet on a face here, best face match first for each face.
        notes = list(dict.fromkeys(t["resolved"] for t in p.get("tags", [])
                                   if t.get("resolved") and t.get("face") is None and t["resolved"] not in used))
        skip = used | set(notes)

        def suggest(fid):
            if fid not in rows:
                return []
            return [s for s in top(pnames, rows[fid], 3 + len(skip)) if s[0] not in skip][:3]

        def ranked_notes(fid):
            row = rows.get(fid)
            scored = [[n, round(float(row[pidx[n]]), 3) if row is not None and n in pidx else None] for n in notes]
            return sorted(scored, key=lambda s: (s[1] is None, -(s[1] or 0)))
        out.append({**{k: p.get(k, "") for k in ("path", "caption", "date", "source", "source_url")},
                    "tags": [{"index": i, "name": t.get("name", ""), "familysearch_id": t.get("familysearch_id", ""),
                              "resolved": t.get("resolved"), "face": t.get("face")}
                             for i, t in enumerate(p.get("tags", []))],
                    "faces": [{"id": f["id"], "name": names.get(str(f["id"])),
                               "source": sources.get(str(f["id"])),
                               "notes": [] if str(f["id"]) in names else ranked_notes(f["id"]),
                               "suggest": suggest(f["id"])} for f in fs]})
    return out


def _int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def import_batch(batch, q=None):
    """One page of an import (24 photos), so a 5,000-photo import opens as fast as a small one.

    filter=unnamed (default) lists photos that still have an unnamed face; filter=link, photos with names
    from their notes waiting to be linked to someone; filter=all, every photo.
    order=1 adds the full list of matching photo positions, which the page keeps so pages don't shift
    while faces are being named; at=3,7,9 then fetches exactly those positions.
    next=<position> answers where the next photo with an unnamed face is (wrapping to the start)."""
    q = q or {}
    items = import_batch_photos(batch)
    by_photo = import_faces_by_photo()
    if q.get("next") is not None:
        after = _int(q["next"], -1)
        todo = [i for i, p in enumerate(items) if import_has_unnamed(p, by_photo)]
        nxt = next((i for i in todo if i > after), todo[0] if todo else None)
        return {"batch": batch, "n": len(items), "next": nxt,
                "unnamed_index": todo.index(nxt) if nxt is not None else None}
    flt = q.get("filter") if q.get("filter") in ("all", "link") else "unnamed"
    shown = {"all": lambda p: True,
             "unnamed": lambda p: import_has_unnamed(p, by_photo),
             "link": lambda p: any(not t.get("resolved") for t in p.get("tags", []))}[flt]
    run = q.get("run") or None   # one run of the importer: the photos it just added
    wanted = (lambda p: p.get("run") == run and shown(p)) if run else shown
    out = {"batch": batch, "filter": flt, "per_page": IMPORT_PAGE_SIZE, "n": len(items), "v": VERSION}
    if run:
        out["run"] = run
        out["run_photos"] = sum(1 for p in items if p.get("run") == run)
    if q.get("at") is not None:
        at = [i for i in (_int(x, -1) for x in q["at"].split(",")) if 0 <= i < len(items)][:IMPORT_PAGE_SIZE]
    else:
        order = [i for i, p in enumerate(items) if wanted(p)]
        pages = max(1, -(-len(order) // IMPORT_PAGE_SIZE))
        page = min(max(1, _int(q.get("page"), 1)), pages)
        at = order[(page - 1) * IMPORT_PAGE_SIZE:page * IMPORT_PAGE_SIZE]
        out.update(page=page, pages=pages, total=len(order))
        if q.get("order"):
            out["order"] = order
    out["counts"] = import_counts(items, by_photo)
    out["photos"] = [dict(card, at=i) for i, card in zip(at, import_cards([items[i] for i in at], by_photo))]
    return out


def resolve_tag(path, index, name):
    """Link a name that came with a photo to a person in the library (existing or new),
    remember the link for next time, and resolve any other waiting tags with the same identity."""
    items = library.photos()
    item = next(p for p in items if p["path"] == path)
    tag = item["tags"][index]
    people.link(name, tag.get("name", ""), tag.get("familysearch_id", ""))
    same = lambda t: (not t.get("resolved") and
                      ((tag.get("familysearch_id") and t.get("familysearch_id", "").upper() == tag["familysearch_id"].upper())
                       or t.get("name", "").strip().lower() == tag.get("name", "").strip().lower()))
    for p in items:
        for t in p.get("tags", []):
            if t is tag or same(t):
                t["resolved"] = name
                if t.get("face") is not None:
                    labels["names"][str(t["face"])] = name
                    labels.setdefault("sources", {})[str(t["face"])] = p.get("source") or "photo metadata"
    library.save(items)


def save():
    """Write labels.json atomically (temp file, flushed to disk, then renamed over the old one).
    api/history.py wraps this, and tree/people/library saves, to journal every change."""
    global labels_rev
    labels_rev += 1
    tmp = labels_path.with_suffix(".tmp")
    with open(tmp, "w") as fh:
        fh.write(json.dumps(labels, indent=1))
        fh.flush()
        os.fsync(fh.fileno())
    tmp.replace(labels_path)


def save_data_file(path, text):
    """Write a small data file atomically (temp file, then renamed over the old one). Plug-ins save their own
    files (suggest-rejections.json, not-duplicates.json, conflict-ok.json, matching-groups/...) through this,
    so api/history.py can journal them: then History lists those changes too and Undo puts them back.
    text None removes the file."""
    path = Path(path)
    if text is None:   # an undo of the change that created the file
        path.unlink(missing_ok=True)
        return
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


def import_memory_tags(body):
    """Merge cached MCP reads with current app data. Caller holds the label lock."""
    global VERSION
    if import_state['running']:
        raise ValueError('Wait for the photo import to finish before mapping tags.')
    ids = body.get('memoryIds')
    run_id, batch_id = body.get('runId', ''), body.get('batchId', '')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 150 or \
            any(not isinstance(mid, str) or not re.fullmatch(r'[0-9]{1,20}', mid) for mid in ids) or len(set(ids)) != len(ids) or \
            not isinstance(run_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', run_id) or \
            not isinstance(batch_id, str) or not re.fullmatch(r'[0-9]{1,8}', batch_id):
        raise ValueError('The tag mapping request is not valid.')
    dry_run = body.get('dryRun', False)
    if not isinstance(dry_run, bool):
        raise ValueError('The tag mapping request is not valid.')
    run_dir = DATA / 'familysearch-tags' / 'runs' / run_id
    report_path = run_dir / f'batch-{batch_id}.json'
    if not dry_run and report_path.exists():
        previous = json.loads(report_path.read_text())
        if previous['memoryIds'] != ids:
            raise ValueError('This batch number was already used for other images.')
        return previous['report']
    memories = []
    for mid in ids:
        doc = json.loads((DATA / 'familysearch-tags' / 'raw' / f'{mid}.json').read_text())
        if doc.get('memoryId') != mid or not isinstance(doc.get('people'), list):
            raise ValueError('A saved tag read is not valid.')
        memories.append(doc)
    dimensions = {}
    items = library.photos()
    for photo in items:
        if str(photo.get('memory_id', '')) not in ids:
            continue
        try:
            with Image.open(library.abspath(photo['path'])) as image:
                # The stored source photos are upright. Uncertain orientation cannot label a face.
                if image.getexif().get(274, 1) == 1:
                    dimensions[photo['path']] = image.size
        except (OSError, ValueError):
            pass
    current_people = people.load()
    merged_photos, merged_people, merged_labels, report = familysearch_tags.map_memories(
        items, current_people, labels, faces, memories, dimensions, tree.load().get('people', {}))
    if dry_run:
        return report
    run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = run_dir / 'before'
    if not backup.exists():
        backup.mkdir(mode=0o700)
        for filename, doc in [('photos.json', items), ('people.json', current_people), ('labels.json', labels)]:
            target = backup / filename
            target.write_text(json.dumps(doc, indent=1))
            target.chmod(0o600)
    people.save(merged_people)
    library.save(merged_photos)
    labels.clear()
    labels.update(merged_labels)
    save()
    VERSION = data_version()
    family._person_cache.clear()
    _people_layout_cache.clear()
    temp = report_path.with_suffix('.tmp')
    temp.write_text(json.dumps({'memoryIds':ids, 'report':report}, indent=1))
    temp.chmod(0o600)
    temp.replace(report_path)
    return report


_hidden_cache = {"key": None, "names": frozenset()}


def _stamp(path):
    try:
        st = Path(path).stat()
        return (st.st_mtime_ns, st.st_size)
    except FileNotFoundError:
        return None


def data_stamp():
    """Changes whenever names, the tree, people's details, the photo list or the face data change."""
    return (labels_rev, VERSION, id(faces), people.stamp(), _stamp(tree.PATH), _stamp(library.PATH), id(library.photos()))


class Snap:
    """A consistent copy of the names and face data, taken under the lock, so slow read-only work
    (the Groups/Leftovers state, the map) can run without holding up saves."""

    def __init__(self):
        self.names = dict(labels["names"])
        self.rejected = list(labels.get("rejected", []))
        self.labels = {"names": self.names, "rejected": self.rejected}
        self.faces, self.emb, self.clusters, self.version = faces, emb, clusters, VERSION
        self.stamp = data_stamp()


def hidden_import_people(snap=None):
    """People named only in hidden FamilySearch tag imports (cached until the data changes)."""
    key = snap.stamp if snap else data_stamp()
    if _hidden_cache["key"] == key:
        return _hidden_cache["names"]
    out = frozenset(familysearch_cleanup.hidden_names(people.load_cached(), tree.load(), library.photos(),
                                                      snap.faces if snap else faces,
                                                      snap.names if snap else labels['names']))
    _hidden_cache.update(key=key, names=out)
    return out


def clean_up_tag_people(body):
    """Hide unlinked imports using current data. Caller holds the app lock."""
    global VERSION
    if import_state['running']:
        raise ValueError('Wait for the photo import to finish before cleaning up people.')
    dry_run = body.get('dryRun', False)
    if not isinstance(dry_run, bool):
        raise ValueError('The cleanup request is not valid.')
    imported = json.loads((DATA / 'familysearch-tags' / 'mapping-report.json').read_text())
    current = people.load()
    at = datetime.now(timezone.utc).isoformat()
    updated, report = familysearch_cleanup.hide_unlinked(current, tree.load(), library.photos(), faces,
                                                         labels['names'], imported, at)
    if dry_run:
        return report
    folder = DATA / 'familysearch-tags' / ('cleanup-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    folder.mkdir(parents=True, mode=0o700)
    for filename, doc in [('people.json', current), ('labels.json', labels), ('photos.json', library.photos())]:
        target = folder / filename
        target.write_text(json.dumps(doc, indent=1))
        target.chmod(0o600)
    people.save(updated)
    VERSION = data_version()
    family._person_cache.clear()
    _people_layout_cache.clear()
    report['backup'] = str(folder)
    target = DATA / 'familysearch-tags' / 'cleanup-report.json'
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(report, indent=1))
    temp.chmod(0o600)
    temp.replace(target)
    return report


def sample_faces(ids, k=60):
    """Up to k of a person's faces, chosen by a fixed hash of each face id rather than at random: naming one
    more face changes at most one sample, so match scores (and the suggestions shown) stay steady while
    someone names faces quickly."""
    if len(ids) <= k:
        return list(ids)
    return sorted(ids, key=lambda f: ((int(f) * 2654435761) & 0xFFFFFFFF, int(f)))[:k]


def person_prototypes(scope=None, snap=None):
    """Up to 60 sample faces per named person (not one centroid, so a person
    photographed at 5 and at 50 still matches either age). Rows are grouped by person."""
    scope = scope or load_scope()
    names_map, face_list, vectors = (snap.names, snap.faces, snap.emb) if snap else (labels["names"], faces, emb)
    by = {}
    hidden = hidden_import_people(snap)
    n_faces = min(len(face_list), len(vectors))
    for fid, name in names_map.items():
        f = int(fid)
        if f >= n_faces:   # a face an import is still adding: not loaded here yet
            continue
        if name != IGNORE and name not in hidden and scope.allows_sample(face_list[f], name):
            by.setdefault(name, []).append(f)
    names = sorted(by)
    rows, starts = [], []
    for n in names:
        starts.append(sum(map(len, rows)))
        rows.append(sample_faces(by[n]))
    protos = vectors[[i for r in rows for i in r]] if names else np.zeros((0, vectors.shape[1]), np.float32)
    return names, np.array(starts, dtype=int), protos


def per_person_sims(face_ids, names, starts, protos, vectors=None):
    """faces x people matrix: each face's best similarity to any sample face of that person."""
    return np.maximum.reduceat((emb if vectors is None else vectors)[face_ids] @ protos.T, starts, axis=1)


def group_suggestions(groups, names, starts, protos, per_group=30, chunk=4096, vectors=None):
    """Mean per-person similarity for many face groups at once: one matrix product over all
    the groups' faces (in chunks) instead of one small product per group."""
    rows = [g[:per_group] for g in groups]
    flat = [f for r in rows for f in r]
    if not flat:
        return [np.zeros(len(names), np.float32) for _ in groups]
    sims = np.vstack([per_person_sims(flat[i:i + chunk], names, starts, protos, vectors) for i in range(0, len(flat), chunk)])
    bounds = np.cumsum([0] + [len(r) for r in rows])
    sums = np.add.reduceat(sims, bounds[:-1], axis=0)
    return list(sums / np.maximum(1, np.diff(bounds))[:, None])


def top(names, scores, k):
    if len(scores) > k:   # only the best k are needed: partial sort instead of sorting everyone
        best = np.argpartition(-scores, k)[:k]
        order = best[np.argsort(-scores[best])]
    else:
        order = np.argsort(-scores)[:k]
    return [[names[i], round(float(scores[i]), 3)] for i in order if scores[i] > 0.25]


def top_rows(names, mat, k):
    """top(names, row, k) for every row of a matrix at once (one partial sort for all rows)."""
    mat = np.asarray(mat)
    if not len(mat):
        return []
    if not len(names):
        return [[] for _ in range(len(mat))]
    k = min(k, mat.shape[1])
    idx = np.argpartition(-mat, k - 1, axis=1)[:, :k] if mat.shape[1] > k else np.tile(np.arange(mat.shape[1]), (len(mat), 1))
    vals = np.take_along_axis(mat, idx, axis=1)
    order = np.argsort(-vals, axis=1, kind="stable")
    idx, vals = np.take_along_axis(idx, order, 1).tolist(), np.take_along_axis(vals, order, 1).tolist()
    return [[[names[i], round(v, 3)] for i, v in zip(ri, rv) if v > 0.25] for ri, rv in zip(idx, vals)]


def face_hints(fid, face_list, source_hints):
    """group_source_hints() for one face, without the counting (a leftover face is one photo)."""
    return [dict(h, photos=1) for h in sorted(source_hints.get(face_list[fid]["photo"], ()),
                                               key=lambda h: h["name"].casefold())[:3]]


_static_counts = {"key": None}


def state(branch=None, snap=None):
    """Everything the Groups and Leftover faces pages need. Runs on a Snap (a copy taken under the lock), so it
    doesn't hold up saves while it works."""
    snap = snap or Snap()
    names, faces_, vectors = snap.names, snap.faces, snap.emb
    hidden = hidden_import_people(snap)
    rejected = set(snap.rejected)
    scope = load_scope(branch)
    grouped, building, matching_error = matching_groups.get(scope, faces_, snap.labels, snap.clusters.get('threshold', .65))
    photos = library.photos()
    key = (id(faces_), id(photos), _stamp(library.PATH), branch, scope)
    if _static_counts["key"] != key:
        photo_sources = {p['path']: p.get('source', '') for p in photos}
        _static_counts.update(key=key,
                              album=[f['id'] for f in faces_ if photo_sources.get(f['photo']) != 'FamilySearch'],
                              matching=[f['id'] for f in faces_ if scope.allows_face(f)],
                              allowed={f['id'] for f in faces_ if scope.allows_face(f)})
    album_faces, matching_faces, allowed = _static_counts["album"], _static_counts["matching"], _static_counts["allowed"]
    source_hints = {path: [p for p in tagged if p["name"] not in hidden]
                    for path, tagged in photo_name_hints(photos, people.load_cached(), scope.names).items()}
    pnames, starts, protos = person_prototypes(scope, snap)
    lives = [[f for f in c["faces"] if f not in rejected and f in allowed] for c in grouped["clusters"]]
    # Suggestions for every still-unnamed group, computed together (was one product per group).
    want = [i for i, live in enumerate(lives)
            if live and pnames and not any(names.get(str(f)) and names.get(str(f)) not in hidden for f in live)]
    sugg = dict(zip(want, top_rows(pnames, group_suggestions([lives[i] for i in want], pnames, starts, protos,
                                                             vectors=vectors), 3))) if want else {}
    out_clusters = []
    for i, (c, live) in enumerate(zip(grouped["clusters"], lives)):
        tally = {}
        for f in live:
            n = names.get(str(f))
            if n and n not in hidden:
                tally[n] = tally.get(n, 0) + 1
        name = max(tally, key=tally.get) if tally else None
        unlabeled = sum(1 for f in live if str(f) not in names)
        out_clusters.append({
            "id": c["id"], "faces": live, "sims": dict(zip(map(str, c["faces"]), c["sims"])),
            "photos": len({faces_[f]['photo'] for f in live}), "captioned": c["captioned"], "hints": c["hints"],
            "name": name, "unlabeled": unlabeled, "suggest": sugg.get(i, []),
            "source_hints": group_source_hints(live, faces_, source_hints),
        })
    grouped_ids = {f for c in grouped['clusters'] for f in c['faces']}
    leftovers = ([] if building or matching_error else
                 [f['id'] for f in faces_ if f['id'] in allowed
                  and str(f['id']) not in names and (f['id'] not in grouped_ids or f['id'] in rejected)])
    left = [{"id": f, "suggest": [], "source_hints": face_hints(f, faces_, source_hints)} for f in leftovers]
    if leftovers and pnames:
        for i in range(0, len(leftovers), 4096):
            rows = top_rows(pnames, per_person_sims(leftovers[i:i + 4096], pnames, starts, protos, vectors), 2)
            for item, row in zip(left[i:i + 4096], rows):
                item["suggest"] = row
    left.sort(key=lambda x: -(x["suggest"][0][1] if x["suggest"] else 0))
    person_photos = {}
    for f, n in names.items():
        if n != IGNORE and int(f) < len(faces_):
            person_photos.setdefault(n, set()).add(faces_[int(f)]["photo"])
    for n, linked in source_photos_by_person().items():
        person_photos.setdefault(n, set()).update(p["path"] for p in linked)
    family_tree = tree.load()
    for n in family_tree["people"]:
        person_photos.setdefault(n, set())
    scope_config_path = DATA / 'familysearch-matching.json'
    scope_config = json.loads(scope_config_path.read_text()) if scope_config_path.exists() else {}
    people_root = people_filters.default_root(family_tree, people.load_cached(), scope_config)
    return {
        "clusters": out_clusters, "leftovers": left,
        "people": {n: len(p) for n, p in sorted(person_photos.items()) if n not in hidden},
        "hidden_people": {n: len(p) for n, p in sorted(person_photos.items()) if n in hidden},
        "people_photo_counts": people_filters.photo_counts(person_photos, photos),
        "people_tree_names": sorted(family_tree['people']), "people_default_root": people_root,
        "home_person": config.SETTINGS.get("home_person", ""), "library_name": config.LIBRARY.name,
        "inbox_path": str(library.INBOX), "familysearch_enabled": config.FAMILYSEARCH_ENABLED,
        # face_photo, photo_sources and captions only change when photos are imported:
        # the page fetches them once per data version from /api/static (see static_data()).
        "album_faces": len(album_faces), "album_labeled": sum(str(fid) in names for fid in album_faces),
        "familysearch_matching": scope.summary(),
        "matching_building": building, "matching_error": matching_error,
        "matching_faces": len(matching_faces), "matching_labeled": sum(str(fid) in names for fid in matching_faces),
        "reps": representative_faces(snap), "source_reps": source_representatives(),
        "v": snap.version,
        "total_faces": len(faces_), "labeled": len(names),
    }


_state_cache = {}   # branch -> (key, encoded JSON body)


def state_body(branch=None):
    """GET /api/state as encoded JSON. The lock is held only to copy the names; the work runs outside it, and
    the result is reused until something it depends on changes (a reload with nothing new costs nothing)."""
    with lock:
        snap = Snap()
    scope = load_scope(branch)
    group_file = matching_groups.cache_path(scope, len(snap.faces), snap.clusters.get('threshold', .65))
    key = (snap.stamp, scope, _stamp(group_file), _stamp(DATA / 'familysearch-matching.json'))
    hit = _state_cache.get(branch)
    if hit and hit[0] == key:
        return hit[1]
    doc = state(branch, snap)
    body = json.dumps(doc).encode()
    if not doc["matching_building"] and not doc["matching_error"]:
        _state_cache[branch] = (key, body)
    return body


def static_data():
    """Per-data-version reference data, cached by the browser (about 3 MB that used to
    be resent on every refresh)."""
    return {"v": VERSION, "face_photo": {f["id"]: f["photo"] for f in faces},
            "photo_sources": {p['path']: p.get('source', '') for p in library.photos()},
            "captions": {p: c for p, c in captions.items() if c}}


_source_cache = {"key": None, "out": {}}


def source_photos_by_person():
    """Photo associations from source records; these do not assign face labels. Cached until people.json or
    the photo list changes (read-only: don't change what it returns)."""
    key = (people.stamp(), _stamp(library.PATH), id(library.photos()))
    if _source_cache["key"] == key:
        return _source_cache["out"]
    out = _source_photos_by_person()
    _source_cache.update(key=key, out=out)
    return out


def _source_photos_by_person():
    identities = people.load_cached()
    by_id = familysearch_tags.unique_people_by_id(identities)
    aliases = {}
    for owner, info in identities.items():
        for alias in info.get("aliases", []):
            aliases.setdefault(alias.strip().casefold(), set()).add(owner)
    out = {}
    for photo in library.photos():
        names = {}
        for tag in photo.get("tags", []):
            name = by_id.get(tag.get("familysearch_id")) or tag.get("resolved")
            owners = aliases.get((name or "").strip().casefold(), set())
            if name not in identities and len(owners) == 1:
                name = next(iter(owners))
            if name:
                names.setdefault(name, tag)
        for name, tag in names.items():
            item = {k: photo.get(k, "") for k in ("path", "caption", "date", "source", "source_url", "memory_id")}
            item["source_url"] = tag.get("source_url") or item["source_url"]
            item["memory_id"] = tag.get("memory_id") or item["memory_id"]
            item["source"] = item["source"] or "FamilySearch"
            out.setdefault(name, []).append(item)
    return out


def source_representatives():
    return {name: photos[0]["path"] for name, photos in source_photos_by_person().items() if photos}


def person_detail(name):
    """Every face carrying this name, likeliest mistakes first.

    fit: mean similarity to the face's 10 closest same-name faces (low = doesn't look like the rest).
    conflict: another face in the same photo has the same name, so one of them is wrong.
    """
    ids = [int(f) for f, n in labels["names"].items() if n == name]
    linked = source_photos_by_person().get(name, [])
    identity = people.load().get(name, {})
    if not ids:
        out = {"name": name, "faces": [], "photos": len(linked), "source_photos": linked, "identity": identity}
        if not linked and not identity and name not in tree.load()["people"]:
            # An old name (a rename, or an album name linked to someone): say who it belongs to now.
            key = name.strip().casefold()
            owners = [n for n, info in people.load_cached().items()
                      if any(str(a).strip().casefold() == key for a in info.get("aliases", []) or [])]
            if len(owners) == 1:
                out["alias_of"] = owners[0]
        return out
    sims = emb[ids] @ emb[ids].T
    np.fill_diagonal(sims, -1)
    k = min(10, len(ids) - 1)
    fit = np.sort(sims, axis=1)[:, -k:].mean(1) if k else np.ones(len(ids))
    per_photo = {}
    for f in ids:
        per_photo.setdefault(faces[f]["photo"], []).append(f)
    out = [{"id": f, "photo": faces[f]["photo"], "fit": round(float(s), 3),
            "conflict": len(per_photo[faces[f]["photo"]]) > 1}
           for f, s in zip(ids, fit)]
    out.sort(key=lambda x: (not x["conflict"], x["photo"] if x["conflict"] else "", x["fit"]))
    return {"name": name, "faces": out, "photos": len(set(per_photo) | {p["path"] for p in linked}), "source_photos": linked, "identity": identity}


_reps_cache = {"key": None, "reps": {}}


def representative_faces(snap=None):
    """For each named person, their clearest face that looks most like the rest of them (cached per data version)."""
    names_map, face_list, vectors = (snap.names, snap.faces, snap.emb) if snap else (labels["names"], faces, emb)
    key = snap.stamp if snap else data_stamp()
    if _reps_cache["key"] == key:
        return _reps_cache["reps"]
    by = {}
    n_faces = min(len(face_list), len(vectors))
    for f, n in names_map.items():
        if n != IGNORE and int(f) < n_faces:
            by.setdefault(n, []).append(int(f))
    out = {}
    for n, ids in by.items():
        good = [i for i in ids if portraits.good(i, face_list)] or ids
        c = vectors[ids].mean(0)
        out[n] = good[int(np.argmax(vectors[good] @ c))]
    _reps_cache.update(key=key, reps=out)
    return out


def sex_guesses():
    """Majority vote of the face model's per-face sex estimate, for each named person."""
    A = portraits.attrs()
    votes = {}
    for f, n in labels["names"].items():
        a = A.get(int(f))
        if n != IGNORE and a:
            votes.setdefault(n, []).append(a["sex"] == "M")
    return {n: ("M" if sum(v) / len(v) >= 0.5 else "F") for n, v in votes.items() if len(v) >= 3}


_people_layout_cache = {}


def people_layout(people, cents):
    """2D positions for people so that nearby = alike, from the full person-to-person
    similarity matrix (t-SNE on 1 - cosine, started from a metric-MDS layout).

    Unrelated faces are all about equally unalike, so no flat map can keep every distance;
    t-SNE keeps who-is-near-whom best. Returns unit-square coords plus two honesty scores:
    rank correlation between map and true distances, and the share of each person's top-5
    lookalikes that are also among their 5 nearest on the map."""
    from scipy.stats import spearmanr
    from sklearn.manifold import MDS, TSNE
    # Naming one more face nudges that person's average face but rarely changes who sits near whom, so the layout
    # is reused until the set of people on the map changes (or a person's average face moves a lot). Without
    # this, the Map took 2-6 s to open after every name change.
    key = hashlib.sha1("|".join(people).encode()).hexdigest()
    hit = _people_layout_cache.get(key)
    if hit is not None and (hit[2].shape == cents.shape and float(np.min(np.sum(hit[2] * cents, axis=1))) > 0.98):
        return hit[0], hit[1]
    dist = np.clip(1 - cents @ cents.T, 0, None)
    np.fill_diagonal(dist, 0)
    xy = MDS(n_components=2, dissimilarity="precomputed", n_init=1, random_state=0,
             normalized_stress="auto").fit_transform(dist)
    if len(people) >= 20:
        init = (xy - xy.mean(0)) / xy.std(0) * 1e-2
        xy = TSNE(metric="precomputed", perplexity=min(12, (len(people) - 1) / 3), init=init,
                  early_exaggeration=4, random_state=0).fit_transform(dist)
    xy = (xy - xy.min(0)) / (xy.max(0) - xy.min(0)).max()
    d2 = np.linalg.norm(xy[:, None] - xy[None], axis=-1)
    iu = np.triu_indices(len(people), 1)
    faithful = float(spearmanr(d2[iu], dist[iu]).correlation)
    kept = float(np.mean([len(set(np.argsort(dist[i])[1:6]) & set(np.argsort(d2[i])[1:6])) / 5
                          for i in range(len(people))]))
    out = (xy, {"faithful": round(faithful, 2), "neighbours": round(kept, 2)})
    _people_layout_cache.clear()
    _people_layout_cache[key] = (*out, cents.copy())
    return out


def face_map(snap=None):
    """Face cloud layout plus person-level lookalikes, from the current names (on a Snap: the slow layout
    work runs without holding up saves).

    Person similarity is the cosine between each person's mean face embedding.
    """
    if not (DATA / "map.json").exists():
        return {"missing": True, "people": []}
    snap = snap or Snap()
    faces, emb = snap.faces, snap.emb
    m = json.loads((DATA / "map.json").read_text())
    hidden = hidden_import_people(snap)
    names = {f: n for f, n in snap.names.items() if n not in hidden and int(f) < len(faces)}
    by = {}
    for f, n in names.items():
        if n != IGNORE:
            by.setdefault(n, []).append(int(f))
    people = sorted((n for n in by if len(by[n]) >= 3), key=lambda n: -len(by[n]))
    xy = np.array(m["xy"])
    cents, out = [], []
    for n in people:
        ids = by[n]
        c = emb[ids].mean(0)
        c /= np.linalg.norm(c)
        cents.append(c)
        good = [i for i in ids if faces[i]["score"] >= 0.7 and faces[i]["size"] >= 80] or ids
        rep = good[int(np.argmax(emb[good] @ c))]
        x, y = np.median(xy[ids], axis=0)
        out.append({"name": n, "faces": len(ids), "photos": len({faces[i]["photo"] for i in ids}),
                    "x": round(float(x), 4), "y": round(float(y), 4), "rep": rep})
    pairs, quality = [], None
    if len(people) >= 3:
        lxy, quality = people_layout(people, np.array(cents))
        for p, (x, y) in zip(out, lxy):
            p["lx"], p["ly"] = round(float(x), 4), round(float(y), 4)
    if people:
        sim = np.array(cents) @ np.array(cents).T
        np.fill_diagonal(sim, -1)
        for i, p in enumerate(out):
            order = np.argsort(-sim[i])[:5]
            p["like"] = [[int(j), round(float(sim[i, j]), 3)] for j in order]
        iu = np.triu_indices(len(people), 1)
        top = np.argsort(-sim[iu])[:25]
        pairs = [[int(iu[0][k]), int(iu[1][k]), round(float(sim[iu][k]), 3)] for k in top]
    index = {n: i for i, n in enumerate(people)}
    return {
        "xy": m["xy"], "tile": m["tile"], "cols": m["cols"], "people": out, "pairs": pairs, "quality": quality,
        # per face: index into people, -1 unnamed (or a person with < 3 faces), -2 ignored
        "who": [index.get(names.get(str(f["id"])), -2 if names.get(str(f["id"])) == IGNORE else -1) for f in faces],
    }


# Writes that can't go through POST /api/batch (they check their own headers or start long jobs).
BATCH_REFUSED = {"/api/batch", "/api/import", "/api/regroup", "/api/familysearch-tags/import", "/api/familysearch-tags/cleanup",
                 "/api/familysearch-upload/preview", "/api/familysearch-upload/confirm"}


class Handler(SimpleHTTPRequestHandler):
    timeout = 30   # seconds a connection may sit idle mid-request (a body shorter than its length header)

    def log_message(self, *a):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype, cache=None):
        if not path.is_file():
            return self.send_error(404)
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache or ("no-cache" if ctype.startswith(('text/html', 'text/javascript', 'text/css')) else "max-age=3600"))
        self.end_headers()
        self.wfile.write(data)

    def send_video(self, path):
        """MP4 with HTTP Range support, so the browser can seek."""
        if not path.is_file():
            return self.send_error(404)
        size = path.stat().st_size
        start, end = 0, size - 1
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a) if a else max(0, size - int(b))
            end = min(int(b), size - 1) if a and b else size - 1   # browsers may ask past the end
        with open(path, "rb") as fh:
            fh.seek(start)
            data = fh.read(end - start + 1)
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(data)))
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        p = unquote(urlparse(self.path).path)
        if p == "/":
            body = page_html().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return self.wfile.write(body)
        if p.startswith("/web/") and "/" not in p[5:] and not p[5:].startswith("."):
            f = WEB / p[5:]
            ctype = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8"}.get(f.suffix, "application/octet-stream")
            # The page links these with ?v=<file time>, so a versioned URL never changes: cache it for good.
            versioned = "v=" in (urlparse(self.path).query or "")
            return self.send_file(f, ctype, "max-age=31536000, immutable" if versioned else None)
        handler = PLUGIN_ROUTES["GET"].get(p) or next(
            (fn for pre, fn in PLUGIN_ROUTES["GET_PREFIX"].items() if p.startswith(pre)), None)
        if handler:
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            q["_path"] = p
            try:
                return self.send_json(handler(q))
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, status=400)
        if p == '/api/people-relations':
            q = parse_qs(urlparse(self.path).query)
            try:
                with lock:
                    result = people_filters.relations(tree.load(), q.get('root', [''])[0],
                        partners=q.get('partners', ['true'])[0] != 'false')
                return self.send_json(result)
            except ValueError as exc:
                return self.send_json({'error': str(exc)}, status=400)
        if p == '/api/photo-gallery':
            q = parse_qs(urlparse(self.path).query)
            try:
                with lock:
                    result = photo_gallery.gallery(library.photos(), faces, labels['names'], source_photos_by_person(),
                        selected=q.get('person', []), mode=q.get('mode', ['and'])[0], source=q.get('source', ['all'])[0],
                        offset=_int(q.get('offset', ['0'])[0], 0), limit=max(1, min(500, _int(q.get('limit', ['60'])[0], 60))))
                    hidden = hidden_import_people() - set(q.get('person', []))
                    result['people'] = {n:c for n,c in result['people'].items() if n not in hidden}
                return self.send_json(result)
            except ValueError as exc:
                return self.send_json({'error': str(exc)}, status=400)
        if p.startswith('/gallery-image/'):
            item = library.by_path().get(p[len('/gallery-image/'):])
            if not item:
                return self.send_error(404)
            try:
                image = photo_gallery.thumbnail(item, library.ROOT, DATA / 'gallery-thumbnails')
                return self.send_file(image, 'image/jpeg')
            except (OSError, ValueError):
                return self.send_error(404, 'Photo preview is not available')
        if p == "/api/static":
            with lock:
                body = json.dumps(static_data()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=31536000, immutable")   # URL carries the version
            self.end_headers()
            return self.wfile.write(body)
        if p == "/api/state":
            branch = parse_qs(urlparse(self.path).query).get('branch', [None])[0]
            try:
                body = state_body(branch)
            except ValueError as exc:
                return self.send_json({'error': str(exc)}, status=400)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if p == "/api/map":
            with lock:
                snap = Snap()
            return self.send_json(face_map(snap))
        if p in ("/api/portrait", "/api/gallery", "/composite.jpg"):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            with lock:
                if p == "/api/gallery":
                    hidden = hidden_import_people()
                    return self.send_json(portraits.gallery({f:n for f,n in labels["names"].items() if n not in hidden}, faces))
                if p == "/api/portrait":
                    return self.send_json(portraits.detail(q.get("name", ""), labels["names"], faces, emb))
                names = dict(labels["names"])
            # composites are slow-ish and read-only: build them outside the lock
            jpg = portraits.composite(q.get("name", ""), q.get("band", "all"), names, faces, q.get("blend"))
            if jpg is None:
                return self.send_error(404)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpg)))
            self.send_header("Cache-Control", "max-age=300")
            self.end_headers()
            return self.wfile.write(jpg)
        if p == "/api/tree":
            with lock:
                return self.send_json({"tree": tree.load(), "version": tree_version(), "reps": representative_faces(), "source_reps": source_representatives(), "sex": sex_guesses(),
                                       "ids": {n: i.get("familysearch_id", "") for n, i in people.load().items()}})
        if p == "/family-tree.ged":
            with lock:
                fs_ids = {n: i["familysearch_id"] for n, i in people.load().items() if i.get("familysearch_id")}
                body = tree.gedcom(sex_guesses(), fs_ids).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", 'attachment; filename="family-tree.ged"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        if p in ("/api/family", "/api/branches", "/api/family-video", "/group.jpg"):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            with lock:
                names = dict(labels["names"])
            ages = q.get("ages", "all") if q.get("ages") in family.AGES else "all"
            if p == "/api/family":
                return self.send_json(family.detail(q.get("name", ""), names, faces, ages))
            if p == "/api/branches":
                return self.send_json(family.branches(names, faces, ages))
            if p == "/api/family-video":
                out = family.generations_video(q.get("name", ""), names, faces, ages)
                return self.send_json(out) if out else self.send_error(404)
            jpg = family.group_jpg([n for n in q.get("names", "").split("|") if n], names, faces, ages)
            if jpg is None:
                return self.send_error(404)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpg)))
            self.send_header("Cache-Control", "max-age=300")
            self.end_headers()
            return self.wfile.write(jpg)
        if p == "/api/morph":
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            with lock:
                names = dict(labels["names"])
            out = portraits.morph_video(q.get("name", ""), q.get("order", "age"), names, faces)   # may take ~15s
            return self.send_json(out) if out else self.send_error(404)
        if p.startswith("/morphs/"):
            return self.send_video(DATA / "morphs" / Path(p).name)
        if p.startswith("/aligned/"):
            return self.send_file(DATA / "aligned" / Path(p).name, "image/jpeg")
        if p == "/atlas.jpg":
            return self.send_file(DATA / "atlas.jpg", "image/jpeg")
        if p == "/api/person":
            name = parse_qs(urlparse(self.path).query).get("name", [""])[0]
            with lock:
                return self.send_json(person_detail(name))
        if p == '/api/person-upload-photos':
            name = parse_qs(urlparse(self.path).query).get('name', [''])[0]
            with lock:
                paths = {f['photo'] for f in faces if labels['names'].get(str(f['id'])) == name}
                items = [dict(path=p['path'], caption=p.get('caption', '')) for p in library.photos()
                         if p['path'] in paths and p.get('source') != 'FamilySearch' and not p.get('memory_id')]
            return self.send_json({'photos': uploads.statuses(items)})
        if p == "/api/import":
            inbox = len(pipeline.inbox_files())
            if inbox:
                warm_up_import()
            return self.send_json({**import_state, "inbox": inbox, "skipped": pipeline.inbox_skipped(),
                                   "last": None if import_state.get("report") else last_import()})
        if p == "/api/imports":
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            with lock:
                return self.send_json(import_batch(q["batch"], q) if q.get("batch") else imports_overview())
        if p.startswith("/api/photo/"):
            name = p[len("/api/photo/"):]
            item = library.by_path().get(name, {})
            source_tag = next((t for t in item.get("tags", []) if t.get("source_url")), {})
            fs = [f for f in faces if f["photo"] == name]
            identities = people.load()
            return self.send_json({
                "photo": name, "caption": captions.get(name, ""), "original_available": item.get("original_available", True), "source": item.get("source", "") or ("FamilySearch" if source_tag else ""),
                "source_url": item.get("source_url", "") or source_tag.get("source_url", ""),
                "faces": [{"id": f["id"], "bbox": f["bbox"], "img_w": f.get("img_w"), "name": labels["names"].get(str(f["id"])),
                           'familysearch_id': identities.get(labels['names'].get(str(f['id'])), {}).get('familysearch_id', '')} for f in fs],
            })
        if p.startswith("/thumbs/"):
            return self.send_file(DATA / "thumbs" / Path(p).name, "image/jpeg")
        if p.startswith("/photos/"):
            rel = p[len("/photos/"):]
            item = library.by_path().get(rel)
            if not item:
                return self.send_error(404)
            original = parse_qs(urlparse(self.path).query).get("original", ["0"])[0] == "1"
            thumbnail = parse_qs(urlparse(self.path).query).get("thumbnail", ["0"])[0] == "1"
            target = (item.get("thumbnail_path") if thumbnail else None) or item.get("preview_path") if not original else None
            if target:
                return self.send_file(library.abspath(target), "image/jpeg")
            ctype = item.get("mime_type") or {".png": "image/png", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff", ".bmp": "image/bmp"}.get(Path(rel).suffix.lower(), "image/jpeg")
            return self.send_file(library.abspath(rel), ctype)
        self.send_error(404)

    def do_POST(self):
        """Every POST answers JSON: the result (plus "history": the History entry it made, if
        any), or {"error": message} with 400 (bad request), 403 (not from this app's page),
        404, 409 (the data changed since the page loaded it) or 500."""
        p = urlparse(self.path).path
        refused = self.cross_site()
        if not refused and p in PLUGIN_ROUTES["POST"] and \
                self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            refused = "Use the app's own page to make this change."   # plug-in writes take JSON only (feat/viewer)
        if refused:
            return self.send_json({"error": refused}, status=403)
        if p == "/api/batch":
            return self.post_batch()
        tx = None
        try:
            with journal_tx() as tx:
                status, result = self.route_post(p)
        except Exception as exc:
            status, result = error_reply(exc)
        if tx is not None and tx.entry and status == 200 and isinstance(result, dict):
            result["history"] = journal.brief(tx.entry)
        self.send_json(result, status=status)

    def post_batch(self):
        """{requests: [{url, body}, ...]}: several writes in one request, run one after another in the order
        given, each its own History entry, as if they had been sent one by one. The page sends the writes it
        hasn't sent yet this way (with keepalive) when it is closed or reloaded, so none is lost and their
        order is kept. Answers {results: [{status, result}, ...]}."""
        try:
            reqs = self.read_json().get("requests")
            if not isinstance(reqs, list) or not reqs or len(reqs) > 500:
                raise ValueError("Send the changes to save as a list.")
        except Exception as exc:
            status, result = error_reply(exc)
            return self.send_json(result, status=status)
        results = []
        for r in reqs:
            url, sub = (r.get("url"), r.get("body")) if isinstance(r, dict) else (None, None)
            path = urlparse(url).path if isinstance(url, str) else ""
            if path in BATCH_REFUSED or not path.startswith("/api/") or not isinstance(sub, dict):
                results.append({"status": 400, "result": {"error": "This change can’t be sent in a batch."}})
                continue
            tx = None
            try:
                with journal_tx() as tx:
                    status, result = self.dispatch(path, sub)
            except Exception as exc:
                status, result = error_reply(exc)
            if tx is not None and tx.entry and status == 200 and isinstance(result, dict):
                result["history"] = journal.brief(tx.entry)
            results.append({"status": status, "result": result})
        return self.send_json({"results": results})

    def cross_site(self):
        """Refuse writes that don't come from this app's own page (another website, or a
        DNS-rebinding page posing as localhost). Returns the reason, or None."""
        host = self.headers.get("Host", "")
        if host not in (f"localhost:{PORT}", f"127.0.0.1:{PORT}"):
            return f"Changes can only be made from the app itself, at http://localhost:{PORT}."
        origin = self.headers.get("Origin")
        if (origin and origin != f"http://{host}") or self.headers.get("Sec-Fetch-Site") == "cross-site":
            return "Changes can only be made from the app’s own page, not from another website."
        return None

    def read_json(self):
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("The request has a broken length header.")
        if size < 0 or size > 50_000_000:
            raise ValueError("The request is too large.")
        raw = self.rfile.read(size) if size else b""
        if not raw.strip():
            return {}
        try:
            body = json.loads(raw)
        except (ValueError, RecursionError):
            raise ValueError("The request isn't valid JSON, so nothing was changed.")
        if not isinstance(body, dict):
            raise ValueError("The request must be a JSON object, so nothing was changed.")
        return body

    def route_post(self, p):
        """(status, result) for a POST; raises for errors (see error_reply)."""
        if p in ('/api/familysearch-tags/import', '/api/familysearch-tags/cleanup'):
            host = self.headers.get('Host', '')
            origin = self.headers.get('Origin')
            if host not in (f'localhost:{PORT}', f'127.0.0.1:{PORT}') or \
                    (origin and origin != f'http://{host}') or \
                    self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return 403, {'error':'Use the local app to map tags.'}
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 20_000:
                    raise ValueError('The tag mapping request is not valid.')
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError('The tag mapping request is not valid.')
                with lock:
                    describe('Mapped FamilySearch tags' if p.endswith('/import') else 'Hid unlinked FamilySearch people')
                    report = import_memory_tags(body) if p.endswith('/import') else clean_up_tag_people(body)
                return 200, report
            except (ValueError, KeyError, TypeError, OSError) as exc:
                message = str(exc) if isinstance(exc, ValueError) else 'Could not map these saved tags.'
                return 400, {'error':message}
        if p in ('/api/familysearch-upload/preview', '/api/familysearch-upload/confirm'):
            # These actions write to FamilySearch. Require a local JSON request.
            host = self.headers.get('Host', '')
            origin = self.headers.get('Origin')
            if host not in (f'localhost:{PORT}', f'127.0.0.1:{PORT}') or \
                    (origin and origin != f'http://{host}') or \
                    self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                return 403, {'error': 'Open this action from the local People page.'}
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if size <= 0 or size > 100_000:
                    raise ValueError('The upload request is not valid.')
                body = json.loads(self.rfile.read(size))
                with lock:
                    snapshot = upload_snapshot(body.get('photo', ''))
                result = uploads.preview(body, snapshot) if p.endswith('/preview') else uploads.confirm(body.get('previewToken'), snapshot)
                return 200, result
            except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as exc:
                message = str(exc) if isinstance(exc, ValueError) else 'Could not check this photo. Check the file and tags, then try the preview again.'
                return 400, {'error': message}
        return self.dispatch(p, self.read_json())

    @staticmethod
    def dispatch(p, body):
        """(status, result) for a JSON write to p."""
        if p in PLUGIN_ROUTES["POST"]:
            return 200, PLUGIN_ROUTES["POST"][p](body)
        result = post_core(p, body)
        if result is None:
            return 404, {"error": "There is nothing to save at this address. Reload the page and try again."}
        return 200, result


def error_reply(exc):
    """(status, {"error": ...}) for an exception raised while handling a POST."""
    if isinstance(exc, ValueError):
        return getattr(exc, "status", 400), {"error": str(exc) or "The request is not valid."}
    if isinstance(exc, KeyError):
        return 400, {"error": f"The request is missing “{exc.args[0]}”, so nothing was changed."}
    if isinstance(exc, TypeError):
        return 400, {"error": "The request is not valid, so nothing was changed."}
    traceback.print_exc()
    return 500, {"error": "Something went wrong in the app, so this change may not have been saved. "
                          "Reload the page to check; the server log has the details."}


def face_ids(body):
    """The face ids a request names, checked against this library."""
    ids = body["faces"]
    if not isinstance(ids, list):
        raise ValueError("Choose the faces to change.")
    out = []
    for f in ids:
        if isinstance(f, str) and f.isascii() and f.isdigit():
            f = int(f)
        if not isinstance(f, int) or isinstance(f, bool) or not 0 <= f < len(faces):
            raise ValueError("Some of those faces aren't in this library any more. Reload the page and try again.")
        out.append(f)
    return out


def clean_name(name, empty_ok=True):
    """A person's name from a request: None (no name) or trimmed text."""
    if name is None or name == "":
        if empty_ok:
            return None
        raise ValueError("Type a name first.")
    if not isinstance(name, str):
        raise ValueError("A name must be text.")
    name = name.strip()
    if not name:
        raise ValueError("Type a name first.")
    if len(name) > 200:
        raise ValueError("That name is too long (200 characters at most).")
    return name


def post_core(p, body):
    """The built-in write endpoints. Returns the JSON result (None: no such endpoint)."""
    if p == "/api/regroup":
        with lock:
            if import_state["running"]:
                return {"error": "Wait for the import or regroup that's running to finish."}
            import_state.update(running=True, stage="Regrouping faces", done=0, total=0, report=None, error=None,
                                regrouped=None)
        threading.Thread(target=run_regroup, daemon=True).start()
        return {"ok": True}
    if p == "/api/import":
        with lock:
            if not import_state["running"]:
                import_state.update(running=True, stage="Starting", done=0, total=0, report=None, error=None)
                threading.Thread(target=run_import, daemon=True).start()
        return {"ok": True}
    with lock:
        if p == "/api/reload":
            reload_data()
        elif p == "/api/resolve-tag":
            path, index, name = body["path"], body["index"], clean_name(body["name"], empty_ok=False)
            if isinstance(index, str) and index.isdigit():
                index = int(index)
            if not isinstance(path, str) or not isinstance(index, int) or isinstance(index, bool):
                raise ValueError("That photo or tag isn't in the library any more. Reload the page and try again.")
            item = library.by_path().get(path)
            if not item or not 0 <= index < len(item.get("tags", [])):
                raise ValueError("That photo or tag isn't in the library any more. Reload the page and try again.")
            describe(f"Linked “{item['tags'][index].get('name') or 'a tag'}” to {name}")
            resolve_tag(path, index, name)
            save()
        elif p == "/api/person-id":
            fsid = body.get("familysearch_id") or ""
            if not isinstance(fsid, str) or len(fsid) > 40:
                raise ValueError("A FamilySearch ID is text like KWC8-4ZM.")
            people.link(clean_name(body["name"], empty_ok=False), familysearch_id=fsid)
        elif p == "/api/label":
            # {faces: [...], name: "X" | "_ignore" | null}, or {batch: [{faces, name}, ...]} for one undo step.
            # Options (top level): only_unnamed: true names only faces that have no name yet (the check runs here,
            # in the same step as the save, so nothing can slip in between); reject: true also takes the faces
            # out of their groups (Groups' "Name selected"), so naming and leaving the group are one change.
            # Answers {"ok", "named": [ids whose name changed], "faces": n}.
            batch = body["batch"] if "batch" in body else [body]
            if not isinstance(batch, list) or not all(isinstance(b, dict) for b in batch):
                raise ValueError("The request is not valid, so nothing was changed.")
            work = [(face_ids(b), clean_name(b.get("name"))) for b in batch]
            only_unnamed, reject = body.get("only_unnamed") is True, body.get("reject") is True
            names, sources, changed = labels["names"], labels.get("sources", {}), []
            for ids, name in work:
                for f in ids:
                    k = str(f)
                    if only_unnamed and k in names:
                        continue
                    if names.get(k) != name:
                        changed.append(f)
                        sources.pop(k, None)   # the name no longer came from the photo's notes or tags
                    if name:
                        names[k] = name
                    else:
                        names.pop(k, None)
                    if reject and f not in labels["rejected"]:
                        labels["rejected"].append(f)
            save()
            return {"ok": True, "named": changed, "faces": sum(len(ids) for ids, _ in work)}
        elif p == "/api/reject":
            # {faces: [...]} -> pull out of their cluster and drop any name
            sources = labels.get("sources", {})
            for f in face_ids(body):
                labels["names"].pop(str(f), None)
                sources.pop(str(f), None)
                if f not in labels["rejected"]:
                    labels["rejected"].append(f)
            save()
        elif p == "/api/rename":
            # {old, new} -> rename (or merge into) a person everywhere
            old, new = body["old"], clean_name(body["new"], empty_ok=False)
            if not isinstance(old, str) or not old:
                raise ValueError("Choose the person to rename.")
            if new != old:
                known = set(labels["names"].values()) | set(tree.load()["people"]) | set(people.load())
                describe(f"Merged {old} into {new}" if new in known else f"Renamed {old} to {new}")
                for f, n in labels["names"].items():
                    if n == old:
                        labels["names"][f] = new
                tree.rename(old, new)
                people.rename(old, new)
                save()
        elif p == "/api/tree":
            # {tree: {people, parents, partners}, version} - version from GET /api/tree
            doc = body.get("tree", body)
            if not isinstance(doc, dict) or not isinstance(doc.get("people", {}), dict):
                raise ValueError("The family tree data is not valid, so it wasn't saved.")
            if "version" not in body or "tree" not in body:   # a page from before saves carried a version
                raise ValueError("This page is out of date. Reload it and make the change again.")
            if body.get("version") != tree_version():
                raise Conflict("The family tree was changed somewhere else (another tab, a rename or an undo) "
                               "since this page loaded it. The latest tree is shown now; please make your change again.")
            tree.save(doc)
            return {"ok": True, "version": tree_version()}
        else:
            return None
    return {"ok": True}


# ---- Plug-in endpoints: every api_*.py module next to this file defines
#   register(routes, app)  where routes = {"GET": {path: fn}, "POST": {path: fn}, "GET_PREFIX": {prefix: fn}}
#   GET handlers:  fn(query: dict) -> JSON-able object   (query values are single strings; query["_path"] = path)
#   POST handlers: fn(body: dict)  -> JSON-able object   (called WITHOUT the app lock; take app.lock yourself)
#   `app` is this running module: app.faces, app.emb, app.labels, app.lock, app.save(), app.reload_data(),
#   app.library, app.people, app.tree, app.DATA ... (always read them through `app.`, they're replaced on reload).
#   Raise ValueError("message for the user") for a 400. Never `import serve`: it would load a second copy.
PLUGIN_ROUTES = {"GET": {}, "POST": {}, "GET_PREFIX": {}}


def load_plugins():
    import importlib
    app = sys.modules[__name__]
    for path in sorted((HERE / "api").glob("*.py")):
        if path.stem == "__init__":
            continue
        mod = importlib.import_module(f"family_faces.api.{path.stem}")
        mod.register(PLUGIN_ROUTES, app)
    return sorted(PLUGIN_ROUTES["GET"]) + sorted(PLUGIN_ROUTES["POST"])


def page_html():
    """review.html with the web/ add-on files (CSS, then JS, in name order) linked in."""
    html = (WEB / "review.html").read_text()
    web = WEB
    css = "".join(f'<link rel="stylesheet" href="/web/{f.name}?v={int(f.stat().st_mtime)}">\n' for f in sorted(web.glob("*.css")))
    js = "".join(f'<script src="/web/{f.name}?v={int(f.stat().st_mtime)}"></script>\n' for f in sorted(web.glob("*.js")))
    return html.replace("<!-- WEB:CSS -->", css).replace("<!-- WEB:JS -->", js)


if __name__ == "__main__":
    put_back = pipeline.recover_interrupted()   # an import that stopped halfway: its photos go back to the Inbox
    if put_back:
        import_state["recovered"] = put_back
        print(f"Put {len(put_back)} photos from an import that stopped back in the Inbox: {', '.join(put_back[:5])}")
    routes = load_plugins()
    print(f"Review app: http://localhost:{PORT}" + (f"  (plug-in endpoints: {', '.join(routes)})" if routes else ""))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
