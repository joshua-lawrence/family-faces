import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from family_faces import serve


class TagServiceTests(unittest.TestCase):
    def exercise(self, dry_run=False):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            data = Path(temp)
            raw = data/'familysearch-tags/raw'
            raw.mkdir(parents=True)
            (raw/'123.json').write_text(json.dumps({'memoryId':'123','readAt':'today','people':[
                {'memoryPersonId':'tag','personId':'ABCD-123','name':'Alice Source','regions':[]}]}))
            labels = {'names':{'0':'Manual Name'},'sources':{'0':'manual'},'rejected':[0]}
            photos = [{'path':'missing.jpg','source':'FamilySearch','memory_id':'123','tags':[]}]
            stack.enter_context(patch.object(serve,'DATA',data))
            stack.enter_context(patch.object(serve,'labels',labels))
            stack.enter_context(patch.object(serve,'faces',[]))
            stack.enter_context(patch.object(serve,'import_state',{'running':False}))
            stack.enter_context(patch.object(serve,'data_version',return_value=1))
            stack.enter_context(patch.object(serve.library,'photos',return_value=photos))
            save_photos=stack.enter_context(patch.object(serve.library,'save'))
            stack.enter_context(patch.object(serve.people,'load',return_value={'Alice Saved':{'familysearch_id':'ABCD-123','note':'Keep'}}))
            save_people=stack.enter_context(patch.object(serve.people,'save'))
            save_labels=stack.enter_context(patch.object(serve,'save'))
            stack.enter_context(patch.object(serve.tree,'load',return_value={'people':{}}))
            body={'memoryIds':['123'],'runId':'test','batchId':'0','dryRun':dry_run}
            report=serve.import_memory_tags(body)
            self.assertEqual(report['mappedTags'],1)
            self.assertEqual(labels['names'],{'0':'Manual Name'})
            self.assertEqual(labels['sources'],{'0':'manual'})
            self.assertEqual(labels['rejected'],[0])
            if dry_run:
                self.assertFalse((data/'familysearch-tags/runs').exists())
                save_photos.assert_not_called(); save_people.assert_not_called(); save_labels.assert_not_called()
            else:
                before=json.loads((data/'familysearch-tags/runs/test/before/labels.json').read_text())
                self.assertEqual(before['names'],{'0':'Manual Name'})
                self.assertEqual(save_people.call_args.args[0]['Alice Saved']['note'],'Keep')
                self.assertEqual(save_photos.call_args.args[0][0]['tags'][0]['resolved'],'Alice Saved')
                labels['names']['0']='New Manual Name'
                with patch.object(serve.familysearch_tags,'map_memories',side_effect=AssertionError('A completed batch must not run again')):
                    self.assertEqual(serve.import_memory_tags(body),report)
                self.assertEqual(labels['names']['0'],'New Manual Name')
                self.assertEqual(save_labels.call_count,1)

    def test_apply_uses_current_names_makes_backup_and_does_not_replay(self):
        self.exercise()

    def test_dry_run_does_not_save_or_make_a_backup(self):
        self.exercise(dry_run=True)


if __name__ == '__main__': unittest.main()
