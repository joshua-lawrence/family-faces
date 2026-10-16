import { prepareMemoryTags, applyMemoryTags } from './memory-tags.js';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

// FamilySearch Help: JPEG, PNG, TIFF and BMP photos, up to 15 MB.
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const API_ORIGIN = 'https://api.familysearch.org';
const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp',
};

export interface PhotoUploadOptions {
  personId: string;
  filePath: string;
  title?: string;
  description?: string;
  dryRun?: boolean;
}

export interface PhotoTag {
  personId: string;
  rectangle: { x: number; y: number; width: number; height: number };
}

export interface TaggedPhotoOptions {
  filePath: string;
  people: PhotoTag[];
  title?: string;
  description?: string;
  dryRun?: boolean;
}

export function validatePhotoTags(tags: PhotoTag[]): PhotoTag[] {
  if (!Array.isArray(tags) || !tags.length || tags.length > 100) throw new Error('Select 1 to 100 face tags.');
  return tags.map(tag => {
    const personId = tag.personId?.trim().toUpperCase();
    if (!personId || !/^[A-Z0-9]{4}-[A-Z0-9]{3}$/.test(personId)) throw new Error('Each face tag needs a FamilySearch person ID.');
    const r = tag.rectangle;
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 ||
        r.width <= 0 || r.height <= 0 || r.x + r.width > 1.000001 || r.y + r.height > 1.000001) {
      throw new Error('Each face rectangle must be inside the photo, with coordinates from 0 to 1.');
    }
    return { personId, rectangle: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
}

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
      bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) return 'image/tiff';
  if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  return undefined;
}

