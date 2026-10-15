"""Family tree storage and GEDCOM export.

data/tree.json:
    {"people":   {name: {"born": "1931", "died": "", "sex": "M"|"F"|""}},   # everyone in the tree
     "parents":  [[parent, child], ...],
     "partners": [[a, b], ...]}

Names are the same names used for faces, so renaming a person in the People tab
renames them here too (see rename()).
"""

import json
from datetime import date
from pathlib import Path
import config

PATH = config.DATA / "tree.json"


def load():
    if PATH.exists():
        return json.loads(PATH.read_text())
    return {"people": {}, "parents": [], "partners": []}


def save(doc):
    """Validate and store a whole tree document sent by the page."""
    people = {str(k): {"born": str(v.get("born", ""))[:20], "died": str(v.get("died", ""))[:20],
                       "sex": v.get("sex", "") if v.get("sex") in ("M", "F") else ""}
              for k, v in doc.get("people", {}).items()}
    pairs = lambda key: sorted({tuple(p) for p in doc.get(key, [])
                                if len(p) == 2 and p[0] in people and p[1] in people and p[0] != p[1]})
    parents = pairs("parents")
    partners = sorted({tuple(sorted(p)) for p in pairs("partners")})
    tmp = PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps({"people": people, "parents": [list(p) for p in parents],
                               "partners": [list(p) for p in partners]}, indent=1))
    tmp.replace(PATH)


def rename(old, new):
    doc = load()
    if old not in doc["people"]:
        return
    if new in doc["people"]:   # merging two people: keep any dates the survivor lacks
        for k, v in doc["people"].pop(old).items():
            doc["people"][new][k] = doc["people"][new].get(k) or v
    else:
        doc["people"][new] = doc["people"].pop(old)
    swap = lambda n: new if n == old else n
    doc["parents"] = [[swap(a), swap(b)] for a, b in doc["parents"]]
    doc["partners"] = [[swap(a), swap(b)] for a, b in doc["partners"]]
    save(doc)


def gedcom(sex_guess=None, fs_ids=None):
    """GEDCOM 5.5.1 text of the tree (individuals, couples and their children).
    sex_guess: {name: "M"|"F"} from the photos, used where the tree doesn't say."""
    doc = load()
    sex = {n: doc["people"][n].get("sex") or (sex_guess or {}).get(n, "") for n in doc["people"]}
    names = sorted(doc["people"])
    iid = {n: f"@I{i + 1}@" for i, n in enumerate(names)}
    parents_of = {}
    for p, c in doc["parents"]:
        parents_of.setdefault(c, set()).add(p)
    # A family is a couple (or lone parent) plus the children they share.
    fams = {}
    for a, b in doc["partners"]:
        fams[frozenset((a, b))] = []
    for c, ps in parents_of.items():
        fams.setdefault(frozenset(ps), []).append(c)
    fid = {k: f"@F{i + 1}@" for i, k in enumerate(fams)}

    out = ["0 HEAD", "1 SOUR FamilyFaces", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED",
           "1 CHAR UTF-8", f"1 DATE {date.today().strftime('%d %b %Y').upper()}"]
    for n in names:
        parts = n.split()
        given, surname = (" ".join(parts[:-1]), parts[-1]) if len(parts) > 1 else (n, "")
        out += [f"0 {iid[n]} INDI", f"1 NAME {given} /{surname}/"]
        if sex[n]:
            out.append(f"1 SEX {sex[n]}")
        if (fs_ids or {}).get(n):
            out.append(f"1 _FSFTID {fs_ids[n]}")   # FamilySearch Family Tree ID
        info = doc["people"][n]
        if info.get("born"):
            out += ["1 BIRT", f"2 DATE {info['born']}"]
        if info.get("died"):
            out += ["1 DEAT", f"2 DATE {info['died']}"]
        for k, kids in fams.items():
            if n in k:
                out.append(f"1 FAMS {fid[k]}")
            if n in kids:
                out.append(f"1 FAMC {fid[k]}")
    for k, kids in fams.items():
        out.append(f"0 {fid[k]} FAM")
        # GEDCOM 5.5.1 has HUSB/WIFE slots: men first, then women, then anyone unknown
        for i, p in enumerate(sorted(k, key=lambda n: ({"M": 0, "F": 1}.get(sex[n], 2), n))):
            role = {"M": "HUSB", "F": "WIFE"}.get(sex[p]) or ("HUSB" if i == 0 else "WIFE")
            out.append(f"1 {role} {iid[p]}")
        out += [f"1 CHIL {iid[c]}" for c in sorted(kids)]
    out.append("0 TRLR")
    return "\n".join(out) + "\n"
