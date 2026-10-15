# Family Faces

Find every face in your family photos, put names to them, and link the people to a family tree.
Everything runs on your own computer: your photos and names never leave it.

- **Finds and groups faces.** Detects faces with InsightFace and groups the ones that look alike,
  so you name a whole group at once.
- **Suggests names, never applies them.** Likely matches come with a score, and nothing is named
  until you click. Every change can be undone from History.
- **Builds a family tree.** Add parents, partners and children, filter people by how closely they
  are related, and export GEDCOM for Ancestry, FamilySearch or any genealogy app.
- **Dates undated photos.** Estimates when a photo was taken from its caption, the ages of the
  people in it against their birth years, and how colourful the print is.
- **Shows people across their lives.** Portraits by age, "growing up" morph videos, and average
  faces by generation along the tree.

![Review: one group of faces at a time, with the best match ready to accept](docs/screenshots/review.png)

| | |
| --- | --- |
| ![Home: how much of the library is named, and what to do next](docs/screenshots/home.png) | ![A person's page: photos by decade with their age in each, and close family](docs/screenshots/person.png) |
| ![Family tree built from the people you name](docs/screenshots/family-tree.png) | ![Timeline: photos dated from captions and the ages of the people in them](docs/screenshots/timeline.png) |

<sub>Screenshots show a made-up family drawn with the CC0 [Notionists](https://www.dicebear.com/styles/notionists/) avatars.
See [tools/demo-library](tools/demo-library) to rebuild it.</sub>

## Install

You need [uv](https://docs.astral.sh/uv/) and Python 3.12 or newer.

```bash
git clone https://github.com/joshua-lawrence/family-faces
cd family-faces
uv sync
```

## Start

```bash
uv run python app.py --library ~/Pictures/Family
```

The first start looks through every photo in that folder and its subfolders (about a second per
photo on a laptop), groups the faces, and opens the app at http://localhost:8765. The folder is
remembered, so next time `uv run python app.py` is enough.

Your photos are never moved or changed. What the app learns from them (faces, names, the tree,
thumbnails) goes in `<library>/.family-faces`. Use `--data /some/other/folder` to keep it elsewhere.

## Adding photos later

1. Drop photos (JPG, PNG, TIFF, HEIC, WebP) into `<library>/Inbox`. Subfolders are fine.
2. Press **Process new photos** in the app.
3. Review them under **Imports**.

Each import is filed under `Added photos/<date>/`. HEIC and TIFF are converted to JPEG with the
originals kept, photos are turned upright, and exact duplicates are set aside.

A photo can bring its own notes in a JSON file beside it, named `<photo file name>.json`:

```json
{
  "caption": "Ann and Lee at the reunion",
  "date": "1988",
  "people": [
    {"name": "Ann Ward", "familysearch_id": "ABCD-123", "box": [0.12, 0.20, 0.31, 0.48]},
    {"name": "Lee Ward"}
  ]
}
```

`box` is the face as `[left, top, right, bottom]` fractions of the image. Face tags saved by Apple
Photos, Lightroom or Picasa are read the same way.

## Better matching (optional)

`uv run python -m family_faces.pipeline.reembed` adds [AdaFace](https://github.com/mk-minchul/AdaFace) fingerprints
alongside ArcFace. Download the IR-101 WebFace12M weights as
`~/.insightface/models/adaface_ir101_webface12m.safetensors` first. Then regroup with `uv run python -m family_faces.pipeline.cluster`.

On the author's library of about 18,000 photos, `family_faces/pipeline/bakeoff.py` measured how often a face's nearest
named face is the right person. The albums were split into five blocks and faces were only matched
against other blocks, so a face can't be recognised from the same outfit on the next page.

| Model | All faces | Children under 10 | Faces under 80 px |
| --- | --- | --- | --- |
| ArcFace (buffalo_l) | 97.2% | 87.8% | 85.4% |
| ArcFace + AdaFace | 97.8% | 90.9% | 88.6% |

## Other tools

| Command | What it does |
| --- | --- |
| `uv run python -m family_faces.pipeline.cluster [threshold]` | Regroup faces (default 0.65; lower is stricter). Names are kept. |
| `uv run python -m family_faces.export` | Copy each person's photos to `<library>/_by_person/<Name>/` as hard links, plus a CSV. |
| `uv run python -m family_faces.pipeline.map` | Lay out every face on a map of look-alikes for the Map tab. |
| `uv run python -m family_faces.pipeline.attrs` then `-m family_faces.pipeline.age` | Aligned portraits and age estimates for the Portraits tab. |
| `uv run python -m family_faces.pipeline.orient` then `-m family_faces.pipeline.rotate --apply` | Find and fix sideways photos losslessly, keeping the originals. |

## Settings

`~/.config/family-faces/config.json` (or the file named by `FAMILY_FACES_CONFIG`):

```json
{
  "library": "/Users/you/Pictures/Family",
  "data": "/Users/you/Pictures/Family/.family-faces",
  "album_name": "Family albums",
  "home_person": "Ann Ward"
}
```

`FAMILY_FACES_LIBRARY` and `FAMILY_FACES_DATA` override the file. `home_person` is where the
family tree opens.

### FamilySearch (optional)

The app can read face tags from FamilySearch Memories and upload chosen photos and tags. It talks
to FamilySearch through two small Node scripts that you provide, which keep your sign-in outside the
app. Add them under `"familysearch": {"connection_script": "...", "upload_script": "..."}`. Without
them, the FamilySearch features stay switched off.

## Model licenses

The code is MIT licensed. The face models are not part of this repository and have their own terms:
InsightFace's pretrained models (buffalo_l) are released for non-commercial research use, and
AdaFace weights follow their own license. Check those terms before using this in anything
commercial.

## Project layout

```
app.py                  Start here: picks the library, finds faces the first time, opens the app
family_faces/
  config.py             Where the library and the app's data live; optional integrations
  library.py            The photo library: scanning, captions, the Inbox
  people.py, tree.py    Who is who, and how they are related
  serve.py              The local web server (http://localhost:8765)
  api/                  One module per group of endpoints, loaded by serve.py
  pipeline/             Finding faces: detection, fingerprints, ages, grouping, the face map, Inbox imports
  familysearch/         Optional FamilySearch tags, tree hints and uploads
  web/                  The interface: review.html plus the scripts and styles it loads
  export.py, portraits.py, morph.py, photo_gallery.py, people_filters.py, family.py
tests/                  Python unittest and Node tests
docs/                   Design notes and README screenshots
tools/demo-library/     Builds the made-up family used in the screenshots
```

## Development

```bash
uv run python -m unittest discover -s tests
for f in tests/*.mjs; do node "$f"; done
```
