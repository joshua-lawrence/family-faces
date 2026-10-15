"""Import new photos from the Inbox folder into the library.

Drop image files (JPG, PNG, TIFF, HEIC, WebP) into <library>/Inbox, then press
"Process new photos" in the app (or run `uv run python pipeline.py`). For each photo:

  1. Read what came with it: a sidecar notes file and/or metadata inside the image
     (caption, date, source, tagged people with optional face boxes). See README.
  2. Skip exact duplicates of photos already in the library (moved to Inbox/_Already in library).
  3. Move it to "Added photos/<date>/". HEIC and TIFF are converted to JPEG (browsers and
     FamilySearch can't show HEIC; browsers can't show TIFF); originals are kept in originals/.
  4. Bake in the orientation flag and turn it upright if the faces say it's sideways.
  5. Find faces; save thumbnails, aligned crops, landmarks, sex/age estimates and the
     buffalo_l + AdaFace fingerprints, appended to the existing data (nothing is redone).
  6. Apply names that came with the photo: a tagged face box with a known person (by
     FamilySearch ID, confirmed alias or exact name) is named; anything else waits for review.
     Model guesses are never applied automatically; they appear as suggestions.
Then unnamed faces are regrouped and the map is rebuilt.
"""

import json
import shutil
import subprocess
from datetime import date, datetime
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

import library
import people
import config

try:   # let Pillow open iPhone HEIC photos anywhere in the pipeline
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

DATA = library.DATA
SUPPORTED = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".heif", ".webp", ".gif", ".bmp", ".jxl"}
CONVERT = {".heic", ".heif", ".tif", ".tiff", ".webp", ".gif", ".bmp", ".jxl"}


def _is_jpeg(path):
    with open(path, "rb") as fh:
        return fh.read(3) == b"\xff\xd8\xff"


def open_image(path):
    """Image.open, plus JPEG XL (Pillow can't read .jxl): decoded with Homebrew's djxl to a temporary PNG."""
    path = Path(path)
    if path.suffix.lower() != ".jxl" or _is_jpeg(path):   # some scanner apps save plain JPEGs as .jxl
        return Image.open(path)
    import tempfile
    djxl = shutil.which("djxl") or "/opt/homebrew/bin/djxl"
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "decoded.png"
        r = subprocess.run([djxl, str(path), str(out)], capture_output=True, text=True)
        if r.returncode != 0 or not out.exists():
            raise ValueError(f"couldn't decode this JPEG XL file ({(r.stderr or 'djxl failed').strip()[:120]})")
        im = Image.open(out)
        im.load()
        return im
DUPES = library.INBOX / "_Already in library"
FAILED = library.INBOX / "_Could not import"
APP_FOLDERS = {DUPES.name, FAILED.name}   # the import's own folders in the Inbox: never imported again
PENDING = DATA / "import-in-progress.json"   # files moved by an import that hasn't saved the photo list yet
MODELS = Path.home() / ".insightface/models"


# ---------------------------------------------------------------- what came with the photo

_EXIF = {}   # resolved path -> exiftool record, filled in bulk by prefetch_metadata()


def prefetch_metadata(paths, per_call=250, parallel=8):
    """Read embedded metadata for many files with a few exiftool runs in parallel (one run per file was the
    slowest part of a big import). read_metadata() falls back to a single run for anything missing."""
    from concurrent.futures import ThreadPoolExecutor
    paths = [str(Path(p).resolve()) for p in paths]

    def one(chunk):
        try:
            r = subprocess.run(["exiftool", "-j", "-struct", "-n", "-q", "-q", *chunk],
                               capture_output=True, text=True, timeout=600)
            for rec in json.loads(r.stdout or "[]"):
                _EXIF[str(Path(rec.get("SourceFile", "")).resolve())] = rec
        except (subprocess.SubprocessError, json.JSONDecodeError, FileNotFoundError, OSError):
            pass   # read_metadata will run exiftool for these one at a time

    with ThreadPoolExecutor(parallel) as ex:
        list(ex.map(one, [paths[i:i + per_call] for i in range(0, len(paths), per_call)]))


