// Read Memory tags only through MCP tools. Cache private results with the album.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, mkdir, writeFile, rename, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dataArg, libraryArg] = process.argv.slice(2);
if (!dataArg || !libraryArg) throw new Error('Usage: node scripts/read-tags.mjs DATA_DIR LIBRARY_DIR');
const data = resolve(dataArg), library = resolve(libraryArg), cache = join(data, 'familysearch-tags', 'raw');
await mkdir(cache, { recursive:true, mode:0o700 });
const photos = JSON.parse(await readFile(join(data,'photos.json'),'utf8'));
const memories = new Set();
for (const photo of photos) {
  if ((!photo.memory_id && photo.source !== 'FamilySearch') || !photo.memory_id) continue;
  const candidates = [photo.path,photo.preview_path,photo.thumbnail_path].filter(Boolean);
  let exists = false;
  for (const path of candidates) {
    try { await access(join(library,path)); exists = true; break; } catch {}
  }
  if (exists) memories.add(String(photo.memory_id));
}
const pending = [], errors = {};
let cached = 0, completed = 0, read = 0, failed = 0, aborted = false, throttleMs = 0;
for (const id of memories) {
  try {
    const value = JSON.parse(await readFile(join(cache,`${id}.json`),'utf8'));
    if (value.memoryId === id && Array.isArray(value.people)) { cached++; continue; }
  } catch {}
  pending.push(id);
}
const base = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const client = new Client({name:'family-faces-read-tags',version:'1.0'});
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const progress = () => console.log(JSON.stringify({stage:'Read Memory tags',total:memories.size,cached,read,failed,pending:pending.length}));
async function persist(id,value) {
  const target = join(cache,`${id}.json`), temp = `${target}.tmp`;
  await writeFile(temp,JSON.stringify({...value,source:'FamilySearch MCP',readAt:new Date().toISOString()})+'\n',{mode:0o600});
  await rename(temp,target);
}
async function request(id) {
  const result = await client.callTool({name:'get-memory-people',arguments:{memoryId:id}},undefined,{timeout:45000});
  const text = result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n') || '';
  if (result.isError) throw new Error(text);
  const value = JSON.parse(text);
  if (value.memoryId !== id || !Array.isArray(value.people)) throw new Error('The MCP returned an invalid tag result.');
  return value;
}
async function worker() {
  while (pending.length && !aborted) {
    const id = pending.shift();
    try {
      let value;
      for (let attempt=0;attempt<3;attempt++) {
        if (throttleMs) await pause(throttleMs);
        try { value = await request(id); break; }
        catch(error) {
          if (/HTTP 401|not authenticated|sign in|required authentication/i.test(error.message)) { aborted=true; throw error; }
          const temporary = /HTTP (429|408|5\d\d)|failed or timed out/i.test(error.message);
          if (!temporary || attempt===2) throw error;
          if (/HTTP 429/.test(error.message)) throttleMs = Math.min(2000,throttleMs+500);
          await pause((attempt+1)*3000);
        }
      }
      await persist(id,value); read++;
    } catch(error) {
      errors[id]={memoryId:id,error:error.message,readAt:new Date().toISOString()}; failed++;
      if (aborted) console.log('The saved session was refused by FamilySearch. Tag reads stopped.');
    }
    completed++;
    if (completed%50===0) progress();
  }
}
progress();
try {
  if (pending.length) {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(base,'build/index.js')],stderr:'ignore'}));
    // Validate the saved session on the first real read before starting other workers.
    await workerOnce();
    if (!aborted) await Promise.all(Array.from({length:4},worker));
  }
} finally {
  await client.close();
  const report = {source:'FamilySearch MCP',finishedAt:new Date().toISOString(),total:memories.size,cached,read,failed,
    remaining:pending.length,aborted,errors:Object.values(errors)};
  await writeFile(join(cache,'..','read-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  progress();
  console.log(JSON.stringify({stage:'Tag reads finished',...report,errors:report.errors.length}));
  if (failed || aborted) process.exitCode=1;
}
async function workerOnce() {
  const id = pending.shift();
  try { await persist(id,await request(id));read++;completed++; }
  catch(error) {
    errors[id]={memoryId:id,error:error.message,readAt:new Date().toISOString()};failed++;completed++;
    if (/HTTP 401|not authenticated|sign in|required authentication/i.test(error.message)) aborted=true;
  }
}
