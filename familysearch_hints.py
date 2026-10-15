"""Person links on source photos are review clues, not face identities."""

from collections import Counter
import re


def photo_name_hints(photos, identities, allowed_names=None):
    by_id = {info.get('familysearch_id'): name for name, info in identities.items()
             if info.get('familysearch_id')}
    aliases = {}
    for owner, info in identities.items():
        for alias in info.get('aliases', []):
            aliases.setdefault(alias.strip().casefold(), set()).add(owner)
    out = {}
    for photo in photos:
        if photo.get('source') != 'FamilySearch':
            continue
        linked = {}
        for tag in photo.get('tags', []):
            name = by_id.get(tag.get('familysearch_id')) or tag.get('resolved')
            owners = aliases.get((name or '').strip().casefold(), set())
            if name not in identities and len(owners) == 1:
                name = next(iter(owners))
            if not name or name == '_ignore':
                continue
            if allowed_names is not None and name not in allowed_names:
                continue
            pid = identities.get(name, {}).get('familysearch_id') or tag.get('familysearch_id') or ''
            if not re.fullmatch(r'[A-Z0-9]{4}-[A-Z0-9]{3}', pid):
                pid = ''
            linked[name] = {'name': name, 'familysearch_id': pid}
        if linked:
            out[photo['path']] = list(linked.values())
    return out


def group_source_hints(ids, faces, photo_hints, limit=6):
    counts, people = Counter(), {}
    for path in {faces[fid]['photo'] for fid in ids}:
        for person in photo_hints.get(path, []):
            key = person['familysearch_id'] or person['name']
            counts[key] += 1
            people[key] = person
    keys = sorted(counts, key=lambda key: (-counts[key], people[key]['name'].casefold()))[:limit]
    return [dict(people[key], photos=counts[key]) for key in keys]
