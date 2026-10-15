"""Naming loop helpers for the Groups and Leftover faces pages (web/10-naming.js).

GET  /api/naming/names    -> {"aliases": {alias: person}, "vocab": [lower-case name words]}
     Album names (aliases) let the name field say "Did you mean ...?"; the word list lets the
     page offer only caption words that are really names (never "Add", "Primary", "Title"...).
POST /api/naming/unnamed  {faces: [...]}              -> {"faces": [ids that have no name yet]}
POST /api/naming/check    {faces: [...], name: "X"} or {batch: [{faces, name}, ...]}
     -> {"named": how many of the faces now have that name, "faces": how many were asked about}
POST /api/naming/split    {branch, faces: [...]}      -> {"id": new group id, "faces": n}
     Moves the chosen faces out of their groups into a new group. Only the cached grouping for
     that family branch changes; names (labels.json) and the tree are never touched. The grouping
     file is written with app.save_data_file, so the split is in History and Undo puts it back.
"""

import collections
import json
import math
import re

import numpy as np

WORD = re.compile(r"[^\W\d_][^\W\d_'’-]*", re.UNICODE)


def _face_ids(body, limit=20000):
    ids = body.get("faces")
    if not isinstance(ids, list) or not ids:
        raise ValueError("Choose at least one face first.")
    if len(ids) > limit:
        raise ValueError("Too many faces in one request.")
    try:
        return [int(f) for f in ids]
    except (TypeError, ValueError):
        raise ValueError("The face list is not valid.")


def register(routes, app):
    def names(query):
        identities = app.people.load()
        family = app.tree.load()
        with app.lock:
            labelled = set(app.labels["names"].values())
        aliases, words = {}, set()
        everyone = set(identities) | set(family.get("people", {})) | labelled
        for owner, info in identities.items():
            for alias in info.get("aliases", []) or []:
                alias = str(alias).strip()
                # Skip FamilySearch ids that were stored as aliases (e.g. "KWC1-B6N").
                if alias and alias != owner and not re.fullmatch(r"[A-Z0-9]{4}-[A-Z0-9]{3,4}", alias):
                    aliases.setdefault(alias, owner)
                    everyone.add(alias)
        for name in everyone:
            if name and not name.startswith("_"):
                words.update(w.casefold() for w in WORD.findall(name) if len(w) > 1)
        return {"aliases": aliases, "vocab": sorted(words)}

    def unnamed(body):
        ids = _face_ids(body)
        with app.lock:
            named = app.labels["names"]
            return {"faces": [f for f in ids if str(f) not in named]}

    def check(body):
        batch = body.get("batch")
        if batch is None:
            batch = [body]
        if not isinstance(batch, list) or not batch or not all(isinstance(b, dict) for b in batch):
            raise ValueError("The list of names to check is not valid.")
        work = []
        for item in batch:
            name = str(item.get("name") or "").strip()
            if not name:
                raise ValueError("Type a name first.")
            work.append((_face_ids(item), name))
        with app.lock:
            named = app.labels["names"]
            return {"named": sum(1 for ids, name in work for f in ids if named.get(str(f)) == name),
                    "faces": sum(len(ids) for ids, _ in work)}

    def describe(members, emb, faces, photo_names, global_df, n_captioned):
        """The same summary cluster.build() writes for a group: similarity to the group's
        average face, photo counts and caption name hints."""
        centroid = emb[members].mean(0)
        centroid /= max(float(np.linalg.norm(centroid)), 1e-9)
        sims = emb[members] @ centroid
        order = np.argsort(-sims)
        members = [members[i] for i in order]
        photos = sorted({faces[m]["photo"] for m in members})
        capped = [p for p in photos if p in photo_names]
        df = collections.Counter(n for p in capped for n in photo_names[p])
        hints = []
        for name, k in df.items():
            lift = (k / len(capped)) / (global_df[name] / n_captioned) if n_captioned else 0
            if lift > 1.5:
                hints.append((name, k, k * math.log(lift)))
        hints.sort(key=lambda h: -h[2])
        return {"faces": members, "sims": [round(float(s), 3) for s in sims[order]],
                "photos": len(photos), "captioned": len(capped), "hints": [[n, k] for n, k, _ in hints[:4]]}

    def split(body):
        import cluster   # already loaded by matching_groups; reuses its caption word rules
        ids = list(dict.fromkeys(_face_ids(body, limit=5000)))
        branch = body.get("branch")
        with app.lock:
            if any(f < 0 or f >= len(app.faces) for f in ids):
                raise ValueError("Some of these faces no longer exist. Refresh the page.")
            scope = app.load_scope(branch)
            threshold = app.clusters.get("threshold", .65)
            path = app.matching_groups.cache_path(scope, len(app.faces), threshold)
            if not path.exists():
                raise ValueError("Groups are still being rebuilt. Try again in a moment.")
            doc = json.loads(path.read_text())
            chosen = set(ids)
            touched = [c for c in doc["clusters"] if chosen & set(c["faces"])]
            if not touched:
                raise ValueError("These faces aren’t in a group any more. Refresh the page.")
            grouped = set().union(*(set(c["faces"]) for c in touched))
            ids = [f for f in ids if f in grouped]   # only faces that are really in a group move
            chosen = set(ids)
            if len(touched) == 1 and set(touched[0]["faces"]) <= chosen:
                raise ValueError("That’s every face in the group. Select only the faces to split off.")
            new_id = max((c["id"] for c in doc["clusters"]), default=-1) + 1
            captions = {p: c for p, c in app.library.captions().items()
                        if c and (p not in scope.source_paths or p in scope.allowed_paths)}
            photo_names = {p: cluster.caption_names(c) for p, c in captions.items()}
            global_df = collections.Counter(n for ns in photo_names.values() for n in ns)
            args = (app.emb, app.faces, photo_names, global_df, len(photo_names))
            for c in touched:
                rest = [f for f in c["faces"] if f not in chosen]
                if rest:
                    c.update(describe(rest, *args))
                else:
                    c["faces"] = []
            doc["clusters"] = [c for c in doc["clusters"] if c["faces"]]
            group = {"id": new_id, **describe(ids, *args)}
            doc["clusters"].append(group)
            n = len(ids)
            app.describe(f"Split {n:,} face{'' if n == 1 else 's'} into a new group")
            app.journal_note(counts={"faces": n}, faces=ids)
            app.save_data_file(path, json.dumps(doc))
        return {"id": new_id, "faces": len(ids)}

    routes["GET"]["/api/naming/names"] = names
    routes["POST"]["/api/naming/unnamed"] = unnamed
    routes["POST"]["/api/naming/check"] = check
    routes["POST"]["/api/naming/split"] = split
