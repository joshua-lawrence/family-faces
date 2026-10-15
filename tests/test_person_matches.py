import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
import numpy as np
from family_faces.api.person_matches import PersonMatches, rank_matches


class MatchesTest(unittest.TestCase):
    def setUp(self):
        self.faces = [{'photo': p} for p in ['known.jpg','best.jpg','lower.jpg','known.jpg','named.jpg','best.jpg','fs.jpg']]
        self.vecs = np.array([[1.,0.],[.9,.1],[.6,.4],[.99,.01],[.98,.02],[.8,.2],[.95,.05]],np.float32)
        self.names = {'0':'Root','4':'Other'}
        self.scope = SimpleNamespace(source_paths={'fs.jpg'},branch='maternal',allows_face=lambda f:True,allows_sample=lambda f,n:True)

    def rank(self, **kw):
        return rank_matches(self.faces,self.vecs,self.names,[0],{'known.jpg'},set(),self.scope,**kw)

    def test_ranked_unnamed_photos_exclude_associated_and_named_faces(self):
        result=self.rank()
        self.assertEqual([r['face'] for r in result],[1,2])
        self.assertGreater(result[0]['sim'],result[1]['sim'])

    def test_source_scope_rejections_and_minimum(self):
        self.assertEqual([r['face'] for r in self.rank(source='familysearch')],[6])
        self.assertEqual([r['face'] for r in self.rank(minimum=.8)],[1])
        self.scope.allows_face=lambda f:f['photo']!='fs.jpg'
        self.assertNotIn(6,[r['face'] for r in self.rank(source='all')])
        result=rank_matches(self.faces,self.vecs,self.names,[0],{'known.jpg'},{1,5},self.scope)
        self.assertEqual([r['face'] for r in result],[2])

    def test_no_reference_and_nonfinite_scores(self):
        self.assertEqual(rank_matches(self.faces,self.vecs,self.names,[],set(),set(),self.scope),[])
        self.vecs[1]=np.nan
        self.assertEqual([r['face'] for r in self.rank()],[5,2])

    def test_accept_rechecks_live_names_and_photo_links(self):
        class Conflict(ValueError): pass
        app=SimpleNamespace(lock=threading.Lock(), labels={'names':self.names}, faces=self.faces,emb=self.vecs,
            sample_faces=lambda ids:ids, load_scope=lambda branch:self.scope,source_photos_by_person=lambda:{},
            suggestions=SimpleNamespace(lock=threading.Lock(),rejected=set()),save=Mock(),describe=Mock(),journal_note=Mock(),Conflict=Conflict)
        matches=PersonMatches(app)
        body={'name':'Root','faces':[1],'branch':'maternal'}
        matches.accept(body)
        self.assertEqual(app.labels['names']['1'],'Root')
        app.labels['names'].pop('1')
        app.labels['names']['5']='Root'
        with self.assertRaises(Conflict):matches.accept(body)
        app.labels['names'].pop('5'); app.labels['names']['1']='Other'
        with self.assertRaises(Conflict):matches.accept(body)
        self.assertEqual(app.labels['names']['1'],'Other')
        self.assertEqual(app.save.call_count,1)

    def test_source_tags_and_pagination(self):
        app=SimpleNamespace(lock=threading.Lock(),labels={'names':self.names},faces=self.faces,emb=self.vecs,captions={},
            sample_faces=lambda ids:ids,load_scope=lambda branch:self.scope,source_photos_by_person=lambda:{'Root':[{'path':'best.jpg'}]},
            suggestions=SimpleNamespace(lock=threading.Lock(),rejected=set()))
        result=PersonMatches(app).view({'name':'Root','limit':'1'})
        self.assertEqual(result['total'],1)
        self.assertEqual(result['items'][0]['face'],2)


if __name__=='__main__': unittest.main()
