"""The photo registry: every photo in the library, wherever it lives.

data/photos.json is a list, in library order, of
    {"path": "1987/beach_04.jpg" | "Added photos/2026-10-12/IMG_1234.jpg",
     "sha256": ..., "batch": "<album name>" | "2026-10-12", "order": 0,
     "caption": "...", "date": "1987:06:14 ..." or ""}

Paths are relative to the library root (the photo folder chosen in config.py). Face records
refer to their photo by this path, so photos keep their own file names and folders.
"""

import hashlib
import json
from pathlib import Path
import config

HERE = Path(__file__).resolve().parent
ROOT = config.LIBRARY
DATA = config.DATA
INBOX = ROOT / "Inbox"
ADDED = ROOT / "Added photos"
PATH = DATA / "photos.json"
ALBUM = config.ALBUM_NAME   # batch name of the photos that were in the library before any import
IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".webp"}   # HEIC and TIFF go through the Inbox import, which converts them

_cache = None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def photos():
    """All registered photos, in library order (cached until save())."""
    global _cache
    if _cache is None:
        if not PATH.exists():
            if not config.CONFIGURED:
                return []   # no photo folder chosen yet
            migrate()
        _cache = json.loads(PATH.read_text())
    return _cache


def save(items):
    """One photo per line: as readable and diff-friendly as indent=0, but about 3x faster to write (the C
    encoder does each record), which keeps caption and date edits quick on a 10 MB registry."""
    global _cache
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text("[\n" + ",\n".join(json.dumps(p) for p in items) + "\n]\n")
    tmp.replace(PATH)
    _cache = items


def reload():
    global _cache
    _cache = None


def by_path():
    return {p["path"]: p for p in photos()}


def abspath(rel):
    """Absolute path of a registered photo; refuses anything outside the library."""
    p = (ROOT / rel).resolve()
    if ROOT.resolve() not in p.parents:
        raise ValueError(f"not in the library: {rel}")
    return p


def captions():
    return {p["path"]: p["caption"] for p in photos() if p.get("caption")}


def order():
    return {p["path"]: p["order"] for p in photos()}


def album_files():
    """Photos in the library, skipping the app's own folders, the Inbox, exports and hidden folders."""
    skip = {INBOX.resolve(), ADDED.resolve(), (ROOT / "_by_person").resolve(), DATA.resolve(), HERE}
    found = []
    for f in sorted(ROOT.rglob("*")):
        if f.suffix.lower() not in IMAGE_TYPES or not f.is_file():
            continue
        rel = f.relative_to(ROOT)
        if any(part.startswith((".", "_")) for part in rel.parts[:-1]) or any(d in f.resolve().parents for d in skip):
            continue
        found.append(f)
    return found


def migrate():
    """Build the registry from the photos already in the library folder and its subfolders, with
    captions from download-index.json when there is one. Moves nothing."""
    index = {}
    idx_path = ROOT / "download-index.json"
    if idx_path.exists():
        index = {x["filename"]: x for x in json.loads(idx_path.read_text())}
    items = []
    for i, f in enumerate(album_files()):
        rel = f.relative_to(ROOT).as_posix()
        meta = index.get(rel, {})
        items.append({"path": rel, "sha256": sha256(f), "batch": ALBUM, "order": i,
                      "caption": meta.get("caption", "").strip(), "date": ""})
    DATA.mkdir(exist_ok=True)
    save(items)
    return items
