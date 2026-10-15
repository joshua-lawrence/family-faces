"""Likely unnamed faces for one person, without changing existing names."""
import math
import numpy as np


def rank_matches(faces, vectors, names, samples, linked_photos, rejected, scope,
                 source='album', minimum=.4, candidates=None):
    if not samples:
        return []
    ids = [i for i in (candidates if candidates is not None else range(min(len(faces), len(vectors))))
           if str(i) not in names and i not in rejected and faces[i]['photo'] not in linked_photos
           and scope.allows_face(faces[i])
           and (source == 'all' or (faces[i]['photo'] in scope.source_paths) == (source == 'familysearch'))]
    best = {}
    refs = vectors[samples]
    for start in range(0, len(ids), 2048):
        chunk = ids[start:start + 2048]
        scores = (vectors[chunk] @ refs.T).max(axis=1)
        for i, score in zip(chunk, scores):
            score = float(score)
            if not math.isfinite(score) or score < minimum:
                continue
            item = {'face': i, 'photo': faces[i]['photo'], 'sim': min(1., score),
                    'source': 'FamilySearch' if faces[i]['photo'] in scope.source_paths else 'Album'}
            prior = best.get(item['photo'])
            if prior is None or (-item['sim'], i) < (-prior['sim'], prior['face']):
                best[item['photo']] = item
    return sorted(best.values(), key=lambda row: (-row['sim'], row['photo'], row['face']))


class PersonMatches:
    def __init__(self, app):
        self.app = app

    def options(self, body):
        name = body.get('name', '')
        if not isinstance(name, str) or not name.strip() or name.startswith('_') or len(name) > 200:
            raise ValueError('Choose a person to match.')
        source, branch = body.get('source', 'album'), body.get('branch', 'maternal')
        if source not in {'album', 'familysearch', 'all'} or branch not in {'maternal', 'paternal', 'all', 'none'}:
            raise ValueError('Choose a valid photo source and family branch.')
        minimum = float(body.get('minimum', .4))
        if not math.isfinite(minimum) or not 0 <= minimum <= 1:
            raise ValueError('Choose a match score from 0 to 100%.')
        return name.strip(), source, self.app.load_scope(branch), minimum

    def inputs(self, name, scope):
        app = self.app
        names = dict(app.labels['names'])
        samples = [int(i) for i, n in names.items() if n == name and int(i) < min(len(app.faces), len(app.emb))
                   and (app.faces[int(i)]['photo'] not in scope.source_paths or scope.allows_sample(app.faces[int(i)], name))]
        linked = {app.faces[int(i)]['photo'] for i, n in names.items() if n == name and int(i) < len(app.faces)}
        linked.update(p['path'] for p in app.source_photos_by_person().get(name, []))
        return names, app.sample_faces(samples), linked

    def rejected(self, name):
        with self.app.suggestions.lock:
            return {i for i, n in self.app.suggestions.rejected if n == name}

    def view(self, query):
        name, source, scope, minimum = self.options(query)
        offset, limit = max(0, int(query.get('offset', 0))), max(1, min(100, int(query.get('limit', 12))))
        rejected = self.rejected(name)
        with self.app.lock:
            names, samples, linked = self.inputs(name, scope)
            faces, vectors, captions = self.app.faces, self.app.emb, dict(self.app.captions)
        items = rank_matches(faces, vectors, names, samples, linked, rejected, scope, source, minimum)
        page = [dict(row, caption=captions.get(row['photo'], '')) for row in items[offset:offset + limit]]
        return {'name': name, 'items': page, 'total': len(items), 'offset': offset,
                'hasReference': bool(samples), 'branch': scope.branch}

    def accept(self, body):
        name, source, scope, minimum = self.options(body)
        ids = body.get('faces')
        if not isinstance(ids, list) or not ids or len(ids) > 100 or any(type(i) is not int for i in ids):
            raise ValueError('Select 1 to 100 faces to add.')
        ids = list(dict.fromkeys(ids))
        rejected = self.rejected(name)
        app = self.app
        with app.lock:
            if any(i < 0 or i >= min(len(app.faces), len(app.emb)) for i in ids):
                raise ValueError('The face is no longer available. Check the matches again.')
            names, samples, linked = self.inputs(name, scope)
            valid = rank_matches(app.faces, app.emb, names, samples, linked, rejected, scope, source, minimum, ids)
            if {r['face'] for r in valid} != set(ids):
                raise app.Conflict('These matches changed or a photo is already linked. Check the matches again.')
            for i in ids:
                app.labels['names'][str(i)] = name
                app.labels.get('sources', {}).pop(str(i), None)
            app.save()
            app.describe(f'Added {len(ids)} likely match' + ('' if len(ids) == 1 else 'es') + f' to {name}')
            app.journal_note(faces=ids)
        return {'named': ids}


def register(routes, app):
    matches = PersonMatches(app)
    routes['GET']['/api/people/likely'] = matches.view
    routes['POST']['/api/people/likely/accept'] = matches.accept
