"""Change history, undo and rolling backups.

Every write to the four files that hold your work (labels.json, tree.json, people.json,
photos.json) is compared with what was on disk just before it, and the difference is appended
to data/history.jsonl, one line per change:

    {"id": 12, "time": "2026-10-10T14:32:05-07:00", "kind": "change" | "undo" | "redo",
     "action": "Named 12 faces Ann Ward", "counts": {"faces": 12}, "undoable": true,
     "undoes": 11, "base": "<action of the change an undo/redo is about>",
     "changes": {"labels": {...}, "tree": {...}, "people": {...}, "photos": {...}}}

Each file's changes map a top-level key to one of
    {"v": {"b": before, "a": after}}                         the whole value
    {"d": {subkey: {"b": before, "a": after}}}               a dict: only the changed sub-keys
    {"l": {"add": [item, ...], "remove": [[index, item], ...]}}   a list, as a set of items
("b" or "a" is left out when the key is absent on that side; a removed key also keeps "i", its
position, so undo puts it back where it was and the file comes back byte for byte.) photos.json, a list of photo
records, is diffed as {path: record} under "records"; photos added or removed (imports) are only
listed by path, under "added"/"removed", and make the entry not undoable.

Undo puts every "b" back, but only if every value still equals its "a", and (family tree) no
link would be left pointing at someone the undo takes out; otherwise 409 and a message naming
the later change. Nothing to undo / already undone are 200 {"ok": false, "nothing": true,
"message"}. The undo is itself an entry, so it can be redone.

history.jsonl is appended under an flock and re-read before each id is chosen, so ids stay
unique even if another process writes to it (serve.py also refuses a second server per library).

How writes are caught: register() wraps app.save (labels.json), tree.save, people.save and
library.save, so every endpoint, including other plug-ins, is journaled without changes.
Plug-ins' own small data files are journaled too when they are written with app.save_data_file():
suggest-rejections.json ("not this person" answers), not-duplicates.json, conflict-ok.json and the
cached groups in matching-groups/ (Split into new group). Their kind is "file:<path under data/>" and
their changes have the same shape as labels'. After an undo puts one back, the functions in
journal.on_revert are called with the set of kinds it changed, so plug-ins can reload what they cache.
An endpoint can add to its entry with app.journal.note(counts={...}, faces=[ids]) (for History's
counts and face thumbnails) when its changes are only in such files.
serve.py's do_POST makes each request one transaction (one entry); writes outside a request
(the Inbox import thread opens its own) are one entry each.

Snapshots: copies of the four files in data/snapshots/YYYY-MM-DD_HHMM/, taken at startup and at
most every 15 minutes after a change. The newest 48 are kept, plus the last one of each day for
30 days. Files unchanged since the previous snapshot are hard links to it, so they take no space.
"""

import copy
import fcntl
import json
import os
import re
import shutil
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path

FILES = {"labels": "labels.json", "tree": "tree.json", "people": "people.json", "photos": "photos.json"}
TRACKED = {"suggest-rejections.json", "not-duplicates.json", "conflict-ok.json"}   # + matching-groups/*.json
WHAT = {"suggest-rejections.json": "those suggestions", "not-duplicates.json": "those people",
        "conflict-ok.json": "those photos"}
IGNORE = "_ignore"
_M = object()   # "this key is absent"


# ---------------------------------------------------------------- diffs

def _pair(b, a, i=None):
    p = {}
    if b is not _M:
        p["b"] = b
    if a is not _M:
        p["a"] = a
    elif i is not None and b is not _M:
        p["i"] = i   # where the removed key sat
    return p


def _reorder(d, wanted):
    """Put re-added keys back at their old positions ({key: index}), in place."""
    wanted = {k: i for k, i in wanted.items() if k in d}
    if not wanted:
        return
    items = [(k, v) for k, v in d.items() if k not in wanted]
    for k, i in sorted(wanted.items(), key=lambda kv: kv[1]):
        items.insert(min(i, len(items)), (k, d[k]))
    d.clear()
    d.update(items)


def _side(p, after):
    return p.get("a" if after else "b", _M)


def _same(x, y):
    return (x is _M) == (y is _M) and (x is _M or x == y)


def _key(item):
    return json.dumps(item, sort_keys=True, separators=(",", ":"))


def _diff_lists(b, a):
    bk, ak = {}, {}
    for i, x in enumerate(b):
        bk.setdefault(_key(x), (i, x))
    for x in a:
        ak.setdefault(_key(x), x)
    return {"add": [x for k, x in ak.items() if k not in bk],
            "remove": [[i, x] for k, (i, x) in bk.items() if k not in ak]}


def diff_docs(before, after):
    """Changes from one JSON object to another, per top-level key (see the module docstring)."""
    out, top = {}, None
    for k in sorted(before.keys() | after.keys(), key=str):
        b, a = before.get(k, _M), after.get(k, _M)
        if _same(b, a):
            continue
        if isinstance(b, dict) and isinstance(a, dict):
            pos = {sk: i for i, sk in enumerate(b)} if b.keys() - a.keys() else {}
            d = {sk: _pair(b.get(sk, _M), a.get(sk, _M), pos.get(sk)) for sk in sorted(b.keys() | a.keys(), key=str)
                 if not _same(b.get(sk, _M), a.get(sk, _M))}
            if d:
                out[k] = {"d": d}
        elif isinstance(b, list) and isinstance(a, list):
            lst = _diff_lists(b, a)
            if lst["add"] or lst["remove"]:   # a reorder alone is not a change
                out[k] = {"l": lst}
        else:
            if a is _M and top is None:
                top = {key: i for i, key in enumerate(before)}
            out[k] = {"v": _pair(b, a, (top or {}).get(k))}
    return out


