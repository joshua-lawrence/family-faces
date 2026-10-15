"""Imports page: name or skip faces one photo at a time.

POST /api/imports/name  {"faces": [id, ...], "path": photo path, "name": "Person" | "_ignore" | null,
                         "from_notes": true when the name came from the photo's own notes}
  -> {"photo": the photo's updated card (as in GET /api/imports?batch=...), "counts": the import's progress}

POST /api/imports/link-tag  {"path": photo path, "index": tag position, "name": "Person in the library"}
  -> {"tags": tags linked, "photos": photos they're on, "faces": faces named, "kept": faces left with their own name}

Returning the one updated card lets the page redraw just that photo instead of the whole import.
"""

import re

MAX_NAME = 200


def _key(name):
    return re.sub(r"\s+", " ", name or "").strip().lower()


def _clean_name(app, name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Type a name first.")
    name = name.strip()
    if len(name) > MAX_NAME:
        raise ValueError(f"Names can be up to {MAX_NAME} characters.")
    if name.startswith("_") and name != app.IGNORE:
        raise ValueError("Names can't start with an underscore.")
    return name


def register(routes, app):
    def name_faces(body):
        ids, path, name = body.get("faces"), body.get("path"), body.get("name")
        if not isinstance(path, str) or not isinstance(ids, list) or not 1 <= len(ids) <= 500 \
                or any(not isinstance(f, int) or isinstance(f, bool) for f in ids):
            raise ValueError("The naming request is not valid. Reload the page and try again.")
        if name is not None:
            name = _clean_name(app, name)
        with app.lock:
            item = app.library.by_path().get(path)
            if not item:
                raise ValueError("This photo is no longer in the library. Reload the page.")
            faces = app.faces
            if any(not 0 <= f < len(faces) or faces[f]["photo"] != path for f in ids):
                raise ValueError("These faces aren't in that photo any more. Reload the page.")
            names, sources = app.labels["names"], app.labels.setdefault("sources", {})
            for f in ids:
                key = str(f)
                if name is None:
                    names.pop(key, None)
                    sources.pop(key, None)
                    continue
                if names.get(key) != name:
                    # The note-source badge only stays true while the name is the one the notes gave.
                    sources.pop(key, None)
                names[key] = name
                if body.get("from_notes") is True:
                    sources[key] = item.get("source") or "photo metadata"
            app.save()
            items = app.import_batch_photos(item["batch"])
            by_photo = app.import_faces_by_photo()
            at = next(i for i, p in enumerate(items) if p["path"] == path)
            card = app.import_cards([item], by_photo)[0]
            return {"photo": dict(card, at=at), "counts": app.import_counts(items, by_photo)}

    def link_tag(body):
        """Link a name that came with a photo to a person in the library.

        A tag with a name or FamilySearch ID also links every other waiting tag for that same person
        (same FamilySearch ID, or the same name when either side has no ID), and remembers the link for
        future imports. A tag with neither (FamilySearch's "someone here") only ever links itself: there
        is nothing to tell two of those apart. Faces marked by a linked tag get the name, except faces on
        other photos that you have already named or skipped, which are left as they are."""
        path, index = body.get("path"), body.get("index")
        if not isinstance(path, str) or not isinstance(index, int) or isinstance(index, bool):
            raise ValueError("The link request is not valid. Reload the page and try again.")
        name = _clean_name(app, body.get("name"))
        if name == app.IGNORE:
            raise ValueError("Pick a person to link this name to.")
        with app.lock:
            items = app.library.photos()
            item = next((p for p in items if p["path"] == path), None)
            if not item:
                raise ValueError("This photo is no longer in the library. Reload the page.")
            tags = item.get("tags") or []
            if not 0 <= index < len(tags):
                raise ValueError("This name isn't on the photo any more. Reload the page.")
            tag = tags[index]
            if tag.get("resolved"):
                if tag["resolved"] == name:
                    return {"tags": 0, "photos": 0, "faces": 0, "kept": 0}
                raise ValueError(f"This is already linked to {tag['resolved']}. Reload the page to see it.")
            tname, fsid = (tag.get("name") or "").strip(), (tag.get("familysearch_id") or "").strip().upper()

            def same(t):
                if t is tag:
                    return True
                if t.get("resolved"):
                    return False
                other = (t.get("familysearch_id") or "").strip().upper()
                if fsid and other:
                    return other == fsid
                return bool(tname) and _key(t.get("name")) == _key(tname)

            names, sources = app.labels["names"], app.labels.setdefault("sources", {})
            faces = app.faces
            linked, photos, named, kept = 0, 0, 0, 0
            for p in (items if tname or fsid else [item]):
                hit = False
                for t in p.get("tags") or []:
                    if not same(t):
                        continue
                    t["resolved"] = name
                    linked += 1
                    hit = True
                    f = t.get("face")
                    if not isinstance(f, int) or not 0 <= f < len(faces) or faces[f]["photo"] != p["path"]:
                        continue
                    key = str(f)
                    if t is not tag and names.get(key) not in (None, name):
                        kept += 1   # you've already named or skipped this face: leave it
                        continue
                    if names.get(key) != name:
                        named += 1
                    names[key] = name
                    sources[key] = p.get("source") or "photo metadata"
                photos += hit
            if tname or fsid:
                app.people.link(name, tname, fsid)
            app.library.save(items)
            app.save()
            return {"tags": linked, "photos": photos, "faces": named, "kept": kept}

    routes["POST"]["/api/imports/name"] = name_faces
    routes["POST"]["/api/imports/link-tag"] = link_tag
