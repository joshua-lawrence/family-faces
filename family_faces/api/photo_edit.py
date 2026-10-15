"""Photo viewer endpoints: one photo's faces (with name suggestions), library order,
and editing a photo's caption and date in data/photos.json.

    GET  /api/viewer/photo?path=...&branch=...   faces left to right, names, top-2 suggestions
    GET  /api/viewer/order                        every photo path, in library order
    GET  /api/viewer/date-estimate?path=...       {"estimate": ...} from /api/photo-date if another
                                                  plug-in provides it, else {"estimate": null}
    GET  /api/viewer/caption-edits                captions edited since this server started that are still
                                                  in photos.json: the page's /api/static copy is cached per data
                                                  version, so it patches these in
    POST /api/photo/edit {path, caption?, date?}  saves under the app lock (atomic write); refused while an
                                                  Inbox import runs, since the import rewrites photos.json.
                                                  A date with a year in it is "your date" (date_source "you",
                                                  the file's own date kept in date_file), the same as the
                                                  Timeline's POST /api/photo-date; clearing it puts the
                                                  file's date back.
"""

import os
import re

from family_faces.familysearch.scope import load_scope
from family_faces.familysearch.memory_tags import memory_target

CAPTION_MAX = 2000
DATE_MAX = 80
YEAR = re.compile(r"(?<!\d)(1[89]\d\d|20\d\d)(?!\d)")


