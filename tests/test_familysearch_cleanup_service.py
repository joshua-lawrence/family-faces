import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from family_faces import serve


class CleanupServiceTests(unittest.TestCase):
    def test_cleanup_uses_current_tree_and_people_without_saving_labels_or_photos(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            data=Path(temp); folder=data/'familysearch-tags';folder.mkdir()
            (folder/'mapping-report.json').write_text(json.dumps({'runId':'read','newPeople':[
                {'name':'Source Person','personId':'ABCD-123'}, {'name':'Now Linked','personId':'EFGH-456'}]}))
            current={'Source Person':{'familysearch_id':'ABCD-123','user_note':'Keep my edit'},
                     'Now Linked':{'familysearch_id':'EFGH-456'}}
            labels={'names':{'0':'Source Person'},'rejected':[0],'sources':{'0':'manual'}}
            photos=[{'path':'source.jpg','source':'FamilySearch','memory_id':'123','tags':[{'resolved':'Source Person'}]}]
            for attr,value in [('DATA',data),('labels',labels),('faces',[{'id':0,'photo':'source.jpg'}]),
                               ('import_state',{'running':False})]:stack.enter_context(patch.object(serve,attr,value))
            stack.enter_context(patch.object(serve.tree,'load',return_value={'people':{'Now Linked':{}}}))
            stack.enter_context(patch.object(serve.people,'load',return_value=current))
            stack.enter_context(patch.object(serve.library,'photos',return_value=photos))
            stack.enter_context(patch.object(serve,'data_version',return_value=1))
            save_people=stack.enter_context(patch.object(serve.people,'save'))
            save_labels=stack.enter_context(patch.object(serve,'save'))
            save_photos=stack.enter_context(patch.object(serve.library,'save'))
            dry=serve.clean_up_tag_people({'dryRun':True})
            self.assertEqual(dry['hidden'],['Source Person'])
            save_people.assert_not_called()
            result=serve.clean_up_tag_people({})
            self.assertEqual(result['kept'],['Now Linked'])
            saved=save_people.call_args.args[0]
            self.assertEqual(saved['Source Person']['user_note'],'Keep my edit')
            self.assertEqual(saved['Now Linked'],current['Now Linked'])
            self.assertEqual(json.loads((Path(result['backup'])/'labels.json').read_text()),labels)
            self.assertEqual(json.loads((Path(result['backup'])/'photos.json').read_text()),photos)
            save_labels.assert_not_called();save_photos.assert_not_called()
            self.assertEqual(current['Source Person'],{'familysearch_id':'ABCD-123','user_note':'Keep my edit'})


if __name__ == '__main__': unittest.main()
