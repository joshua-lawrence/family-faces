import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from familysearch_hints import photo_name_hints, group_source_hints


class SourceHintsTest(unittest.TestCase):
    def test_source_id_follows_saved_rename(self):
        photos = [{'path': 'a.jpg', 'source': 'FamilySearch', 'tags': [
            {'resolved': 'Old name', 'familysearch_id': 'TEST-001'}]}]
        identities = {'New name': {'familysearch_id': 'TEST-001'}}
        self.assertEqual(photo_name_hints(photos, identities)['a.jpg'],
                         [{'name': 'New name', 'familysearch_id': 'TEST-001'}])

    def test_count_photos_instead_of_faces(self):
        faces = [{'photo': 'a.jpg'}, {'photo': 'a.jpg'}, {'photo': 'b.jpg'}]
        hints = {'a.jpg': [{'name': 'A', 'familysearch_id': 'TEST-001'}],
                 'b.jpg': [{'name': 'A', 'familysearch_id': 'TEST-001'}]}
        self.assertEqual(group_source_hints([0, 1, 2], faces, hints)[0]['photos'], 2)

    def test_unlinked_source_name_does_not_assign_a_person(self):
        photos = [{'path': 'a.jpg', 'source': 'FamilySearch', 'tags': [{'name': 'Unknown'}]}]
        self.assertEqual(photo_name_hints(photos, {}), {})

    def test_existing_alias_is_resolved(self):
        photos = [{'path': 'a.jpg', 'source': 'FamilySearch', 'tags': [{'resolved': 'Old name'}]}]
        identities = {'New name': {'aliases': ['Old name'], 'familysearch_id': 'TEST-001'}}
        self.assertEqual(photo_name_hints(photos, identities)['a.jpg'][0]['name'], 'New name')

    def test_other_photo_sources_are_left_out(self):
        photos = [{'path': 'a.jpg', 'source': 'Local', 'tags': [{'resolved': 'A'}]}]
        self.assertEqual(photo_name_hints(photos, {}), {})

    def test_record_ids_are_validated(self):
        photos = [{'path': 'a.jpg', 'source': 'FamilySearch', 'tags': [
            {'resolved': 'A', 'familysearch_id': 'not-a-person-id'}]}]
        self.assertEqual(photo_name_hints(photos, {})['a.jpg'][0]['familysearch_id'], '')


if __name__ == '__main__':
    unittest.main()