def register(routes, app):
    faces_index = {"src": None, "by_photo": {}}
    protos_cache = {"key": None, "value": None}
    caption_edits = {}   # path -> caption ("" when removed), for pages holding an older /api/static copy

    def faces_by_photo():
        # app.faces is replaced (not mutated) when an import reloads the data, so the list
        # object itself is the cache key (holding it also keeps its id from being reused).
        if faces_index["src"] is not app.faces:
            by = {}
            for f in app.faces:
                by.setdefault(f["photo"], []).append(f)
            faces_index.update(src=app.faces, by_photo=by)
        return faces_index["by_photo"]

    def mtimes():
        out = []
        for name in ("people.json", "tree.json", "photos.json", "familysearch-matching.json"):
            try:
                out.append(os.stat(app.DATA / name).st_mtime_ns)
            except OSError:
                out.append(0)
        return tuple(out)

    def prototypes(branch):
        """person_prototypes() for a branch, reused until any name or the scope's inputs change.
        Call under the app lock."""
        key = (branch, id(app.emb), app.labels_rev, mtimes())
        if protos_cache["key"] != key:
            scope = load_scope(branch)
            protos_cache.update(key=key, value=app.person_prototypes(scope))
        return protos_cache["value"]

    def photo(q):
        path = q.get("path", "")
        branch = q.get("branch") or None
        with app.lock:
            item = app.library.by_path().get(path)
            if not item:
                raise ValueError("This photo is no longer in the library. Close the viewer and reload the page.")
            names = app.labels["names"]
            fs = sorted(faces_by_photo().get(path, []), key=lambda f: (f["bbox"][0] + f["bbox"][2], f["id"]))
            unnamed = [f["id"] for f in fs if str(f["id"]) not in names]
            sugg = {}
            if unnamed:
                try:
                    pnames, starts, protos = prototypes(branch)
                except ValueError:   # unknown branch: fall back to the saved one
                    pnames, starts, protos = prototypes(None)
                if pnames:
                    for fid, row in zip(unnamed, app.per_person_sims(unnamed, pnames, starts, protos)):
                        sugg[fid] = app.top(pnames, row, 2)
            source_tag = next((t for t in item.get("tags", []) if t.get("source_url")), {})
            return {
                "path": path,
                "caption": item.get("caption", ""),
                "date": item.get("date", ""),
                "batch": item.get("batch", ""),
                "source": item.get("source", "") or ("FamilySearch" if source_tag else ""),
                "source_url": item.get("source_url", "") or source_tag.get("source_url", ""),
                "familysearch_memory_id": memory_target(item, app.uploads.journal()),
                "original_available": item.get("original_available", True) is not False,
                "faces": [{"id": f["id"], "bbox": f["bbox"], "img_w": f.get("img_w"),
                           "name": names.get(str(f["id"])), "suggest": sugg.get(f["id"], [])} for f in fs],
            }

    def order(q):
        with app.lock:
            return {"paths": [p["path"] for p in app.library.photos()]}

    def date_estimate(q):
        fn = app.PLUGIN_ROUTES["GET"].get("/api/photo-date")
        if not fn:
            return {"estimate": None}
        try:
            return {"estimate": fn({"path": q.get("path", ""), "_path": "/api/photo-date"})}
        except Exception:   # an estimate is optional: never break the viewer over it
            return {"estimate": None}

    def clean(body, key, limit, label):
        value = body.get(key)
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise ValueError(f"The {label} must be text.")
        value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
        if key == "date":
            value = " ".join(value.split())
        if len(value) > limit:
            raise ValueError(f"The {label} is too long: keep it under {limit} characters.")
        return value

    def edit(body):
        path = body.get("path")
        if not isinstance(path, str) or not path:
            raise ValueError("Choose a photo to edit.")
        changes = {}
        if "caption" in body:
            changes["caption"] = clean(body, "caption", CAPTION_MAX, "caption")
        if "date" in body:
            changes["date"] = clean(body, "date", DATE_MAX, "date")
        if not changes:
            raise ValueError("Nothing to save: send a caption or a date.")
        with app.lock:
            if app.import_state.get("running"):
                # The import holds its own copy of photos.json and writes it back when it finishes.
                raise ValueError("A photo import is running. Save the caption again when it finishes.")
            items = app.library.photos()
            record = next((p for p in items if p["path"] == path), None)
            if record is None:
                raise ValueError("This photo is no longer in the library. Close the viewer and reload the page.")
            if all(record.get(k, "") == v for k, v in changes.items()):
                return {"ok": True, "changed": False, "path": path,
                        "caption": record.get("caption", ""), "date": record.get("date", "")}
            if "date" in changes:
                yours = record.get("date_source") == "you"
                if changes["date"] and YEAR.search(changes["date"]):
                    # A date you type is yours: the Timeline uses it ahead of any estimate. The file's own
                    # date (from the camera or scanner) is kept in date_file, as POST /api/photo-date does.
                    if record.get("date") and not yours and "date_file" not in record:
                        changes["date_file"] = record["date"]
                    changes["date_source"] = "you"
                elif yours:
                    # Cleared, or no year in it any more: back to the file's own date.
                    if not changes["date"]:
                        changes["date"] = record.get("date_file", "")
                    changes["date_source"] = None
                    changes["date_file"] = None
            previous = {k: record[k] for k in changes if k in record}
            for k, v in changes.items():       # in place: any other holder of this record sees the edit
                if v is None:
                    record.pop(k, None)
                else:
                    record[k] = v
            try:
                app.library.save(items)        # temp file + rename: never a half-written photos.json
            except OSError:
                for k in changes:              # keep memory and disk in step if the write failed
                    if k in previous:
                        record[k] = previous[k]
                    else:
                        record.pop(k, None)
                raise ValueError("Couldn't save: the photo list couldn't be written. "
                                 "Check there is free disk space, then try again.")
            app.captions = app.library.captions()
            caption_edits[path] = record.get("caption", "")
            out = {"ok": True, "changed": True, "path": path,
                   "caption": record.get("caption", ""), "date": record.get("date", "")}
        if "date" in changes and getattr(app, "photo_dates", None):
            app.photo_dates.refresh(force=True)   # the Timeline picks the new date up in the background
        return out

    def recent_caption_edits(q):
        # Only edits that photos.json still holds: a reload or an import may have replaced them.
        with app.lock:
            current = app.library.by_path()
            return {"captions": {path: cap for path, cap in caption_edits.items()
                                 if path in current and current[path].get("caption", "") == cap}}

    routes["GET"]["/api/viewer/photo"] = photo
    routes["GET"]["/api/viewer/order"] = order
    routes["GET"]["/api/viewer/date-estimate"] = date_estimate
    routes["GET"]["/api/viewer/caption-edits"] = recent_caption_edits
    routes["POST"]["/api/photo/edit"] = edit
