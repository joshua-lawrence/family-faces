import unittest
from familysearch_cleanup import hide_unlinked, hidden_names


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.ids={'Maternal':{'familysearch_id':'AAAA-111'},'Paternal':{'familysearch_id':'BBBB-222'},
                  'Album Friend':{'aliases':[]},'Unlinked':{'familysearch_id':'CCCC-333','note':'Keep'},
                  'Older Source':{'familysearch_id':'DDDD-444'}}
        self.tree={'people':{'Maternal':{},'Paternal':{}}}
        self.photos=[{'path':'album.jpg'},{'path':'source.jpg','source':'FamilySearch'}]
        self.faces=[{'id':0,'photo':'album.jpg'},{'id':1,'photo':'source.jpg'}]
        self.labels={'0':'Album Friend','1':'Unlinked'}
        self.report={'runId':'import','newPeople':[{'name':n,'personId':self.ids[n].get('familysearch_id')}
                                                for n in ['Maternal','Paternal','Album Friend','Unlinked']]}

    def test_hides_only_unlinked_imports_and_keeps_both_family_sides_and_album_people(self):
        ids,report=hide_unlinked(self.ids,self.tree,self.photos,self.faces,self.labels,self.report,'now')
        self.assertEqual(report['hidden'],['Unlinked'])
        self.assertEqual(report['kept'],['Album Friend','Maternal','Paternal'])
        self.assertEqual(ids['Unlinked']['note'],'Keep')
        self.assertNotIn('hidden_tag_import',ids['Older Source'])
        self.assertNotIn('hidden_tag_import',self.ids['Unlinked'])
        self.assertEqual(hidden_names(ids,self.tree,self.photos,self.faces,self.labels),{'Unlinked'})

    def test_new_tree_link_or_album_label_makes_a_hidden_person_visible(self):
        ids,_=hide_unlinked(self.ids,self.tree,self.photos,self.faces,self.labels,self.report,'now')
        self.tree['people']['Unlinked']={}
        self.assertEqual(hidden_names(ids,self.tree,self.photos,self.faces,self.labels),set())
        self.tree['people'].pop('Unlinked')
        self.labels['0']='Unlinked'
        self.assertEqual(hidden_names(ids,self.tree,self.photos,self.faces,self.labels),set())

    def test_saved_tree_id_aliases_are_kept_and_duplicate_ids_wait(self):
        self.ids['Tree Name']={'familysearch_id':'CCCC-333'}
        self.tree['people']['Tree Name']={}
        ids,report=hide_unlinked(self.ids,self.tree,self.photos,self.faces,self.labels,self.report,'now')
        self.assertEqual(report['hidden'],[])
        self.assertEqual(report['ambiguous'],['Unlinked'])

    def test_current_renamed_person_is_found_by_tree_id(self):
        self.ids['Renamed']=self.ids.pop('Unlinked')
        ids,report=hide_unlinked(self.ids,self.tree,self.photos,self.faces,self.labels,self.report,'now')
        self.assertEqual(report['hidden'],['Renamed'])
        self.assertIn('hidden_tag_import',ids['Renamed'])


if __name__ == '__main__': unittest.main()