def sidecar_for(path):
    for cand in (path.with_name(path.name + ".json"), path.with_suffix(".json")):
        if cand.exists():
            return cand
    return None


def _box_fraction(box, units, w, h):
    x1, y1, x2, y2 = [float(v) for v in box]
    if units == "pixels" or max(x1, y1, x2, y2) > 1.5:
        x1, x2, y1, y2 = x1 / w, x2 / w, y1 / h, y2 / h
    return [x1, y1, x2, y2]


def read_metadata(path):
    """Caption, date, source and tagged people for a photo, from its sidecar notes file and
    from metadata inside the image (XMP face regions, PersonInImage, captions, dates).
    Face boxes are returned as fractions of the image as displayed."""
    out = {"caption": "", "date": "", "source": "", "source_url": "", "people": []}
    raw = _EXIF.pop(str(Path(path).resolve()), None)
    if raw is None:
        try:
            raw = json.loads(subprocess.run(["exiftool", "-j", "-struct", "-n", str(path)],
                                            capture_output=True, text=True, timeout=60).stdout or "[{}]")[0]
        except (subprocess.SubprocessError, json.JSONDecodeError, FileNotFoundError):
            raw = {}
    for k in ("Description", "Caption-Abstract", "ImageDescription", "XPComment", "UserComment"):
        v = raw.get(k)
        if isinstance(v, str) and v.strip() and v.strip().lower() not in ("default", "untitled"):
            out["caption"] = v.strip()
            break
    for k in ("DateTimeOriginal", "DateCreated", "CreateDate"):
        if raw.get(k):
            out["date"] = str(raw[k])
            break
    # Metadata Working Group face regions (Apple Photos, Lightroom, Picasa...): centre + size, normalised
    regions = (raw.get("RegionInfo") or {}).get("RegionList") or []
    for r in regions if isinstance(regions, list) else []:
        a, name = r.get("Area") or {}, r.get("Name")
        if name and {"X", "Y", "W", "H"} <= set(a):
            x, y, w, h = (float(a[k]) for k in ("X", "Y", "W", "H"))
            out["people"].append({"name": name, "box": [x - w / 2, y - h / 2, x + w / 2, y + h / 2]})
    tagged = {p["name"] for p in out["people"]}
    pii = raw.get("PersonInImage") or []
    for name in [pii] if isinstance(pii, str) else pii:
        if name not in tagged:
            out["people"].append({"name": name, "box": None})

    side = sidecar_for(path)
    if side:
        doc = json.loads(side.read_text())
        with open_image(path) as im:
            w, h = ImageOps.exif_transpose(im).size
        for k in ("caption", "date", "source", "source_url"):
            if doc.get(k):
                out[k] = str(doc[k]).strip()
        given = []
        for p in doc.get("people", []):
            box = p.get("box")
            given.append({"name": p.get("name", ""), "familysearch_id": p.get("familysearch_id", ""),
                          "box": _box_fraction(box, p.get("box_units", ""), w, h) if box else None})
        if given:   # the notes file is the more deliberate source: it wins over embedded tags
            out["people"] = given
    return out


# ---------------------------------------------------------------- filing and orientation

def _unique(dest):
    n, stem, suf = 1, dest.stem, dest.suffix
    while dest.exists():
        n += 1
        dest = dest.with_name(f"{stem} ({n}){suf}")
    return dest


