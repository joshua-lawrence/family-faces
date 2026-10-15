"""Submit selected tags to an existing Memory through the FamilySearch MCP."""
import hashlib
import re
import secrets
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageOps
from familysearch_upload import call_mcp, face_rectangle, fingerprint


def memory_target(photo, journal=None):
    for item in [photo, *photo.get('tags', [])]:
        value = str(item.get('memory_id') or '')
        if re.fullmatch(r'[A-Z0-9_-]{1,100}', value, re.I):
            return value
        url = urlparse(item.get('source_url') or '')
        match = re.fullmatch(r'/en/memories/memory/([A-Z0-9_-]{1,100})/?', url.path, re.I)
        if url.scheme == 'https' and url.hostname in ('www.familysearch.org', 'familysearch.org') and not url.username and match:
            return match[1]
    for record in (journal or {}).values():
        value = str((record.get('result') or {}).get('memoryId') or '')
        if record.get('photo') == photo.get('path') and re.fullmatch(r'[A-Z0-9_-]{1,100}', value, re.I):
            return value
    return None


class MemoryTags:
    def __init__(self, root, mcp=call_mcp):
        self.root, self.mcp = Path(root).resolve(), mcp
        self.previews = {}
        self.lock = threading.Lock()

    def target(self, snapshot, journal):
        memory_id = memory_target(snapshot['photo'], journal)
        if not memory_id:
            raise ValueError('This photo has no saved FamilySearch Memory. Open a downloaded FamilySearch photo or a photo uploaded from this app.')
        path = (self.root / snapshot['photo']['path']).resolve()
        if self.root not in path.parents or not path.is_file():
            raise ValueError('The photo file is not available. Reload the library and try again.')
        return memory_id, path

    def info(self, snapshot, journal):
        memory_id, _ = self.target(snapshot, journal)
        faces = sorted(snapshot['faces'], key=lambda f: (f['bbox'][0] + f['bbox'][2], f['id']))
        return {'photo': snapshot['photo']['path'], 'memoryId': memory_id,
                'memoryUrl': f'https://www.familysearch.org/en/memories/memory/{memory_id}',
                'faces': [{'id': f['id'], 'number': i + 1, 'name': f['name'],
                           'personId': snapshot['identities'].get(f['name'], {}).get('familysearch_id', '')}
                          for i, f in enumerate(faces) if f.get('name') and f['name'] != '_ignore']}

    def preview(self, body, snapshot, journal):
        memory_id, path = self.target(snapshot, journal)
        selections = body.get('faces')
        if not isinstance(selections, list) or not 1 <= len(selections) <= 100:
            raise ValueError('Select 1 to 100 named faces to tag.')
        indexed = {f['id']: f for f in snapshot['faces']}
        ids, tags, local = [], [], []
        with Image.open(path) as image:
            width, height = ImageOps.exif_transpose(image).size
        for selected in selections:
            if not isinstance(selected, dict) or type(selected.get('faceId')) is not int:
                raise ValueError('Select a named face from this photo.')
            fid = selected['faceId']
            face = indexed.get(fid)
            if fid in ids or not face or not face.get('name') or face['name'] == '_ignore':
                raise ValueError('Select each named face from this photo only once.')
            person_id = str(selected.get('personId') or '').strip().upper()
            if not re.fullmatch(r'[A-Z0-9]{4}-[A-Z0-9]{3}', person_id):
                raise ValueError(f"Enter a FamilySearch person ID for {face['name']} or clear its checkbox.")
            ids.append(fid)
            tags.append({'personId': person_id, 'rectangle': face_rectangle(face, width, height)})
            local.append({'faceId': fid, 'name': face['name']})
        payload = {'action': 'tag-memory', 'memoryId': memory_id, 'people': tags, 'dryRun': True}
        result = self.mcp(payload)
        if result.get('status') != 'ready' or result.get('dryRun') is not True or not result.get('planHash'):
            raise ValueError('FamilySearch did not confirm the tag preview. Check the Memory and try again.')
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.previews = {k: v for k, v in self.previews.items() if v['expires'] > time.time()}
            self.previews[token] = {'payload': {**payload, 'expectedPlanHash': result['planHash']},
                'photo': snapshot['photo']['path'], 'memory_id': memory_id, 'face_ids': ids,
                'fingerprint': fingerprint(snapshot, ids), 'sha': hashlib.sha256(path.read_bytes()).hexdigest(),
                'expires': time.time() + 1200}
        return {**result, 'previewToken': token, 'localFaces': local}

    def confirm(self, body, snapshot, journal):
        with self.lock:
            plan = self.previews.get(body.get('previewToken'))
            if not plan or plan['expires'] < time.time():
                raise ValueError('The tag preview expired. Check the selected tags again.')
            memory_id, path = self.target(snapshot, journal)
            if memory_id != plan['memory_id'] or snapshot['photo']['path'] != plan['photo'] or \
                    fingerprint(snapshot, plan['face_ids']) != plan['fingerprint'] or \
                    hashlib.sha256(path.read_bytes()).hexdigest() != plan['sha']:
                raise ValueError('The photo, face names, or person links changed. Check the selected tags again.')
            del self.previews[body['previewToken']]
            try:
                return self.mcp({**plan['payload'], 'dryRun': False})
            except Exception:
                return {'status': 'unknown', 'tagsApplied': False, 'memoryId': memory_id,
                        'memoryUrl': f'https://www.familysearch.org/en/memories/memory/{memory_id}',
                        'note': 'The tag result is unknown. Open the Memory to check its tags before trying again. No photo was uploaded.'}
