import json
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from family_faces import serve
from family_faces.familysearch.scope import build_scope


class ReviewStateTest(unittest.TestCase):
    def test_source_clue_is_visible_without_assigning_a_face_name(self):
        labels = {'names': {}, 'rejected': []}
        photos = [{'path': 'source.jpg', 'source': 'FamilySearch', 'tags': [
            {'resolved': 'Old name', 'familysearch_id': 'TEST-001'}]}]
        identities = {'Confirmed name': {'familysearch_id': 'TEST-001'}}
        faces = [{'id': 0, 'photo': 'source.jpg'}, {'id': 1, 'photo': 'source.jpg'}]
        clusters = {'clusters': [{'id': 0, 'faces': [0, 1], 'sims': [1.0, 0.99],
                                 'photos': 1, 'captioned': 0, 'hints': []}], 'unclustered': []}
        with ExitStack() as stack:
            for name, value in [('faces', faces), ('clusters', clusters), ('labels', labels)]:
                stack.enter_context(patch.object(serve, name, value))
            stack.enter_context(patch.object(serve.library, 'photos', return_value=photos))
            stack.enter_context(patch.object(serve.people, 'load', return_value=identities))
            stack.enter_context(patch.object(serve.people, 'load_cached', return_value=identities))
            stack.enter_context(patch.object(serve.tree, 'load', return_value={'people': identities}))
            stack.enter_context(patch.object(serve, 'load_scope', return_value=build_scope(photos, identities, {})))
            stack.enter_context(patch.object(serve.matching_groups, 'get', return_value=(clusters, False, '')))
            state = serve.state()
            static = serve.static_data()
        self.assertEqual(state['total_faces'], 2)
        self.assertEqual(static['photo_sources']['source.jpg'], 'FamilySearch')
        self.assertEqual(state['album_faces'], 0)
        self.assertEqual(state['clusters'][0]['source_hints'],
                         [{'name': 'Confirmed name', 'familysearch_id': 'TEST-001', 'photos': 1}])
        self.assertEqual(labels['names'], {})
        json.dumps(state)

    def test_scope_removes_outside_faces_and_clues_without_removing_people(self):
        from test_familysearch_scope import PHOTOS, IDENTITIES, TREE, CONFIG
        scope = build_scope(PHOTOS, IDENTITIES, TREE, CONFIG)
        labels = {'names': {}, 'rejected': [3]}
        faces = [{'id': i, 'photo': p} for i, p in enumerate(
            ['album.jpg', 'shared.jpg', 'paternal.jpg', 'paternal.jpg'])]
        clusters = {'clusters': [{'id': 0, 'faces': [0, 1, 2], 'sims': [1., .9, .9],
                                 'photos': 3, 'captioned': 0, 'hints': []}], 'unclustered': [3]}
        with ExitStack() as stack:
            for name, value in [('faces', faces), ('clusters', clusters), ('labels', labels)]:
                stack.enter_context(patch.object(serve, name, value))
            stack.enter_context(patch.object(serve, 'load_scope', return_value=scope))
            stack.enter_context(patch.object(serve.matching_groups, 'get', return_value=(clusters, False, '')))
            stack.enter_context(patch.object(serve.library, 'photos', return_value=PHOTOS))
            stack.enter_context(patch.object(serve.people, 'load', return_value=IDENTITIES))
            stack.enter_context(patch.object(serve.people, 'load_cached', return_value=IDENTITIES))
            stack.enter_context(patch.object(serve.tree, 'load', return_value=TREE))
            state = serve.state()
        self.assertEqual(state['clusters'][0]['faces'], [0, 1])
        self.assertEqual(state['clusters'][0]['photos'], 2)
        self.assertEqual([h['name'] for h in state['clusters'][0]['source_hints']], ['Mother'])
        self.assertEqual(state['leftovers'], [])
        self.assertIn('Father', state['people'])
        self.assertEqual(state['familysearch_matching']['branch'], 'maternal')
        self.assertEqual(labels, {'names': {}, 'rejected': [3]})


if __name__ == '__main__':
    unittest.main()
