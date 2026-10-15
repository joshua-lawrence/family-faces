"""Browse full photos using confirmed person labels and source associations."""
import hashlib
import tempfile
from pathlib import Path

from PIL import Image, ImageOps


def gallery(photos, faces, names, associations=None, selected=(), mode='and', source='all', offset=0, limit=60):
    if mode not in ('and', 'or') or source not in ('all', 'album', 'familysearch'):
        raise ValueError('Choose AND or OR and a valid photo source.')
    if not 1 <= limit <= 120 or offset < 0 or len(selected) > 100:
        raise ValueError('The gallery page or person filter is not valid.')
    people_by_photo = {}
    for face in faces:
        name = names.get(str(face['id']))
        if name and name != '_ignore':
            people_by_photo.setdefault(face['photo'], set()).add(name)
    for name, linked in (associations or {}).items():
        if name and name != '_ignore':
            for item in linked:
                people_by_photo.setdefault(item['path'], set()).add(name)
    chosen = set(selected)
    rows, counts = [], {}
    for photo in photos:
        is_fs = photo.get('source') == 'FamilySearch' or bool(photo.get('memory_id'))
        if (source == 'album' and is_fs) or (source == 'familysearch' and not is_fs):
            continue
        people = people_by_photo.get(photo['path'], set())
        for name in people:
            counts[name] = counts.get(name, 0) + 1
        if chosen and not (chosen.issubset(people) if mode == 'and' else bool(chosen & people)):
            continue
        rows.append({'path': photo['path'], 'caption': photo.get('caption', ''), 'date': photo.get('date', ''),
                     'source': 'FamilySearch' if is_fs else 'Album', 'people': sorted(people)})
    return {'photos': rows[offset:offset+limit], 'total': len(rows), 'offset': offset, 'limit': limit,
            'mode': mode, 'source': source, 'selected': sorted(chosen), 'people': dict(sorted(counts.items())),
            'totalLibraryPhotos': len(photos)}


def thumbnail(item, root, cache):
    """Small upright preview; keep the original file unchanged."""
    root, cache = Path(root).resolve(), Path(cache)
    path = (root / (item.get('preview_path') or item['path'])).resolve()
    if root not in path.parents:
        raise ValueError('The photo is outside the album.')
    stat = path.stat()
    key = hashlib.sha256(f'{path}:{stat.st_mtime_ns}:{stat.st_size}:gallery-v1'.encode()).hexdigest()
    target = cache / f'{key}.jpg'
    if target.exists():
        return target
    cache.mkdir(parents=True, exist_ok=True)
    with Image.open(path) as image:
        upright = ImageOps.exif_transpose(image)
        upright.thumbnail((800, 800))
        preview = upright.convert('RGB')
        with tempfile.NamedTemporaryFile(dir=cache, suffix='.jpg', delete=False) as file:
            temp = Path(file.name)
        try:
            preview.save(temp, format='JPEG', quality=85)
            temp.replace(target)
        finally:
            temp.unlink(missing_ok=True)
    return target