export async function preparePhotoUpload(options: PhotoUploadOptions) {
  const personId = options.personId.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{3}$/.test(personId)) throw new Error('Provide a FamilySearch person ID such as ABCD-123.');
  const input = options.filePath.startsWith('~/') ? join(homedir(), options.filePath.slice(2)) : options.filePath;
  if (!isAbsolute(input)) throw new Error('Provide an absolute local photo path or a path that starts with ~/.');
  const filePath = resolve(input);
  const filename = basename(filePath);
  const expectedMime = TYPES[extname(filename).toLowerCase()];
  if (!expectedMime) throw new Error('Choose a JPEG, PNG, TIFF, or BMP photo.');
  const file = await open(filePath, 'r');
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size) throw new Error('Choose a non-empty photo file.');
    if (stat.size > MAX_PHOTO_BYTES) throw new Error('The photo exceeds the 15 MB upload limit.');
    // A fixed buffer bounds memory use even if another process grows the file.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await file.read(buffer, length, buffer.length - length, null);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    if (length !== stat.size) throw new Error('The photo changed while it was read. Try again with a stable file.');
    bytes = buffer.subarray(0, length);
  } finally {
    await file.close();
  }
  const mimeType = imageMime(bytes);
  if (!mimeType || mimeType !== expectedMime) throw new Error('The file content does not match its photo file extension.');
  const title = options.title === undefined ? basename(filename, extname(filename)) : options.title.trim();
  if (!title || title.length > 250) throw new Error('The photo title must have 1 to 250 characters.');
  const description = options.description?.trim() || '';
  if (description.length > 2000) throw new Error('The description must have 2000 characters or fewer.');
  return { personId, filePath, filename, mimeType, bytes, title, description,
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

export type PreparedPhotoUpload = Awaited<ReturnType<typeof preparePhotoUpload>>;

export function photoUploadPreview(photo: PreparedPhotoUpload, personName: string) {
  return { personId: photo.personId, personName, filePath: photo.filePath, filename: photo.filename,
    mimeType: photo.mimeType, bytes: photo.bytes.length, sha256: photo.sha256,
    title: photo.title, description: photo.description,
    personMemoriesUrl: `https://www.familysearch.org/en/tree/person/memories/${photo.personId}` };
}

function createdMemoryId(response: Response): string | null {
  const entityId = response.headers.get('x-entity-id');
  if (entityId && /^[A-Z0-9_-]+$/i.test(entityId)) return entityId;
  const location = response.headers.get('location');
  if (!location) return null;
  try {
    const url = new URL(location, API_ORIGIN);
    if (url.origin !== API_ORIGIN || url.username || url.password) return null;
    return url.pathname.match(/^\/platform\/memories\/memories\/([A-Z0-9_-]+)\/?$/i)?.[1] || null;
  } catch {
    return null;
  }
}

export async function uploadPreparedPhoto(photo: PreparedPhotoUpload, personName: string,
  credentials: { sessionId: string; userAgent: string }, attachToPerson = true) {
  if (!credentials.sessionId) throw new Error('The saved browser session has no FamilySearch access token. Sign in with login-with-browser.');
  const url = new URL(attachToPerson ? `/platform/tree/persons/${photo.personId}/memories` : '/platform/memories/memories', API_ORIGIN);
  for (const [key, value] of Object.entries({ type: 'Photo', filename: photo.filename, title: photo.title,
    description: photo.description, personName: attachToPerson ? personName : '' })) {
    if (value) url.searchParams.set(key, value);
  }
  const fallbackName = photo.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encodedName = encodeURIComponent(photo.filename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${credentials.sessionId}`, Accept: 'application/x-fs-v1+json',
        'Content-Type': photo.mimeType,
        'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
        'User-Agent': credentials.userAgent },
      body: new Uint8Array(photo.bytes),
    });
  } catch {
    throw new Error('The upload request failed or timed out. Its result is unknown. Check the person’s Memories before you try again.');
  }
  // Do not follow redirects or retry a write: a second request could create a duplicate.
  if (response.status !== 201) {
    await response.body?.cancel();
    const unknown = response.ok || response.status >= 500 || response.status === 408;
    throw new Error(`FamilySearch did not confirm the upload (HTTP ${response.status}). ` +
      (unknown ? 'Its result is unknown. Check the person’s Memories before you try again.' :
        'Check your session, access to the person, and FamilySearch upload requirements. No retry was sent.'));
  }
  const memoryId = createdMemoryId(response);
  await response.body?.cancel();
  return { status: 'uploaded', dryRun: false, ...photoUploadPreview(photo, personName), memoryId,
    memoryUrl: memoryId ? `https://www.familysearch.org/en/memories/memory/${encodeURIComponent(memoryId)}` : null,
    attachedToPerson: attachToPerson,
    ...(memoryId ? {} : { note: 'FamilySearch confirmed creation but returned no Memory ID. Check the person’s Memories before uploading again.' }) };
}

// Upload first, then create all face tags on that one Memory. Never retry a write.
export async function uploadPreparedTaggedPhoto(photo: PreparedPhotoUpload,
  tags: Array<PhotoTag & { personName: string }>, credentials: { sessionId: string; userAgent: string }) {
  const uploaded = await uploadPreparedPhoto(photo, tags[0].personName, credentials, false);
  const partial = (note: string) => ({ ...uploaded, status: 'partial', tagsApplied: false, people: tags,
    galleryUrl: 'https://www.familysearch.org/en/memories/gallery',
    note: `${note} The photo was uploaded. Open its Memory to check or finish the tags. Do not upload the photo again.` });
  if (!uploaded.memoryId) return partial('FamilySearch returned no Memory ID.');
  try {
    const plan = await prepareMemoryTags(uploaded.memoryId, tags, credentials);
    const result = await applyMemoryTags(plan, credentials);
    if ('note' in result) return { ...uploaded, ...result, note: `${result.note} The photo was uploaded. Do not upload the photo again.` };
    return { ...uploaded, ...result };
  } catch (error) {
    const message = error instanceof Error && error.message === 'FamilySearch returned an unexpected image reference.'
      ? error.message : 'Could not check the uploaded Memory tags. No tag write was sent.';
    return partial(message);
  }
}
