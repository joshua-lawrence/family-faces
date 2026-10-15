import unittest

from people_filters import default_root, photo_counts, relations


class PeopleFilterTests(unittest.TestCase):
    def setUp(self):
        self.doc = {'people': {n: {} for n in ['Me', 'Mom', 'Dad', 'Sister', 'Grandma', 'Aunt', 'Cousin', 'Partner', 'Unknown']},
                    'parents': [['Mom', 'Me'], ['Dad', 'Me'], ['Mom', 'Sister'], ['Grandma', 'Mom'],
                                ['Grandma', 'Aunt'], ['Aunt', 'Cousin'], ['Missing', 'Unknown']],
                    'partners': [['Me', 'Partner'], ['Mom', 'Dad']]}

    def test_shortest_family_connections(self):
        d = relations(self.doc, 'Me')['distances']
        self.assertEqual({n: d[n] for n in ['Me', 'Mom', 'Sister', 'Grandma', 'Cousin', 'Partner']},
                         {'Me': 0, 'Mom': 1, 'Sister': 2, 'Grandma': 2, 'Cousin': 4, 'Partner': 1})
        self.assertNotIn('Unknown', d)

    def test_parent_child_only_and_new_root(self):
        d = relations(self.doc, 'Cousin', False)['distances']
        self.assertEqual(d['Me'], 4)
        self.assertNotIn('Partner', d)

    def test_missing_root_is_not_unrelated(self):
        with self.assertRaisesRegex(ValueError, 'Choose a person'):
            relations(self.doc, 'Missing')

    def test_source_counts_use_registry_and_unique_photos(self):
        photos = [{'path': 'a'}, {'path': 'b', 'source': 'FamilySearch'}, {'path': 'c', 'memory_id': '123'}]
        counts = photo_counts({'Mixed': ['a', 'a', 'b'], 'Only FS': ['b', 'c'], 'None': []}, photos)
        self.assertEqual(counts['Mixed'], {'total': 2, 'album': 1, 'familysearch': 1})
        self.assertEqual(counts['Only FS'], {'total': 2, 'album': 0, 'familysearch': 2})
        self.assertEqual(counts['None'], {'total': 0, 'album': 0, 'familysearch': 0})

    def test_root_uses_unique_saved_id_and_current_name(self):
        identities = {'Me': {'familysearch_id': 'ABC-1234'}}
        self.assertEqual(default_root(self.doc, identities, {'root_id': 'ABC-1234'}), 'Me')
        self.assertEqual(default_root(self.doc, {**identities, 'Mom': identities['Me']}, {'root_id': 'ABC-1234'}), '')
        self.assertEqual(default_root(self.doc, identities, {}), '')


if __name__ == '__main__':
    unittest.main()