def file_photo(src, batch_dir, log=None):
    """Move src into the batch folder as a browser-friendly image with orientation baked in.
    Returns the new path. Converted files keep their original in originals/. log (a dict) records
    what was moved and made, so an import that stops halfway can put things back (recover_interrupted)."""
    log = log if log is not None else {}
    batch_dir.mkdir(parents=True, exist_ok=True)
    suffix = src.suffix.lower()
    if suffix == ".jxl" and _is_jpeg(src):   # really a JPEG: keep it losslessly, just give it the right extension
        dest = _unique(batch_dir / (src.stem + ".jpg"))
        log.setdefault("moved", []).append([str(src), str(dest)])
        if log.get("save"):
            log["save"]()
        shutil.move(str(src), str(dest))
        bake_jpeg_orientation(dest)
        return dest
    if suffix in CONVERT:
        dest = _unique(batch_dir / (src.stem + ".jpg"))
        log.setdefault("made", []).append(str(dest))
        with open_image(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.save(dest, "JPEG", quality=95)
        (batch_dir / "originals").mkdir(exist_ok=True)
        original = _unique(batch_dir / "originals" / src.name)
        log.setdefault("moved", []).append([str(src), str(original)])
        if log.get("save"):
            log["save"]()
        shutil.move(str(src), str(original))
        return dest
    dest = _unique(batch_dir / src.name)
    log.setdefault("moved", []).append([str(src), str(dest)])
    if log.get("save"):
        log["save"]()
    shutil.move(str(src), str(dest))
    if suffix in (".jpg", ".jpeg"):
        bake_jpeg_orientation(dest)
    else:
        with Image.open(dest) as im:
            if (im.getexif().get(274) or 1) != 1:
                ImageOps.exif_transpose(im).save(dest)
    return dest


def bake_jpeg_orientation(path, extra_cw=0):
    """Losslessly rotate a JPEG so its pixels are upright (orientation flag + extra_cw degrees)."""
    from rotate import EXIF_CW, fix_file
    with Image.open(path) as im:
        flag = im.getexif().get(274, 1)
    total = (EXIF_CW.get(flag, 0) + extra_cw) % 360
    if total or flag != 1:
        fix_file(path, total)


def rotate_image_file(path, cw):
    if path.suffix.lower() in (".jpg", ".jpeg"):
        bake_jpeg_orientation(path, cw)
    else:
        with Image.open(path) as im:
            im.rotate(-cw, expand=True).save(path)


def rotate_frac_box(b, cw):
    x1, y1, x2, y2 = b
    return {90: [1 - y2, x1, 1 - y1, x2], 180: [1 - x2, 1 - y2, 1 - x1, 1 - y1],
            270: [y1, 1 - x2, y2, 1 - x1]}.get(cw, b)


# ---------------------------------------------------------------- models (loaded once per import)

class Models:
    def __init__(self, providers=None):
        from insightface.app import FaceAnalysis
        from embed import DET_SIZE
        providers = list(providers or config.onnx_providers())
        self.app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "recognition", "genderage"],
                                providers=providers)
        self.app.prepare(ctx_id=0, det_size=(DET_SIZE, DET_SIZE), det_thresh=0.5)
        self.orient = FaceAnalysis(name="buffalo_l", allowed_modules=["detection"], providers=providers)
        self.orient.prepare(ctx_id=0, det_size=(640, 640), det_thresh=0.5)
        self._rec = None

    def upright_turn(self, path):
        """Clockwise degrees that make the faces in this photo upright (0 if unsure)."""
        from orient import ROTS, upright_score
        img = cv2.imread(str(path))
        s = 1200 / max(img.shape[:2])
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        first = upright_score(self.orient.get(img))
        if first >= 0.7:   # confident upright faces as it is: almost every photo; skip the other 3 rotations
            return 0
        scores = [first] + [upright_score(self.orient.get(cv2.rotate(img, r))) for r in ROTS[1:]]
        best = int(np.argmax(scores))
        return best * 90 if best and scores[best] >= 0.7 and scores[best] > 1.5 * scores[0] + 0.3 else 0

    def fingerprints(self, crops112):
        """buffalo_l + AdaFace combined, normalised (same as reembed.py)."""
        import torch
        import adaface_net
        from bakeoff import ADAFACE, normed
        from insightface.model_zoo import get_model
        if self._rec is None:
            buffalo = get_model(str(MODELS / "buffalo_l/w600k_r50.onnx"),
                                providers=config.onnx_providers())
            buffalo.prepare(ctx_id=0)
            dev = "mps" if torch.backends.mps.is_available() else "cpu"
            self._rec = (buffalo, adaface_net.load(ADAFACE, dev), dev)
        buffalo, ada, dev = self._rec
        b = np.vstack([buffalo.get_feat([c]) for c in crops112])
        x = np.stack(crops112)[..., ::-1].astype(np.float32) / 255.0
        with torch.no_grad():
            a = ada(torch.from_numpy((x - 0.5) / 0.5).permute(0, 3, 1, 2).contiguous().to(dev)).cpu().numpy()
        return normed(np.hstack([normed(b), normed(a)])).astype(np.float32)


