import hashlib
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from family_faces.familysearch.upload import Uploads, face_rectangle


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / '_faces'; self.data.mkdir()
        self.photo = self.root / 'album.jpg'
        Image.new('RGB', (200, 100), 'white').save(self.photo)
        self.snapshot = {'photo': {'path': 'album.jpg'},
            'faces': [{'id': 1, 'name': 'Ancestor', 'bbox': [20, 10, 60, 50], 'img_w': 200},
                      {'id': 2, 'name': None, 'bbox': [100, 10, 160, 50], 'img_w': 200}],
            'identities': {'Ancestor': {'familysearch_id': 'ABCD-123'}}}
        self.body = {'faces': [{'faceId': 1, 'personId': 'ABCD-123'}], 'title': 'Album photo'}
        self.calls = []
        def mcp(payload):
            self.calls.append(payload)
            if payload['dryRun'] and payload.get('action') == 'tag-memory':
                return {'status': 'ready', 'dryRun': True, 'planHash': 'a'*64, 'people': payload['people']}
            if payload['dryRun']:
                return {'status': 'ready', 'dryRun': True,
                        'sha256': hashlib.sha256(Path(payload['filePath']).read_bytes()).hexdigest(),
                        'people': payload['people']}
            return {'status': 'uploaded', 'tagsApplied': True, 'memoryUrl': 'https://www.familysearch.org/en/memories/memory/123'}
        self.uploads = Uploads(self.root, self.data, mcp)

    def test_preview_is_read_only_and_converts_face_pixels(self):
        preview = self.uploads.preview(self.body, self.snapshot)
        self.assertTrue(preview['dryRun'])
        self.assertEqual(self.calls[0]['people'][0]['rectangle'], {'x': .1, 'y': .1, 'width': .2, 'height': .4})
        self.assertFalse(self.uploads.path.exists())

    def test_confirmation_uses_saved_plan_and_blocks_duplicate_photo(self):
        preview = self.uploads.preview(self.body, self.snapshot)
        result = self.uploads.confirm(preview['previewToken'], self.snapshot)
        self.assertEqual(result['status'], 'uploaded')
        self.assertEqual(len(self.calls), 2)
        self.assertFalse(self.calls[-1]['dryRun'])
        self.assertEqual(self.uploads.preview(self.body, self.snapshot)['status'], 'existing')
        self.assertEqual(len(self.calls), 2)
        with self.assertRaises(ValueError):
            self.uploads.confirm(preview['previewToken'], self.snapshot)

    def test_changed_face_labels_or_file_stop_before_upload(self):
        preview = self.uploads.preview(self.body, self.snapshot)
        self.snapshot['faces'][0]['name'] = 'Other person'
        with self.assertRaisesRegex(ValueError, 'labels or person links changed'):
            self.uploads.confirm(preview['previewToken'], self.snapshot)
        self.snapshot['faces'][0]['name'] = 'Ancestor'
        Image.new('RGB', (200, 100), 'black').save(self.photo)
        with self.assertRaisesRegex(ValueError, 'photo changed'):
            self.uploads.confirm(preview['previewToken'], self.snapshot)
        self.assertEqual(len(self.calls), 1)

    def test_partial_result_keeps_memory_record_and_blocks_reupload(self):
        preview = self.uploads.preview(self.body, self.snapshot)
        normal_mcp = self.uploads.mcp
        self.uploads.mcp = lambda p: {'status': 'partial', 'memoryId': '123', 'tagsApplied': False, 'title': 'Saved upload title'}
        self.assertEqual(self.uploads.confirm(preview['previewToken'], self.snapshot)['status'], 'partial')
        self.uploads.mcp = normal_mcp
        repair = self.uploads.preview(self.body, self.snapshot)
        self.assertEqual(repair['uploadAction'], 'tag-memory')
        self.assertEqual(self.calls[-1]['memoryId'], '123')
        self.uploads.confirm(repair['previewToken'], self.snapshot)
        self.assertEqual(self.calls[-1]['action'], 'tag-memory')
        self.assertNotIn('filePath', self.calls[-1])
        self.assertEqual(self.calls[-1]['expectedPlanHash'], 'a'*64)
        self.assertEqual(next(iter(self.uploads.journal().values()))['result']['title'], 'Saved upload title')

    def test_bulk_previews_keep_each_photo_plan_and_recheck_current_labels(self):
        import copy
        second = self.root / 'second.jpg'
        Image.new('RGB', (200, 100), 'black').save(second)
        other = copy.deepcopy(self.snapshot); other['photo']['path'] = 'second.jpg'
        first_plan = self.uploads.preview(self.body, self.snapshot)
        second_plan = self.uploads.preview(self.body, other)
        self.uploads.confirm(first_plan['previewToken'], self.snapshot)
        other['faces'][0]['name'] = 'New label'
        with self.assertRaisesRegex(ValueError, 'labels or person links changed'):
            self.uploads.confirm(second_plan['previewToken'], other)
        self.assertEqual(sum(not p['dryRun'] for p in self.calls), 1)

    def test_expired_bulk_plan_sends_no_upload(self):
        preview = self.uploads.preview(self.body, self.snapshot)
        self.uploads.previews[preview['previewToken']]['expires'] = 0
        with self.assertRaisesRegex(ValueError, 'preview expired'):
            self.uploads.confirm(preview['previewToken'], self.snapshot)
        self.assertTrue(all(p['dryRun'] for p in self.calls))

    def test_duplicate_source_in_two_previews_is_sent_once(self):
        first = self.uploads.preview(self.body, self.snapshot)
        second = self.uploads.preview(self.body, self.snapshot)
        self.uploads.confirm(first['previewToken'], self.snapshot)
        self.assertEqual(self.uploads.confirm(second['previewToken'], self.snapshot)['status'], 'existing')
        self.assertEqual(sum(not p['dryRun'] for p in self.calls), 1)

    def test_same_pixels_with_different_metadata_are_blocked_after_restart(self):
        import copy
        from PIL.PngImagePlugin import PngInfo
        original = self.root / 'first.png'
        Image.new('RGB',(200,100),'red').save(original)
        self.snapshot['photo']['path'] = 'first.png'
        first = self.uploads.preview(self.body,self.snapshot)
        self.uploads.confirm(first['previewToken'],self.snapshot)
        metadata=PngInfo(); metadata.add_text('Comment','Different metadata')
        other=self.root/'second.png'; Image.new('RGB',(200,100),'red').save(other,pnginfo=metadata)
        self.assertNotEqual(original.read_bytes(),other.read_bytes())
        snapshot=copy.deepcopy(self.snapshot);snapshot['photo']['path']='second.png'
        reloaded=Uploads(self.root,self.data,self.uploads.mcp)
        self.assertEqual(reloaded.preview(self.body,snapshot)['status'],'existing')
        self.assertEqual(sum(not p['dryRun'] for p in self.calls),1)

    def test_two_copy_previews_and_legacy_journal_are_blocked(self):
        import copy
        other=self.root/'copy.png'
        Image.open(self.photo).save(other)
        snapshot=copy.deepcopy(self.snapshot); snapshot['photo']['path']='copy.png'
        first=self.uploads.preview(self.body,self.snapshot)
        second=self.uploads.preview(self.body,snapshot)
        self.uploads.confirm(first['previewToken'],self.snapshot)
        self.assertEqual(self.uploads.confirm(second['previewToken'],snapshot)['status'],'existing')
        journal=self.uploads.journal()
        for record in journal.values(): record.pop('image_sha',None)
        self.uploads.write_journal(journal)
        reloaded=Uploads(self.root,self.data,self.uploads.mcp)
        self.assertEqual(reloaded.preview(self.body,snapshot)['status'],'existing')
        self.assertEqual(reloaded.journal(),journal)
        self.assertEqual(sum(not p['dryRun'] for p in self.calls),1)

    def test_picker_status_comes_from_the_saved_upload_record(self):
        plan=self.uploads.preview(self.body,self.snapshot)
        self.uploads.confirm(plan['previewToken'],self.snapshot)
        photos=self.uploads.statuses([{'path':'album.jpg'},{'path':'other.jpg'}])
        self.assertTrue(photos[0]['upload_record']['result']['tagsApplied'])
        self.assertIsNone(photos[1]['upload_record'])

    def test_unknown_result_survives_restart_and_blocks_reupload(self):
        preview = self.uploads.preview(self.body, self.snapshot)
        def fail(p): raise TimeoutError('private error')
        self.uploads.mcp = fail
        self.assertEqual(self.uploads.confirm(preview['previewToken'], self.snapshot)['status'], 'unknown')
        reloaded = Uploads(self.root, self.data, fail)
        self.assertEqual(reloaded.preview(self.body, self.snapshot)['status'], 'existing')

    def test_unknown_faces_and_external_or_familysearch_photos_are_rejected(self):
        for body in [{'faces': [{'faceId': 2, 'personId': 'ABCD-123'}]}, {'faces': []},
                     {'faces': [{'faceId': 1, 'personId': 'bad'}]}]:
            with self.assertRaises(ValueError): self.uploads.preview(body, self.snapshot)
        self.snapshot['photo']['source'] = 'FamilySearch'
        with self.assertRaises(ValueError): self.uploads.preview(self.body, self.snapshot)
        self.snapshot['photo'] = {'path': '../outside.jpg'}
        with self.assertRaises(ValueError): self.uploads.preview(self.body, self.snapshot)
        self.assertFalse(self.calls)

    def test_face_bounds_are_clipped_and_stale_image_width_is_rejected(self):
        result = face_rectangle({'bbox': [-10, 0, 201, 100], 'img_w': 200}, 200, 100)
        self.assertEqual(result, {'x': 0, 'y': 0, 'width': 1, 'height': 1})
        with self.assertRaises(ValueError): face_rectangle({'bbox': [1,2,3,4], 'img_w': 400}, 200, 100)

    def test_exif_orientation_is_removed_from_upload_copy(self):
        exif = Image.Exif(); exif[274] = 6
        Image.new('RGB', (100, 200), 'white').save(self.photo, exif=exif)
        preview = self.uploads.preview(self.body, self.snapshot)
        copy = Path(self.calls[0]['filePath'])
        self.assertNotEqual(copy, self.photo)
        with Image.open(copy) as im:
            self.assertEqual(im.size, (200,100)); self.assertEqual(im.getexif().get(274,1),1)
        self.assertEqual(preview['status'], 'ready')


if __name__ == '__main__':
    unittest.main()
