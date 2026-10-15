# Demo library

The README screenshots use a made-up family, the Hales, drawn with the
[Notionists](https://www.dicebear.com/styles/notionists/) avatar style by Zoish (CC0 1.0, via DiceBear).
No real photos or real people are involved.

```bash
cd tools/demo-library && npm install
node render-photos.mjs "/tmp/Hale Family Photos"        # 32 photos, 1950s to 2020s
uv run python build-data.py "/tmp/Hale Family Photos"    # faces, names and family tree, no detection needed
cd ../.. && FAMILY_FACES_LIBRARY="/tmp/Hale Family Photos" uv run python -m family_faces.pipeline.cluster --only-unnamed
FAMILY_FACES_LIBRARY="/tmp/Hale Family Photos" uv run python -m family_faces.pipeline.map
FAMILY_FACES_LIBRARY="/tmp/Hale Family Photos" uv run python app.py --no-scan
```

Face fingerprints are random vectors around one point per person, so groups and suggestions behave like
the real thing without running the face models.