CHUNK = 400   # photos per save: an interrupted import loses at most this many


# ---------------------------------------------------------------- parallel face finding (worker processes)

_W = None


def _worker_init(threads, providers):
    """Each worker: ONNX sessions limited to a few threads (many workers share the cores), its own models."""
    import onnxruntime as ort
    orig = ort.InferenceSession.__init__

    def init(self, path_or_bytes, sess_options=None, providers=None, provider_options=None, **kw):
        so = sess_options or ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = threads, 1
        return orig(self, path_or_bytes, sess_options=so, providers=providers, **kw)
    ort.InferenceSession.__init__ = init
    cv2.setNumThreads(1)
    import warnings
    warnings.filterwarnings("ignore", category=FutureWarning)
    global _W
    _W = Models(providers=providers)


def _analyze(dest):
    """Turn a filed photo upright and find its faces. Runs in a worker; returns plain data (the main process
    assigns face ids and writes files)."""
    try:
        from attrs import aligned_crop, crop_quality, is_frontal
        from embed import load, thumb
        from insightface.utils import face_align
        dest = Path(dest)
        turn = _W.upright_turn(dest)
        if turn:
            rotate_image_file(dest, turn)
        img, scale = load(dest)
        full = cv2.imread(str(dest))
        ih, iw = full.shape[:2]
        out = []
        for f in _W.app.get(img):
            bbox = [float(v) for v in f.bbox]
            t = thumb(img, bbox)
            crop = aligned_crop(img, f.kps)
            kps = (f.kps / scale).astype(np.float32)
            out.append({"bbox": [round(v / scale, 1) for v in bbox],
                        "size": round(max(bbox[2] - bbox[0], bbox[3] - bbox[1]) / scale),
                        "score": round(float(f.det_score), 3), "sex": "M" if f.sex == "M" else "F",
                        "kps": [[round(float(x), 1), round(float(y), 1)] for x, y in kps],
                        "frontal": is_frontal(f.kps), "quality": crop_quality(crop),
                        "thumb": cv2.imencode(".jpg", t, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes() if t is not None else None,
                        "aligned": cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes(),
                        "c112": face_align.norm_crop(full, kps, 112),
                        "det": f.normed_embedding.astype(np.float32)})
        return {"turn": turn, "iw": iw, "ih": ih, "faces": out}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}


def _redetect(photo, boxes):
    """Eye/mouth points, sex and an aligned crop for faces we have boxes for but no attrs (attrs.fill_missing).
    Runs in a worker. Returns one entry per box: None when no detection matches it."""
    try:
        from attrs import aligned_crop, crop_quality, iou, is_frontal
        from embed import load
        img, scale = load(library.abspath(photo))
        if img is None:
            return [None] * len(boxes)
        dets = _W.app.get(img)
        out = []
        for box in boxes:
            box = [v * scale for v in box]
            best = max(dets, key=lambda d: iou(d.bbox, box), default=None)
            if best is None or iou(best.bbox, box) < 0.3:
                out.append(None)
                continue
            kps = best.kps.astype(np.float32)
            crop = aligned_crop(img, kps)
            out.append({"aligned": cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes(),
                        "attrs": {"age": 30.0, "age_pending": True, "sex": "M" if best.sex == "M" else "F",
                                  "kps": [[round(float(x) / scale, 1), round(float(y) / scale, 1)] for x, y in kps],
                                  "frontal": is_frontal(kps), **crop_quality(crop)}})
        return out
    except Exception:
        return [None] * len(boxes)


