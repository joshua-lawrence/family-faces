"""Photo sources and recorded family connections for the People list."""
from collections import defaultdict, deque


def photo_counts(person_photos, photos):
    sources = {p['path']: p.get('source') == 'FamilySearch' or bool(p.get('memory_id')) for p in photos}
    result = {}
    for name, paths in person_photos.items():
        unique = set(paths)
        fs = sum(sources.get(path, False) for path in unique)
        result[name] = {'total': len(unique), 'album': len(unique) - fs, 'familysearch': fs}
    return result


def default_root(doc, identities, config):
    matches = [name for name, info in identities.items()
               if config.get('root_id') and info.get('familysearch_id') == config['root_id']
               and name in doc.get('people', {})]
    return matches[0] if len(matches) == 1 else ''


def relations(doc, root, partners=True):
    members = doc.get('people', {})
    if root not in members:
        raise ValueError('Choose a person from the family tree.')
    graph = defaultdict(set)
    edges = list(doc.get('parents', []))
    if partners:
        edges += list(doc.get('partners', []))
    for a, b in edges:
        if a in members and b in members and a != b:
            graph[a].add(b)
            graph[b].add(a)
    distance = {root: 0}
    todo = deque([root])
    while todo:
        name = todo.popleft()
        for other in graph[name]:
            if other not in distance:
                distance[other] = distance[name] + 1
                todo.append(other)
    return {'root': root, 'partners': partners, 'distances': distance}
