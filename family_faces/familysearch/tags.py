"""Map explicit Memory tags to people and clear face boxes. No face recognition."""
from collections import defaultdict
from copy import deepcopy
import math
import re

PID = re.compile(r'^[A-Z0-9]{4}-[A-Z0-9]{3}$')


def key(name):
    return ' '.join((name or '').split()).casefold()


def full_name(name):
    words = key(name).split()
    unclear = re.search(r'\b(or|and|unknown|unidentified|family|children|cousins|possibly|maybe)\b|[?&;/]', key(name))
    return len(words) >= 2 and not unclear and words[0] not in {'unknown','unidentified','living','person','someone','mom','dad','grandma','grandpa','mother','father','aunt','uncle'}


def person_name(tag, identities, known_names, report):
    pid = (tag.get('personId') or '').strip().upper()
    name = ' '.join((tag.get('name') or '').split())[:500]
    if pid and not PID.fullmatch(pid):
        return None
    owners = [n for n, info in identities.items() if pid and info.get('familysearch_id', '').upper() == pid]
    if len(owners) == 1:
        resolved = owners[0]
    elif len(owners) > 1:
        matches = [n for n in owners if key(n) == key(name) or key(name) in {key(a) for a in identities[n].get('aliases', [])}]
        if len(matches) != 1:
            report['ambiguousIdentities'] += 1
            return None
        resolved = matches[0]
    elif pid:
        # An ID is the identity. Equal names with different IDs stay separate.
        exact = [n for n in known_names if full_name(name)
                 and (key(n) == key(name) or key(name) in {key(a) for a in identities.get(n, {}).get('aliases', [])})
                 and not identities.get(n, {}).get('familysearch_id')]
        if len(exact) != 1:
            exact = []
        resolved = exact[0] if len(exact) == 1 else name or f'FamilySearch person {pid}'
        if not exact and (resolved in known_names or resolved in identities or key(resolved) == '_ignore'):
            resolved = f'{resolved} ({pid})'
        suffix = 2
        base = resolved
        while not exact and resolved in identities:
            resolved = f'{base} {suffix}'; suffix += 1
        new = resolved not in known_names
        info = identities.setdefault(resolved, {})
        info['familysearch_id'] = pid
        profile = info.setdefault('familysearch', {})
        for field, value in {'id': pid, 'name': name, 'source_url': tag.get('personUrl') or
                            f'https://www.familysearch.org/en/tree/person/details/{pid}',
                            'match_reason': 'Explicit FamilySearch Memory tag'}.items():
            profile.setdefault(field, value)
        info.setdefault('aliases', [])
        known_names.add(resolved)
        if new:
            report['newPeople'].append({'name': resolved, 'personId': pid})
    else:
        # Unlinked names can be generic. Resolve only a unique saved name or alias.
        matches = {n for n in known_names if full_name(name) and key(n) == key(name)} if name else set()
        matches.update(n for n, info in identities.items() if name and key(name) in {key(a) for a in info.get('aliases', [])})
        if not matches and full_name(name):
            resolved = name
            identities[resolved] = {'aliases': [], 'familysearch_tag_name':name,
                'source':'Unlinked FamilySearch Memory tag'}
            known_names.add(resolved)
            report['newPeople'].append({'name':resolved,'personId':None})
        elif len(matches) == 1:
            resolved = next(iter(matches))
        else:
            report['unlinkedTags'] += 1
            return None
    info = identities.setdefault(resolved, {})
    if name and key(name) != key(resolved):
        aliases = info.setdefault('aliases', [])
        if key(name) not in {key(a) for a in aliases}:
            aliases.append(name)
    return resolved


def specific_regions(tag):
    out = []
    for r in tag.get('regions') or []:
        try:
            x, y, w, h = (float(r[k]) for k in ('x', 'y', 'width', 'height'))
        except (TypeError, ValueError, KeyError):
            continue
        if not all(math.isfinite(v) for v in (x,y,w,h)) or min(x,y) < 0 or min(w,h) <= 0 or x+w > 1.000001 or y+h > 1.000001:
            continue
        # Large regions are photo or group links, not individual face positions.
        if w*h <= .5:
            out.append([x,y,x+w,y+h])
    return out


def region_face(region, photo_faces, size):
    if not size:
        return None
    width, height = size
    enclosed, candidates = [], []
    x1,y1,x2,y2 = region
    area = (x2-x1)*(y2-y1)
    for face in photo_faces:
        if abs(face.get('img_w', width)-width) > 2:
            continue
        a,b,c,d = face['bbox']
        a,c,b,d = a/width,c/width,b/height,d/height
        face_area = max(0,c-a)*max(0,d-b)
        if face_area <= 0:
            continue
        overlap = max(0,min(c,x2)-max(a,x1))*max(0,min(d,y2)-max(b,y1))
        coverage = overlap/face_area
        if coverage >= .5:
            enclosed.append(face['id'])
        union = area+face_area-overlap
        if coverage >= .7 and union > 0 and overlap/union >= .25:
            candidates.append(face['id'])
    return candidates[0] if len(candidates) == 1 and len(enclosed) == 1 else None


