import test from 'node:test';
import assert from 'node:assert/strict';
import {familySummary, cardSummary} from '../build/family.js';

test('website child wrappers and spouse parent fields produce the correct family links', () => {
  const result=familySummary({spouses:[{parent1:{id:'A-1',name:'A'},parent2:{id:'B-2',name:'B'},
    children:[{child:{id:'C-3',name:'Child'},relationshipId:'REL'}]}],parents:[]});
  assert.equal(result.spouses[0].children[0].id,'C-3');
  assert.equal(result.spouses[0].parent2.id,'B-2');
});
test('family summaries omit credential-bearing and contributor details', () => {
  const result=cardSummary({name:'Person',birth:{details:{date:{localizedText:'1900'},place:{localizedText:'Utah',geoCode:{latitude:1}}},contributor:{secret:'value'}}},'A-1');
  assert.deepEqual(result.birth,{date:'1900',place:'Utah'});
  assert.ok(!JSON.stringify(result).includes('secret'));
});
