"""Limit source references by tree relationships, without changing saved identities."""

from collections import defaultdict
from dataclasses import dataclass
import json
from pathlib import Path

from family_faces.familysearch.hints import photo_name_hints
from family_faces import config

PATH = config.DATA / 'familysearch-matching.json'
BRANCHES = {'maternal', 'paternal', 'all', 'none'}


@dataclass(frozen=True)
class MatchingScope:
    names: frozenset | None
    source_paths: frozenset
    allowed_paths: frozenset
    parent_name: str = ''
    branch: str = 'all'
    aliases: frozenset = frozenset()

    def allows_face(self, face):
        return (self.names is None or face['photo'] not in self.source_paths
                or face['photo'] in self.allowed_paths)

    def allows_name(self, name):
        return (self.branch not in {'maternal', 'paternal'}
                or name in (self.names or ()) or name.strip().casefold() in self.aliases)

    def allows_sample(self, face, name):
        if not self.allows_name(name):
            return False
        if self.names is None or face['photo'] not in self.source_paths:
            return True
        return (face['photo'] in self.allowed_paths
                and (name in self.names or name.strip().casefold() in self.aliases))

    def summary(self):
        return {'branch': self.branch,
                'parent_name': self.parent_name, 'people': len(self.names or ()),
                'photos': len(self.allowed_paths),
                'excluded_photos': len(self.source_paths - self.allowed_paths)}


def _walk(seeds, edges):
    seen, todo = set(seeds), list(seeds)
    while todo:
        for name in edges.get(todo.pop(), ()):
            if name not in seen:
                seen.add(name)
                todo.append(name)
    return seen


def build_scope(photos, identities, doc, config=None):
    source_paths = frozenset(p['path'] for p in photos if p.get('source') == 'FamilySearch')
    if not config or config.get('branch') == 'all':
        return MatchingScope(None, source_paths, source_paths)
    if config.get('branch') in {'maternal', 'paternal'} and not config.get('root_id'):
        # No family branch has been set up (a new library): match against everyone.
        return MatchingScope(None, source_paths, source_paths)
    if config.get('branch') == 'none':
        return MatchingScope(frozenset(), source_paths, frozenset(), branch='none')
    if config.get('branch') not in BRANCHES:
        raise ValueError('Unsupported FamilySearch matching branch')

    def person(pid):
        found = [n for n, info in identities.items() if info.get('familysearch_id') == pid]
        if len(found) != 1 or found[0] not in doc.get('people', {}):
            raise ValueError('The FamilySearch matching root or parent is missing or ambiguous')
        return found[0]

    root = person(config['root_id'])
    parents, children = defaultdict(set), defaultdict(set)
    for parent, child in doc.get('parents', []):
        parents[child].add(parent)
        children[parent].add(child)
    branch = config['branch']
    selected_id = config.get('father_id') if branch == 'paternal' else config.get('mother_id', config.get('parent_id'))
    if not selected_id and branch == 'paternal':
        mother = person(config.get('mother_id', config.get('parent_id')))
        other = parents[root] - {mother}
        if len(other) != 1:
            raise ValueError('The father branch is missing or ambiguous')
        parent = next(iter(other))
    else:
        parent = person(selected_id)
    if parent not in parents[root]:
        raise ValueError('The selected FamilySearch branch is not a parent of the root')
    ancestors = _walk([parent], parents)
    blood = _walk(ancestors, children)
    members = set(blood)
    # Add relatives' spouses once. Do not ascend into a spouse's own ancestry.
    for a, b in doc.get('partners', []):
        if a in blood:
            members.add(b)
        if b in blood:
            members.add(a)
    # The other parent must not open a separate branch. Shared descendants stay.
    other_ancestors = _walk(parents[root] - {parent}, parents)
    members -= _walk(other_ancestors, children) - blood
    owners = defaultdict(set)
    for name in set(doc.get('people', {})) | set(identities):
        for alias in [name, *identities.get(name, {}).get('aliases', [])]:
            owners[alias.strip().casefold()].add(name)
    aliases = frozenset(alias for alias, names in owners.items()
                        if len(names) == 1 and names <= members)
    hints = photo_name_hints(photos, identities, allowed_names=members)
    return MatchingScope(frozenset(members), source_paths, frozenset(hints), parent, branch, aliases)


_scopes = {}


def _stamp(path):
    try:
        st = Path(path).stat()
        return (st.st_mtime_ns, st.st_size)
    except FileNotFoundError:
        return None


def load_scope(branch=None):
    """The matching scope for a branch (None: the saved setting). Built once per version of its inputs."""
    from family_faces import library
    from family_faces import people
    from family_faces import tree
    key = (branch, _stamp(PATH), _stamp(library.PATH), id(library.photos()), people.stamp(), _stamp(tree.PATH))
    hit = _scopes.get(branch)
    if hit and hit[0] == key:
        return hit[1]
    scope = _build_scope(branch)
    _scopes[branch] = (key, scope)
    return scope


def _build_scope(branch):
    from family_faces import library
    from family_faces import people
    from family_faces import tree
    config = json.loads(PATH.read_text()) if PATH.exists() else None
    if branch is not None:
        if branch not in BRANCHES:
            raise ValueError('Unsupported FamilySearch matching branch')
        config = {**(config or {}), 'branch': branch}
    return build_scope(library.photos(), people.load_cached(), tree.load(), config)