def map_memories(photos, identities, labels, faces, memories, dimensions=None, known_names=()):
    """Return merged copies. Caller saves them under the live app label lock."""
    photos, identities, labels = deepcopy(photos), deepcopy(identities), deepcopy(labels)
    known_names = set(known_names) | set(identities) | (set(labels['names'].values()) - {'_ignore'})
    by_memory, by_photo = defaultdict(list), defaultdict(list)
    for p in photos:
        if p.get('source') == 'FamilySearch' or p.get('memory_id'):
            if p.get('memory_id'):
                by_memory[str(p['memory_id'])].append(p)
    for f in faces:
        by_photo[f['photo']].append(f)
    report = {'memories':0, 'photos':0, 'tags':0, 'mappedTags':0, 'unlinkedTags':0, 'ambiguousIdentities':0,
              'newPeople':[], 'newFaceLabels':[], 'manualFaceConflicts':[], 'ambiguousFaces':0}
    for memory in memories:
        mid = str(memory.get('memoryId', ''))
        items = by_memory.get(mid, [])
        if not items:
            continue
        report['memories'] += 1
        for photo in items:
            report['photos'] += 1
            proposals = defaultdict(list)
            tags = photo.setdefault('tags', [])
            for incoming in memory.get('people', []):
                report['tags'] += 1
                name = person_name(incoming, identities, known_names, report)
                if name:
                    report['mappedTags'] += 1
                tid = str(incoming.get('memoryPersonId') or '')
                pid = incoming.get('personId') or ''
                saved = next((t for t in tags if tid and t.get('memory_person_id') == tid), None)
                if saved is None and pid:
                    saved = next((t for t in tags if t.get('familysearch_id') == pid and not t.get('memory_person_id') and t.get('face') is None), None)
                if saved is None:
                    saved = {}; tags.append(saved)
                # Keep any previous manual tag-to-face link and record the source region separately.
                saved.update({'name':incoming.get('name') or '', 'familysearch_id':pid, 'resolved':name,
                    'memory_person_id':tid, 'memory_id':mid, 'source_url':f'https://www.familysearch.org/en/memories/memory/{mid}',
                    'tag_source':'FamilySearch MCP', 'regions':deepcopy(incoming.get('regions') or []),
                    'region_scope':incoming.get('regionScope'), 'tags_read_at':memory.get('readAt')})
                regions = specific_regions(incoming)
                if not saved.get('box') and len(regions) == 1:
                    saved['box'] = regions[0]; saved['box_units'] = 'fraction'
                matched = set()
                for region in regions:
                    fid = region_face(region, by_photo[photo['path']], (dimensions or {}).get(photo['path']))
                    if fid is not None:
                        matched.add(fid)
                    else:
                        report['ambiguousFaces'] += 1
                if name:
                    for fid in matched:
                        proposals[fid].append((name, saved))
            for fid, proposals_for_face in proposals.items():
                names = {n for n,_ in proposals_for_face}
                if len(names) != 1:
                    report['ambiguousFaces'] += 1
                    continue
                name = next(iter(names))
                current = labels['names'].get(str(fid))
                if current and current != name:
                    report['manualFaceConflicts'].append({'face':fid, 'existing':current, 'tagged':name, 'photo':photo['path']})
                    continue
                if not current:
                    labels['names'][str(fid)] = name
                    labels.setdefault('sources', {})[str(fid)] = 'FamilySearch tag'
                    labels.setdefault('familysearch_tags', {})[str(fid)] = {'memory_id':mid,
                        'memory_person_id':proposals_for_face[0][1]['memory_person_id'],
                        'person_id':proposals_for_face[0][1]['familysearch_id'], 'read_at':memory.get('readAt')}
                    report['newFaceLabels'].append({'face':fid, 'name':name, 'photo':photo['path']})
                for _, tag in proposals_for_face:
                    linked = set(tag.get('faces') or []) | {fid}
                    if tag.get('face') is not None:
                        linked.add(tag['face'])
                    tag['faces'] = sorted(linked)
                    if len(linked) == 1 and tag.get('face') is None:
                        tag['face'] = fid
            photo['familysearch_tags_read_at'] = memory.get('readAt')
            photo['familysearch_tag_count'] = len(memory.get('people', []))
    return photos, identities, labels, report


def unique_people_by_id(identities):
    owners = defaultdict(list)
    for name, info in identities.items():
        if info.get('familysearch_id'):
            owners[info['familysearch_id']].append(name)
    return {pid:names[0] for pid,names in owners.items() if len(names) == 1}
