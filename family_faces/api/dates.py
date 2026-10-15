"""Photo dates and the Timeline tab: about when was each photo taken?

Evidence, strongest first:
  1. a year you typed for the photo in this app (photos.json "date" with date_source "you")
  2. a camera date in the file (EXIF DateTimeOriginal written by a camera that names its make or
     model), unless the faces or a black-and-white image say it's a copy or scan of an older print
  3. a year in the caption ("1952", "early 1980's", "1988-1989", "c. 1920"). Lifespans ("1896-1995"),
     birth/death dates ("b. 23 Mar 1897") and camera/scanner file names ("2019-12-24_120348.jpg",
     "photo 1890.jpg") are not photo dates, and neither is a year after everyone pictured had died
     (unless the caption is about a grave or a funeral)
  4. the faces: every named face (at least 60 px) whose person has a birth year (tree.json, or the
     FamilySearch record in people.json) and an estimated age (attrs.json). Each face gives a
     likelihood for the year: tight for children, and lopsided for adults, because the age model
     often reads older adults far too young (so an adult's reading is closer to a minimum).
     Faces are multiplied together (each with a small chance of being mislabelled), together
     with how likely a colour or black-and-white print is in each decade (measured on this
     library's caption-dated photos). The year is the median of the result, the range its 90%
     interval; when faces disagree the range covers all of them and the date is marked rough.
  5. any other date saved in the file (a scanner's date, say), only when nothing else is known.

Results are cached in data/photo-dates.json, keyed by a data version (the input files' modification
times and the in-memory face data) and a hash of labels.json, and recomputed in a background thread
when any of those change. Colour and camera facts per photo are cached in data/photo-media.json.

GET  /api/photo-date?path=   -> {year, low, high, label, source: "your date"|"file date"|"caption"|"estimated", basis, ...}
GET  /api/timeline           -> decades (and years of one decade) with counts and sample photos
POST /api/photo-date {path, year}  -> save (or clear, with year "") the year you know for a photo
POST /api/person-born {name, born} -> add a birth year to someone in the Family tree who has none
"""

import hashlib
import json
import math
import re
import threading
import time
from datetime import date

import numpy as np

FIRST_YEAR = 1839                       # the first photographs
NOW_YEAR = date.today().year
SOURCES = ("your date", "file date", "caption", "estimated")
CACHE_VERSION = 9
MEDIA_VERSION = 1
PAGE = 24                               # photos shown per year before "Show all"
MIN_FACE = 60                           # smaller faces give unreliable ages
DEBOUNCE = 2.2
ROUGH = 20                              # an estimate wider than this many years is shown as decades

YEAR = r"(1[89]\d\d|20[0-4]\d)"
MONTH = r"(?i:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
# "b. 23 Mar 1897", "born 1931", "d. 1950", "died Sept 4, 1950": a life event, not the photo's date.
# A single letter counts only as "b." / "d." or a lowercase "b 1897": "James B 1894 - 1959" is a middle initial.
LIFE_EVENT = re.compile(
    rf"(?:\b(?i:born|died|dec'd|deceased|bur|buried|chr|christened|bap|baptized)\b\.?|\b[bBdD]\.|\b[bd]\b)\s*:?\s*"
    rf"(?:(?i:abt|about|c|ca|circa)\.?\s*)?(?:\d{{1,2}}(?:st|nd|rd|th)?\s+)?(?:{MONTH}\s+)?"
    rf"(?:\d{{1,2}}(?:st|nd|rd|th)?,?\s+)?{YEAR}\b")
# camera, phone and scanner file names: their digits are timestamps or sequence numbers
FILE_NAME = [
    re.compile(r"\bScreen ?shot[ _-]\d{4}-\d\d-\d\d(?:\s+at\s+[\d.;:-]+(?:\s*[AP]M)?)?", re.I),
    re.compile(r"\b\d{4}[-_.:]\d\d[-_.:]\d\d[ _T-]+\d{6}\b"),                     # 2019-12-24_120348
    re.compile(r"\b\d{4}[-_.:]\d\d[-_.:]\d\d[ _T-]+\d\d[-_.:;]\d\d(?:[-_.:;]\d\d)?\b"),
    re.compile(r"\b\d{8}[ _-]\d{6}\b"),                                           # IMG_20191224_120348
    re.compile(r"\b\d{1,2}-\d{1,2}-\d{4}\s+\d{1,2}[;:.]\d\d(?:[;:.]\d\d)?(?:\s*[AP]M)?", re.I),
    re.compile(r"^\s*(?:photo|image|img|dsc|dscn|dscf|pict?|scan|p)[ _-]?\d+(?:\s*\(\d+\))?\.[a-z0-9]{2,4}\s*$", re.I),
]
RANGE = re.compile(rf"\b{YEAR}\s*(?:-|–|—|/|\bto\b)\s*(1[89]\d\d|20[0-4]\d|\d\d)\b(?!['’]?s\b)")
DECADE = re.compile(r"\b(?:(early|mid|late)[\s-]*)?(1[89]\d0|20[0-4]0)['’]?s\b", re.I)
CIRCA = re.compile(rf"\b(?:c|ca|circ|circa|abt|about|approx|approximately|around)\.?\s*{YEAR}\b", re.I)
PLAIN = re.compile(rf"\b{YEAR}\b(\s*\?)?")
# a photo of a grave, a funeral or an obituary can be dated after the people in it died
GRAVE = re.compile(r"\b(?:head ?stones?|grave(?:stones?|side|s)?|cemetery|burial|buried|funeral|obituary|memorial|"
                   r"tomb(?:stones?)?|in memory|marker|services?)\b", re.I)
