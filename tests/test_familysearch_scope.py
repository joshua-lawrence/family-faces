import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from familysearch_scope import build_scope
from familysearch_hints import photo_name_hints
import serve
with patch.object(sys, 'argv', ['cluster.py']):
    cluster = importlib.import_module('cluster')


CONFIG = {'branch': 'maternal', 'root_id': 'ROOT-001', 'parent_id': 'MOMM-001'}
IDENTITIES = {n: {'familysearch_id': pid} for n, pid in [
    ('Root', 'ROOT-001'), ('Mother', 'MOMM-001'), ('Father', 'DADD-001'),
    ('Grandmother', 'GMOM-001'), ('Aunt', 'AUNT-001'), ('Cousin', 'COUS-001'),
    ('Uncle by marriage', 'UNCL-001'), ('Paternal grandfather', 'GDAD-001'),
    ('Uncle parent', 'UPAR-001')]}
TREE = {'people': dict.fromkeys(IDENTITIES, {}),
        'parents': [['Grandmother', 'Mother'], ['Grandmother', 'Aunt'],
                    ['Mother', 'Root'], ['Father', 'Root'], ['Aunt', 'Cousin'],
                    ['Paternal grandfather', 'Father'], ['Uncle parent', 'Uncle by marriage']],
        'partners': [['Mother', 'Father'], ['Aunt', 'Uncle by marriage']]}


def photo(path, *names):
    return {'path': path, 'source': 'FamilySearch', 'tags': [
        {'familysearch_id': IDENTITIES[n]['familysearch_id'], 'resolved': n} for n in names]}


PHOTOS = [photo('maternal.jpg', 'Grandmother'), photo('paternal.jpg', 'Father'),
          photo('shared.jpg', 'Mother', 'Father'), photo('uncle.jpg', 'Uncle by marriage'),
          photo('uncle-parent.jpg', 'Uncle parent'), {'path': 'album.jpg', 'source': ''}]


