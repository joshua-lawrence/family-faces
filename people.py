"""Identity details for named people: FamilySearch IDs and other names they go by.

data/people.json:  {"Ann Ward": {"familysearch_id": "ABCD-123", "aliases": ["Ann Marie Ward"]}}

Used to map names that arrive with imported photos (e.g. from FamilySearch) onto the
names already used in this library, so one person never ends up under two names.
"""

import json
import re
from pathlib import Path
import config

PATH = config.DATA / "people.json"


def load():
    return json.loads(PATH.read_text()) if PATH.exists() else {}


_cached = {"stamp": None, "doc": {}}


def stamp():
    """Changes whenever people.json is rewritten."""
    try:
        st = PATH.stat()
        return (st.st_mtime_ns, st.st_size)
    except FileNotFoundError:
        return None


def load_cached():
    """people.json parsed once per version of the file, for read-only use (don't change what it returns:
    it is shared). Writers use load(), which always returns a fresh copy."""
    s = stamp()
    if _cached["stamp"] != s:
        _cached.update(stamp=s, doc=load())
    return _cached["doc"]


def save(doc):
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True))
    tmp.replace(PATH)


def _key(name):
    return re.sub(r"\s+", " ", name or "").strip().lower()


def resolve(name, familysearch_id, known_names):
    """The library name for an incoming identity, or None if it needs a person to decide.
    Order: FamilySearch ID already linked -> confirmed alias -> exact (case-insensitive) name."""
    doc = load()
    if familysearch_id:
        for n, info in doc.items():
            if info.get("familysearch_id", "").upper() == familysearch_id.upper():
                return n
    k = _key(name)
    for n, info in doc.items():
        if k and k in (_key(a) for a in info.get("aliases", [])):
            return n
    for n in known_names:
        if k and _key(n) == k:
            return n
    return None


def link(library_name, incoming_name="", familysearch_id=""):
    """Remember that an incoming name / FamilySearch ID means library_name."""
    doc = load()
    info = doc.setdefault(library_name, {})
    if incoming_name and _key(incoming_name) != _key(library_name):
        aliases = info.setdefault("aliases", [])
        if _key(incoming_name) not in (_key(a) for a in aliases):
            aliases.append(incoming_name.strip())
    if familysearch_id:
        info["familysearch_id"] = familysearch_id.strip().upper()
    save(doc)


def rename(old, new):
    doc = load()
    if old not in doc:
        return
    info = doc.pop(old)
    merged = doc.setdefault(new, {})
    for key, value in info.items():
        if key != "aliases" and key not in merged:
            merged[key] = value
    merged.setdefault("aliases", [])
    for a in info.get("aliases", []) + [old]:
        if _key(a) != _key(new) and _key(a) not in (_key(x) for x in merged["aliases"]):
            merged["aliases"].append(a)
    if info.get("familysearch_id") and not merged.get("familysearch_id"):
        merged["familysearch_id"] = info["familysearch_id"]
    save(doc)
