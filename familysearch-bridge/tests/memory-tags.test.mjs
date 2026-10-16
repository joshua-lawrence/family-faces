import assert from 'node:assert/strict';
import test from 'node:test';
import { FamilySearchSessionClient } from '../build/session-client.js';
import { memoryDescription } from '../build/memory-tags.js';
const base = '/platform/memories/memories/12345';
const rectangle = {x:.2,y:.2,width:.1,height:.1};
const tag = {personId:'ABCD-123',rectangle};
const tree = 'http://familysearch.org/v1/FamilyTreePerson';
const persona = {id:'12345-11', names:[{nameForms:[{fullText:'Person ABCD-123'}]}],
  identifiers:{'http://familysearch.org/v1/MemoryPerson':['11']},
  media:[{description:'https://api.familysearch.org'+base,qualifiers:[{name:'http://gedcomx.org/RectangleRegion',value:'.1,.1,.4,.4'}]}]};
function setup(t, people=[persona], fail=false) {
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url, options={}) => {
    calls.push({url,options});
    if(url.pathname.includes('/card')) return Response.json({id:'ABCD-123',name:'Person ABCD-123'});
    if(options.method==='POST') {if(fail) throw new Error('secret credential');return new Response(null,{status:204});}
    if(url.pathname===base) return Response.json({sourceDescriptions:[{id:'12345',about:'https://sg30p0.familysearch.org/photo.jpg',links:{description:{href:'https://api.familysearch.org'+base+'?flag=fsh'}}}]});
    if(url.pathname===base+'/personas') return Response.json({persons:people});
    return Response.json({persons:people.filter(p=>url.pathname.endsWith('/'+p.id))});
  });
  return {calls,client:new FamilySearchSessionClient({cookies:'fssessionid=test-session'})};
}
test('uses the explicit Memory description when the image about link is on the CDN',()=>{
  assert.equal(memoryDescription({sourceDescriptions:[{id:'12345',about:'https://sg30p0.familysearch.org/photo.jpg',links:{description:{href:'https://api.familysearch.org'+base+'?flag=fsh'}}}]},'12345'),'https://api.familysearch.org'+base);
  for(const href of ['https://evil.test'+base,'https://test-session@api.familysearch.org'+base,'https://api.familysearch.org/platform/memories/memories/999'])
    assert.throws(()=>memoryDescription({sourceDescriptions:[{id:'12345',links:{description:{href}}}]},'12345'),/unexpected/);
});
test('repair preview reuses an existing name tag and sends no writes',async t=>{
  const {client,calls}=setup(t);
  const r=await client.tagMemoryPeople({memoryId:'12345',people:[tag],dryRun:true});
  assert.equal(r.tagActions[0].action,'link');assert.equal(r.tagActions[0].memoryPersonId,persona.id);
  assert.equal(r.planHash.length,64);assert.ok(calls.every(c=>c.options.method!=='POST'));
});
test('repair links an existing tag, keeps its region, and preserves unselected people',async t=>{
  const other={...persona,id:'12345-22',names:[{nameForms:[{fullText:'Other person'}]}]};
  const {client,calls}=setup(t,[persona,other]);
  const preview=await client.tagMemoryPeople({memoryId:'12345',people:[tag],dryRun:true});
  const r=await client.tagMemoryPeople({memoryId:'12345',people:[tag],expectedPlanHash:preview.planHash});
  assert.equal(r.tagsApplied,true);
  const writes=calls.filter(c=>c.options.method==='POST');assert.equal(writes.length,1);
  assert.equal(writes[0].url.pathname,base+'/personas/'+persona.id);
  const p=JSON.parse(writes[0].options.body).persons[0];
  assert.deepEqual(p.identifiers[tree],['https://familysearch.org/ark:/61903/4:1:ABCD-123']);
  assert.deepEqual(p.media[0].qualifiers,persona.media[0].qualifiers);
  assert.equal(writes[0].options.redirect,'manual');assert.ok(!JSON.stringify(r).includes('test-session'));
});
test('an already linked tag requires no write',async t=>{
  const {client,calls}=setup(t,[{...persona,identifiers:{[tree]:['https://familysearch.org/ark:/61903/4:1:ABCD-123']}}]);
  assert.equal((await client.tagMemoryPeople({memoryId:'12345',people:[tag]})).tagsApplied,true);
  assert.ok(calls.every(c=>c.options.method!=='POST'));
});
test('conflicting or ambiguous tags and changed preview plans stop before any write',async t=>{
  const {client,calls}=setup(t,[{...persona,identifiers:{[tree]:['https://familysearch.org/ark:/61903/4:1:EFGH-456']}}]);
  await assert.rejects(client.tagMemoryPeople({memoryId:'12345',people:[tag]}),/another person/);
  assert.ok(calls.every(c=>c.options.method!=='POST'));
});
test('uncertain tag update returns the Memory, no retry, and no private error',async t=>{
  const {client,calls}=setup(t,[persona],true);
  const r=await client.tagMemoryPeople({memoryId:'12345',people:[tag]});
  assert.equal(r.status,'partial');assert.match(r.note,/unknown/);assert.ok(!r.note.includes('secret'));
  assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
});
test('stale preview and duplicate face matches block writes',async t=>{
  const {client,calls}=setup(t);
  await assert.rejects(client.tagMemoryPeople({memoryId:'12345',people:[tag],expectedPlanHash:'a'.repeat(64)}),/changed/);
  await assert.rejects(client.tagMemoryPeople({memoryId:'12345',people:[tag,tag]}),/same tag/);
  assert.ok(calls.every(c=>c.options.method!=='POST'));
});
