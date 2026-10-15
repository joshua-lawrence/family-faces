import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const source=fs.readFileSync(new URL('../web/42-people-matches.js',import.meta.url),'utf8');
function setup(fetchPage) {
  const listeners={}, c=vm.createContext({URLSearchParams,person:'Person',tab:'people',reviewSettings:{branch:'maternal'},
    localStorage:{getItem:()=>null},document:{addEventListener:(type,listener)=>listeners[type]=listener},
    $:()=>({focus(){}}),ppJSON:fetchPage});
  vm.runInContext(source,c);vm.runInContext('PM.key="test"; pmPaint=()=>{};',c);
  return {c,listeners,data:()=>vm.runInContext('PM.data',c)};
}
test('match pages reach beyond 100 without repeating the first page',async()=>{
  const rows=Array.from({length:150},(_,face)=>({face,photo:`${face}.jpg`,sim:.9})), calls=[];
  const {c,listeners,data}=setup(async url=>{
    const query=new URLSearchParams(url.split('?')[1]),offset=Number(query.get('offset')),limit=Math.min(100,Number(query.get('limit')));
    calls.push({offset,limit});return {items:rows.slice(offset,offset+limit),total:rows.length,hasReference:true};
  });
  await c.pmLoad('test');
  const action={hasAttribute:attr=>attr==='data-pm-more',dataset:{}};
  while(data().items.length<rows.length) await listeners.click({target:{closest:()=>action}});
  assert.equal(data().items.length,150);assert.equal(new Set(data().items.map(row=>row.face)).size,150);
  assert.ok(calls.every(call=>call.limit===12));assert.equal(calls.at(-1).offset,144);
});
test('an older match page cannot replace a new filter request',async()=>{
  let finish;const {c,data}=setup(()=>new Promise(resolve=>finish=resolve));
  const pending=c.pmLoad('test');vm.runInContext('PM.key="new"',c);
  finish({items:[{face:1}],total:1,hasReference:true});await pending;
  assert.equal(data(),null);
});
