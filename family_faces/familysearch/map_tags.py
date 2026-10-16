"""Map cached FamilySearch Memory tags to people through the running app, using its label lock.

Run after `node familysearch-bridge/scripts/read-tags.mjs DATA_DIR LIBRARY_DIR`, with the app open:
    python -m family_faces.familysearch.map_tags
"""
import argparse
from datetime import datetime, timezone
import json
import os
import uuid
from urllib.request import Request, urlopen

from family_faces import config

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run-id', help='Use the same run ID to resume an interrupted mapping.')
parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8765)), help='Port the app is running on.')
args = parser.parse_args()
data = config.DATA
cache = data/'familysearch-tags'
photos = json.loads((data/'photos.json').read_text())
memory_ids = {str(p['memory_id']) for p in photos if p.get('memory_id') and (config.LIBRARY/p['path']).is_file()}
memories = []
for mid in sorted(memory_ids):
    doc = json.loads((cache/'raw'/f'{mid}.json').read_text())
    if doc.get('memoryId') != mid or not isinstance(doc.get('people'), list):
        raise ValueError(f'The saved read for Memory {mid} is not valid.')
    memories.append(doc)
# Read-linked IDs and their aliases first. Unlinked names can then use those identities.
memories.sort(key=lambda m: not any(t.get('personId') for t in m['people']))
ids = [m['memoryId'] for m in memories]
run_id = args.run_id or datetime.now().strftime('tags-%Y%m%d-%H%M%S-')+uuid.uuid4().hex[:6]
print(json.dumps({'stage':'Map saved tags','runId':run_id,'memories':len(ids)}), flush=True)
report = {'source':'FamilySearch MCP','runId':run_id,'startedAt':datetime.now(timezone.utc).isoformat(),
          'memories':0,'photos':0,'tags':0,'mappedTags':0,'unlinkedTags':0,'ambiguousIdentities':0,
          'newPeople':[],'newFaceLabels':[],'manualFaceConflicts':[],'ambiguousFaces':0}
for index, start in enumerate(range(0,len(ids),150)):
    batch = ids[start:start+150]
    body = {'runId':run_id,'batchId':str(index),'memoryIds':batch}
    request = Request(f'http://localhost:{args.port}/api/familysearch-tags/import', data=json.dumps(body).encode(),
                      headers={'Content-Type':'application/json'}, method='POST')
    with urlopen(request, timeout=90) as response:
        result = json.load(response)
    if 'error' in result:
        raise ValueError(result['error'])
    for key, value in result.items():
        if isinstance(value,list): report[key].extend(value)
        else: report[key] += value
    print(json.dumps({'stage':'Map saved tags','done':min(start+150,len(ids)),'total':len(ids),
                      'mappedTags':report['mappedTags'],'newPeople':len(report['newPeople']),
                      'newFaceLabels':len(report['newFaceLabels'])}), flush=True)
report['finishedAt'] = datetime.now(timezone.utc).isoformat()
current = json.loads((data/'photos.json').read_text())
report['unresolvedTags'] = [{'photo':p['path'],'memoryId':p.get('memory_id'),
    'memoryPersonId':t.get('memory_person_id'),'name':t.get('name'), 'personId':t.get('familysearch_id')}
    for p in current if str(p.get('memory_id')) in memory_ids for t in p.get('tags',[])
    if t.get('tag_source')=='FamilySearch MCP' and not t.get('resolved')]
report['summary'] = {key:len(value) if isinstance(value,list) else value for key,value in report.items()
                     if key not in ('source','runId','startedAt','finishedAt','summary')}
report['summary']['sourceTagsWithoutTreeIds'] = sum(not t.get('personId') for m in memories for t in m['people'])
report['summary']['sourcePeopleWithTreeIds'] = len({t['personId'] for m in memories for t in m['people'] if t.get('personId')})
report['summary']['peopleFromUnlinkedTags'] = sum(not p.get('personId') for p in report['newPeople'])
report['backup'] = str(cache/'runs'/run_id/'before')
output = cache/'mapping-report.json'
temp = output.with_suffix('.tmp')
temp.write_text(json.dumps(report, indent=1)+'\n')
temp.chmod(0o600)
temp.replace(output)
print(json.dumps({'stage':'Tag mapping finished',**report['summary'],'report':str(output),'backup':report['backup']}), flush=True)
