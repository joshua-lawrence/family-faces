import copy
import unittest

import numpy as np

from family_faces.api.face_similarity import compare, options


class Scope:
    source_paths = {'fs.jpg'}
    def allows_sample(self, face, name):
        return name == 'Allowed'


class FaceSimilarityTests(unittest.TestCase):
    def setUp(self):
        self.faces = [{'photo': f'{i}.jpg'} for i in range(9)]
        self.faces[7]['photo'] = 'fs.jpg'
        self.vectors = np.array([[1.,0.], [0.,1.], [1.,0.], [0.,1.], [.8,.6], [1.,0.], [1.,0.], [1.,0.], [1.,0.]])
        self.names = dict(enumerate(['Reference','Reference','A','A','B','Missing','Ignored','Forbidden','Hidden']))
        self.names = {str(k): v for k,v in self.names.items()}
        self.names['6'] = '_ignore'
        self.attrs = {i:{'age': a, 'sharp':20} for i,a in enumerate([5.,25.,5.,25.,5.,None,5.,5.,5.])}
        self.query = {'name':'Reference','reference_min':0,'reference_max':9,'age_min':0,'age_max':9,'quality':'all'}

    def run_compare(self, **query):
        return compare(self.faces,self.vectors,self.names,self.attrs,Scope(),options({**self.query,**query}),
                       lambda i,f: i != 4, {'Hidden'})

    def test_window_changes_the_faces_used(self):
        young = self.run_compare()
        old = self.run_compare(age_min=20,age_max=29)
        self.assertEqual([r['name'] for r in young['items']], ['A','B'])
        self.assertEqual(young['items'][0]['similarity'],1.)
        self.assertEqual(old['items'][0]['similarity'],0.)
        self.assertEqual(old['items'][0]['samples'][0]['id'],3)

    def test_reference_window_is_independent(self):
        same = self.run_compare(reference_min=20,reference_max=29,age_min=20,age_max=29)
        self.assertEqual(same['items'][0]['similarity'],1.)
        self.assertEqual(same['reference']['samples'][0]['id'],1)

    def test_fractional_ages_and_boundary(self):
        self.attrs[2]['age'] = 9.9
        self.attrs[4]['age'] = 10.
        self.assertEqual([r['name'] for r in self.run_compare()['items']], ['A'])

    def test_quality_minimum_and_candidate_filters(self):
        self.assertEqual([r['name'] for r in self.run_compare(quality='clear')['items']], ['A'])
        self.assertEqual(self.run_compare(minimum_faces=2)['items'], [])
        self.assertEqual([r['name'] for r in self.run_compare(candidate='B')['items']], ['B'])
        self.assertEqual([r['name'] for r in self.run_compare(minimum_score=90)['items']], ['A'])

    def test_source_scope_and_hidden_imports(self):
        self.assertNotIn('Forbidden',[r['name'] for r in self.run_compare(source='all')['items']])
        self.names['7'] = 'Allowed'
        self.assertIn('Allowed',[r['name'] for r in self.run_compare(source='all')['items']])
        self.assertIn('Hidden',[r['name'] for r in self.run_compare(include_hidden=1)['items']])

    def test_missing_or_pending_age_does_not_become_age_zero(self):
        self.attrs[0]['age_pending'] = True
        result = self.run_compare()
        self.assertFalse(result['hasReference'])
        self.assertEqual(result['reference']['missingAge'],1)
        self.assertEqual(result['items'],[])

    def test_bad_vectors_and_ignored_labels_stay_out(self):
        self.vectors[2] = [float('nan'),0]
        self.vectors[4] = [0,0]
        self.assertEqual(self.run_compare()['items'],[])

    def test_duplicate_photo_counts_once(self):
        self.faces[3]['photo'] = self.faces[2]['photo']
        self.attrs[3]['age'] = 5
        self.attrs[3]['sharp'] = 30
        row = self.run_compare()['items'][1]
        self.assertEqual(row['name'],'A')
        self.assertEqual(row['faces'],1)
        self.assertEqual(row['samples'][0]['id'],3)

    def test_pagination_and_no_mutation(self):
        snapshot = copy.deepcopy((self.faces,self.names,self.attrs))
        page = self.run_compare(offset=1,limit=1)
        self.assertEqual(page['total'],2)
        self.assertEqual(page['items'][0]['name'],'B')
        self.assertEqual(snapshot,(self.faces,self.names,self.attrs))

    def test_invalid_input(self):
        for change in [{'age_min':10,'age_max':2},{'reference_max':121},{'minimum_faces':0},
                       {'minimum_score':'nan'},{'quality':'bad'},{'name':'_ignore'},{'age_min':'2.5'}]:
            with self.subTest(change=change),self.assertRaises(ValueError):
                options({**self.query,**change})


if __name__ == '__main__':
    unittest.main()
