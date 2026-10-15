import tempfile
import unittest
from pathlib import Path

from PIL import Image

from family_faces.photo_gallery import gallery, thumbnail

PHOTOS = [{'path': 'both.jpg'}, {'path': 'mother.jpg'}, {'path': 'father.jpg'}, {'path': 'unknown.jpg'},
          {'path': 'source.jpg', 'source': 'FamilySearch'}]
FACES = [{'id': 0, 'photo': 'both.jpg'}, {'id': 1, 'photo': 'both.jpg'}, {'id': 2, 'photo': 'both.jpg'},
         {'id': 3, 'photo': 'mother.jpg'}, {'id': 4, 'photo': 'father.jpg'}, {'id': 5, 'photo': 'unknown.jpg'}]
NAMES = {'0': 'Mother', '1': 'Father', '2': 'Mother', '3': 'Mother', '4': 'Father', '5': '_ignore'}
ASSOCIATIONS = {'Mother': [{'path': 'source.jpg'}, {'path': 'source.jpg'}]}


class GalleryTests(unittest.TestCase):
    def result(self, **options): return gallery(PHOTOS, FACES, NAMES, ASSOCIATIONS, **options)

    def test_and_requires_every_person_and_or_accepts_either(self):
        self.assertEqual([p['path'] for p in self.result(selected=['Mother','Father'],mode='and')['photos']], ['both.jpg'])
        self.assertEqual([p['path'] for p in self.result(selected=['Mother','Father'],mode='or')['photos']],
                         ['both.jpg','mother.jpg','father.jpg','source.jpg'])

    def test_no_people_filter_keeps_unlabelled_photos(self):
        result = self.result()
        self.assertEqual(result['total'], 5)
        self.assertEqual(next(p for p in result['photos'] if p['path'] == 'unknown.jpg')['people'], [])
        self.assertNotIn('_ignore', result['people'])

    def test_repeated_faces_and_source_links_count_each_photo_once(self):
        result = self.result(selected=['Mother'])
        self.assertEqual(result['total'],3)
        self.assertEqual(result['people']['Mother'],3)
        self.assertEqual(result['photos'][0]['people'],['Father','Mother'])

    def test_source_filter_and_pagination_keep_matching_totals(self):
        self.assertEqual(self.result(source='album')['total'],4)
        self.assertEqual(self.result(source='familysearch')['total'],1)
        result = self.result(selected=['Mother'],offset=1,limit=1)
        self.assertEqual(result['total'],3)
        self.assertEqual(result['photos'][0]['path'],'mother.jpg')
        for options in [{'mode':'xor'},{'source':'wrong'},{'offset':-1},{'limit':0}]:
            with self.assertRaises(ValueError): self.result(**options)

    def test_unknown_person_does_not_match_or_bypass_and(self):
        self.assertEqual(self.result(selected=['Mother','Unknown'],mode='and')['total'],0)
        self.assertEqual(self.result(selected=['Unknown'],mode='or')['total'],0)

    def test_thumbnail_is_small_upright_cached_and_keeps_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); original=root/'photo.jpg'; cache=root/'cache'
            exif=Image.Exif(); exif[274]=6
            Image.new('RGB',(1600,1000),'white').save(original,exif=exif)
            before=original.read_bytes()
            result=thumbnail({'path':'photo.jpg'},root,cache)
            with Image.open(result) as image:
                self.assertEqual(image.size,(500,800)); self.assertEqual(image.getexif().get(274,1),1)
            self.assertEqual(thumbnail({'path':'photo.jpg'},root,cache),result)
            self.assertEqual(original.read_bytes(),before)


if __name__ == '__main__': unittest.main()
