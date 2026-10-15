"""Removing a whole photo from the library, and putting it back.

    POST /api/photo/remove  {path} | {paths} | {faces}   take the photos (of those faces) out of the library
    POST /api/photo/restore {path} | {paths}             put removed photos back (the toast's Undo, or later)
    GET  /api/photo/removed           the photos removed so far, newest first

Removing a photo:
  - moves the file to "Removed photos/" beside the albums (same sub-folders), so nothing is deleted:
    empty that folder in Finder to get rid of the files for good;
  - takes its record out of data/photos.json, so it leaves the Gallery, Timeline, Home and search;
  - marks its faces "_ignore" (the same as Ignore face), so they leave groups, leftovers, people and
    suggestions. Face ids never change, so nothing else has to be renumbered.
What it took away (the record, each face's name and name source) is kept in data/removed-photos.json, so
restoring puts back exactly that: the file, the record in its place, and the names of faces still ignored.
Each is one History entry ("Removed a photo"); History can't undo them (photos.json lost a photo), Restore can.
"""

import json
import shutil
from datetime import datetime

IGNORE = "_ignore"


def register(routes, app):
    root = app.library.ROOT
    bin_dir = root / "Removed photos"
    log_path = app.DATA / "removed-photos.json"

    def log():
        try:
            return json.loads(log_path.read_text())
        except (OSError, ValueError):
            return []

    def save_log(entries):
        tmp = log_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(entries, indent=1))
        tmp.replace(log_path)

    def unique(p):
        k, out = 2, p
        while out.exists():
            out = p.with_name(f"{p.stem} ({k}){p.suffix}")
            k += 1
        return out

    def paths_from(body):
        """{path} | {paths: [...]} | {faces: [face ids]} -> photo paths, in order, without repeats."""
        if app.import_state.get("running"):
            raise ValueError("A photo import or regroup is running. Try again when it finishes.")
        paths = [body["path"]] if isinstance(body.get("path"), str) else list(body.get("paths") or [])
        for fid in body.get("faces") or []:
            fid = int(fid)
            if 0 <= fid < len(app.faces):
                paths.append(app.faces[fid]["photo"])
        paths = [p for p in dict.fromkeys(paths) if isinstance(p, str) and p]
        if not paths:
            raise ValueError("Choose a photo.")
        return paths

    def short(paths):
        return paths[0].rsplit("/", 1)[-1] if len(paths) == 1 else f"{len(paths)} photos"

    def remove(body):
        paths = paths_from(body)
        with app.lock:
            items = app.library.photos()
            where = {p["path"]: i for i, p in enumerate(items)}
            missing = [p for p in paths if p not in where]
            if missing:
                raise ValueError(f"{short(missing)} {'is' if len(missing) == 1 else 'are'} no longer in the library. Reload the page.")
            app.describe(f"Removed {'the photo ' if len(paths) == 1 else ''}{short(paths)}")
            by_photo = {}
            for f in app.faces:
                if f["photo"] in where:
                    by_photo.setdefault(f["photo"], []).append(f["id"])
            moved = []   # (src, dest) so a failed save can put the files back
            try:
                for p in paths:
                    src = app.library.abspath(p)
                    if src.exists():
                        dest = unique(bin_dir / p)
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(src), str(dest))
                        moved.append((p, src, dest))
                gone = set(paths)
                app.library.save([r for r in items if r["path"] not in gone])
            except Exception:
                app.library.reload()
                for _, src, dest in reversed(moved):
                    shutil.move(str(dest), str(src))
                raise ValueError("Couldn't remove: the photo list couldn't be saved. Check there is free disk space.")
            dest_of = {p: d for p, _, d in moved}
            names = app.labels["names"]
            sources = app.labels.setdefault("sources", {})
            entries, ids_all = log(), []
            when = datetime.now().astimezone().isoformat(timespec="seconds")
            for p in paths:
                ids = by_photo.get(p, [])
                ids_all += ids
                entries.insert(0, {"path": p, "moved_to": dest_of[p].relative_to(root).as_posix() if p in dest_of else None,
                                   "index": where[p], "record": items[where[p]],
                                   "names": {str(i): names.get(str(i)) for i in ids},
                                   "sources": {str(i): sources.get(str(i)) for i in ids}, "removed": when})
                for i in ids:
                    names[str(i)] = IGNORE
                    sources.pop(str(i), None)
            app.save()
            save_log(entries)
            app.journal_note(counts={"photos": len(paths)}, faces=ids_all)
            app.reload_data()
        return {"ok": True, "paths": paths, "faces": len(ids_all)}

    def restore(body):
        paths = paths_from(body)
        with app.lock:
            entries = log()
            todo = [e for e in entries if e["path"] in paths]
            if not todo:
                raise ValueError("Those photos aren't in the removed photos list.")
            items = app.library.photos()
            have = {p["path"] for p in items}
            for e in todo:
                if e["path"] in have:
                    raise ValueError(f"{short([e['path']])} is back in the library already.")
                if e.get("moved_to"):
                    if not (root / e["moved_to"]).exists():
                        raise ValueError(f"{short([e['path']])} isn't in the Removed photos folder any more, so it can't come back.")
                    if app.library.abspath(e["path"]).exists():
                        raise ValueError(f"Another file is where {short([e['path']])} was. Move it, then try again.")
            app.describe(f"Restored {'the photo ' if len(todo) == 1 else ''}{short([e['path'] for e in todo])}")
            moved = []
            try:
                for e in todo:
                    if e.get("moved_to"):
                        src, back = root / e["moved_to"], app.library.abspath(e["path"])
                        back.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(src), str(back))
                        moved.append((src, back))
                new = list(items)
                for e in sorted(todo, key=lambda e: e.get("index", len(new))):   # back in their places
                    new.insert(min(e.get("index", len(new)), len(new)), e["record"])
                app.library.save(new)
            except Exception:
                app.library.reload()
                for src, back in reversed(moved):
                    shutil.move(str(back), str(src))
                raise ValueError("Couldn't restore: the photo list couldn't be saved. Check there is free disk space.")
            names = app.labels["names"]
            sources = app.labels.setdefault("sources", {})
            ids_all = []
            for e in todo:
                for i, n in e["names"].items():
                    ids_all.append(int(i))
                    if names.get(i) != IGNORE:
                        continue   # named since: keep that
                    if n is None:
                        names.pop(i, None)
                    else:
                        names[i] = n
                        if e.get("sources", {}).get(i):
                            sources[i] = e["sources"][i]
            app.save()
            done = {id(e) for e in todo}
            save_log([e for e in entries if id(e) not in done])
            app.journal_note(counts={"photos": len(todo)}, faces=ids_all)
            app.reload_data()
        return {"ok": True, "paths": [e["path"] for e in todo]}

    def removed(q):
        return {"photos": [{k: e.get(k) for k in ("path", "moved_to", "removed")} | {"faces": len(e.get("names", {}))}
                           for e in log()]}

    routes["POST"]["/api/photo/remove"] = remove
    routes["POST"]["/api/photo/restore"] = restore
    routes["GET"]["/api/photo/removed"] = removed
