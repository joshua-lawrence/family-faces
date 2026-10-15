import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const nodes = new Map();
const node = selector => {
  if (!nodes.has(selector)) nodes.set(selector,{innerHTML:'',textContent:'',value:'',disabled:false,hidden:false,
    setAttribute(name,value) {this[name]=value;}});
  return nodes.get(selector);
};
const root = {tagName:'SECTION',isConnected:true,querySelector:node,querySelectorAll:()=>[],contains:()=>true};
const calls = [];
const pending = [];
const context = vm.createContext({window:{},document:{getElementById:()=>root,addEventListener(){}},
  S:{v:1,people:{Reference:[]},hidden_people:{}},esc:String,plural:(n,label)=>`${n} ${label}s`,
  registerTab(){},localStorage:{getItem:()=>null,setItem(){}},queueMicrotask(){},setTimeout,clearTimeout,
  AbortController,URLSearchParams,tab:'people',
  fetch:(url,options)=>{calls.push({url,signal:options.signal});return new Promise(resolve=>pending.push(resolve));}
});
let source = await readFile(process.argv[2] || new URL('../web/43-face-similarity.js',import.meta.url),'utf8');
source = source.replace('window.faceSimilaritySection = section;',
  'window.test = {load,normalize,params,settings,setRoot:el=>root=el,setName:name=>selectedName=name}; window.faceSimilaritySection = section;');
vm.runInContext(source,context);
const tool = context.window.test;
tool.setRoot(root); tool.setName('Reference');
context.window.faceSimilaritySection('Reference');
root.tagName = 'DETAILS'; root.open = true;
assert.match(context.window.faceSimilaritySection('Reference'),/aria-label="Face similarity" open/);
root.tagName = 'SECTION';
tool.settings.start = 119; tool.settings.span = 10; tool.normalize();
assert.equal(tool.params().get('age_min'),'111');
assert.equal(tool.params().get('age_max'),'120');
tool.settings.reference = 'same';
assert.equal(tool.params().get('reference_min'),'111');
assert.equal(tool.params().get('reference_max'),'120');
tool.settings.reference = 'custom'; tool.settings.refMin = 5; tool.settings.refMax = 8;
assert.equal(tool.params().get('reference_min'),'5');
assert.equal(tool.params().get('reference_max'),'8');
const first = tool.load(false);
assert.equal(node('[data-fsim-more]').disabled,true);
assert.equal(node('#fsim-results')['aria-busy'],'true');
tool.settings.start = 20;
const latest = tool.load(false);
assert.equal(calls[0].signal.aborted,true);
const result = name=>({ok:true,json:async()=>({reference:{name,faces:0,samples:[],missingAge:0},
  hasReference:false,items:[],total:0})});
pending[1](result('Latest reference'));
await latest;
const html = node('#fsim-reference-faces').innerHTML;
assert.match(html,/Latest reference/);
pending[0](result('Old reference'));
await first;
assert.equal(node('#fsim-reference-faces').innerHTML,html);
const failed = tool.load(false);
pending[2]({ok:false,json:async()=>({error:'Could not load the age data. Try again.'})});
await failed;
assert.match(node('#fsim-status').textContent,/Could not load the age data/);
assert.match(node('#fsim-results').innerHTML,/Try again/);
assert.equal(node('#fsim-results')['aria-busy'],'false');
console.log('PASS: age-window boundaries, separate reference range, stale replies, and failed-request recovery.');