def diff_photos(before, after):
    bm = {p.get("path"): p for p in before if isinstance(p, dict)}
    am = {p.get("path"): p for p in after if isinstance(p, dict)}
    out = {}
    records = diff_docs({k: bm[k] for k in bm.keys() & am.keys()}, {k: am[k] for k in bm.keys() & am.keys()})
    if records:
        out["records"] = records
    added = sorted(k for k in am.keys() - bm.keys() if k)
    removed = sorted(k for k in bm.keys() - am.keys() if k)
    if added:
        out["added"] = added
    if removed:
        out["removed"] = removed
    return out


def apply_doc(doc, changes, forward):
    """Move doc to the other side of these changes, in place (forward=False undoes them)."""
    top = {}
    for k, ch in changes.items():
        if "v" in ch:
            v = _side(ch["v"], forward)
            if v is _M:
                doc.pop(k, None)
            else:
                doc[k] = copy.deepcopy(v)
                if not forward and "i" in ch["v"]:
                    top[k] = ch["v"]["i"]
        elif "d" in ch:
            target = doc.get(k)
            if not isinstance(target, dict):
                target = doc[k] = {}
            back = {}
            for sk, p in ch["d"].items():
                v = _side(p, forward)
                if v is _M:
                    target.pop(sk, None)
                else:
                    target[sk] = copy.deepcopy(v)
                    if not forward and "i" in p:
                        back[sk] = p["i"]
            _reorder(target, back)
        elif "l" in ch:
            lst = doc.get(k)
            if not isinstance(lst, list):
                lst = doc[k] = []
            adds, removes = ch["l"]["add"], ch["l"]["remove"]
            gone = {_key(x) for _, x in removes} if forward else {_key(x) for x in adds}
            lst[:] = [x for x in lst if _key(x) not in gone]
            if forward:
                lst.extend(copy.deepcopy(adds))
            else:
                for i, x in sorted(removes, key=lambda r: r[0]):
                    lst.insert(min(i, len(lst)), copy.deepcopy(x))
    _reorder(doc, top)
    return doc


def check_doc(doc, changes):
    """(key, subkey) of every value that is no longer what these changes left behind."""
    bad = []
    for k, ch in changes.items():
        cur = doc.get(k, _M)
        if "v" in ch:
            if not _same(cur, _side(ch["v"], True)):
                bad.append((k, None))
        elif "d" in ch:
            cur = cur if isinstance(cur, dict) else {}
            bad += [(k, sk) for sk, p in ch["d"].items() if not _same(cur.get(sk, _M), _side(p, True))]
        elif "l" in ch:
            have = {_key(x) for x in cur} if isinstance(cur, list) else set()
            bad += [(k, _key(x)) for x in ch["l"]["add"] if _key(x) not in have]
            bad += [(k, _key(x)) for _, x in ch["l"]["remove"] if _key(x) in have]
    return bad


def _touches(changes, bad):
    for k, sk in bad:
        ch = changes.get(k)
        if not ch:
            continue
        if "v" in ch or sk is None or ("d" in ch and sk in ch["d"]):
            return True
        if "l" in ch and sk in {_key(x) for x in ch["l"]["add"]} | {_key(x) for _, x in ch["l"]["remove"]}:
            return True
    return False


def _value_after(value, ch, forward):
    doc = {} if value is _M else {"x": copy.deepcopy(value)}
    return apply_doc(doc, {"x": ch}, forward).get("x", _M)


def _compose_key(c1, c2):
    """One key's change c1 followed by c2, as a single change (None if they cancel out)."""
    t1, t2 = next(iter(c1)), next(iter(c2))
    if t1 == t2 == "d":
        d = dict(c1["d"])
        for sk, p2 in c2["d"].items():
            first = d.get(sk, p2)
            b, a = _side(first, False), _side(p2, True)
            if _same(b, a):
                d.pop(sk, None)
            else:
                d[sk] = _pair(b, a, first.get("i"))
        return {"d": d} if d else None
    if t1 == t2 == "l":
        add = {_key(x): x for x in c1["l"]["add"]}
        rem = {_key(x): [i, x] for i, x in c1["l"]["remove"]}
        for x in c2["l"]["add"]:
            if _key(x) in rem:
                del rem[_key(x)]
            else:
                add[_key(x)] = x
        for i, x in c2["l"]["remove"]:
            if _key(x) in add:
                del add[_key(x)]
            else:
                rem[_key(x)] = [i, x]
        return {"l": {"add": list(add.values()), "remove": list(rem.values())}} if add or rem else None
    # Whole values (or the value changed type between writes): work out both ends in full.
    i = c1["v"].get("i") if t1 == "v" else None
    if t1 == "v":
        b, a = _side(c1["v"], False), _value_after(_side(c1["v"], True), c2, True)
    elif t2 == "v":
        b, a = _value_after(_side(c2["v"], False), c1, False), _side(c2["v"], True)
    else:   # a dict that became a list between two writes of the same request: keep the latest
        return c2
    return None if _same(b, a) else {"v": _pair(b, a, i)}