# "77 years", "88 years old", "age 10", "82nd birthday": an age, which dates the photo when one person in it has a birth year
AGE = re.compile(r"\b(?:(\d{1,3})\s*(?:years|yrs)(?:\s+old)?|age[sd]?\s+(\d{1,3})|(\d{1,3})(?:st|nd|rd|th)\s+birthday)\b", re.I)

# How likely a print is black and white / in between / clearly colour, by decade. Measured on this
# library's caption-dated photos with colourfulness(); hand-tinted portraits and scanned clippings
# keep the early colour share above zero.
COLOUR_TABLE = [  # (year, bw, mid, colour)
    (1880, .93, .05, .02), (1935, .88, .07, .05), (1945, .88, .06, .06), (1955, .82, .08, .10),
    (1965, .55, .18, .27), (1975, .25, .20, .55), (1985, .17, .09, .74), (1995, .13, .05, .82),
    (2005, .10, .06, .84), (2015, .06, .07, .87),
]
COLOUR_AT, MID_AT = 26.0, 12.0          # colourfulness thresholds: >= 26 clearly colour, < 12 black and white
GRID = np.arange(FIRST_YEAR, NOW_YEAR + 1, dtype=float)


def colour_class(c):
    if c is None:
        return None
    return "colour" if c >= COLOUR_AT else "bw" if c < MID_AT else "mid"


def colour_likelihood(cls, years):
    col = {"bw": 1, "mid": 2, "colour": 3}[cls]
    xs = [r[0] for r in COLOUR_TABLE]
    return np.interp(years, xs, [r[col] for r in COLOUR_TABLE])


def caption_age(caption, name):
    """The age a caption gives for this person, if it names them ("Rose at about age 15")."""
    text = str(caption or "")
    words = {w for w in re.findall(r"[a-z]{3,}", name.lower()) if w not in ("jr", "sr", "iii")}
    if not words & set(re.findall(r"[a-z]{3,}", text.lower())):
        return None
    m = AGE.search(text)
    if not m or re.search(r"\b(?:died|death|passed)\b[^.;]*$", text[:m.start()], re.I):
        return None
    age = int(next(g for g in m.groups() if g))
    return (age, m.group(0).strip()) if age <= 105 else None


def year_in(text):
    m = re.search(rf"\b{YEAR}\b", str(text or ""))
    y = int(m.group(1)) if m else None
    return y if y and FIRST_YEAR - 40 <= y <= NOW_YEAR else None


def caption_years(caption):
    """Years a caption gives for the photo itself: [(year, low, high, snippet, kind)],
    kind "exact" | "about" | "range" | "decade"."""
    text = str(caption or "")
    if not re.search(r"1[89]\d\d|20[0-4]\d", text):
        return []
    found = []
    blank = lambda m: " " * (m.end() - m.start())
    for pat in FILE_NAME:
        text = pat.sub(blank, text)
    text = LIFE_EVENT.sub(blank, text)

    def rng(m):
        a, b = int(m.group(1)), m.group(2)
        short = len(b) == 2
        b = int(b) if not short else a // 100 * 100 + int(b)
        if b <= a or b - a > 6:         # "1896-1995" is a lifespan; "1952-06" and "2004 - 88 years" aren't ranges
            return m.group(0) if b <= a or short else blank(m)
        found.append(((a + b) / 2, a, b, m.group(0).strip(), "range"))
        return blank(m)
    text = RANGE.sub(rng, text)

    def dec(m):
        start = int(m.group(2))
        part = (m.group(1) or "").lower()
        lo, hi = {"early": (0, 3), "mid": (3, 7), "late": (6, 9)}.get(part, (0, 9))
        found.append(((2 * start + lo + hi) / 2, start + lo, start + hi, m.group(0).strip(), "decade"))
        return blank(m)
    text = DECADE.sub(dec, text)

    def circa(m):
        y = int(m.group(1))
        found.append((y, y - 3, y + 3, m.group(0).strip(), "about"))
        return blank(m)
    text = CIRCA.sub(circa, text)
    for m in PLAIN.finditer(text):
        y = int(m.group(1))
        d = 2 if m.group(2) else 0
        found.append((y, y - d, y + d, m.group(0).strip(), "about" if d else "exact"))
    return [(y, max(lo, FIRST_YEAR), min(hi, NOW_YEAR), s, k) for y, lo, hi, s, k in found
            if FIRST_YEAR <= y <= NOW_YEAR]


