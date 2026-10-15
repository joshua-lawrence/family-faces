"""Merge a reviewed FamilySearch MCP export into the local photo library."""
from pathlib import Path
import argparse, hashlib, json, re, shutil, datetime
from family_faces import config

def read(path, fallback=None):
 return json.loads(path.read_text()) if path.exists() else fallback

def atomic(path,value):
 tmp=path.with_name(path.name+'.familysearch.tmp')
 tmp.write_text(json.dumps(value,indent=1,ensure_ascii=False)+'\n');tmp.replace(path)

def year(text):
 m=re.search(r'\b(\d{4})\b',text or '');return m.group(1) if m else ''

def prepare(app,cache):
 data=config.DATA;graph=read(cache/'graph.json');matches=read(cache/'matches.json',[])
 tree=read(data/'tree.json',{'people':{},'parents':[],'partners':[]})
 labels=read(data/'labels.json',{'names':{},'rejected':[]});identities=read(data/'people.json',{})
 photos=read(data/'photos.json',[]);families=read(cache/'families.json',{});caption_links=read(cache/'caption-associations.json',[])
 nodes=graph['nodes'];mapping={};reasons={m['personId']:m for m in matches}
 old_to_id={n:v['familysearch_id'] for n,v in identities.items() if v.get('familysearch_id') in nodes}
 old_to_id.update({m['local']:m['personId'] for m in matches})
 used=set(tree['people'])|set(labels['names'].values());used-=set(old_to_id)
 # Prefer reviewed existing identities when full names are shared by two records.
 ordered=sorted(nodes,key=lambda x:(x not in reasons,x not in graph['ancestors'],x))
 for pid in ordered:
  if not re.fullmatch(r'[A-Z0-9]+-[A-Z0-9]+',pid):continue
  name=nodes[pid].get('name','').strip()
  if not name:continue
  canonical=name if name not in used else f'{name} ({pid})'
  mapping[pid]=canonical;used.add(canonical)
 renames={old:mapping[pid] for old,pid in old_to_id.items() if pid in mapping}
 new_tree={'people':{},'parents':[],'partners':[]}
 for name,p in tree['people'].items():new_tree['people'][renames.get(name,name)]=dict(p)
 new_labels={**labels,'names':{fid:renames.get(n,n) for fid,n in labels['names'].items()}}
 new_info={renames.get(n,n):dict(v) for n,v in identities.items()}
 for link in caption_links:
  for subject in link['people']:
   name=renames.get(subject['name'],subject['name'])
   if name in new_tree['people']:
    entry=new_info.setdefault(name,{});entry['aliases']=list(dict.fromkeys(entry.get('aliases',[])+[subject['alias']]))
 conflicts=[]
 for pid,name in mapping.items():
  p=families.get(pid,{}).get('person',nodes[pid]);entry=new_tree['people'].setdefault(name,{'born':'','died':'','sex':''})
  life=re.findall(r'\b\d{4}\b',p.get('lifespan',''));birth=p.get('birth',{});death=p.get('death',{})
  facts={'born':year(birth.get('date','')) or (life[0] if life else ''),
    'died':'' if p.get('living') else (year(death.get('date','')) or (life[1] if len(life)>1 else '')),
    'sex':{'MALE':'M','FEMALE':'F'}.get(p.get('gender',''),'')}
  for key,value in facts.items():
   if not entry.get(key):entry[key]=value
   elif value and entry[key]!=value:conflicts.append({'personId':pid,'name':name,'field':key,'local':entry[key],'familysearch':value})
  info=new_info.setdefault(name,{})
  old_names=[m['local'] for m in matches if m['personId']==pid and m['local']!=name]
  info['aliases']=list(dict.fromkeys(info.get('aliases',[])+old_names+([p['name']] if p.get('name')!=name else [])))
  info['familysearch_id']=pid;info['familysearch']={**p,'source_url':f'https://www.familysearch.org/en/tree/person/details/{pid}',
    'read_at':graph['readAt'],'match_reason':reasons.get(pid,{}).get('reason','New FamilySearch person')}
  info['aliases']=[a for a in info['aliases'] if a and a!=name]
 # Preserve explicit step and adoptive parent roles from the source.
 roles={}
 for family in families.values():
  for kind in ['parents','spouses']:
   for group in family.get('family',{}).get(kind,[]):
    for child in group.get('children',[]):
     if child.get('id') not in mapping:continue
     for lineage in child.get('lineage') or []:
      if lineage.get('title') not in ['STEP','ADOPTIVE']:continue
      parent_id=lineage.get('parentId') or (group.get('parent1',{}).get('id') if lineage.get('type')=='PARENT1_LINEAGE' else group.get('parent2',{}).get('id'))
      if parent_id in mapping:
       roles[(child['id'],parent_id)]={'parentId':parent_id,'name':mapping[parent_id],'type':lineage['title']}
 for pid,name in mapping.items():
  new_info[name]['familysearch']['parent_relations']=[r for (child,_),r in roles.items() if child==pid]
 def edge_merge(kind):
  edges={tuple(renames.get(n,n) for n in e) for e in tree[kind]}
  edges.update(tuple(mapping[n] for n in e) for e in graph[kind] if all(n in mapping for n in e))
  if kind=='partners':edges={tuple(sorted(e)) for e in edges}
  return [list(e) for e in sorted(edges) if e[0]!=e[1] and all(n in new_tree['people'] for n in e)]
 new_tree['parents']=edge_merge('parents');new_tree['partners']=edge_merge('partners')
 # Parent cycles indicate an identity error; stop before changing the library.
 children={}
 for p,c in new_tree['parents']:children.setdefault(p,[]).append(c)
 visiting=set();done=set()
 def visit(n):
  if n in visiting:raise ValueError('Parent cycle: '+n)
  if n in done:return
  visiting.add(n)
  for c in children.get(n,[]):visit(c)
  visiting.remove(n);done.add(n)
 for n in new_tree['people']:visit(n)
 for photo in photos:
  for tag in photo.get('tags',[]):
   if tag.get('resolved') in renames:tag['resolved']=renames[tag['resolved']]
 report={'old_people':len(tree['people']),'people':len(new_tree['people']),'new_people':len(set(new_tree['people'])-set(renames.get(n,n) for n in tree['people'])),
  'matched_existing':len(matches),'renamed':len([x for x,y in renames.items() if x!=y]),'parent_links':len(new_tree['parents']),
  'couples':len(new_tree['partners']),'ancestors':len(graph['ancestors']),'facts_kept_for_review':conflicts,
  'step_or_adoptive_links':len(roles),'root_name':mapping[graph['root']]}
 return new_tree,new_labels,new_info,photos,mapping,report

