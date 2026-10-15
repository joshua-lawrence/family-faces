import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../review.html', import.meta.url), 'utf8');
const start = html.indexOf('function familySearchFace(');
const end = html.indexOf('function header()', start);
assert.ok(start >= 0 && end > start);
const groups = [
  {id: 0, faces: [0, 1]},
  {id: 1, faces: [1]},
  {id: 2, faces: [2]},
];
const context = vm.createContext({showFamilySearchOnly: false, S: {
  face_photo: {0: 'album.jpg', 1: 'source.jpg', 2: 'album2.jpg'},
  photo_sources: {'album.jpg': '', 'source.jpg': 'FamilySearch', 'album2.jpg': ''},
  clusters: groups,
  leftovers: [{id: 1}, {id: 2}],
}, reviewSettings: {sort:'match',minimum:0}});
vm.runInContext(html.slice(start, end), context);
assert.deepEqual(Array.from(context.reviewGroups(), c => c.id), [0, 2]);
assert.deepEqual(context.reviewGroups()[0].faces, [0, 1]);
assert.deepEqual(Array.from(context.reviewLeftovers(), f => f.id), [2]);
context.showFamilySearchOnly = true;
assert.deepEqual(Array.from(context.reviewGroups(), c => c.id), [0, 1, 2]);
assert.deepEqual(Array.from(context.reviewLeftovers(), f => f.id), [1, 2]);
assert.deepEqual(groups[0].faces, [0, 1]);
context.S.clusters = [
  {id:0,faces:[0,2],photos:20,suggest:[['A',.35]]},
  {id:1,faces:[0],photos:1,suggest:[['B',.8]]},
  {id:2,faces:[2],photos:5,suggest:[]},
];
context.showFamilySearchOnly = false;
assert.deepEqual(Array.from(context.reviewGroups(),c=>c.id),[1,0,2]);
context.reviewSettings.sort='photos';
assert.deepEqual(Array.from(context.reviewGroups(),c=>c.id),[0,2,1]);
context.reviewSettings.sort='faces';
assert.deepEqual(Array.from(context.reviewGroups(),c=>c.id),[0,2,1]);
context.reviewSettings.minimum=.5;
assert.deepEqual(Array.from(context.reviewGroups(),c=>c.id),[1]);
context.S.leftovers=[{id:0,suggest:[['A',.2]]},{id:2,suggest:[['B',.9]]}];
assert.deepEqual(Array.from(context.reviewLeftovers(),f=>f.id),[2]);
assert.deepEqual(context.S.clusters[0].faces,[0,2]);
console.log('Source filters, match ranking, photo/face sorting, and minimum scores passed.');
