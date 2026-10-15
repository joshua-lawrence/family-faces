"""Turn the rendered mock photos into the app's data files (no face detection needed)."""
import hashlib, json, sys
from pathlib import Path
import numpy as np
from PIL import Image
LIB = Path(sys.argv[1] if len(sys.argv) > 1 else 'demo-library'); DATA = LIB / '.family-faces'
(DATA / 'thumbs').mkdir(parents=True, exist_ok=True)
m = json.load(open(LIB / 'manifest.json'))
NAMES = {'walter': 'Walter Hale', 'edith': 'Edith Hale', 'richard': 'Richard Hale', 'carol': 'Carol Hale', 'susan': 'Susan Ortiz',
         'daniel': 'Daniel Ortiz', 'peter': 'Peter Hale', 'emily': 'Emily Patel', 'sam': 'Sam Patel', 'jacob': 'Jacob Hale',
         'lucia': 'Lucia Ortiz', 'mateo': 'Mateo Ortiz', 'nora': 'Nora Patel'}
# Left unnamed so Review has work: Jacob in the unsorted scans (the app should suggest him), Aunt June, and strangers.
UNNAMED_PHOTOS = {'Unsorted/scan-0057.jpg', 'Unsorted/scan-0061.jpg', 'Unsorted/scan-0042.jpg'}
JACOB_UNNAMED = {'1990s/beach-1993.jpg', '1990s/christmas-1998.jpg', '2000s/cabin-2007.jpg'}
rng = np.random.default_rng(7)
ids = sorted({f['person'] for p in m for f in p['people']})
centre = {k: (v := rng.normal(size=512)) / np.linalg.norm(v) for k in ids}
faces, embs, names, photos = [], [], {}, []
for order, p in enumerate(m):
    im = Image.open(LIB / p['path']).convert('RGB')
    for f in p['people']:
        x1, y1, x2, y2 = f['box']; s = x2 - x1
        bbox = [x1 + .32 * s, y1 + .17 * s, x1 + .70 * s, y1 + .60 * s]
        fid = len(faces)
        size = round(bbox[3] - bbox[1])
        faces.append({'id': fid, 'photo': p['path'], 'bbox': [round(v, 1) for v in bbox], 'size': size, 'score': 0.86, 'img_w': im.width})
        e = centre[f['person']] + rng.normal(size=512) * 0.032
        embs.append(e / np.linalg.norm(e))
        cx, cy, h = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2, max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * .8
        im.crop((int(cx - h), int(cy - h), int(cx + h), int(cy + h))).resize((160, 160), Image.LANCZOS).save(DATA / 'thumbs' / f'{fid}.jpg', quality=88)
        jacob_left = f['person'] == 'jacob' and p['path'] in JACOB_UNNAMED
        if f['person'] in NAMES and p['path'] not in UNNAMED_PHOTOS and not jacob_left:
            names[str(fid)] = NAMES[f['person']]
    photos.append({'path': p['path'], 'sha256': hashlib.sha256((LIB / p['path']).read_bytes()).hexdigest(), 'batch': 'Hale family albums',
                   'order': order, 'caption': p['caption'], 'date': ''})
np.save(DATA / 'embeddings.npy', np.array(embs, dtype=np.float32))
(DATA / 'faces.json').write_text(json.dumps(faces))
(DATA / 'photos.json').write_text('[\n' + ',\n'.join(json.dumps(x) for x in photos) + '\n]\n')
(DATA / 'done.json').write_text(json.dumps([p['path'] for p in m]))
(DATA / 'labels.json').write_text(json.dumps({'names': names, 'rejected': []}, indent=1))
P = lambda born, died='', sex='': {'born': born, 'died': died, 'sex': sex}
tree = {'people': {'Walter Hale': P('1928', '2001', 'M'), 'Edith Hale': P('1931', '2015', 'F'), 'Richard Hale': P('1954', '', 'M'),
                   'Carol Hale': P('1956', '', 'F'), 'Susan Ortiz': P('1957', '', 'F'), 'Daniel Ortiz': P('1955', '', 'M'),
                   'Peter Hale': P('1961', '', 'M'), 'Emily Patel': P('1983', '', 'F'), 'Sam Patel': P('1982', '', 'M'),
                   'Jacob Hale': P('1986', '', 'M'), 'Lucia Ortiz': P('1985', '', 'F'), 'Mateo Ortiz': P('1989', '', 'M'),
                   'Nora Patel': P('2014', '', 'F')},
        'parents': [[par, c] for a, b, kids in [('Walter Hale', 'Edith Hale', ['Richard Hale', 'Susan Ortiz', 'Peter Hale']),
                                               ('Richard Hale', 'Carol Hale', ['Emily Patel', 'Jacob Hale']),
                                               ('Susan Ortiz', 'Daniel Ortiz', ['Lucia Ortiz', 'Mateo Ortiz']),
                                               ('Emily Patel', 'Sam Patel', ['Nora Patel'])] for c in kids for par in (a, b)],
        'partners': [['Edith Hale', 'Walter Hale'], ['Carol Hale', 'Richard Hale'], ['Daniel Ortiz', 'Susan Ortiz'], ['Emily Patel', 'Sam Patel']]}
(DATA / 'tree.json').write_text(json.dumps(tree, indent=1))
print(len(faces), 'faces,', len(names), 'named')