def caption_label(y, lo, hi, snippet, kind):
    if kind == "about":
        return f"about {int(round(y))}"
    if kind == "decade":
        m = DECADE.search(snippet)
        part = (m.group(1) or "").lower() if m else ""
        return f"{part + ' ' if part else ''}{lo // 10 * 10}s"
    if lo != hi:
        return f"{lo}–{str(hi)[2:] if str(lo)[:2] == str(hi)[:2] else hi}"
    return str(int(round(y)))


def face_model(age):
    """(sd below, sd above) in years for one face's reading. Children's ages are read to a year or
    two either way; an adult's true age is often much higher than the reading, rarely lower."""
    sd = 1.5 + 0.15 * age
    if age <= 16:
        return sd, sd
    return sd, (max(age + 1.645 * sd, 1.6 * age) - age) / 1.645


def face_estimate(used, colour=None, floor=FIRST_YEAR):
    """used: [(name, born, died, age, clear, weight)] -> dict(year, low, high, faces, dropped, disagree) or None.
    Each face gives a likelihood over the years. A child's reading is close either way. An adult's is
    lopsided: often right, but older adults are often read 20-40 years too young, so part of the
    likelihood is spread evenly from the reading to the end of their life (more of it for a blurry or
    turned face, less once the reading itself is old). Every face also has a small chance of being misnamed."""
    lo_year = int(min(max(FIRST_YEAR, floor), NOW_YEAR))
    years = GRID[int(lo_year - FIRST_YEAR):]
    logp = np.zeros_like(years)
    faces, dropped = [], []
    for name, born, died, age, clear, weight in used:
        sl, sh = face_model(age)
        e = born + age
        end = min(died + 1, NOW_YEAR) if died else NOW_YEAR
        lo_i = max(e - 1.645 * sl, born)
        adult = age > 16
        hi_i = end if adult else min(e + 1.645 * sh, end)
        if lo_i > end or hi_i < max(born, lo_year):
            dropped.append({"name": name, "born": born, "died": died, "age": round(age), "year": int(round(e))})
            continue
        z = np.where(years < e, (years - e) / sl, (years - e) / sh)
        dens = np.exp(-0.5 * z * z) * (2 / (math.sqrt(2 * math.pi) * (sl + sh)))
        if adult:
            # chance the reading is far too young: high for readings of 20-45, low once it says 60+
            older = (0.35 if clear else 0.5) * min(1.0, max(0.2, (65 - age) / 20))
            span = (years >= lo_i) & (years <= end)
            dens = (1 - older) * dens + older * span / max(end - lo_i + 1, 1)
        dens *= (years >= born) & (years <= end)
        eps = 0.03                                          # chance this face is misnamed
        logp += weight * np.log((1 - eps) * dens + eps / len(years))
        faces.append({"name": name, "born": born, "age": round(age), "year": int(round(min(e, end))),
                      "low": int(math.floor(lo_i)), "high": int(math.ceil(e + 1.645 * sh if not adult else hi_i))})
    if not faces:
        return None if not dropped else {"dropped": dropped}
    if colour:
        logp += 2.5 * np.log(colour_likelihood(colour, years))
    p = np.exp(logp - logp.max())
    cdf = np.cumsum(p) / p.sum()
    q = lambda x: int(years[min(int(np.searchsorted(cdf, x)), len(years) - 1)])
    year, low, high = q(.5), q(.05), q(.95)
    disagree = [f for f in faces if f["high"] < low or f["low"] > high] if len(faces) > 1 else []
    if disagree:    # say so, and widen the range to cover every face
        low = max(min([low] + [f["low"] for f in faces]), lo_year)
        high = min(max([high] + [f["high"] for f in faces]), NOW_YEAR)
    for f in faces:
        f["fits"] = f not in disagree
    return {"year": year, "low": low, "high": high, "faces": faces, "dropped": dropped,
            "disagree": [f["name"] for f in disagree], "adults_only": all(f["age"] > 16 for f in faces)}


def dropped_note(dropped):
    return "; ".join(f"{d['name']} looks about {d['age']}, which doesn’t fit their "
                     f"{'dates' if d['died'] else 'birth year'}, so that face was left out" for d in dropped)


def confidence(low, high, rough=False):
    w = high - low
    return "low" if rough else "high" if w <= 4 else "medium" if w <= 10 else "low"


def estimate_label(year, low, high, rough=False):
    if rough or high - low > ROUGH:
        a, b = low // 10 * 10, high // 10 * 10
        return (f"{a}s" if a == b else f"{a}s–{b}s"), True
    return f"about {year}", False


def plural(n, one, many=None):
    return f"{n} {one if n == 1 else (many or one + 's')}"


