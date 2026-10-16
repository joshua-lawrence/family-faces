// Read FamilySearch only through its MCP tools. Keep private data out of the repository.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const [root,cacheArg,phase='tree']=process.argv.slice(2);
if(!root || !cacheArg) throw new Error('Usage: node scripts/sync.mjs ROOT_PERSON_ID CACHE_DIR [tree|memories|download]');
const cache=resolve(cacheArg);await mkdir(cache,{recursive:true,mode:0o700});
const base=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const client=new Client({name:'family-faces-import',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[join(base,'build/index.js')],stderr:'ignore'}));
async function save(file,value){await writeFile(join(cache,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function read(file,fallback){try{return JSON.parse(await readFile(join(cache,file),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;return fallback;}}
async function call(name,args){
 const result=await client.callTool({name,arguments:args},undefined,{timeout:180000});
 const text=result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n');
 if(result.isError)throw new Error(text);
 try{return JSON.parse(text);}catch{throw new Error(text);}
}
const families=await read('families.json',{});
const errors=await read('errors.json',[]);
let count=0;
async function family(id){
 if(families[id])return families[id];
 try{families[id]=await call('get-person-family',{personId:id});await save('families.json',families);
  if(++count%10===0)console.log(`Read ${count} more family records; ${Object.keys(families).length} cached.`);
  return families[id];
 }catch(e){errors.push({personId:id,phase:'family',error:e.message});await save('errors.json',errors);console.log(`Family unavailable: ${id}`);return null;}
}
try{
 if(phase==='tree'){
  const ancestors={[root]:0};let queue=[[root,0]];
  while(queue.length){const [id,depth]=queue.shift();if(depth>=4)continue;const f=await family(id);if(!f)continue;
   for(const group of f.family.parents)for(const p of [group.parent1,group.parent2])if(p?.id && (!(p.id in ancestors)||ancestors[p.id]>depth+1)){ancestors[p.id]=depth+1;queue.push([p.id,depth+1]);}
  }
  const nodes={},parents=new Map(),partners=new Map(),expanded={};
  const add=p=>{if(p?.id)nodes[p.id]={...nodes[p.id],...p};};
  const edge=(a,b)=>{if(a&&b&&a!==b)parents.set(`${a}|${b}`,[a,b]);};
  const couple=(a,b)=>{if(a&&b&&a!==b)partners.set([a,b].sort().join('|'),[a,b]);};
  queue=Object.entries(ancestors).map(([id,d])=>[id,d]);
  while(queue.length){const [id,left]=queue.shift();if(expanded[id]>=left)continue;expanded[id]=left;
   const f=await family(id);if(!f)continue;add(f.person);
   for(const group of f.family.spouses){for(const p of [group.parent1,group.parent2])add(p);couple(group.parent1?.id,group.parent2?.id);
    if(left>0)for(const child of group.children){add(child);edge(group.parent1?.id,child.id);edge(group.parent2?.id,child.id);queue.push([child.id,left-1]);}
   }
  }
  // Link known children to known parents, without expanding the bounded tree.
  for(const id of Object.keys(expanded))for(const g of families[id]?.family.parents||[]){
   if(nodes[g.parent1?.id]&&nodes[g.parent2?.id])couple(g.parent1.id,g.parent2.id);
   for(const c of g.children)if(nodes[c.id])for(const p of [g.parent1,g.parent2])if(nodes[p?.id])edge(p.id,c.id);
  }
  await save('graph.json',{source:'FamilySearch MCP',root,readAt:new Date().toISOString(),ancestorDepth:4,ancestors,nodes,parents:[...parents.values()],partners:[...partners.values()],expanded});
  console.log(JSON.stringify({ancestors:Object.keys(ancestors).length,people:Object.keys(nodes).length,parentLinks:parents.size,couples:partners.size,errors:errors.length}));
 }
 if(phase==='memories'){
  const graph=await read('graph.json');const lists=await read('memories-by-person.json',{});const memories=await read('memories.json',{});
  for(const [id,p] of Object.entries(graph.nodes)){
   if(!lists[id]){try{let offset=0,items=[];while(true){const r=await call('get-person-memories',{personId:id,type:'photo',limit:200,offset});items.push(...r.memories);if(items.length>=r.totalMatching||!r.memories.length)break;offset+=r.memories.length;}lists[id]=items;await save('memories-by-person.json',lists);}catch(e){errors.push({personId:id,phase:'memories',error:e.message});lists[id]=[];await save('errors.json',errors);}}
   for(const memory of lists[id]){const old=memories[memory.memoryId];memories[memory.memoryId]={...memory,people:[...new Set([...(old?.people||[]),id])]};}
   if(++count%25===0)console.log(`Read photos for ${count}/${Object.keys(graph.nodes).length} people; ${Object.keys(memories).length} distinct Memories.`);
  }
  await save('memories.json',memories);console.log(JSON.stringify({people:Object.keys(lists).length,memories:Object.keys(memories).length,errors:errors.length}));
 }
 if(phase==='download'){
  const memories=await read('memories.json',{});const downloaded=await read('downloads.json',{});await mkdir(join(cache,'photos'),{recursive:true,mode:0o700});
  const pending=Object.values(memories).filter(m=>!downloaded[m.memoryId]);
  let checkpoint=Promise.resolve();
  const persist=()=>checkpoint=checkpoint.then(()=>save('downloads.json',downloaded)).then(()=>save('errors.json',errors));
  async function worker(){while(pending.length){const m=pending.shift();
   try{downloaded[m.memoryId]=await call('download-memory',{memoryId:m.memoryId,outputDir:join(cache,'photos'),filename:`familysearch-${m.memoryId}`});await persist();}catch(e){errors.push({memoryId:m.memoryId,phase:'download',error:e.message});await persist();}
   if(++count%20===0)console.log(`Downloaded ${Object.keys(downloaded).length}/${Object.keys(memories).length} photos.`);
  }}
  await Promise.all(Array.from({length:4},worker));
  console.log(JSON.stringify({downloaded:Object.keys(downloaded).length,total:Object.keys(memories).length,errors:errors.length}));
 }
}finally{await client.close();}
