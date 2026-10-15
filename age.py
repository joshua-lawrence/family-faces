"""Estimate each face's age with MiVOLO v2 (face + body; age_mivolo.py, run in .venv-mivolo because it needs an
old timm).

Measured on 549 faces of this library with known ages (photo year from a caption minus the person's birth year):
MiVOLO is off by 8.1 years on average, and by about 3 for children under 10. The earlier FairFace + CLIP mix was
9.2 (about 7 for young children); averaging CLIP back in for adults gained only 0.1 years and doubled the time.

python age.py: gives faces without attrs (FamilySearch's) their aligned crop first, then re-estimates every face.
Updates data/attrs.json ("age", "age_mivolo").
"""

import json
from pathlib import Path
import config

DATA = config.DATA


def mivolo_ages(ids, progress=lambda done, total: None):
    """{face id (str): age} from MiVOLO, run in its own environment (it needs an old timm)."""
    import subprocess
    import tempfile
    here = Path(__file__).resolve().parent
    faces = json.loads((DATA / "faces.json").read_text())
    root = config.LIBRARY
    req = [{"id": int(i), "photo": str(root / faces[int(i)]["photo"]), "bbox": faces[int(i)]["bbox"]} for i in ids]
    with tempfile.TemporaryDirectory() as tmp:
        rq, rs = Path(tmp) / "req.json", Path(tmp) / "res.json"
        rq.write_text(json.dumps(req))
        p = subprocess.Popen([str(here / ".venv-mivolo" / "bin" / "python"), "-W", "ignore", str(here / "age_mivolo.py"),
                              str(rq), str(rs)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for line in p.stdout:
            if line.startswith("progress "):
                d, t = line.split()[1:3]
                progress(int(d), int(t))
        err = p.stderr.read()
        if p.wait() != 0:
            raise RuntimeError(f"MiVOLO failed: {err.strip().splitlines()[-1] if err.strip() else p.returncode}")
        return json.loads(rs.read_text())


def estimate(ids, progress=lambda done, total: None):
    """{face id (str): {"age", "age_mivolo"}}."""
    ids = [str(i) for i in ids]
    if not ids:
        return {}
    return {i: {"age": a, "age_mivolo": a} for i, a in mivolo_ages(ids, progress).items()}


def main(step=5000):
    import attrs as attrs_mod
    filled, unmatched = attrs_mod.fill_missing(lambda s, d, t: print(f"{s}: {d}/{t}", flush=True))
    print(f"Aligned crops for {filled} more faces ({unmatched} couldn't be found again)")
    path = DATA / "attrs.json"
    attrs = json.loads(path.read_text())
    ids = sorted(attrs, key=int)
    for k in range(0, len(ids), step):   # save as it goes
        for i, v in estimate(ids[k:k + step]).items():
            attrs[i].update(v)
            for old in ("age_ff", "age_clip", "age_pending"):   # the old models' readings
                attrs[i].pop(old, None)
        tmp = DATA / "attrs.json.tmp"
        tmp.write_text(json.dumps(attrs))
        tmp.replace(path)
        print(f"Ages: {min(k + step, len(ids))}/{len(ids)}", flush=True)


if __name__ == "__main__":
    main()
