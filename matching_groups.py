"""Cache separate groups per source branch. Filters never rewrite saved names."""

import hashlib
import json
from pathlib import Path
import threading

import cluster
import config

DATA = config.DATA
_jobs = {}
_jobs_lock = threading.Lock()
_build_lock = threading.Lock()


def cache_path(scope, face_count, threshold):
    stamp = (DATA / 'embeddings.npy').stat().st_mtime_ns
    signature = json.dumps([face_count, stamp, threshold, sorted(scope.allowed_paths)])
    key = hashlib.sha256(signature.encode()).hexdigest()[:20]
    return DATA / 'matching-groups' / f'{scope.branch}-{key}.json'


def prepare(scope, face_count, labels, threshold):
    path = cache_path(scope, face_count, threshold)
    path.parent.mkdir(parents=True, exist_ok=True)
    named = {int(fid) for fid in labels['names']} | set(labels.get('rejected', []))
    with _build_lock:
        if not path.exists():
            cluster.build(named, threshold, scope=scope, data_dir=DATA, output=path)
    doc = json.loads(path.read_text())
    if doc.get('face_count') != face_count:
        raise ValueError('Face data changed while groups were built. Refresh the view.')
    return path


_read = {}   # path -> ((mtime, size), doc): each cache file is parsed once per version


def read(path):
    st = path.stat()
    stamp = (st.st_mtime_ns, st.st_size)
    hit = _read.get(path)
    if hit and hit[0] == stamp:
        return hit[1]
    doc = json.loads(path.read_text())
    if len(_read) > 8:
        _read.clear()
    _read[path] = (stamp, doc)
    return doc


def get(scope, faces, labels, threshold):
    """The groups for a branch: ({clusters, ...}, building, error). Read-only: don't change what it returns."""
    path = cache_path(scope, len(faces), threshold)
    if path.exists():
        return read(path), False, ''
    with _jobs_lock:
        job = _jobs.get(path)
        if job:
            if job['error']:
                error = job['error']
                del _jobs[path]
                return {'clusters': [], 'unclustered': []}, False, error
            return {'clusters': [], 'unclustered': []}, True, ''
        _jobs[path] = {'error': ''}
    snapshot = {'names': dict(labels['names']), 'rejected': list(labels.get('rejected', []))}

    def run():
        try:
            prepare(scope, len(faces), snapshot, threshold)
            with _jobs_lock:
                _jobs.pop(path, None)
        except Exception as exc:
            with _jobs_lock:
                _jobs[path] = {'error': str(exc)}

    threading.Thread(target=run, daemon=True).start()
    return {'clusters': [], 'unclustered': []}, True, ''
