"""Hide unlinked tag imports without removing their identities, tags, or names."""
from collections import defaultdict
from copy import deepcopy


def album_names(photos, faces, labels):
    source = {p['path'] for p in photos if p.get('source') == 'FamilySearch' or p.get('memory_id')}
    return {labels.get(str(f['id'])) for f in faces if f['photo'] not in source} - {None, '_ignore'}


def protected_names(identities, doc, photos, faces, labels):
    names = set(doc.get('people', {})) | album_names(photos, faces, labels)
    ids = {identities[n].get('familysearch_id') for n in names if n in identities} - {None, ''}
    # Keep an alternate source name if its Tree ID identifies a protected person.
    names.update(n for n, info in identities.items() if info.get('familysearch_id') in ids)
    keys = {n.strip().casefold() for n in names}
    names.update(n for n, info in identities.items()
                 if any(alias.strip().casefold() in keys for alias in info.get('aliases', [])))
    return names


def hidden_names(identities, doc, photos, faces, labels):
    marked = {n for n, info in identities.items() if info.get('hidden_tag_import')}
    if not marked:
        return set()
    return marked - protected_names(identities, doc, photos, faces, labels)


def hide_unlinked(identities, doc, photos, faces, labels, import_report, at):
    """Only the last tag-import cohort is eligible. Preserve all current data."""
    identities = deepcopy(identities)
    by_id, aliases = defaultdict(set), defaultdict(set)
    for name, info in identities.items():
        if info.get('familysearch_id'):
            by_id[info['familysearch_id']].add(name)
        for alias in info.get('aliases', []):
            aliases[alias.strip().casefold()].add(name)
    candidates = set()
    ambiguous = []
    for person in import_report.get('newPeople', []):
        if person.get('personId'):
            owners = by_id[person['personId']]
        else:
            owners = {person['name']} if person['name'] in identities else aliases[person['name'].strip().casefold()]
        if len(owners) == 1:
            candidates.update(owners)
        elif len(owners) > 1:
            ambiguous.append(person['name'])
    protected = protected_names(identities, doc, photos, faces, labels)
    hidden = sorted(candidates - protected)
    for name in hidden:
        identities[name]['hidden_tag_import'] = {
            'reason':'No saved family link on either side and no named album face',
            'import_run':import_report.get('runId'), 'hidden_at':at}
    report = {'at':at,'importRun':import_report.get('runId'),'hidden':hidden,
              'kept':sorted(candidates & protected),'ambiguous':ambiguous}
    return identities, report