def life_years(app):
    """{name: (born, died)} from the tree, falling back to FamilySearch records."""
    out = {}
    for name, info in app.people.load().items():
        fs = info.get("familysearch") or {}
        life = re.findall(r"\d{4}", fs.get("lifespan", "") or "")
        born = year_in((fs.get("birth") or {}).get("date")) or (int(life[0]) if life else None)
        died = year_in((fs.get("death") or {}).get("date")) or (int(life[1]) if len(life) > 1 else None)
        if born or died:
            out[name] = (born, died)
    for name, info in app.tree.load()["people"].items():
        born, died = year_in(info.get("born")), year_in(info.get("died"))
        old = out.get(name, (None, None))
        if born or died:
            out[name] = (born or old[0], died or old[1])
    return out


def colourfulness(path):
    """How much real colour a photo has (0 for black and white or toned prints, 30+ for colour film).
    Tints that follow brightness (sepia, faded yellow) are fitted away; what's left is colour."""
    from PIL import Image
    with Image.open(path) as im:
        im.draft("RGB", (160, 160))
        im = im.convert("RGB")
        im.thumbnail((128, 128))
        a = np.asarray(im, dtype=np.float32)
    h, w, _ = a.shape
    a = a[h // 10: h - h // 10, w // 10: w - w // 10].reshape(-1, 3)      # skip borders and mounts
    lum = a.mean(1)
    keep = (lum > 25) & (lum < 235)
    if keep.sum() < 200:
        return 0.0
    r, g, b, lum = a[keep, 0], a[keep, 1], a[keep, 2], lum[keep] / 255
    x = np.stack([np.ones_like(lum), lum, lum * lum], 1)
    res = 0
    for c in (r - g, (r + g) / 2 - b):
        coef, *_ = np.linalg.lstsq(x, c, rcond=None)
        res = res + (c - x @ coef) ** 2
    return round(float(np.percentile(np.sqrt(res), 90)), 1)


def has_camera(path):
    from PIL import Image
    with Image.open(path) as im:
        ex = im.getexif()
        return bool(str(ex.get(271) or "").strip() or str(ex.get(272) or "").strip())


def compute(app, media):
    """Date every photo in the library. Snapshot shared state under the lock, work outside it.
    Returns (records by path, paths whose colour/camera facts would help and aren't known yet)."""
    with app.lock:
        names = dict(app.labels["names"])
        faces = app.faces
        photos = [dict(p) for p in app.library.photos()]
        tagged = {n: [p["path"] for p in items] for n, items in app.source_photos_by_person().items()}
    attrs = app.portraits.attrs()
    life = life_years(app)

    pictured = {}                 # photo -> {name: (face size, face id)}
    for f in faces:
        n = names.get(str(f["id"]))
        if n and n != "_ignore":
            best = pictured.setdefault(f["photo"], {}).get(n)
            if not best or f.get("size", 0) > best[0]:
                pictured[f["photo"]][n] = (f.get("size", 0), f["id"])
    linked = {}
    for n, paths in tagged.items():
        for p in paths:
            linked.setdefault(p, set()).add(n)

    out, wants = {}, set()
    for order, photo in enumerate(photos):
        path = photo["path"]
        here = pictured.get(path, {})
        people_in = sorted(set(here) | linked.get(path, set()))
        used, needs_born, missing_age, small = [], [], [], []
        for n, (size, fid) in sorted(here.items()):
            born, died = life.get(n, (None, None))
            age = (attrs.get(fid) or {}).get("age")
            if age is None:
                missing_age.append(n)
            elif size < MIN_FACE:
                small.append(n)
            elif not born:
                needs_born.append(n)
            else:
                a = attrs.get(fid) or {}
                frontal = bool(a.get("frontal"))
                clip, ff = a.get("age_clip"), a.get("age_ff")   # only faces still read by the old two models
                disagreement = abs(float(clip) - float(ff)) if clip is not None and ff is not None else 0
                weight = (1.0 if frontal else 0.3) * (0.3 if disagreement > 10 else 1.0)
                # A turned face that looks young in one model is weak evidence of childhood.
                if disagreement > 10:
                    age = max(float(age), float(clip), float(ff))
                used.append((n, born, died, float(age), frontal and a.get("sharp", 0) >= 12, weight))
        floor = max([life[n][0] for n in people_in if life.get(n, (None,))[0]] or [FIRST_YEAR])
        info = media.get(path) or {}
        known = info.get("sha") == photo.get("sha256") and info.get("v") == MEDIA_VERSION
        stored = year_in(photo.get("date"))
        mine = photo.get("date_source") == "you"
        if (used or (stored and not mine)) and not known:
            wants.add(path)
        colour = colour_class(info.get("colour")) if known else None
        fe = face_estimate(used, colour if used else None, floor) if used else None
        est = fe if fe and fe.get("faces") else None
        rec = {"people": people_in, "order": order}
        if colour:
            rec["colour"] = colour
        if est:
            rec["estimate"] = [est["year"], est["low"], est["high"]]
        if fe:
            rec["detail"] = (est["faces"] if est else []) + [dict(d, fits=False, ignored=True) for d in fe["dropped"]]

        caption = photo.get("caption") or ""
        caps = [c for c in caption_years(caption) if c[2] >= floor - 1]
        cap_conflict = None
        died = [life.get(n, (None, None))[1] for n in people_in]
        if caps and people_in and all(died) and not GRAVE.search(caption):
            after = [c for c in caps if c[1] > max(died) + 1]
            if after and len(after) == len(caps):
                cap_conflict = (f"the caption says {after[0][3]}, after "
                                + (f"{people_in[0]} died in {died[0]}" if len(people_in) == 1 else "everyone pictured had died"))
                caps = []
        # a date in the file: a camera's own date is good evidence; a scan of an old print isn't
        file_year, file_note = None, None
        if stored and not mine:
            if est and stored > est["high"] + 8:
                file_note = f"the file says {stored}, probably when it was copied or scanned"
            elif colour == "bw" and stored >= 1995:
                file_note = f"the file says {stored}, but it’s a black-and-white print, so probably a copy"
            elif stored < floor - 1:
                file_note = f"the file says {stored}, before someone pictured was born"
            else:
                file_year = stored
        camera = bool(known and info.get("camera"))

        if stored and mine:
            rec.update(year=stored, low=stored, high=stored, source="your date", label=str(stored), basis="you entered it")
        elif file_year and camera:
            rec.update(year=file_year, low=file_year, high=file_year, source="file date", label=str(file_year),
                       basis="the camera’s date in the file", camera=True)
        elif (not caps and len(here) == 1 and len(used) + len(missing_age) + len(small) == 1
              and life.get(next(iter(here)), (None,))[0] and caption_age(caption, next(iter(here)))):
            n = next(iter(here))
            age, snippet = caption_age(caption, n)
            born = life[n][0]
            y = min(born + age, NOW_YEAR)
            rec.update(year=y, low=max(y - 1, FIRST_YEAR), high=y, source="caption", label=f"about {y}",
                       basis=f"caption says “{snippet}”, and {n} was born in {born}")
        elif caps:
            if len(caps) > 1 and max(c[0] for c in caps) - min(c[0] for c in caps) <= 6:
                mid = sorted(c[0] for c in caps)[len(caps) // 2]
                lo, hi = min(c[1] for c in caps), max(c[2] for c in caps)
                snippet = ", ".join(dict.fromkeys(c[3] for c in caps))
                y, label = mid, (f"about {int(round(mid))}" if hi - lo > 1 else str(int(round(mid))))
            else:
                pick = (min(caps, key=lambda c: abs(c[0] - est["year"])) if est else max(caps, key=lambda c: c[0]))
                y, lo, hi, snippet, _ = pick
                label = caption_label(*pick)
            rec.update(year=int(round(y)), low=lo, high=hi, source="caption", label=label, basis=f"caption says “{snippet}”")
            if est and not (est["low"] - 5 <= y <= est["high"] + 5):
                rec["conflict"] = f"faces suggest about {est['year']}"
        elif est:
            label, rough = estimate_label(est["year"], est["low"], est["high"], bool(est["disagree"]))
            where = {"colour": " in a colour photo", "bw": " in a black-and-white photo"}.get(colour, "")
            rec.update(year=est["year"], low=est["low"], high=est["high"], source="estimated", label=label,
                       basis=f"from {plural(len(est['faces']), 'person', 'people')}{where}")
            if rough:
                rec["rough"] = True
            notes = []
            if est["disagree"]:
                rec["disagree"] = True
                notes.append("faces disagree: " + ", ".join(
                    f"{f['name']} looks about {f['age']}, so about {f['year']}" for f in est["faces"]))
            if fe["dropped"]:
                notes.append(dropped_note(fe["dropped"]))
            if file_note:
                notes.append(file_note)
            if cap_conflict:
                notes.append(cap_conflict)
            if notes:
                rec["conflict"] = "; ".join(notes)
        elif file_year:
            rec.update(year=file_year, low=file_year, high=file_year, source="file date", label=str(file_year),
                       basis="a date saved in the file")
        else:
            rec["needs_born"] = needs_born
            rec["needs_age"] = bool(missing_age)
            rec["small"] = bool(small)
            notes = [cap_conflict] if cap_conflict else []
            if fe and fe["dropped"]:
                notes.append(dropped_note(fe["dropped"]))
            if notes:
                rec["conflict"] = "; ".join(notes)
        out[path] = rec
    # name first whoever's birth year would date the most photos
    unlocks = {}
    for rec in out.values():
        for n in rec.get("needs_born", ()):
            unlocks[n] = unlocks.get(n, 0) + 1
    for rec in out.values():
        if rec.get("needs_born"):
            rec["needs_born"].sort(key=lambda n: (-unlocks[n], n))
    return out, wants


class Dates:
    def __init__(self, app):
        self.app = app
        self.path = app.DATA / "photo-dates.json"
        self.media_path = app.DATA / "photo-media.json"
        self.photos, self.key, self.computed_at = None, None, None
        self.media = {}
        self.busy = False
        self._generation = 0
        self._overrides = {}
        self.ready = threading.Event()
        self.mutex = threading.Lock()
        self._checked, self._labels_stat, self._labels_hash = 0.0, None, None
        try:
            doc = json.loads(self.media_path.read_text())
            self.media = doc.get("photos", {}) if doc.get("v") == MEDIA_VERSION else {}
        except (OSError, ValueError):
            pass
        self.load_cache()

    # ---- staleness: data version (input files' mtimes + the in-memory face data) + labels hash
    def current_key(self):
        app, data = self.app, self.app.DATA
        files = ("faces.json", "photos.json", "people.json", "tree.json", "attrs.json")
        version = max((int((data / n).stat().st_mtime_ns // 1000) for n in files if (data / n).exists()), default=0)
        lp = data / "labels.json"
        st = lp.stat() if lp.exists() else None
        sig = (st.st_mtime_ns, st.st_size) if st else None
        if sig != self._labels_stat:
            self._labels_hash = hashlib.sha1(lp.read_bytes()).hexdigest()[:16] if st else "none"
            self._labels_stat = sig
        # an import rewrites the files first and swaps the data in memory later: a run in between
        # must not be stored under the new files' key
        memory = f"{id(app.faces):x}.{len(app.faces)}.{id(app.portraits.attrs()):x}.{getattr(app, 'VERSION', 0)}"
        return f"v{CACHE_VERSION}:{version}:{self._labels_hash}:{memory}"

    def load_cache(self):
        try:
            doc = json.loads(self.path.read_text())
            if doc.get("cache_version") == CACHE_VERSION:
                self.photos, self.key, self.computed_at = doc["photos"], doc["key"], doc.get("computed_at")
                self.ready.set()
        except (OSError, ValueError, KeyError):
            pass
        self.refresh(force=True)

    def refresh(self, force=False):
        """Mark changed inputs; recompute after the last change has settled."""
        now = time.monotonic()
        if not force and now - self._checked < 1.0:
            return
        self._checked = now
        try:
            key = self.current_key()
        except OSError:
            return
        if force or key != self.key:
            with self.mutex:
                if force:
                    self._generation += 1
            self.start()

    def start(self):
        with self.mutex:
            if self.busy:
                return
            self.busy = True
        threading.Thread(target=self.run, daemon=True, name="photo-dates").start()

    def write(self, photos, key, at):
        tmp = self.path.with_suffix(f".{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps({"cache_version": CACHE_VERSION, "key": key, "computed_at": at, "photos": photos}))
        tmp.replace(self.path)

    def fill_media(self, paths):
        """Measure colour and look for a camera make/model in these photos (slow: reads the images)."""
        by_path = {p["path"]: p for p in self.app.library.photos()}
        media = dict(self.media)
        for path in paths:
            item = by_path.get(path)
            if not item:
                continue
            rec = {"sha": item.get("sha256"), "v": MEDIA_VERSION, "colour": None, "camera": False}
            try:
                full = self.app.library.abspath(item.get("preview_path") or path)
                rec["colour"] = colourfulness(full)
                if item.get("date"):
                    rec["camera"] = has_camera(self.app.library.abspath(path))
            except Exception:
                pass
            media[path] = rec
            time.sleep(0.002)   # let foreground requests run between image reads
        self.media = media
        tmp = self.media_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"v": MEDIA_VERSION, "photos": media}))
        tmp.replace(self.media_path)

    def run(self):
        try:
            filled = False   # measure new photos once per run: a photo that can't be measured mustn't loop forever
            while True:
                key, generation, changed = self.current_key(), self._generation, time.monotonic()
                # No foreground request is needed to notice another write during this delay.
                while True:
                    time.sleep(0.1)
                    latest, g = self.current_key(), self._generation
                    if latest != key or g != generation:
                        key, generation, changed = latest, g, time.monotonic()
                    if time.monotonic() - changed >= DEBOUNCE:
                        break
                photos, wants = compute(self.app, self.media)
                with self.mutex:
                    if key == self.current_key() and generation == self._generation:
                        self._overrides.clear()
                    photos.update(self._overrides)
                    self.photos, self.key, self.computed_at = photos, key, time.time()
                self.ready.set()
                self.write(photos, key, self.computed_at)
                if wants and not filled:
                    self.fill_media(wants)
                    filled = True
                    # Media facts changed, so the next pass must use them.
                    continue
                with self.mutex:
                    if self.current_key() == key and generation == self._generation:
                        self.busy = False
                        return
        except Exception:
            import traceback
            traceback.print_exc()
            with self.mutex:
                self.busy = False

    def record_edit(self, path, year):
        """Update only the edited photo now; rebuild the rest after writes stop."""
        with self.mutex:
            rec = dict((self.photos or {}).get(path, {}))
            for k in ("rough", "disagree", "conflict", "camera"):
                rec.pop(k, None)
            if year is not None:
                rec.update(year=year, low=year, high=year, source="your date", label=str(year), basis="you entered it")
            else:
                # The old estimate remains useful until captions and file dates are rechecked.
                est = rec.get("estimate")
                if est:
                    y, low, high = est
                    label, rough = estimate_label(y, low, high)
                    rec.update(year=y, low=low, high=high, source="estimated", label=label,
                               basis="from named faces", rough=rough)
                else:
                    for k in ("year", "low", "high", "source", "label", "basis"):
                        rec.pop(k, None)
            self._overrides[path] = rec
            if self.photos is not None:
                self.photos = {**self.photos, path: rec}
        self.refresh(force=True)
        return public(path, rec)

    def get(self):
        self.refresh()
        if not self.ready.wait(60):
            raise ValueError("Photo dates are still being worked out. Try again in a minute.")
        return self.photos

    @property
    def updating(self):
        return self.busy


def public(path, rec, born=None):
    out = {"path": path}
    if rec.get("year") is not None:
        out.update({k: rec[k] for k in ("year", "low", "high", "source", "basis")})
        out["label"] = rec.get("label") or str(rec["year"])
        out["confidence"] = confidence(rec["low"], rec["high"], rec.get("rough") or rec.get("disagree"))
        for k in ("conflict", "rough", "camera"):
            if rec.get(k):
                out[k] = rec[k]
        if born:
            out["age"] = rec["year"] - born
    else:
        out.update(year=None, low=None, high=None, source=None, label=None, basis=undated_basis(rec))
        if rec.get("conflict"):
            out["conflict"] = rec["conflict"]
    return out


def undated_basis(rec):
    if rec.get("needs_born"):
        who = rec["needs_born"]
        return f"add a birth year for {who[0]}" + (f" or {plural(len(who) - 1, 'other')}" if len(who) > 1 else "")
    if rec.get("conflict"):
        return rec["conflict"]
    if rec.get("needs_age"):
        return "no age estimates for the named faces yet"
    if rec.get("small"):
        return "the named faces are too small to judge their ages"
    if rec.get("people"):
        return "the people here aren’t named on their faces"
    return "no names, caption year or date"


def register(routes, app):
    dates = Dates(app)
    app.photo_dates = dates

    def photo_date(q):
        path = q.get("path", "")
        photos = dates.get()
        rec = photos.get(path)
        if rec is None:
            raise ValueError("That photo isn’t in the library. Check the path.")
        out = public(path, rec)
        out["people"] = rec.get("people", [])
        if rec.get("detail"):
            out["faces"] = rec["detail"]
        if rec.get("estimate") and rec.get("source") != "estimated":
            out["estimate"] = dict(zip(("year", "low", "high"), rec["estimate"]))
        if rec.get("colour"):
            out["colour"] = rec["colour"]
        out["updating"] = dates.updating
        return out

    def timeline(q):
        photos = dates.get()
        person = q.get("person", "").strip()
        born = died = None
        items = photos.items()
        if person:
            items = [(p, r) for p, r in items if person in r.get("people", ())]
            born, died = life_years(app).get(person, (None, None))
        known = [(p, r) for p, r in items if r.get("year") is not None]
        rough = [(p, r) for p, r in known if r.get("rough")]
        dated = [(p, r) for p, r in known if not r.get("rough")]
        undated = [(p, r) for p, r in items if r.get("year") is None]
        by_source = {s: 0 for s in SOURCES}
        decades = {}
        for p, r in known:
            is_rough = bool(r.get("rough"))
            if not is_rough:
                by_source[r["source"]] += 1
            d = decades.setdefault(r["year"] // 10 * 10,
                                   {"count": 0, "dated": 0, "rough": 0, "by_source": {s: 0 for s in SOURCES}})
            d["count"] += 1
            d["rough" if is_rough else "dated"] += 1
            if not is_rough:
                d["by_source"][r["source"]] += 1
        rank = {s: i for i, s in enumerate(SOURCES)}
        best = lambda pr: (rank[pr[1]["source"]], pr[1]["high"] - pr[1]["low"], pr[1]["order"])
        out = {
            "key": dates.key, "updating": dates.updating, "total": len(items) if person else len(photos),
            "dated": len(dated), "rough": len(rough), "undated": len(undated), "by_source": by_source,
            "decades": [{"decade": d, **v} for d, v in sorted(decades.items())],
        }
        if person:
            out["person"] = {"name": person, "born": born, "died": died, "photos": len(items)}
        view = q.get("view", "")
        if view == "counts":
            return out
        caption_of = {p["path"]: p.get("caption", "") for p in app.library.photos()}

        def card(p, r):
            c = public(p, r, born)
            c["caption"] = (caption_of.get(p) or "")[:160]
            return c

        if view == "undated":
            raw = str(q.get("offset", "0") or "0").strip()
            if not (raw.isascii() and raw.isdigit()):
                raise ValueError("Show more needs a page number, like offset=60.")
            offset = int(raw)
            # one birth year away first, starting with the people whose birth year would date the most
            # photos; then captioned photos, then the rest
            unlocks = {}
            for _, r in undated:
                for n in r.get("needs_born", ()):
                    unlocks[n] = unlocks.get(n, 0) + 1
            top = lambda r: max((unlocks[n] for n in r.get("needs_born", ())), default=0)
            score = lambda pr: (0 if pr[1].get("needs_born") else 1 if caption_of.get(pr[0]) else 2,
                                -top(pr[1]), min(pr[1].get("needs_born") or [""], key=lambda n: -unlocks.get(n, 0)),
                                pr[1]["order"])
            undated.sort(key=score)
            tree_people = set(app.tree.load()["people"])

            def needs(r):
                ns = sorted(r.get("needs_born", ()), key=lambda n: -unlocks[n])
                return [{"name": n, "in_tree": n in tree_people, "photos": unlocks[n]} for n in ns]
            out["photos"] = [dict(card(p, r), needs=needs(r)) for p, r in undated[offset:offset + 60]]
            out["offset"] = offset
            if offset == 0:
                ranked = sorted(unlocks.items(), key=lambda kv: (-kv[1], kv[0]))[:6]
                out["people_to_date"] = [{"name": n, "photos": c, "in_tree": n in tree_people} for n, c in ranked]
            return out
        if q.get("decade"):
            try:
                decade = int(q["decade"]) // 10 * 10
            except ValueError:
                raise ValueError("Choose a decade like 1950.")
            only_year = int(q["year"]) if (q.get("year", "").isascii() and q.get("year", "").isdigit()) else None
            years = {}
            for p, r in dated:
                if r["year"] // 10 * 10 == decade:
                    years.setdefault(r["year"], []).append((p, r))
            around = sorted([(p, r) for p, r in rough if r["year"] // 10 * 10 == decade], key=best)
            out["around"] = {"count": len(around), "photos": [card(p, r) for p, r in
                             (around if q.get("rough") == "all" else around[:PAGE])]}
            out["decade"] = decade
            out["years"] = []
            for y in range(decade, decade + 10):
                rows = sorted(years.get(y, []), key=best)
                show = rows if y == only_year else rows[:PAGE]
                out["years"].append({"year": y, "count": len(rows), "photos": [card(p, r) for p, r in show]})
            return out
        # overview: a few of the most certain photos from each decade, spread across its years
        samples = {}
        for p, r in sorted(dated, key=best):
            d = r["year"] // 10 * 10
            bucket = samples.setdefault(d, [])
            if len(bucket) < 8 and sum(1 for _, x in bucket if x["year"] == r["year"]) < 2:
                bucket.append((p, r))
        rough_samples = {}
        for p, r in sorted(rough, key=best):
            bucket = rough_samples.setdefault(r["year"] // 10 * 10, [])
            if len(bucket) < 8:
                bucket.append((p, r))
        for d in out["decades"]:
            d["around_photos"] = [card(p, r) for p, r in rough_samples.get(d["decade"], [])]
            d["photos"] = [card(p, r) for p, r in sorted(samples.get(d["decade"], []), key=lambda pr: pr[1]["year"])]
        return out

    def set_date(body):
        path = str(body.get("path", ""))
        if "year" not in body:
            raise ValueError("Send the year to save, or an empty year to clear the one you entered.")
        raw = str(body.get("year") if body.get("year") is not None else "").strip()
        year = None
        if raw:
            if not (raw.isascii() and raw.isdigit()) or not FIRST_YEAR <= int(raw) <= NOW_YEAR:
                raise ValueError(f"Enter a year between {FIRST_YEAR} and {NOW_YEAR}, like 1952.")
            year = int(raw)
        with app.lock:
            items = app.library.photos()
            item = next((p for p in items if p["path"] == path), None)
            if item is None:
                raise ValueError("That photo isn’t in the library. Check the path.")
            if year is None:
                if item.get("date_source") != "you":
                    raise ValueError("Only a year you entered can be cleared.")
                item["date"] = item.pop("date_file", "")
                item.pop("date_source", None)
            else:
                if item.get("date") and item.get("date_source") != "you" and "date_file" not in item:
                    item["date_file"] = item["date"]      # keep the file's own date
                item["date"], item["date_source"] = str(year), "you"
            app.library.save(items)
        out = dates.record_edit(path, year)
        out["updating"] = True
        return out

    def set_born(body):
        name = str(body.get("name", "")).strip()
        raw = str(body.get("born", "")).strip()
        if not (raw.isascii() and raw.isdigit()) or not 1700 <= int(raw) <= NOW_YEAR:
            raise ValueError(f"Enter a birth year between 1700 and {NOW_YEAR}, like 1922.")
        with app.lock:
            doc = app.tree.load()
            person = doc["people"].get(name)
            if person is None:
                raise ValueError(f"{name or 'That person'} isn’t in the Family tree yet. Add them there first.")
            if year_in(person.get("born")):
                raise ValueError(f"{name} already has a birth year ({person['born']}). Change it in the Family tree.")
            person["born"] = raw
            app.tree.save(doc)
        dates.refresh(force=True)
        return {"name": name, "born": int(raw)}

    routes["GET"]["/api/photo-date"] = photo_date
    routes["GET"]["/api/timeline"] = timeline
    routes["POST"]["/api/photo-date"] = set_date
    routes["POST"]["/api/person-born"] = set_born