def _pool():
    """Worker processes for face finding: one per core but one, a thread each (IMPORT_WORKERS / IMPORT_THREADS /
    IMPORT_PROVIDERS override)."""
    import os
    from concurrent.futures import ProcessPoolExecutor
    from multiprocessing import get_context
    import multiprocessing.spawn as mspawn
    if not getattr(mspawn.get_preparation_data, "_no_main", False):
        orig = mspawn.get_preparation_data

        def prep(name):   # workers needn't re-run the app's main script (serve.py loads all its data at start)
            d = orig(name)
            d.pop("init_main_from_path", None)
            d.pop("init_main_from_name", None)
            return d
        prep._no_main = True
        mspawn.get_preparation_data = prep
    # measured on an M4 Max (16 cores): 15 one-thread CPU workers find faces in ~15 photos/s; 4 CoreML workers ~9/s
    workers = int(os.environ.get("IMPORT_WORKERS", 0)) or max(2, (os.cpu_count() or 8) - 1)
    threads = int(os.environ.get("IMPORT_THREADS", 1))
    providers = os.environ.get("IMPORT_PROVIDERS", "CPUExecutionProvider").split(",")
    return ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn"),
                               initializer=_worker_init, initargs=(threads, providers))


# ---------------------------------------------------------------- the import

def _inbox_items():
    """Every file in the Inbox except the app's own folders (_Already in library, _Could not import) and
    hidden items. Folders and files whose names start with "_" are imported like any other: some cameras
    name files _6II1363.jpg, and people name folders "_old scans"."""
    if not library.INBOX.exists():
        return []
    out = []
    for p in sorted(library.INBOX.rglob("*")):
        *folders, name = p.relative_to(library.INBOX).parts
        if (p.is_file() and not name.startswith(".")
                and not (folders and folders[0] in APP_FOLDERS) and not any(f.startswith(".") for f in folders)):
            out.append(p)
    return out


def inbox_files():
    return [p for p in _inbox_items() if p.suffix.lower() in SUPPORTED]


def inbox_skipped():
    """Files in the Inbox that can't be imported (not photos, or a kind of image the app can't read), so the
    sidebar can say so instead of ignoring them. Notes files that go with a photo are not listed."""
    photos = {p for p in inbox_files()}
    out = []
    for p in _inbox_items():
        if p in photos or p.suffix.lower() == ".json" and any(sidecar_for(x) == p for x in photos if x.parent == p.parent):
            continue
        out.append({"file": p.relative_to(library.INBOX).as_posix(), "kind": (p.suffix.lower().lstrip(".") or "no extension").upper()})
    return out


def _pending_write(moves):
    tmp = PENDING.with_suffix(".tmp")
    tmp.write_text(json.dumps({"moves": [{k: v for k, v in m.items() if k != "save"} for m in moves]}, indent=1))
    tmp.replace(PENDING)


def recover_interrupted():
    """An import that stopped before it saved the photo list (quit, crash, restart) leaves photos it had already
    filed in Added photos/ that the library doesn't know about. Put them back in the Inbox where they were, so
    the next import picks them up. Returns the files put back."""
    try:
        moves = json.loads(PENDING.read_text()).get("moves", [])
    except (OSError, ValueError):
        return []
    known = {p["path"] for p in library.photos()}
    back = []
    for m in reversed(moves):   # undo the moves in reverse order
        rel = m.get("registered")
        if rel and rel in known:
            continue   # this photo made it into the library
        for made in m.get("made", []):   # files the import created (converted JPEGs): drop them
            try:
                Path(made).unlink()
            except OSError:
                pass
        for src, dest in reversed(m.get("moved", [])):
            src, dest = Path(src), Path(dest)
            if dest.exists() and not src.exists():
                src.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(dest), str(src))
                if src.suffix.lower() != ".json":
                    back.append(src.name)
    PENDING.unlink(missing_ok=True)
    return back