def compose(c1, c2):
    out = dict(c1)
    for k, ch in c2.items():
        merged = _compose_key(out[k], ch) if k in out else ch
        if merged is None:
            out.pop(k, None)
        else:
            out[k] = merged
    return out


# ---------------------------------------------------------------- plain-words descriptions

def _n(n, one, many=None):
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def _faces_touched(labels_ch):
    ids = set(labels_ch.get("names", {}).get("d", {}))
    ids |= set(labels_ch.get("sources", {}).get("d", {}))
    rej = labels_ch.get("rejected", {}).get("l", {})
    ids |= {str(x) for x in rej.get("add", [])} | {str(x) for _, x in rej.get("remove", [])}
    return ids


def counts(changes):
    out = {}
    if changes.get("labels"):
        out["faces"] = len(_faces_touched(changes["labels"]))
    if changes.get("tree"):
        t = changes["tree"]
        out["tree"] = (len(t.get("people", {}).get("d", {})) + sum(
            len(t.get(k, {}).get("l", {}).get("add", [])) + len(t.get(k, {}).get("l", {}).get("remove", []))
            for k in ("parents", "partners"))) or 1
    if changes.get("people"):
        out["people"] = len(changes["people"])
    if changes.get("photos"):
        ph = changes["photos"]
        out["photos"] = len(ph.get("records", {})) + len(ph.get("added", [])) + len(ph.get("removed", []))
    return {k: v for k, v in out.items() if v}


def file_kind(kind):
    return kind.startswith("file:")


def describe_labels(ch):
    names = ch.get("names", {}).get("d", {})
    rej = ch.get("rejected", {}).get("l", {"add": [], "remove": []})
    if names:
        n = len(names)
        befores = [_side(p, False) for p in names.values()]
        afters = [_side(p, True) for p in names.values()]
        named = {a for a in afters if a is not _M}
        had = {b for b in befores if b is not _M}
        if all(a is not _M for a in afters):
            if len(named) == 1:
                to = next(iter(named))
                if to == IGNORE:
                    return f"Ignored {_n(n, 'face')}"
                if len(had) == 1 and all(b is not _M for b in befores) and IGNORE not in had:
                    return f"Moved {_n(n, 'face')} from {next(iter(had))} to {to}"
                return f"Named {_n(n, 'face')} as {to}"
            if not had:
                return f"Named {_n(n, 'face')} as {_n(len(named), 'person', 'people')}"
            return f"Changed the names on {_n(n, 'face')}"
        if all(a is _M for a in afters):
            if had == {IGNORE}:
                return f"Stopped ignoring {_n(n, 'face')}"
            out_of_group = set(names) <= {str(x) for x in rej["add"]}
            if len(had) == 1 and out_of_group:
                return f"Took {_n(n, 'face')} out of {next(iter(had))}’s group"
            if out_of_group:
                return f"Took {_n(n, 'face')} out of their groups"
            if len(had) == 1:
                return f"Removed the name {next(iter(had))} from {_n(n, 'face')}"
            return f"Removed the names from {_n(n, 'face')}"
        return f"Changed the names on {_n(n, 'face')}"
    if rej["add"] and not rej["remove"]:
        return f"Took {_n(len(rej['add']), 'face')} out of {'its group' if len(rej['add']) == 1 else 'their groups'}"
    if rej["remove"] and not rej["add"]:
        return f"Put {_n(len(rej['remove']), 'face')} back in {'its group' if len(rej['remove']) == 1 else 'their groups'}"
    if rej["add"] or rej["remove"]:
        return f"Changed which faces are left out of groups ({_n(len(rej['add']) + len(rej['remove']), 'face')})"
    if "sources" in ch:
        return f"Updated where {_n(len(_faces_touched(ch)), 'name')} came from"
    return "Updated face names"


def _both(xs):
    xs = list(xs)
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


def describe_tree(ch):
    people = ch.get("people", {}).get("d", {})
    added = [n for n, p in people.items() if "b" not in p]
    removed = [n for n, p in people.items() if "a" not in p]
    edited = [n for n, p in people.items() if "a" in p and "b" in p]
    pairs = {k: ch.get(k, {}).get("l", {"add": [], "remove": []}) for k in ("parents", "partners")}
    gone = set(removed)
    phrases = [f"Removed {n} from the family tree" for n in removed]
    by_child = {}
    for p, c in pairs["parents"]["add"]:
        by_child.setdefault(c, []).append(p)
    phrases += [f"Added {_both(ps)} as {c}’s {'parent' if len(ps) == 1 else 'parents'}" for c, ps in by_child.items()]
    phrases += [f"Linked {a} and {b} as partners" for a, b in pairs["partners"]["add"]]
    phrases += [f"Removed {p} as {c}’s parent" for _, (p, c) in pairs["parents"]["remove"] if not {p, c} & gone]
    phrases += [f"Unlinked {a} and {b} as partners" for _, (a, b) in pairs["partners"]["remove"] if not {a, b} & gone]
    mentioned = {x for p in pairs["parents"]["add"] + pairs["partners"]["add"] for x in p}
    phrases += [f"Added {n} to the family tree" for n in added if n not in mentioned]
    for n in edited:
        b, a = people[n]["b"] or {}, people[n]["a"] or {}
        fields = {k for k in set(b) | set(a) if b.get(k) != a.get(k)}
        phrases.append(f"Changed {n}’s {'dates' if fields <= {'born', 'died'} else 'details'}")
    if not phrases:
        return "Changed the family tree"
    if len(phrases) == 1:
        return phrases[0]
    if len(phrases) == 2:
        return phrases[0] + "; " + phrases[1][0].lower() + phrases[1][1:]
    return f"{phrases[0]} and {_n(len(phrases) - 1, 'more tree change')}"


