"""Preview and upload album photos through the FamilySearch MCP.

Only named faces selected by the user become tags. This does not infer identities.
"""
import hashlib
import json
import math
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

from PIL import Image, ImageOps

from family_faces import config

MCP_SCRIPT = config.FAMILYSEARCH_UPLOAD_SCRIPT
NODE = shutil.which('node') or 'node'


def call_mcp(payload):
    if not MCP_SCRIPT:
        raise ValueError('FamilySearch is not set up. Add "familysearch" to the settings file to use it.')
    result = subprocess.run([NODE, str(MCP_SCRIPT)], input=json.dumps(payload),
                            text=True, capture_output=True, timeout=260)
    try:
        data = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise ValueError('The MCP request did not finish. Check FamilySearch before you try an upload again.') from None
    if data.get('error'):
        raise ValueError(data['error'])
    return data


def face_rectangle(face, width, height):
    if abs(face.get('img_w', width) - width) > 2:
        raise ValueError('This photo changed since its faces were found. Scan it again before uploading.')
    x1, y1, x2, y2 = face['bbox']
    if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in (x1, y1, x2, y2)):
        raise ValueError('This face has no valid position in the photo.')
    x1, x2 = max(0, min(width, x1)), max(0, min(width, x2))
    y1, y2 = max(0, min(height, y1)), max(0, min(height, y2))
    if x2 <= x1 or y2 <= y1:
        raise ValueError('This face is outside the photo. Scan it again before uploading.')
    return dict(x=x1 / width, y=y1 / height, width=(x2-x1) / width, height=(y2-y1) / height)


def fingerprint(snapshot, face_ids):
    rows = []
    for face in snapshot['faces']:
        if face['id'] in face_ids:
            rows.append([face, snapshot['identities'].get(face.get('name'), {}).get('familysearch_id', '')])
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()


