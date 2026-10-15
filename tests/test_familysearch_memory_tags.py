import copy
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from PIL import Image
from familysearch_memory_tags import MemoryTags, memory_target
import api_familysearch_memory_tags as api


class MemoryTagTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        Image.new('RGB', (100, 200), 'white').save(self.root/'photo.png')
        self.snapshot = {'photo': {'path':'photo.png','source':'FamilySearch','memory_id':'12345'},
                         'identities': {'Known Person':{'familysearch_id':'ABCD-123'}},
                         'faces':[{'id':1,'name':'Known Person','img_w':100,'bbox':[10,20,30,60]}]}
        self.calls = []

        def mcp(payload):
            self.calls.append(copy.deepcopy(payload))
            return {'status':'ready','dryRun':True,'planHash':'test-plan','people':[]} if payload['dryRun'] else \
                   {'status':'uploaded','tagsApplied':True,'memoryId':'12345'}

        self.service = MemoryTags(self.root, mcp)
        self.body = {'photo':'photo.png','faces':[{'faceId':1,'personId':'ABCD-123'}]}

    def test_target_uses_saved_memory_metadata_or_upload_record(self):
        self.assertEqual(memory_target({'path':'p','memory_id':'12345'}),'12345')
        self.assertEqual(memory_target({'source_url':'https://www.familysearch.org/en/memories/memory/12345'}),'12345')
        self.assertEqual(memory_target({'tags':[{'memory_id':'12345'}]}),'12345')
        self.assertEqual(memory_target({'path':'p'},{'hash':{'photo':'p','result':{'memoryId':'12345'}}}),'12345')
        for url in ('https://example.org/en/memories/memory/12345','https://secret@www.familysearch.org/en/memories/memory/12345','http://www.familysearch.org/en/memories/memory/12345'):
            self.assertIsNone(memory_target({'source_url':url}))

    def test_info_lists_only_named_faces_with_the_viewer_face_numbers(self):
        self.snapshot['faces'].insert(0,{'id':2,'name':None,'bbox':[0,0,5,5]})
        info = self.service.info(self.snapshot,{})
        self.assertEqual(info['faces'],[{'id':1,'number':2,'name':'Known Person','personId':'ABCD-123'}])
        self.assertEqual(info['memoryId'],'12345')

    def test_preview_uses_tag_tool_only_and_sends_no_photo(self):
        preview = self.service.preview(self.body,self.snapshot,{})
        self.assertTrue(preview['previewToken'])
        self.assertEqual(self.calls,[{'action':'tag-memory','memoryId':'12345','people':[
            {'personId':'ABCD-123','rectangle':{'x':.1,'y':.1,'width':.2,'height':.2}}],'dryRun':True}])
        self.assertFalse((self.root/'familysearch-uploads.json').exists())

    def test_confirm_reuses_the_checked_target_people_and_plan(self):
        preview = self.service.preview(self.body,self.snapshot,{})
        result = self.service.confirm({'previewToken':preview['previewToken'],'faces':[],'memoryId':'other'},self.snapshot,{})
        self.assertTrue(result['tagsApplied'])
        self.assertEqual(self.calls[-1]['action'],'tag-memory')
        self.assertEqual(self.calls[-1]['memoryId'],'12345')
        self.assertEqual(self.calls[-1]['expectedPlanHash'],'test-plan')
        self.assertFalse(self.calls[-1]['dryRun'])
        self.assertNotIn('filePath',self.calls[-1])
        with self.assertRaises(ValueError):
            self.service.confirm({'previewToken':preview['previewToken']},self.snapshot,{})
        self.assertEqual(len(self.calls),2)

    def test_changed_memory_labels_links_or_pixels_stop_before_any_write(self):
        for change in ('memory','name','link','pixels'):
            with self.subTest(change=change):
                snapshot = copy.deepcopy(self.snapshot)
                preview = self.service.preview(self.body,snapshot,{})
                if change == 'memory': snapshot['photo']['memory_id']='67890'
                if change == 'name': snapshot['faces'][0]['name']='Someone Else'
                if change == 'link': snapshot['identities']['Known Person']['familysearch_id']='EFGH-456'
                if change == 'pixels': Image.new('RGB',(100,200),'black').save(self.root/'photo.png')
                with self.assertRaisesRegex(ValueError,'changed'):
                    self.service.confirm({'previewToken':preview['previewToken']},snapshot,{})
        self.assertTrue(all(call['dryRun'] for call in self.calls))

    def test_missing_or_invalid_people_and_photo_paths_stop_before_mcp(self):
        for faces in ([],[{'faceId':999,'personId':'ABCD-123'}],[{'faceId':1,'personId':''}],self.body['faces']*2,[{'faceId':True,'personId':'ABCD-123'}]):
            with self.assertRaises(ValueError): self.service.preview({'faces':faces},self.snapshot,{})
        self.snapshot['photo']['path']='../outside.png'
        with self.assertRaises(ValueError): self.service.preview(self.body,self.snapshot,{})
        self.assertEqual(self.calls,[])

    def test_expired_preview_stops_before_write(self):
        preview = self.service.preview(self.body,self.snapshot,{})
        self.service.previews[preview['previewToken']]['expires']=0
        with self.assertRaisesRegex(ValueError,'expired'):
            self.service.confirm({'previewToken':preview['previewToken']},self.snapshot,{})
        self.assertEqual(len(self.calls),1)

    def test_uncertain_write_has_no_retry_and_keeps_the_memory_link(self):
        preview = self.service.preview(self.body,self.snapshot,{})
        def fail(payload):
            self.calls.append(payload)
            raise RuntimeError('private diagnostic')
        self.service.mcp=fail
        result=self.service.confirm({'previewToken':preview['previewToken']},self.snapshot,{})
        self.assertEqual(result['status'],'unknown')
        self.assertEqual(result['memoryId'],'12345')
        self.assertNotIn('private',str(result))
        self.assertEqual(len(self.calls),2)

    def test_routes_cannot_submit_tags_in_a_batch(self):
        app=SimpleNamespace(library=SimpleNamespace(ROOT=self.root),BATCH_REFUSED=set(),lock=threading.Lock())
        routes={'GET':{},'POST':{}}
        api.register(routes,app)
        self.assertIn('/api/familysearch-memory-tags/photo',routes['GET'])
        self.assertEqual(set(routes['POST']),app.BATCH_REFUSED)


if __name__ == '__main__': unittest.main()
