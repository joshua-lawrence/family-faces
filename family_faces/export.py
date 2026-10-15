"""Build per-person folders and a who's-in-what spreadsheet from your labels.

    uv run python -m family_faces.export

Creates ../_by_person/<Name>/ containing every photo that person is in
(hard links: no extra disk space, and the originals are never touched), plus
../_by_person/people_in_photos.csv with names left-to-right for FamilySearch tagging.
Safe to re-run; the folder is rebuilt each time.
"""

import csv
import json
import os
import re
import shutil
from collections import defaultdict
from pathlib import Path

from family_faces import library
from family_faces import config

HERE = Path(__file__).resolve().parent
DATA = config.DATA
OUT = library.ROOT / "_by_person"
MARKER = OUT / ".made-by-export-py"
IGNORE = "_ignore"


def safe(name):
    return re.sub(r'[/:\\]', "-", name).strip() or "Unnamed"


def main():
    faces = json.loads((DATA / "faces.json").read_text())
    labels = json.loads((DATA / "labels.json").read_text())["names"]

    if OUT.exists():
        if not MARKER.exists():
            raise SystemExit(f"{OUT} exists but wasn't made by this script; move it aside first.")
        shutil.rmtree(OUT)
    OUT.mkdir()
    MARKER.touch()

    by_photo = defaultdict(list)
    for f in faces:
        by_photo[f["photo"]].append(f)

    people = defaultdict(set)
    rows = []
    for item in library.photos():
        photo = item["path"]
        fs = sorted(by_photo.get(photo, []), key=lambda f: (f["bbox"][0] + f["bbox"][2]) / 2)
        named = []
        unnamed = 0
        for f in fs:
            n = labels.get(str(f["id"]))
            if n == IGNORE:
                continue
            if n:
                if n not in named:
                    named.append(n)
                people[n].add(photo)
            elif f["score"] >= 0.6 and f["size"] >= 40:
                unnamed += 1
        rows.append({
            "photo": photo,
            "people_left_to_right": ", ".join(named),
            "unnamed_faces": unnamed,
            "caption": item.get("caption", ""),
        })
        if unnamed and not named:
            people["_Needs names"].add(photo)

    def link(src, dst):
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)

    for name, photos in people.items():
        d = OUT / safe(name)
        d.mkdir(exist_ok=True)
        for p in photos:   # photos from added batches are named "Added photos - <date> - <file>"
            link(library.abspath(p), d / p.replace("/", " - "))

    with open(OUT / "people_in_photos.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["photo", "people_left_to_right", "unnamed_faces", "caption"])
        w.writeheader()
        w.writerows(rows)

    for name in sorted(people, key=lambda n: -len(people[n])):
        print(f"{len(people[name]):5d}  {name}")
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