def _iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def finish_ages(attrs=None, progress=lambda stage, done, total: None, step=2000):
    """Estimate ages for faces imported without one yet (age_pending), saving attrs.json after each step, so an
    interrupted import's faces get their ages next time."""
    path = DATA / "attrs.json"
    attrs = attrs if attrs is not None else json.loads(path.read_text())
    todo = [i for i, a in attrs.items() if a.get("age_pending")]
    if not todo:
        return 0
    import age
    for k in range(0, len(todo), step):
        progress("Estimating ages", k, len(todo))
        for i, v in age.estimate(todo[k:k + step], lambda d, t: progress("Estimating ages", k + d, len(todo))).items():
            attrs[i].update(v)
            for old in ("age_ff", "age_clip", "age_pending"):
                attrs[i].pop(old, None)
        tmp = DATA / "attrs.json.tmp"
        tmp.write_text(json.dumps(attrs))
        tmp.replace(path)
    return len(todo)


def run(progress=lambda stage, done, total: None, known_names=(), apply_names=lambda names, sources: None):
    """Import everything in the Inbox. Returns a report dict.

    known_names: names already in use (for matching names that came with photos).
    apply_names(dict face_id -> name, dict face_id -> source): called to store names from
    photo metadata (the server applies them to its in-memory labels under its lock).
    """
    from embed import THUMBS

    recover_interrupted()   # photos a stopped import had filed but not saved go back to the Inbox first
    files = inbox_files()
    run_id = datetime.now().strftime("%Y%m%dT%H%M%S")
    report = {"batch": None, "run": run_id, "added": [], "duplicates": [], "failed": [], "faces": 0,
              "named_from_metadata": 0, "awaiting_review": 0}
    if not files:
        finish_ages(None, progress)   # an earlier import stopped before its ages
        return report
    batch = date.today().isoformat()
    batch_dir = library.ADDED / batch
    report["batch"] = batch
    moves = []   # what each photo's import moved and made, kept on disk until the photo list is saved

    progress("Loading face models", 0, len(files))
    models = Models()   # main process: fingerprints only (the workers find the faces)
    reg = list(library.photos())
    known_sha = {p["sha256"] for p in reg}
    faces = json.loads((DATA / "faces.json").read_text())
    det = np.load(DATA / "embeddings_buffalo_detect.npy")
    comb = np.load(DATA / "embeddings.npy")
    attrs = json.loads((DATA / "attrs.json").read_text())
    known_names = set(known_names)
    known_by_sha = {p["sha256"]: p["path"] for p in reg}
    inbox_rel = lambda f: "Inbox/" + f.relative_to(library.INBOX).as_posix()
    done_path = DATA / "done.json"

    def fail(src, dest, log, e):
        FAILED.mkdir(parents=True, exist_ok=True)
        for f in (src, dest):
            if f is not None and f.exists():
                shutil.move(str(f), str(_unique(FAILED / f.name)))
        if log in moves:
            moves.remove(log)
            _pending_write(moves)
        report["failed"].append({"file": inbox_rel(src), "reason": failure_reason(e),
                                 "detail": f"{type(e).__name__}: {e}"[:300], "moved_to": f"Inbox/{FAILED.name}"})

    def checkpoint(new_ids, new_det, crops112, named, sources, logs):
        """Save the chunk: an interruption after this loses nothing before it."""
        nonlocal det, comb
        if new_ids:   # ages come at the end (age_pending until then): they're slow and nothing else needs them
            progress("Computing face fingerprints", done_n, len(files))
            det = np.vstack([det, np.array(new_det, np.float32)])
            comb = np.vstack([comb, models.fingerprints(crops112)])
        # faces and fingerprints first, then the photo list: a crash between them leaves extra faces whose
        # photo isn't registered (harmless, ignored), never registered photos without their faces
        for name, obj in (("faces.json", faces), ("attrs.json", attrs)):
            tmp = DATA / (name + ".tmp")
            tmp.write_text(json.dumps(obj))
            tmp.replace(DATA / name)
        for name, arr in (("embeddings_buffalo_detect.npy", det), ("embeddings.npy", comb)):
            tmp = DATA / (name + ".tmp.npy")
            np.save(tmp, arr)
            tmp.replace(DATA / name)
        library.save(reg)
        saved = {id(m) for m in logs}   # these photos are in the library now: nothing to put back
        moves[:] = [m for m in moves if id(m) not in saved]
        if moves:
            _pending_write(moves)
        else:
            PENDING.unlink(missing_ok=True)
        done = set(json.loads(done_path.read_text())) if done_path.exists() else set()
        done_path.write_text(json.dumps(sorted(done | set(report["added"]))))
        if named:
            apply_names(named, sources)
            report["named_from_metadata"] += len(named)

    done_n = 0

    def stage(chunk):
        nonlocal done_n
        progress("Reading captions and tags", done_n, len(files))
        prefetch_metadata(chunk)
        # 1) file each photo (quick, in order) and hand it to a worker straight away
        staged = []
        for src in chunk:
            side = sidecar_for(src)
            dest = None
            log = {"moved": [], "made": []}
            try:
                with open_image(src) as im:   # refuse unreadable files before moving anything
                    if src.suffix.lower() != ".jxl" or _is_jpeg(src):   # decoded JXL is already loaded
                        im.verify()
                meta = read_metadata(src)
                sha = library.sha256(src)
                if sha in known_sha:
                    DUPES.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(src), str(_unique(DUPES / src.name)))
                    if side:
                        shutil.move(str(side), str(_unique(DUPES / side.name)))
                    report["duplicates"].append({"file": inbox_rel(src), "matches": known_by_sha.get(sha, ""),
                                                 "moved_to": f"Inbox/{DUPES.name}"})
                    done_n += 1
                    continue
                moves.append(log)
                log["save"] = lambda: _pending_write(moves)
                dest = file_photo(src, batch_dir, log)
                if side:
                    (batch_dir / "_notes").mkdir(exist_ok=True)
                    note = _unique(batch_dir / "_notes" / side.name)
                    log["moved"].append([str(side), str(note)])
                    log["save"]()
                    shutil.move(str(side), str(note))
                log["registered"] = dest.relative_to(library.ROOT).as_posix()
                _pending_write(moves)
                known_sha.add(sha)   # a second copy later in the Inbox is a duplicate
                staged.append((src, dest, log, meta, sha, pool.submit(_analyze, str(dest))))
            except Exception as e:   # one bad file shouldn't sink the batch
                fail(src, dest, log, e)
                done_n += 1
        return staged

    def collect(staged):
        nonlocal done_n
        # 2) collect the faces in order, give them ids, write their files
        new_det, new_ids, crops112, named, sources = [], [], [], {}, {}
        for src, dest, log, meta, sha, fut in staged:
            progress("Finding faces", done_n, len(files))
            done_n += 1
            try:
                res = fut.result()
                if "error" in res:
                    raise RuntimeError(res["error"])
                turn, iw, ih = res["turn"], res["iw"], res["ih"]
                tags = [dict(p, box=rotate_frac_box(p["box"], turn) if p.get("box") else None, face=None,
                             resolved=None) for p in meta["people"]]
                rel = log["registered"]
                item = {"path": rel, "sha256": sha, "batch": batch, "order": len(reg), "caption": meta["caption"],
                        "date": meta["date"], "source": meta["source"], "source_url": meta["source_url"],
                        "tags": tags, "turned": turn, "run": run_id}
                photo_faces = []
                for f in res["faces"]:
                    fid = len(faces)
                    box = f["bbox"]
                    if f["thumb"] is not None:
                        (THUMBS / f"{fid}.jpg").write_bytes(f["thumb"])
                    (DATA / "aligned" / f"{fid}.jpg").write_bytes(f["aligned"])
                    faces.append({"id": fid, "photo": rel, "bbox": box, "size": f["size"],
                                  "score": f["score"], "img_w": iw})
                    attrs[str(fid)] = {"age": 30.0, "age_pending": True, "sex": f["sex"], "kps": f["kps"], "frontal": f["frontal"],
                                       **f["quality"]}
                    crops112.append(f["c112"])
                    new_det.append(f["det"])
                    new_ids.append(fid)
                    photo_faces.append((fid, [box[0] / iw, box[1] / ih, box[2] / iw, box[3] / ih]))

                # names that came with the photo
                for tag in tags:
                    tag["resolved"] = people.resolve(tag.get("name", ""), tag.get("familysearch_id", ""), known_names)
                    if tag["box"] and photo_faces:
                        fid, b = max(photo_faces, key=lambda pf: _iou(pf[1], tag["box"]))
                        if _iou(b, tag["box"]) > 0.25:
                            tag["face"] = fid
                    if tag["resolved"] and tag.get("familysearch_id"):
                        people.link(tag["resolved"], tag.get("name", ""), tag["familysearch_id"])
                    if tag["resolved"] and tag["face"] is not None:
                        named[tag["face"]] = tag["resolved"]
                        sources[tag["face"]] = meta["source"] or "photo metadata"
                    elif not tag["resolved"]:
                        report["awaiting_review"] += 1
                reg.append(item)
                report["added"].append(rel)
                report["faces"] += len(photo_faces)
            except Exception as e:
                known_sha.discard(sha)
                fail(src, dest, log, e)

        # 3) save this chunk
        checkpoint(new_ids, new_det, crops112, named, sources, [s[2] for s in staged])

    pool = _pool()
    try:   # file chunk N+1 (and keep the workers busy with it) while chunk N's faces are saved
        prev = None
        for c0 in range(0, len(files), CHUNK):
            staged = stage(files[c0:c0 + CHUNK])
            if prev is not None:
                collect(prev)
            prev = staged
        if prev is not None:
            collect(prev)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    finish_ages(attrs, progress)

    for d in sorted(library.INBOX.rglob("*"), reverse=True):   # tidy subfolders the import emptied
        if d.is_dir() and not d.name.startswith(("_", ".")) and not any(d.iterdir()):
            d.rmdir()
    return report


