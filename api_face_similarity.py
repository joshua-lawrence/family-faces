"""Compare saved, named faces within adjustable estimated-age ranges."""
import json
import math
from collections import defaultdict

import numpy as np


def integer(query, key, default, low, high):
    try:
        value = int(query.get(key, default))
    except (TypeError, ValueError):
        raise ValueError('Choose a whole number for the age range and result filters.') from None
    if not low <= value <= high:
        raise ValueError(f'{key.replace("_", " ").capitalize()} must be from {low} to {high}.')
    return value


def options(query):
    name = query.get('name', '')
    candidate = query.get('candidate', '')
    if not isinstance(name, str) or not name.strip() or name.startswith('_') or len(name) > 200:
        raise ValueError('Choose a person with named faces.')
    if not isinstance(candidate, str) or len(candidate) > 200 or candidate.startswith('_'):
        raise ValueError('Choose a comparison person or leave Compare with empty.')
    source, branch, quality = query.get('source', 'album'), query.get('branch', 'maternal'), query.get('quality', 'clear')
    if source not in {'album', 'familysearch', 'all'} or branch not in {'maternal', 'paternal', 'all', 'none'} or quality not in {'clear', 'all'}:
        raise ValueError('Choose a valid photo source, branch, and face quality.')
    ranges = {key: integer(query, key, default, 0, 120) for key, default in
              [('age_min', 0), ('age_max', 9), ('reference_min', 0), ('reference_max', 120)]}
    if ranges['age_min'] > ranges['age_max'] or ranges['reference_min'] > ranges['reference_max']:
        raise ValueError('The first age must be less than or equal to the last age.')
    return dict(name=name.strip(), candidate=candidate.strip(), source=source, branch=branch, quality=quality,
                minimum_faces=integer(query, 'minimum_faces', 1, 1, 100),
                minimum_score=integer(query, 'minimum_score', 0, 0, 100) / 100,
                offset=integer(query, 'offset', 0, 0, 100000), limit=integer(query, 'limit', 12, 1, 60),
                include_hidden=str(query.get('include_hidden', '0')) == '1', **ranges)


def unit(vector):
    length = float(np.linalg.norm(vector))
    return vector / length if math.isfinite(length) and length > 1e-8 else None


def compare(faces, vectors, names, attrs, scope, settings, good, hidden=frozenset()):
    groups = defaultdict(list)
    missing = defaultdict(int)
    n = min(len(faces), len(vectors))
    for key, name in names.items():
        if not isinstance(name, str) or name.startswith('_'):
            continue
        try:
            fid = int(key)
        except (TypeError, ValueError):
            continue
        if not 0 <= fid < n:
            continue
        face = faces[fid]
        is_source = face['photo'] in scope.source_paths
        if settings['source'] != 'all' and is_source != (settings['source'] == 'familysearch'):
            continue
        if is_source and not scope.allows_sample(face, name):
            continue
        if name != settings['name'] and name in hidden and not settings['include_hidden']:
            continue
        a = attrs.get(fid, {})
        age = a.get('age')
        if isinstance(age, bool) or not isinstance(age, (int, float)) or not math.isfinite(age) or not 0 <= age <= 120 or a.get('age_pending'):
            missing[name] += 1
            continue
        if settings['quality'] == 'clear' and not good(fid, faces):
            continue
        low, high = (settings['reference_min'], settings['reference_max']) if name == settings['name'] else (settings['age_min'], settings['age_max'])
        if low <= age < high + 1 and np.isfinite(vectors[fid]).all() and np.linalg.norm(vectors[fid]) > 1e-8:
            groups[name].append(fid)

    def selected(ids):
        # One crop per photo prevents repeated detections from weighting one photo twice.
        per_photo = {}
        for fid in sorted(ids, key=lambda i: (-float(attrs[i].get('sharp', 0)), i)):
            per_photo.setdefault(faces[fid]['photo'], fid)
        return list(per_photo.values())[:150]

    refs = selected(groups.get(settings['name'], []))
    average = unit(vectors[refs].mean(axis=0)) if refs else None

    def samples(ids):
        return [{'id': i, 'age': round(float(attrs[i]['age']), 1), 'photo': faces[i]['photo'],
                 'source': 'FamilySearch' if faces[i]['photo'] in scope.source_paths else 'Album'} for i in ids[:4]]

    reference = {'name': settings['name'], 'faces': len(refs), 'samples': samples(refs),
                 'missingAge': missing.get(settings['name'], 0)}
    if average is None:
        return {'reference': reference, 'items': [], 'total': 0, 'offset': settings['offset'], 'hasReference': False}
    rows = []
    for name, ids in groups.items():
        if name == settings['name'] or (settings['candidate'] and name != settings['candidate']):
            continue
        ids = selected(ids)
        if len(ids) < settings['minimum_faces']:
            continue
        other = unit(vectors[ids].mean(axis=0))
        if other is None:
            continue
        score = float(np.clip(average @ other, -1, 1))
        if score < settings['minimum_score']:
            continue
        rows.append({'name': name, 'similarity': round(score, 5), 'faces': len(ids), 'samples': samples(ids)})
    rows.sort(key=lambda row: (-row['similarity'], row['name'].casefold(), row['name']))
    offset = settings['offset']
    return {'reference': reference, 'items': rows[offset:offset + settings['limit']], 'total': len(rows),
            'offset': offset, 'hasReference': True}


class FaceSimilarity:
    def __init__(self, app):
        self.app = app
        self.age_stamp = None
        self.age_data = {}

    def view(self, query):
        settings = options(query)
        app = self.app
        scope = app.load_scope(settings['branch'])
        with app.lock:
            path = app.DATA / 'attrs.json'
            stamp = path.stat().st_mtime_ns if path.exists() else None
            if stamp != self.age_stamp:
                try:
                    self.age_data = {int(k): v for k, v in json.loads(path.read_text()).items()} if stamp else {}
                except json.JSONDecodeError:
                    raise ValueError('The age data is being updated. Wait for portrait generation to finish, then try again.') from None
                self.age_stamp = stamp
            attrs = self.age_data
            names, faces, vectors = dict(app.labels['names']), app.faces, app.emb
            hidden = app.hidden_import_people()
        def good(fid, records):
            a, f = attrs.get(fid, {}), records[fid]
            return (a.get('frontal', False) and f.get('size', 0) >= 60 and f.get('score', 0) >= .7
                    and a.get('sharp', 0) >= 12 and 60 <= a.get('bright', 0) <= 205 and a.get('contrast', 0) >= 25)
        result = compare(faces, vectors, names, attrs, scope, settings, good, hidden)
        return dict(result, settings=settings)


def register(routes, app):
    routes['GET']['/api/face-similarity'] = FaceSimilarity(app).view