def main():
 parser=argparse.ArgumentParser();parser.add_argument('app',type=Path);parser.add_argument('cache',type=Path);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 app=args.app.resolve();cache=args.cache.resolve();root=config.LIBRARY;data=config.DATA
 tree,labels,info,photos,mapping,report=prepare(app,cache)
 report['photos_added']=0;report['photos_reused']=0;report['photo_associations']=0
 caption_links=read(cache/'caption-associations.json',[])
 downloads=read(cache/'downloads.json',{});fallbacks=read(cache/'fallbacks.json',{});downloads.update(fallbacks);memories=read(cache/'memories.json',{})
 previews=read(cache/'previews.json',{});thumbnails=read(cache/'thumbnails.json',{})
 by_memory={str(p.get('memory_id')):p for p in photos if p.get('memory_id')};by_sha={p['sha256']:p for p in photos}
 batch='FamilySearch '+datetime.date.today().isoformat();copies=[]
 for mid,dl in downloads.items():
  memory=memories[mid];src=Path(dl['path']);h=hashlib.sha256()
  with src.open('rb') as f:
   for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
  sha=h.hexdigest();photo=by_memory.get(mid) or by_sha.get(sha)
  if photo:report['photos_reused']+=1
  else:
   filename=src.name + ('.bmp' if not src.suffix and dl.get('mimeType')=='image/bmp' else '')
   rel=Path('Added photos')/batch/filename
   photo={'path':str(rel),'sha256':sha,'batch':batch,'order':len(photos),'caption':memory.get('title') or memory.get('description') or '',
    'date':'','mime_type':dl['mimeType'],'source':'FamilySearch','source_url':memory['pageUrl'],'memory_id':mid,'original_available':dl.get('variant','original')=='original','tags':[]}
   photos.append(photo);by_sha[sha]=photo;by_memory[mid]=photo;copies.append((src,root/rel));report['photos_added']+=1
  if mid in previews:
   preview=previews[mid];preview_rel=Path('Added photos')/batch/'previews'/preview['filename']
   photo['preview_path']=str(preview_rel);copies.append((Path(preview['path']),root/preview_rel))
  if mid in thumbnails:
   thumbnail=thumbnails[mid];thumbnail_rel=Path('Added photos')/batch/'thumbnails'/thumbnail['filename']
   photo['thumbnail_path']=str(thumbnail_rel);copies.append((Path(thumbnail['path']),root/thumbnail_rel))
  tags=photo.setdefault('tags',[])
  for pid in memory['people']:
   if pid not in mapping:continue
   if not any(t.get('familysearch_id')==pid for t in tags):
    tags.append({'name':mapping[pid],'familysearch_id':pid,'resolved':mapping[pid],'face':None,'box':None,
      'association':'FamilySearch person Memory','memory_id':mid,'source_url':memory['pageUrl']});report['photo_associations']+=1
 for link in caption_links:
  photo=by_memory.get(link['memoryId'])
  if not photo:continue
  for subject in link['people']:
   name=subject['name']
   if name not in tree['people']:continue
   tags=photo.setdefault('tags',[])
   if not any(t.get('resolved')==name for t in tags):
    tags.append({'name':subject['alias'],'resolved':name,'face':None,'box':None,'association':'FamilySearch Memory caption',
     'memory_id':link['memoryId'],'source_url':memories[link['memoryId']]['pageUrl'],'reason':link['reason']});report['photo_associations']+=1
 report['caption_associations']=sum(1 for p in photos for t in p.get('tags',[]) if t.get('association')=='FamilySearch Memory caption')
 report['photos_total']=len(photos);report['preview_only_memories']=[mid for mid,entry in fallbacks.items() if entry.get('variant')!='original'];report['download_errors']=[e for e in read(cache/'errors.json',[]) if e.get('phase')=='download']
 atomic(cache/'import-report.json',report);atomic(cache/'canonical-names.json',mapping)
 if not args.apply:print(json.dumps(report,indent=2));return
 stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
 backup=data/'backups'/('familysearch-'+stamp);backup.mkdir(parents=True)
 for filename in ['tree.json','labels.json','people.json','photos.json','familysearch-sync.json']:
  if (data/filename).exists():shutil.copy2(data/filename,backup/filename)
 for src,dest in copies:
  dest.parent.mkdir(parents=True,exist_ok=True)
  if dest.exists():
   if hashlib.sha256(dest.read_bytes()).hexdigest()!=hashlib.sha256(src.read_bytes()).hexdigest():raise ValueError('Destination already has a different file: '+str(dest))
  else:shutil.copy2(src,dest)
 atomic(data/'tree.json',tree);atomic(data/'labels.json',labels);atomic(data/'people.json',info);atomic(data/'photos.json',photos)
 atomic(data/'familysearch-sync.json',{'report':report,'backup':str(backup),'names':mapping,'source':'FamilySearch MCP'})
 print(json.dumps({k:v for k,v in report.items() if k not in ['facts_kept_for_review','download_errors']},indent=2));print('Backup:',backup)

if __name__=='__main__':main()