def failure_reason(e):
    """Why a file couldn't be imported, in plain words."""
    text = f"{type(e).__name__} {e}".lower()
    if "truncated" in text or "cannot identify" in text or "unidentifiedimage" in text or "broken" in text \
            or "not a" in text or "syntaxerror" in text:
        return "The file is damaged or incomplete, or isn’t a photo the app can read."
    if "permission" in text:
        return "The app wasn’t allowed to read or move the file."
    if "no space" in text:
        return "The disk is full."
    return f"Something went wrong while reading it ({type(e).__name__})."


def regroup_and_map(named_ids, progress=lambda *a: None):
    """Regroup unnamed faces and rebuild the face map after an import."""
    import cluster
    import importlib
    progress("Grouping unnamed faces", 0, 1)
    summary = cluster.build(set(named_ids))
    progress("Updating the map", 0, 1)
    importlib.import_module("map").main()
    return summary


def _hold_app_lock():
    """The app (serve.py) holds this lock while it runs and keeps the names in memory: an import from the
    command line at the same time would be overwritten by the app's next save. Refuse instead."""
    import fcntl
    import sys
    fh = open(DATA / ".server.lock", "a+")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.seek(0)
        where = fh.read().strip()
        sys.exit(f"The app is running{f' at {where}' if where else ''}. Use Process new photos in the app instead, "
                 "or quit the app first: an import from here would be overwritten by the app's next save.")
    return fh


if __name__ == "__main__":
    APP_LOCK = _hold_app_lock()
    labels_path = DATA / "labels.json"
    doc = json.loads(labels_path.read_text())

    def apply(names, sources):
        doc["names"].update({str(k): v for k, v in names.items()})
        doc.setdefault("sources", {}).update({str(k): v for k, v in sources.items()})
        labels_path.write_text(json.dumps(doc, indent=1))

    rep = run(lambda s, d, t: print(f"{s} {d}/{t}"), set(doc["names"].values()), apply)
    print(json.dumps(rep, indent=1))
    if rep["added"]:   # faces taken out of groups stay out (face ids don't change on import)
        print(regroup_and_map({int(f) for f in doc["names"]} | set(doc.get("rejected", []))))