class MatchingScopeTest(unittest.TestCase):
    def test_paternal_all_and_off_modes_keep_native_photos(self):
        father = build_scope(PHOTOS, IDENTITIES, TREE, {**CONFIG, 'branch':'paternal'})
        self.assertEqual(father.names, {'Father','Paternal grandfather','Root'})
        self.assertEqual(father.allowed_paths, {'paternal.jpg','shared.jpg'})
        self.assertEqual(father.summary()['branch'], 'paternal')
        all_branches = build_scope(PHOTOS, IDENTITIES, TREE, {'branch':'all'})
        self.assertEqual(all_branches.allowed_paths, all_branches.source_paths)
        off = build_scope(PHOTOS, IDENTITIES, TREE, {'branch':'none'})
        self.assertFalse(off.allows_face({'photo':'maternal.jpg'}))
        self.assertFalse(off.allows_sample({'photo':'maternal.jpg'},'Grandmother'))
        self.assertTrue(off.allows_face({'photo':'album.jpg'}))

    def test_cousins_and_spouses_stay_without_crossing_into_other_ancestry(self):
        scope = build_scope(PHOTOS, IDENTITIES, TREE, CONFIG)
        self.assertEqual(scope.names, {'Root', 'Mother', 'Grandmother', 'Aunt',
                                      'Cousin', 'Uncle by marriage'})
        self.assertEqual(scope.allowed_paths, {'maternal.jpg', 'shared.jpg', 'uncle.jpg'})
        self.assertTrue(scope.allows_face({'photo': 'album.jpg'}))
        self.assertFalse(scope.allows_face({'photo': 'paternal.jpg'}))

    def test_shared_photo_only_suggests_maternal_names(self):
        scope = build_scope(PHOTOS, IDENTITIES, TREE, CONFIG)
        hints = photo_name_hints(PHOTOS, IDENTITIES, scope.names)
        self.assertEqual([h['name'] for h in hints['shared.jpg']], ['Mother'])
        self.assertNotIn('paternal.jpg', hints)
        self.assertFalse(scope.allows_sample({'photo': 'shared.jpg'}, 'Father'))

    def test_saved_ids_follow_a_renamed_mother(self):
        identities = dict(IDENTITIES)
        identities['Renamed mother'] = identities.pop('Mother')
        swap = lambda n: 'Renamed mother' if n == 'Mother' else n
        doc = {'people': identities, 'parents': [[swap(a), swap(b)] for a, b in TREE['parents']],
               'partners': [[swap(a), swap(b)] for a, b in TREE['partners']]}
        scope = build_scope(PHOTOS, identities, doc, CONFIG)
        self.assertEqual(scope.parent_name, 'Renamed mother')
        self.assertIn('shared.jpg', scope.allowed_paths)

    def test_missing_parent_stops_instead_of_matching_both_branches(self):
        with self.assertRaises(ValueError):
            build_scope(PHOTOS, IDENTITIES, TREE, {**CONFIG, 'parent_id': 'NONE-001'})

    def test_album_and_source_samples_both_follow_the_selected_branch(self):
        scope = build_scope(PHOTOS, IDENTITIES, TREE, CONFIG)
        faces = [{'id': i, 'photo': p} for i, p in enumerate(
            ['album.jpg', 'maternal.jpg', 'paternal.jpg', 'shared.jpg'])]
        labels = {'names': {'0': 'Father', '1': 'Grandmother', '2': 'Father', '3': 'Father'}}
        vectors = np.eye(4, dtype=np.float32)
        with patch.object(serve, 'faces', faces), patch.object(serve, 'labels', labels), \
             patch.object(serve, 'emb', vectors):
            names, starts, protos = serve.person_prototypes(scope)
        self.assertEqual(names, ['Grandmother'])
        np.testing.assert_array_equal(protos, vectors[[1]])
        father = build_scope(PHOTOS, IDENTITIES, TREE, {**CONFIG, 'branch': 'paternal'})
        with patch.object(serve, 'faces', faces), patch.object(serve, 'labels', labels), \
             patch.object(serve, 'emb', vectors):
            names, starts, protos = serve.person_prototypes(father)
        self.assertEqual(names, ['Father'])
        np.testing.assert_array_equal(protos, vectors[[0, 2, 3]])

    def test_branch_keeps_confirmed_aliases_but_not_ambiguous_aliases(self):
        identities = {n: dict(info) for n, info in IDENTITIES.items()}
        identities['Father']['aliases'] = ['Dad', 'Shared name']
        identities['Mother']['aliases'] = ['Mom', 'Shared name']
        father = build_scope(PHOTOS, identities, TREE, {**CONFIG, 'branch': 'paternal'})
        self.assertTrue(father.allows_sample({'photo': 'album.jpg'}, 'Dad'))
        self.assertTrue(father.allows_sample({'photo': 'paternal.jpg'}, 'dad'))
        self.assertFalse(father.allows_sample({'photo': 'album.jpg'}, 'Mom'))
        self.assertFalse(father.allows_sample({'photo': 'album.jpg'}, 'Shared name'))
        self.assertFalse(father.allows_sample({'photo': 'album.jpg'}, 'Person with no tree link'))

    def test_all_and_album_only_modes_keep_all_album_match_candidates(self):
        for branch in ['all', 'none']:
            scope = build_scope(PHOTOS, IDENTITIES, TREE, {'branch': branch})
            self.assertTrue(scope.allows_sample({'photo': 'album.jpg'}, 'Mother'))
            self.assertTrue(scope.allows_sample({'photo': 'album.jpg'}, 'Father'))
            self.assertTrue(scope.allows_sample({'photo': 'album.jpg'}, 'Person with no tree link'))
        self.assertFalse(scope.allows_sample({'photo': 'paternal.jpg'}, 'Father'))

    def test_excluded_source_cannot_bridge_album_faces_into_a_group(self):
        scope = build_scope(PHOTOS, IDENTITIES, TREE, CONFIG)
        faces = [{'id': i, 'photo': p, 'score': 0.99, 'size': 100} for i, p in enumerate(
            ['album.jpg', 'album.jpg', 'paternal.jpg'])]
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            (data / 'faces.json').write_text(json.dumps(faces))
            np.save(data / 'embeddings.npy', np.array([[1., 0.], [-1., 0.], [0., 1.]]))
            with patch.object(cluster, 'DATA', data), patch.object(cluster, 'load_scope', return_value=scope), \
                 patch.object(cluster.library, 'captions', return_value={}):
                cluster.build(threshold=1.1)
            result = json.loads((data / 'clusters.json').read_text())
        self.assertEqual(result['clusters'], [])
        self.assertEqual(result['unclustered'], [0, 1])


if __name__ == '__main__':
    unittest.main()


class UnconfiguredBranchTest(unittest.TestCase):
    def test_branch_without_a_root_matches_everyone(self):
        scope = build_scope([{'path': 'fs.jpg', 'source': 'FamilySearch'}], {}, {}, {'branch': 'maternal'})
        self.assertIsNone(scope.names)
        self.assertTrue(scope.allows_name('Anyone'))