def describe_people(ch):
    if len(ch) == 1:
        name, c = next(iter(ch.items()))
        if "d" in c:
            fields = c["d"]
            if set(fields) == {"familysearch_id"}:
                after = _side(fields["familysearch_id"], True)
                return f"{'Saved' if after not in (_M, '') else 'Removed'} {name}’s FamilySearch ID"
            if set(fields) == {"aliases"}:
                b = _side(fields["aliases"], False)
                a = _side(fields["aliases"], True)
                new = [x for x in (a if isinstance(a, list) else []) if x not in (b if isinstance(b, list) else [])]
                if len(new) == 1:
                    return f"Linked “{new[0]}” to {name}"
        if "v" in c and "b" not in c["v"]:
            new = c["v"].get("a")
            if isinstance(new, dict) and new.get("familysearch_id") and not any(
                    v for k, v in new.items() if k != "familysearch_id"):
                return f"Saved {name}’s FamilySearch ID"
            return f"Added details for {name}"
        return f"Updated details for {name}"
    return f"Updated details for {_n(len(ch), 'person', 'people')}"


def describe_photos(ch):
    if ch.get("added"):
        return f"Added {_n(len(ch['added']), 'photo')} to the library"
    if ch.get("removed"):
        return f"Removed {_n(len(ch['removed']), 'photo')} from the library"
    records = ch.get("records", {})
    fields = {f for c in records.values() for f in c.get("d", {})}
    dates = {"date", "date_source", "date_file"}   # a year you enter keeps the file's own date in date_file
    if len(records) == 1:
        name = Path(next(iter(records))).name
        if fields == {"caption"}:
            return f"Edited the caption of {name}"
        if fields and fields <= dates:
            return f"Changed the date of {name}"
        if fields <= {"caption"} | dates:
            return f"Edited the caption and date of {name}"
        return f"Changed the details of {name}"
    if fields == {"caption"}:
        return f"Edited captions on {_n(len(records), 'photo')}"
    if fields and fields <= dates:
        return f"Changed dates on {_n(len(records), 'photo')}"
    return f"Changed the details of {_n(len(records), 'photo')}"


def describe(changes):
    for kind, fn in (("labels", describe_labels), ("tree", describe_tree),
                     ("people", describe_people), ("photos", describe_photos)):
        if changes.get(kind):
            return fn(changes[kind])
    if any(k.startswith("file:matching-groups/") for k in changes):
        return "Changed the groups"
    if "file:suggest-rejections.json" in changes:
        return "Changed which suggestions are hidden"
    return "Changed the library"


def tree_dropped(current, ch):
    """Links that undoing tree changes ch would leave pointing at someone who isn't in the tree.
    tree.save() silently drops those, so an undo that would cause it must be refused instead.
    Returns [(pair, missing name, pair is in the tree now)]."""
    doc = {k: dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v
           for k, v in current.items()}   # apply_doc only replaces values one level down
    reverted = apply_doc(doc, ch, False)
    people = reverted.get("people") if isinstance(reverted.get("people"), dict) else {}
    now = {_key(p) for key in ("parents", "partners") for p in current.get(key, []) or []}
    out = []
    for key in ("parents", "partners"):
        for pair in reverted.get(key, []) or []:
            if not (isinstance(pair, list) and len(pair) == 2):
                continue
            missing = [x for x in pair if x not in people]
            if missing:
                out.append((pair, missing[0], _key(pair) in now))
    return out


def undoable(changes):
    ph = changes.get("photos", {})
    if ph.get("added") or ph.get("removed"):
        return False, "Photos were added to or taken out of the library; imports can’t be undone here."
    return True, ""


# ---------------------------------------------------------------- the journal

class Tx:
    """The changes made by one request (or one import run): one history entry."""

    def __init__(self, action=None):
        self.action, self.kind, self.undoes, self.base = action, "change", None, None
        self.changes, self.entry = {}, None
        self.counts, self.faces = {}, None   # set with Journal.note(): for changes counts() can't see

    def add(self, kind, ch):
        if kind == "photos":
            cur = self.changes.get("photos", {})
            merged = {"records": compose(cur.get("records", {}), ch.get("records", {})),
                      "added": sorted(set(cur.get("added", [])) | set(ch.get("added", []))),
                      "removed": sorted(set(cur.get("removed", [])) | set(ch.get("removed", [])))}
            merged = {k: v for k, v in merged.items() if v}
        else:
            merged = compose(self.changes.get(kind, {}), ch)
        if merged:
            self.changes[kind] = merged
        else:
            self.changes.pop(kind, None)


def _read(path):
    try:
        return Path(path).read_text()
    except FileNotFoundError:
        return None