class Uploads:
    def __init__(self, root, data, mcp=call_mcp):
        self.root, self.data, self.mcp = Path(root), Path(data), mcp
        self.path = self.data / 'familysearch-uploads.json'
        self.previews = {}
        self.lock = threading.Lock()
        self.image_hashes = {}

    def journal(self):
        return json.loads(self.path.read_text()) if self.path.exists() else {}

    def write_journal(self, journal):
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps(journal, indent=2))
        temp.replace(self.path)

    def image_hash(self, path):
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if key not in self.image_hashes:
            with Image.open(path) as image:
                upright = ImageOps.exif_transpose(image).convert('RGB')
                digest = hashlib.sha256(f'{upright.width}x{upright.height}:RGB:'.encode())
                digest.update(upright.tobytes())
            self.image_hashes[key] = digest.hexdigest()
        return self.image_hashes[key]

    def previous_record(self, journal, source_sha, image_sha):
        if source_sha in journal:
            return source_sha, journal[source_sha]
        for key, record in journal.items():
            saved = record.get('image_sha')
            if not saved and record.get('photo'):
                path = (self.root / record['photo']).resolve()
                if self.root.resolve() in path.parents and path.is_file():
                    # A legacy record belongs to the bytes originally sent, not a replacement file.
                    if hashlib.sha256(path.read_bytes()).hexdigest() == key:
                        saved = self.image_hash(path)
            if saved == image_sha:
                return key, record
        return source_sha, None

    def statuses(self, photos):
        with self.lock:
            by_path = {record.get('photo'): record for record in self.journal().values()}
            return [dict(photo, upload_record=by_path.get(photo['path'])) for photo in photos]

    def photo_path(self, snapshot):
        item = snapshot['photo']
        if not item:
            raise ValueError('Choose a photo from the album.')
        if item.get('source') == 'FamilySearch' or item.get('memory_id'):
            raise ValueError('This photo is already from FamilySearch. Open its Memory to add tags there.')
        path = (self.root / item['path']).resolve()
        if self.root.resolve() not in path.parents or not path.is_file():
            raise ValueError('The album photo file is not available.')
        if path.stat().st_size > 15 * 1024 * 1024:
            raise ValueError('The photo exceeds the 15 MB upload limit.')
        return path

    def preview(self, body, snapshot):
        path = self.photo_path(snapshot)
        selections = body.get('faces', [])
        if not selections or len(selections) > 100:
            raise ValueError('Select 1 to 100 named faces to tag.')
        face_ids = [int(s['faceId']) for s in selections]
        if len(set(face_ids)) != len(face_ids):
            raise ValueError('Select each face only once.')
        source_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        image_sha = self.image_hash(path)
        with self.lock:
            record_key, previous = self.previous_record(self.journal(), source_sha, image_sha)
            memory_id = (previous or {}).get('result', {}).get('memoryId')
            repair = bool(memory_id and not previous.get('result', {}).get('tagsApplied'))
            if previous and not repair:
                return {'status': 'existing', 'previous': previous,
                        'note': 'This app already sent an upload for this photo. Check its Memory before uploading again.'}
        with Image.open(path) as image:
            upright = ImageOps.exif_transpose(image)
            width, height = upright.size
            upload_path = path
            if image.getexif().get(274, 1) != 1:
                # Keep face positions and uploaded pixels in the same upright frame.
                cache = self.data / 'upload-previews'
                cache.mkdir(exist_ok=True)
                upload_path = cache / f'{source_sha}.jpg'
                upright.convert('RGB').save(upload_path, quality=95)
        indexed = {f['id']: f for f in snapshot['faces']}
        tags, local = [], []
        import re
        for selection in selections:
            face = indexed.get(int(selection['faceId']))
            if not face or not face.get('name') or face['name'] == '_ignore':
                raise ValueError('Only named faces in this photo can be uploaded as tags.')
            person_id = selection.get('personId', '').strip().upper()
            if not re.fullmatch(r'[A-Z0-9]{4}-[A-Z0-9]{3}', person_id):
                raise ValueError(f"Enter a FamilySearch person ID for {face['name']} or clear that face's checkbox.")
            rectangle = face_rectangle(face, width, height)
            tags.append({'personId': person_id, 'rectangle': rectangle})
            local.append({'faceId': face['id'], 'name': face['name']})
        payload = {'filePath': str(upload_path), 'people': tags, 'title': body.get('title', ''),
                   'description': body.get('description', ''), 'dryRun': True}
        if repair:
            payload = {'action': 'tag-memory', 'memoryId': memory_id, 'people': tags, 'dryRun': True}
        result = self.mcp(payload)
        if result.get('status') != 'ready' or result.get('dryRun') is not True:
            raise ValueError('FamilySearch did not confirm the upload preview.')
        if repair:
            payload['expectedPlanHash'] = result['planHash']
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.previews = {k: v for k, v in self.previews.items() if v['expires'] > time.time()}
            self.previews[token] = {'payload': payload, 'source_sha': source_sha, 'image_sha': image_sha,
                'record_key': record_key, 'path': str(path),
                'fingerprint': fingerprint(snapshot, face_ids), 'face_ids': face_ids,
                'photo': snapshot['photo']['path'], 'expires': time.time() + 3600,
                'upload_sha': result.get('sha256') or hashlib.sha256(upload_path.read_bytes()).hexdigest(),
                'upload_path': str(upload_path), 'repair': repair, 'memory_id': memory_id}
        return {**result, 'previewToken': token, 'localFaces': local, 'uploadAction': 'tag-memory' if repair else 'upload'}

    def confirm(self, token, snapshot):
        # Serialise uploads, but do not hold the app's label lock during network requests.
        with self.lock:
            plan = self.previews.get(token)
            if not plan or plan['expires'] < time.time():
                raise ValueError('The preview expired. Check the photo and tags again.')
            if snapshot['photo']['path'] != plan['photo'] or fingerprint(snapshot, plan['face_ids']) != plan['fingerprint']:
                raise ValueError('The face labels or person links changed. Check the photo and tags again.')
            path = self.photo_path(snapshot)
            if hashlib.sha256(path.read_bytes()).hexdigest() != plan['source_sha'] or \
                    hashlib.sha256(Path(plan['upload_path']).read_bytes()).hexdigest() != plan['upload_sha']:
                raise ValueError('The photo changed. Check the photo and tags again.')
            journal = self.journal()
            record_key, previous = self.previous_record(journal, plan['source_sha'], plan['image_sha'])
            if plan['repair'] and (not previous or previous.get('result', {}).get('memoryId') != plan['memory_id']):
                raise ValueError('The upload record changed. Check the preview again.')
            if previous and (not plan['repair'] or previous.get('result', {}).get('tagsApplied')):
                return {'status': 'existing', 'previous': previous,
                        'note': 'This photo already has an upload record. Open its Memory before trying again.'}
            record = {**(previous or {}), 'photo': (previous or {}).get('photo', plan['photo']),
                      'image_sha': plan['image_sha'],
                      'status': 'tagging' if plan['repair'] else 'uploading', 'startedAt': time.time()}
            journal[record_key] = record
            self.write_journal(journal)
            del self.previews[token]
            try:
                result = self.mcp({**plan['payload'], 'dryRun': False})
                record.update(status=result.get('status', 'unknown'),
                              result={**((previous or {}).get('result', {}) if plan['repair'] else {}), **result})
                return result
            except Exception:
                record.update(status='unknown', note='The result is unknown. Check FamilySearch before trying again.')
                return {'status': 'unknown', 'note': record['note'],
                        'memoryId': plan['memory_id'], 'memoryUrl': (previous or {}).get('result', {}).get('memoryUrl')}
            finally:
                self.write_journal(journal)
