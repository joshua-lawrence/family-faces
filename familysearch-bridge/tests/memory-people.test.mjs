import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryPersonaSummary, readMemoryPeople } from '../build/memory-people.js';

const persona = {id:'tag-1', display:{name:'Alice Example'},
  identifiers:{'http://familysearch.org/v1/FamilyTreePerson':['https://familysearch.org/ark:/61903/4:1:ABCD-123']},
  media:[{qualifiers:[{name:'http://gedcomx.org/RectangleRegion',value:'.1,.2,.3,.4'}]}],
  attribution:{contributor:{resource:'private-contributor'}}, secret:'private-session'};

test('returns explicit tree links and face regions without contributor or session fields', () => {
  const result = memoryPersonaSummary(persona);
  assert.equal(result.personId,'ABCD-123'); assert.equal(result.name,'Alice Example');
  assert.deepEqual(result.regions,[{x:.1,y:.2,width:.3,height:.4}]);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('keeps unlinked names and rejects missing or invalid face regions', () => {
  const result = memoryPersonaSummary({id:'2',names:[{nameForms:[{fullText:'Unlinked person'}]}],
    media:[{qualifiers:[{name:'http://gedcomx.org/RectangleRegion',value:'0,0,NaN,.2'}]}]});
  assert.equal(result.name,'Unlinked person'); assert.equal(result.personId,null);
  assert.equal(result.regionScope,null);
  assert.equal(memoryPersonaSummary({identifiers:{'http://familysearch.org/v1/FamilyTreePerson':['https://evil.test/ark:/61903/4:1:ABCD-123']}}).personId,null);
});

test('marks whole-photo tags as photo associations', () => {
  const result = memoryPersonaSummary({...persona, media:[{qualifiers:[{name:'http://gedcomx.org/RectangleRegion',value:'0,0,1,1'}]}]});
  assert.equal(result.regionScope,'whole-photo');
  assert.equal(memoryPersonaSummary(persona).regionScope,'region');
});

test('reads tags with the saved bearer token, includes tree IDs, and sends no cookies or writes', async t => {
  let called = 0;
  t.mock.method(globalThis,'fetch',async (url,options) => {
    called++; assert.equal(url.hostname,'api.familysearch.org');
    assert.equal(url.pathname,'/platform/memories/memories/123/personas');
    assert.equal(url.searchParams.get('includeTreeIdentifier'),'true');
    assert.equal(options.method,'GET'); assert.equal(options.headers.Authorization,'Bearer private-session');
    assert.equal(options.headers.Cookie,undefined); assert.equal(options.body,undefined);
    return Response.json({persons:[persona]});
  });
  const result = await readMemoryPeople('123','private-session','browser');
  assert.equal(called,1); assert.equal(result.total,1);
});

test('handles no tags and rejects redirects without disclosing response bodies', async t => {
  t.mock.method(globalThis,'fetch',async () => new Response(null,{status:204}));
  assert.deepEqual((await readMemoryPeople('123','private-session','browser')).people,[]);
  globalThis.fetch = async () => new Response('private-session',{status:302,headers:{location:'https://evil.test'}});
  await assert.rejects(readMemoryPeople('123','private-session','browser'),{message:'Could not read Memory tags (HTTP 302).'});
});

test('invalid Memory IDs stop before any network request', async t => {
  t.mock.method(globalThis,'fetch',async () => {throw new Error('Must not fetch');});
  await assert.rejects(readMemoryPeople('../123','private-session','browser'),/valid FamilySearch Memory/);
});

test('reads unlinked tags when FamilySearch rejects the tree identifier query', async t => {
  const queries=[];
  t.mock.method(globalThis,'fetch',async (url,options) => {
    queries.push(url.searchParams.get('includeTreeIdentifier'));
    assert.equal(options.method,'GET'); assert.equal(options.redirect,'manual');
    if(queries.length===1)return new Response('private-session',{status:400});
    return Response.json({persons:[{id:'unlinked',display:{name:'Unlinked Person'}}]});
  });
  const result=await readMemoryPeople('123','private-session','browser');
  assert.deepEqual(queries,['true','false']);
  assert.equal(result.people[0].name,'Unlinked Person'); assert.equal(result.people[0].personId,null);
  assert.equal(result.treeIdentifiersAvailable,false);
  assert.ok(!JSON.stringify(result).includes('private-session'));
});