def _well_formed(e):
    """An entry this code can list and undo: one odd line (hand-edited, or from another version) must not take
    History and Cmd-Z down, so anything else is skipped."""
    if not (isinstance(e, dict) and isinstance(e.get("id"), int) and not isinstance(e["id"], bool)
            and isinstance(e.get("action"), str) and isinstance(e.get("changes"), dict)
            and isinstance(e.get("counts", {}), dict) and e.get("kind", "change") in ("change", "undo", "redo")):
        return False
    for kind, ch in e["changes"].items():
        if not isinstance(ch, dict):
            return False
        parts = ch.get("records", {}) if kind == "photos" else ch
        if not isinstance(parts, dict):
            return False
        for v in parts.values():
            if not (isinstance(v, dict) and len(v) == 1 and next(iter(v)) in ("v", "d", "l")):
                return False
            body = next(iter(v.values()))
            if not isinstance(body, dict):
                return False
            if "l" in v and not (isinstance(body.get("add"), list) and isinstance(body.get("remove"), list)):
                return False
    if e.get("undoes") is not None and not isinstance(e["undoes"], int):
        return False
    return True


class Journal:
    def __init__(self, app):
        self.app = app
        self.path = Path(app.DATA) / "history.jsonl"
        self.lock = threading.RLock()
        self.local = threading.local()
        self.entries, self.by_id = [], {}
        self._read_to = 0        # bytes of history.jsonl already read into entries
        self._docs = {}          # kind -> (text, parsed): the last version of each file seen
        self.on_commit = []
        self.on_revert = []      # fn(kinds): an undo or redo changed these kinds (reload what you cache)
        with self.lock:
            self._sync()

    def _sync(self):
        """Read entries appended to history.jsonl since we last looked (by us, or by another
        process). Only whole lines are read; a line cut short by a crash is skipped. Hold self.lock."""
        try:
            size = self.path.stat().st_size
        except FileNotFoundError:
            size = 0
        if size < self._read_to:   # replaced or cut down: read it all again
            self.entries, self.by_id, self._read_to = [], {}, 0
        if size == self._read_to:
            return
        with open(self.path, "rb") as fh:
            fh.seek(self._read_to)
            data = fh.read(size - self._read_to)
        end = data.rfind(b"\n") + 1
        for line in data[:end].splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if _well_formed(e) and e["id"] not in self.by_id:
                self.entries.append(e)
                self.by_id[e["id"]] = e
        self._read_to += end

    # -- recording
    @contextmanager
    def transaction(self, action=None):
        outer = getattr(self.local, "tx", None)
        if outer is not None:
            if action and not outer.action:
                outer.action = action
            yield outer
            return
        tx = self.local.tx = Tx(action)
        try:
            yield tx
        finally:
            self.local.tx = None
            if tx.changes:
                tx.entry = self._commit(tx)

    def describe(self, action):
        tx = getattr(self.local, "tx", None)
        if tx is not None:
            tx.action = action

    def note(self, counts=None, faces=None):
        """Counts and face ids for History, for changes it can't count itself (plug-in files)."""
        tx = getattr(self.local, "tx", None)
        if tx is not None:
            if counts:
                tx.counts.update(counts)
            if faces:
                tx.faces = sorted({int(f) for f in faces})

    # -- plug-in data files written with app.save_data_file()
    def kind_for(self, path):
        """The journal kind of a data file ("file:<path under data/>"), or None if it isn't tracked."""
        try:
            rel = Path(path).resolve().relative_to(Path(self.app.DATA).resolve()).as_posix()
        except ValueError:
            return None
        if rel in TRACKED or (rel.startswith("matching-groups/") and rel.endswith(".json") and rel.count("/") == 1):
            return "file:" + rel
        return None

    def file_path(self, kind):
        return Path(self.app.DATA) / kind[len("file:"):]

    @staticmethod
    def file_text(kind, doc):
        """A tracked file written back after an undo, in the format its owner writes it."""
        if kind.startswith("file:matching-groups/"):
            return json.dumps(doc)
        return json.dumps(doc, indent=1)

    def _parse(self, kind, text):
        if text is None or (file_kind(kind) and not text.strip()):
            return [] if kind == "photos" else {}
        hit = self._docs.get(kind)
        return hit[1] if hit and hit[0] == text else json.loads(text)

    def written(self, kind, before, after):
        """A file was rewritten: record what changed (never lets a journal problem stop a save)."""
        try:
            with self.lock:
                b, a = self._parse(kind, before), self._parse(kind, after)
                self._docs[kind] = (after, a)   # so the next save of this file parses only once
            ch = diff_photos(b, a) if kind == "photos" else diff_docs(b, a)
            if not ch:
                return
            tx = getattr(self.local, "tx", None)
            if tx is not None:
                tx.add(kind, ch)
            else:
                single = Tx()
                single.add(kind, ch)
                if single.changes:
                    self._commit(single)
        except Exception:
            traceback.print_exc()

    def _commit(self, tx):
        ok, note = undoable(tx.changes)
        with self.lock, open(self.path, "ab") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)   # ids stay unique even if another process shares the file
            try:
                size = fh.seek(0, os.SEEK_END)
                if size:
                    with open(self.path, "rb") as rd:
                        rd.seek(size - 1)
                        if rd.read(1) != b"\n":   # a line cut short by a crash: end it so ours stays whole
                            fh.write(b"\n")
                            fh.flush()
                self._sync()
                entry = {"id": max(self.by_id, default=0) + 1,
                         "time": datetime.now().astimezone().isoformat(timespec="seconds"),
                         "kind": tx.kind, "action": tx.action or describe(tx.changes)}
                if tx.undoes is not None:
                    entry["undoes"], entry["base"] = tx.undoes, tx.base
                entry.update(counts={**tx.counts, **counts(tx.changes)}, undoable=ok, changes=tx.changes)
                if tx.faces:
                    entry["faces"] = tx.faces[:200]
                if note:
                    entry["note"] = note
                fh.write((json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
                fh.flush()
                os.fsync(fh.fileno())
                self.entries.append(entry)
                self.by_id[entry["id"]] = entry
                self._read_to = fh.tell()
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
        for fn in self.on_commit:
            try:
                fn()
            except Exception:
                traceback.print_exc()
        return entry

    # -- reading
    def undone(self):
        """{id: True} for every change that is currently undone (an undo that was itself undone
        - a redo - puts its change back)."""
        by = {}
        for e in self.entries:
            if e.get("undoes") is not None:
                by[e["undoes"]] = e["id"]
        out = {}
        for e in reversed(self.entries):   # an undo always comes after what it undoes
            j = by.get(e["id"])
            out[e["id"]] = j is not None and not out.get(j, False)
        return out

    @staticmethod
    def brief(e):
        out = {k: e[k] for k in ("id", "time", "kind", "action", "counts") if k in e}
        if e.get("undoes") is not None:
            out["undoes"] = e["undoes"]
        return out

    def _current(self, kind, docs):
        if kind not in docs:
            app = self.app
            if file_kind(kind):
                # A fresh copy: _parse() may hand back the journal's cached copy, which an undo must not change.
                text = _read(self.file_path(kind))
                try:
                    docs[kind] = json.loads(text) if text and text.strip() else {}
                except ValueError:
                    docs[kind] = {}
            else:
                docs[kind] = (app.labels if kind == "labels" else app.tree.load() if kind == "tree"
                              else app.people.load() if kind == "people"
                              else {p.get("path"): p for p in app.library.photos()})
        return docs[kind]

    def conflicts(self, e, docs):
        """{kind: [(key, subkey)]} of values changed since entry e."""
        out = {}
        for kind, ch in e.get("changes", {}).items():
            bad = check_doc(self._current(kind, docs), ch.get("records", {}) if kind == "photos" else ch)
            if bad:
                out[kind] = bad
        return out

    def _later(self, e, bad):
        for later in reversed(self.entries):
            if later["id"] <= e["id"]:
                break
            for kind, keys in bad.items():
                ch = later.get("changes", {}).get(kind, {})
                if _touches(ch.get("records", {}) if kind == "photos" else ch, keys):
                    return later
        return None

    def _what(self, bad):
        kind, keys = next(iter(bad.items()))
        if kind == "labels":
            n = len({sk for _, sk in keys})
            return "one of those faces" if n == 1 else f"{n:,} of those faces"
        if file_kind(kind):
            return "those groups" if kind.startswith("file:matching-groups/") else WHAT.get(kind[5:], "that")
        return {"tree": "the family tree", "people": "those people’s details", "photos": "those photos"}.get(kind, "that")

    def dangling(self, e, docs):
        """(pair, missing name, linked now, the later entry responsible) for the first family-tree
        link that undoing e would leave pointing at nobody, or None."""
        ch = e.get("changes", {}).get("tree")
        if not ch:
            return None
        dropped = tree_dropped(self._current("tree", docs), ch)
        if not dropped:
            return None
        pair, name, linked = dropped[0]
        k = _key(pair)
        for later in reversed(self.entries):
            if later["id"] <= e["id"]:
                break
            t = later.get("changes", {}).get("tree", {})
            if name in t.get("people", {}).get("d", {}) or any(
                    _key(x) == k for key in ("parents", "partners") for x in t.get(key, {}).get("l", {}).get("add", [])):
                return pair, name, linked, later
        return pair, name, linked, None

    def status(self, e, undone, docs):
        """(can_undo, short reason) for an entry."""
        if undone.get(e["id"]):
            return False, "Undone"
        if not e.get("undoable", True):
            return False, e.get("note") or "This change can’t be undone here."
        bad = self.conflicts(e, docs)
        later = self._later(e, bad) if bad else None
        if not bad:
            hang = self.dangling(e, docs)
            if not hang:
                return True, ""
            later = hang[3]
        return False, (f"Changed later by “{later['action']}”" if later else "Changed since, outside this history")

    # -- undo
    def _pick(self, entry_id, undone):
        if entry_id is None:   # the newest change that can be undone (an import, which can't, is passed over)
            for e in reversed(self.entries):
                if e.get("kind") != "undo" and not undone.get(e["id"]) and e.get("undoable", True):
                    return e
            return None
        e = self.by_id.get(entry_id)
        if e is None:
            raise ValueError("That change isn’t in the history any more. Reload the page to see the latest.")
        return e

    def undo(self, entry_id=None):
        app = self.app
        with app.lock, self.transaction() as tx:
            with self.lock:
                self._sync()
                undone = self.undone()
                e = self._pick(entry_id, undone)
            if e is None:   # normal states, not errors: answer 200 so the page shows a plain note
                return {"ok": False, "nothing": True, "message": "Nothing to undo yet."}
            if undone.get(e["id"]):
                done = "redone" if e.get("kind") == "undo" else "undone"
                return {"ok": False, "nothing": True, "message": f"“{e.get('base') or e['action']}” is already {done}."}
            if not e.get("undoable", True):
                raise app.Conflict(f"Can’t undo “{e['action']}”. {e.get('note', '')}".strip())
            bad = self.conflicts(e, {})
            if bad:
                later = self._later(e, bad)
                what = self._what(bad)
                raise app.Conflict(
                    f"Can’t undo “{e['action']}”: {what} changed later, in “{later['action']}”. Undo that first."
                    if later else f"Can’t undo “{e['action']}”: {what} changed since, outside this history.")
            hang = self.dangling(e, {})
            if hang:
                pair, name, linked, later = hang
                other = pair[1] if pair[0] == name else pair[0]
                why = f"{name} was linked to {other} later" if linked else f"{name} was taken out of the family tree later"
                raise app.Conflict(
                    f"Can’t undo “{e['action']}”: {why}, in “{later['action']}”. Undo that first." if later else
                    f"Can’t undo “{e['action']}”: {why}, outside this history, so the link to {other} would be lost.")
            tx.kind = "redo" if e.get("kind") == "undo" else "undo"
            tx.base = e.get("base") or e["action"]
            tx.action = ("Redid: " if tx.kind == "redo" else "Undid: ") + tx.base
            tx.undoes = e["id"]
            tx.counts, tx.faces = dict(e.get("counts") or {}), e.get("faces")
            self._revert(e["changes"])
        kinds = set(e["changes"])
        for fn in self.on_revert:
            try:
                fn(kinds)
            except Exception:
                traceback.print_exc()
        return {"ok": True, "undone": self.brief(e), "changed": sorted(kinds), "people": self._people_after(e)}

    @staticmethod
    def _people_after(e):
        """{old name: name now} for a rename or merge this undo/redo reversed, so the page can follow the person."""
        ch = e.get("changes", {}).get("tree", {}).get("people", {}).get("d", {})
        gone = [n for n, p in ch.items() if "a" not in p and "b" in p]
        came = [n for n, p in ch.items() if "b" not in p and "a" in p]
        names = e.get("changes", {}).get("labels", {}).get("names", {}).get("d", {})
        moves = {}
        for p in names.values():
            if "a" in p and "b" in p and p["a"] != p["b"]:
                moves[p["a"]] = p["b"]   # undoing puts "b" back
        if len(gone) == 1 and len(came) == 1:
            moves.setdefault(came[0], gone[0])
        return {a: b for a, b in moves.items() if isinstance(a, str) and isinstance(b, str)} if len(moves) == 1 else {}

    def _revert(self, changes):
        app = self.app
        for kind, ch in changes.items():   # plug-ins' own files
            if file_kind(kind):
                doc = self._current(kind, {})
                apply_doc(doc, ch, False)
                # Nothing left: the change created the file, so the undo removes it again (exactly as before).
                app.save_data_file(self.file_path(kind), self.file_text(kind, doc) if doc else None)
        if changes.get("labels"):
            apply_doc(app.labels, changes["labels"], False)
            app.save()
        if changes.get("tree"):
            app.tree.save(apply_doc(app.tree.load(), changes["tree"], False))
        if changes.get("people"):
            app.people.save(apply_doc(app.people.load(), changes["people"], False))
        if changes.get("photos", {}).get("records"):
            items = app.library.photos()
            apply_doc({p.get("path"): p for p in items}, changes["photos"]["records"], False)
            app.library.save(items)
            app.captions = app.library.captions()
            app.VERSION = app.data_version()
        app.family._person_cache.clear()
        app._people_layout_cache.clear()

    def listing(self, limit=50, before=None):
        app = self.app
        with app.lock, self.lock:
            self._sync()
            undone = self.undone()
            picked = [e for e in reversed(self.entries) if before is None or e["id"] < before][:limit + 1]
            docs, out = {}, []
            for e in picked[:limit]:
                try:
                    ok, reason = self.status(e, undone, docs)
                except Exception:   # never let one odd entry take the whole list down
                    traceback.print_exc()
                    ok, reason = False, "This change can’t be undone here."
                item = self.brief(e)
                labels = e.get("changes", {}).get("labels", {})
                touched = {int(f) for f in _faces_touched(labels) if str(f).isdigit()} if labels else set()
                if isinstance(e.get("faces"), list):
                    touched |= {f for f in e["faces"] if isinstance(f, int)}
                item["faces"] = sorted(touched)[:8]
                item.update(can_undo=ok, reason=reason, undone=bool(undone.get(e["id"])))
                out.append(item)
        return {"entries": out, "more": len(picked) > limit, "total": len(self.entries)}


# ---------------------------------------------------------------- snapshots

SNAP_NAME = re.compile(r"^\d{4}-\d{2}-\d{2}_\d{4}$")


def _same_file(a, b):
    try:
        sa, sb = a.stat(), b.stat()
    except FileNotFoundError:
        return False
    return sa.st_size == sb.st_size and sa.st_mtime_ns == sb.st_mtime_ns


class Snapshots:
    EVERY, KEEP, DAYS = 15 * 60, 48, 30

    def __init__(self, app):
        self.app = app
        self.dir = Path(app.DATA) / "snapshots"
        self.lock = threading.Lock()     # one snapshot at a time
        self.tlock = threading.Lock()    # guards the timer; never held while taking app.lock
        self.timer = None
        folders = self.folders()
        self.last = self._when(folders[-1]) if folders else 0.0

    @staticmethod
    def _when(folder):
        try:
            return datetime.strptime(folder.name, "%Y-%m-%d_%H%M").timestamp()
        except ValueError:
            return 0.0

    def folders(self):
        if not self.dir.exists():
            return []
        return sorted(p for p in self.dir.iterdir() if p.is_dir() and SNAP_NAME.match(p.name))

    def take(self):
        """Copy the four files into a new snapshot folder, unless nothing changed since the last one."""
        with self.tlock:
            self.timer = None
        with self.lock:
            folders = self.folders()
            prev = folders[-1] if folders else None
            name = datetime.now().strftime("%Y-%m-%d_%H%M")
            target = self.dir / name
            with self.app.lock:
                srcs = {f: Path(self.app.DATA) / f for f in FILES.values() if (Path(self.app.DATA) / f).exists()}
                if prev and all(_same_file(src, prev / f) for f, src in srcs.items()):
                    self.last = time.time()
                    return None
                if target.exists():   # already one this minute: try again in a minute
                    self.schedule(60)
                    return None
                tmp = self.dir / f".tmp-{name}-{os.getpid()}"
                shutil.rmtree(tmp, ignore_errors=True)
                tmp.mkdir(parents=True)
                for f, src in srcs.items():
                    if prev and _same_file(src, prev / f):
                        try:
                            os.link(prev / f, tmp / f)
                            continue
                        except OSError:
                            pass
                    shutil.copy2(src, tmp / f)
                os.replace(tmp, target)
            self.last = time.time()
            self.prune()
            return target

    def prune(self):
        folders = self.folders()
        keep = set(folders[-self.KEEP:])
        cutoff = (date.today() - timedelta(days=self.DAYS)).isoformat()
        last_of_day = {}
        for f in folders:
            last_of_day[f.name[:10]] = f
        keep |= {f for day, f in last_of_day.items() if day >= cutoff}
        for f in folders:
            if f not in keep:
                shutil.rmtree(f, ignore_errors=True)
        for t in self.dir.glob(".tmp-*"):
            if time.time() - t.stat().st_mtime > 3600:
                shutil.rmtree(t, ignore_errors=True)

    def schedule(self, wait):
        with self.tlock:
            if self.timer is None:
                self.timer = threading.Timer(wait, self._run)
                self.timer.daemon = True
                self.timer.start()

    def changed(self):
        """Called after every recorded change: snapshot now, or when 15 minutes have passed."""
        self.schedule(max(0.0, self.last + self.EVERY - time.time()))

    def _run(self):
        try:
            self.take()
        except Exception:
            traceback.print_exc()

    def info(self):
        folders = self.folders()
        latest = folders[-1] if folders else None
        return {"count": len(folders), "every_minutes": self.EVERY // 60, "folder": "_faces/data/snapshots",
                "latest": datetime.fromtimestamp(self._when(latest)).astimezone().isoformat(timespec="minutes")
                if latest else None}


# ---------------------------------------------------------------- wiring

def _hook(owner, attr, kind, path, journal):
    """Wrap a save function so the journal sees the file before and after each write."""
    fn = getattr(owner, attr)
    if getattr(fn, "_journaled", False):
        return

    def saved(*args, **kwargs):
        before = _read(path())
        try:
            return fn(*args, **kwargs)
        finally:
            after = _read(path())
            if after != before:
                journal.written(kind, before, after)

    saved._journaled = True
    saved.__wrapped__ = fn
    saved.__doc__ = fn.__doc__
    setattr(owner, attr, saved)


def register(routes, app):
    journal = Journal(app)
    snaps = Snapshots(app)
    journal.on_commit.append(snaps.changed)
    _hook(app, "save", "labels", lambda: app.labels_path, journal)
    _hook(app.tree, "save", "tree", lambda: app.tree.PATH, journal)
    _hook(app.people, "save", "people", lambda: app.people.PATH, journal)
    _hook(app.library, "save", "photos", lambda: app.library.PATH, journal)
    write_file = getattr(app.save_data_file, "__wrapped__", app.save_data_file)

    def save_data_file(path, text):
        kind = journal.kind_for(path)
        before = _read(path) if kind else None
        try:
            return write_file(path, text)
        finally:
            if kind:
                after = _read(path)
                if after != before:
                    journal.written(kind, before, after)
    save_data_file.__wrapped__ = write_file
    save_data_file.__doc__ = write_file.__doc__
    app.save_data_file = save_data_file
    app.journal = journal       # serve.py's do_POST makes each request one transaction
    app.snapshots = snaps

    def history(q):
        try:
            limit = max(1, min(500, int(q.get("limit") or 50)))
            before = int(q["before"]) if q.get("before") else None
        except ValueError:
            raise ValueError("Use whole numbers for limit and before.")
        return {**journal.listing(limit, before), "snapshots": snaps.info()}

    def undo(body):
        entry_id = body.get("id")
        if entry_id is not None and (not isinstance(entry_id, int) or isinstance(entry_id, bool)):
            raise ValueError("Choose a change from the history to undo.")
        return journal.undo(entry_id)

    routes["GET"]["/api/history"] = history
    routes["POST"]["/api/undo"] = undo
    threading.Thread(target=snaps._run, name="startup snapshot", daemon=True).start()
