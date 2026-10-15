import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from family_faces.pipeline import matching_groups
from family_faces.familysearch.scope import MatchingScope


class MatchingGroupsTest(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.data=Path(self.folder.name)
        self.faces=[{'id':i,'photo':path,'score':.99,'size':100}
                    for i,path in enumerate(['album.jpg','mother.jpg','father.jpg'])]
        (self.data/'faces.json').write_text(json.dumps(self.faces))
        np.save(self.data/'embeddings.npy',np.eye(3,dtype=np.float32))
        self.labels={'names':{'0':'Confirmed name'},'rejected':[]}
        self.scope=MatchingScope(frozenset({'Mother'}),frozenset({'mother.jpg','father.jpg'}),
                                 frozenset({'mother.jpg'}),'Mother','maternal')
        self.addCleanup(patch.stopall)
        patch.object(matching_groups,'DATA',self.data).start()
        patch.object(matching_groups,'_jobs',{}).start()
        patch.object(matching_groups.cluster.library,'captions',return_value={}).start()

    def test_cached_branch_build_keeps_labels_and_excludes_outside_source_faces(self):
        before=copy.deepcopy(self.labels)
        path=matching_groups.prepare(self.scope,3,self.labels,.65)
        doc,busy,error=matching_groups.get(self.scope,self.faces,self.labels,.65)
        self.assertEqual(doc['unclustered'],[1])
        self.assertEqual(doc['face_count'],3)
        self.assertFalse(busy)
        self.assertEqual(error,'')
        self.assertTrue(path.exists())
        self.assertEqual(self.labels,before)

    def test_cache_changes_with_branch_source_membership_and_face_data(self):
        first=matching_groups.cache_path(self.scope,3,.65)
        father=MatchingScope(self.scope.names,self.scope.source_paths,frozenset({'father.jpg'}),'Father','paternal')
        self.assertNotEqual(first,matching_groups.cache_path(father,3,.65))
        self.assertNotEqual(first,matching_groups.cache_path(self.scope,4,.65))
        self.assertNotEqual(first,matching_groups.cache_path(self.scope,3,.55))

    def test_pending_build_is_started_once_then_returns_cached_groups(self):
        targets=[]
        class Thread:
            def __init__(self,target,daemon):targets.append(target)
            def start(self):pass
        with patch.object(matching_groups.threading,'Thread',Thread):
            self.assertTrue(matching_groups.get(self.scope,self.faces,self.labels,.65)[1])
            self.assertTrue(matching_groups.get(self.scope,self.faces,self.labels,.65)[1])
            self.assertEqual(len(targets),1)
            targets[0]()
            self.assertFalse(matching_groups.get(self.scope,self.faces,self.labels,.65)[1])


if __name__=='__main__':unittest.main()
