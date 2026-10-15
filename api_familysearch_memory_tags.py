"""Local routes for adding selected tags to an existing FamilySearch photo."""
from familysearch_memory_tags import MemoryTags


def register(routes, app):
    service = MemoryTags(app.library.ROOT)

    def snapshot(path):
        with app.lock:
            return app.upload_snapshot(path), app.uploads.journal()

    def info(query):
        photo, journal = snapshot(query.get('photo', ''))
        return service.info(photo, journal)

    def write(body, confirm=False):
        if not isinstance(body, dict) or not isinstance(body.get('photo'), str):
            raise ValueError('Choose a photo from the library.')
        photo, journal = snapshot(body['photo'])
        return service.confirm(body, photo, journal) if confirm else service.preview(body, photo, journal)

    base = '/api/familysearch-memory-tags'
    routes['GET'][base + '/photo'] = info
    routes['POST'][base + '/preview'] = lambda body: write(body)
    routes['POST'][base + '/confirm'] = lambda body: write(body, True)
    app.BATCH_REFUSED.update({base + '/preview', base + '/confirm'})
