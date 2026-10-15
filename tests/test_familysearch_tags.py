import unittest

from family_faces.familysearch.tags import map_memories, unique_people_by_id


class TagMappingTests(unittest.TestCase):
    def setUp(self):
        self.photos = [{'path':'source.jpg','source':'FamilySearch','memory_id':'123','tags':[]}, {'path':'album.jpg','tags':[]}]
        self.faces = [{'id':1,'photo':'source.jpg','img_w':1000,'bbox':[100,100,200,200]},
                      {'id':2,'photo':'source.jpg','img_w':1000,'bbox':[600,100,700,200]}]
        self.ids = {'Local Alice':{'familysearch_id':'ABCD-123','aliases':[]}}
        self.labels = {'names':{},'rejected':[2]}
        self.tag = {'memoryPersonId':'t1','name':'Alice Source','personId':'ABCD-123',
                    'regions':[{'x':.09,'y':.09,'width':.12,'height':.12}],'regionScope':'region'}

    def apply(self, tags=None, **options):
        return map_memories(self.photos,self.ids,self.labels,self.faces,
            [{'memoryId':'123','people':tags or [self.tag],'readAt':'today'}], {'source.jpg':(1000,1000)}, **options)

    def test_duplicate_tree_ids_cannot_select_an_arbitrary_person(self):
        self.assertEqual(unique_people_by_id({'Alice':{'familysearch_id':'ABCD-123'},'Other Alice':{'familysearch_id':'ABCD-123'},'Bob':{'familysearch_id':'EFGH-456'}}),{'EFGH-456':'Bob'})

    def test_saved_id_wins_over_name_and_maps_a_clear_box(self):
        photos, ids, labels, report = self.apply()
        self.assertEqual(labels['names'],{'1':'Local Alice'})
        self.assertEqual(ids['Local Alice']['aliases'],['Alice Source'])
        self.assertEqual(photos[0]['tags'][0]['resolved'],'Local Alice')
        self.assertEqual(labels['sources']['1'],'FamilySearch tag')
        self.assertEqual(report['mappedTags'],1)
        self.assertEqual(self.labels['names'],{})
        self.assertEqual(labels['rejected'],[2])

    def test_manual_and_ignored_names_are_never_overwritten(self):
        for name in ['Manual Name','_ignore']:
            self.labels['names']={'1':name}
            _,_,labels,report = self.apply()
            self.assertEqual(labels['names'],self.labels['names'])
            self.assertEqual(len(report['manualFaceConflicts']),1)

    def test_whole_photo_links_people_without_naming_faces(self):
        tag={**self.tag,'regions':[{'x':0,'y':0,'width':1,'height':1}],'regionScope':'whole-photo'}
        photos,_,labels,_=self.apply([tag])
        self.assertEqual(labels['names'],{})
        self.assertEqual(photos[0]['tags'][0]['resolved'],'Local Alice')

    def test_distinct_ids_with_equal_names_stay_separate(self):
        self.ids={'Alice Source':{'familysearch_id':'WXYZ-789'}}
        _,ids,labels,report=self.apply()
        self.assertIn('Alice Source (ABCD-123)',ids)
        self.assertEqual(labels['names']['1'],'Alice Source (ABCD-123)')
        self.assertEqual(len(report['newPeople']),1)

    def test_multiple_people_on_one_face_and_multi_face_regions_stay_unassigned(self):
        _,_,labels,report=self.apply([self.tag,{**self.tag,'personId':'EFGH-456','name':'Other','memoryPersonId':'t2'}])
        self.assertEqual(labels['names'],{})
        self.assertGreater(report['ambiguousFaces'],0)
        self.faces[1]['bbox']=[150,100,190,150]
        _,_,labels,_=self.apply()
        self.assertEqual(labels['names'],{})

    def test_repeated_import_is_idempotent_and_preserves_other_photo_tags(self):
        self.photos[1]['tags']=[{'resolved':'Album Person'}]
        self.photos,self.ids,self.labels,first=self.apply()
        photos,ids,labels,second=self.apply()
        self.assertEqual(len(photos[0]['tags']),1)
        self.assertEqual(second['newPeople'],[])
        self.assertEqual(second['newFaceLabels'],[])
        self.assertEqual(photos[1]['tags'],[{'resolved':'Album Person'}])

    def test_unlinked_generic_names_and_ambiguous_ids_wait_for_review(self):
        for name in ['Grandma','John or Paul Harper','Harper Family','Nora and Ben Lowe','Nora? Harper']:
            tag={**self.tag,'personId':None,'name':name}
            photos,_,labels,report=self.apply([tag])
            self.assertIsNone(photos[0]['tags'][0]['resolved'])
            self.assertEqual(report['unlinkedTags'],1)
            self.assertEqual(labels['names'],{})
        self.ids['Duplicate']={'familysearch_id':'ABCD-123'}
        _,_,labels,report=self.apply()
        self.assertEqual(report['ambiguousIdentities'],1)
        self.assertEqual(labels['names'],{})

    def test_missing_photo_or_stale_dimensions_cannot_name_faces(self):
        self.faces[0]['img_w']=500
        _,_,labels,_=self.apply()
        self.assertEqual(labels['names'],{})
        self.photos[0]['memory_id']='999'
        _,_,labels,report=self.apply()
        self.assertEqual(report['photos'],0)
        self.assertEqual(labels['names'],{})

    def test_saved_tag_face_link_and_profile_context_are_preserved(self):
        self.photos[0]['tags']=[{'memory_person_id':'t1','face':2}]
        self.ids={'Alice Source':{'familysearch':{'note':'Saved context'}}}
        photos,ids,_,_=self.apply()
        self.assertEqual(photos[0]['tags'][0]['face'],2)
        self.assertEqual(photos[0]['tags'][0]['faces'],[1,2])
        self.assertEqual(ids['Alice Source']['familysearch']['note'],'Saved context')

    def test_unlinked_full_names_create_source_people_and_saved_full_names_get_ids(self):
        tag={**self.tag,'personId':None,'name':'Mary Ann Doe'}
        _,ids,labels,report=self.apply([tag])
        self.assertEqual(labels['names']['1'],'Mary Ann Doe')
        self.assertEqual(ids['Mary Ann Doe']['source'],'Unlinked FamilySearch Memory tag')
        self.assertEqual(len(report['newPeople']),1)
        self.ids={'Alice Source':{'aliases':[]}}
        _,ids,labels,report=self.apply()
        self.assertEqual(labels['names']['1'],'Alice Source')
        self.assertEqual(ids['Alice Source']['familysearch_id'],'ABCD-123')
        self.assertEqual(report['newPeople'],[])


if __name__ == '__main__': unittest.main()
