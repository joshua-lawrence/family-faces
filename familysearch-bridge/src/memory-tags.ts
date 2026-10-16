import { createHash } from 'node:crypto';
import { memoryPersonaSummary } from './memory-people.js';
import type { PhotoTag } from './photo-upload.js';

const ORIGIN = 'https://api.familysearch.org';
const TREE = 'http://familysearch.org/v1/FamilyTreePerson';
type Tag = PhotoTag & { personName: string };
type Persona = Parameters<typeof memoryPersonaSummary>[0] & { extracted?: boolean; media?: any[] };
type Credentials = { sessionId: string; userAgent: string };
export interface MemoryTagOptions { memoryId: string; people: PhotoTag[]; dryRun?: boolean; expectedPlanHash?: string }

export function validateMemoryId(id: string) {
  if (typeof id !== 'string' || !/^[A-Z0-9_-]{1,100}$/i.test(id)) throw new Error('Provide a valid FamilySearch Memory ID.');
  return id;
}

// The description link identifies the Memory. `about` can instead be a CDN image.
export function memoryDescription(data: any, memoryId: string): string {
  const source = data?.sourceDescriptions?.find((s: any) => s?.id === memoryId);
  const explicit = source?.links?.description?.href;
  const input = explicit || source?.about;
  try {
    const url = new URL(input);
    if (!['https://api.familysearch.org', 'https://familysearch.org', 'https://www.familysearch.org'].includes(url.origin) ||
        url.username || url.password) throw new Error();
    if (explicit) {
      if (url.pathname !== `/platform/memories/memories/${memoryId}` &&
          url.pathname !== `/platform/memories/memories/${memoryId}/description`) throw new Error();
      return url.origin + url.pathname;
    }
    if (!/^\/platform\/memories\/artifacts\/[A-Z0-9_-]+(?:\/description)?\/?$/.test(url.pathname)) throw new Error();
    return url.origin + url.pathname.replace(/\/$/, '').replace(/\/description$/, '') + '/description';
  } catch { throw new Error('FamilySearch returned an unexpected image reference.'); }
}

const normalizedName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
function overlap(a: PhotoTag['rectangle'], b: PhotoTag['rectangle']) {
  const w = Math.max(0, Math.min(a.x+a.width, b.x+b.width)-Math.max(a.x,b.x));
  const h = Math.max(0, Math.min(a.y+a.height, b.y+b.height)-Math.max(a.y,b.y));
  return w*h/(a.width*a.height);
}
function headers(c: Credentials) { return { Authorization: `Bearer ${c.sessionId}`,
  Accept: 'application/x-fs-v1+json', 'User-Agent': c.userAgent }; }
async function read(path: string, c: Credentials, empty = false): Promise<any> {
  let r: Response;
  try { r = await fetch(new URL(path, ORIGIN), { headers: headers(c), redirect: 'manual', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error('The FamilySearch tag read failed or timed out.'); }
  if (r.status === 204 && empty) return { persons: [] };
  if (r.status !== 200) { await r.body?.cancel(); throw new Error(`Could not read Memory tags (HTTP ${r.status}).`); }
  try { return await r.json(); } catch { throw new Error('FamilySearch returned an invalid tag response.'); }
}

export async function prepareMemoryTags(memoryId: string, tags: Tag[], c: Credentials) {
  validateMemoryId(memoryId);
  const base = `/platform/memories/memories/${memoryId}`;
  const description = memoryDescription(await read(base, c), memoryId);
  const data = await read(`${base}/personas`, c, true);
  if (!Array.isArray(data?.persons)) throw new Error('FamilySearch returned an invalid tag response.');
  const existing: Persona[] = data.persons;
  const used = new Set<string>();
  const actions = [];
  for (const tag of tags) {
    const matches = existing.filter(p => {
      const s = memoryPersonaSummary(p);
      return (s.personId === tag.personId || normalizedName(s.name) === normalizedName(tag.personName)) &&
        (!s.regions.length || s.regions.some(r => overlap(tag.rectangle, r) >= .5));
    });
    if (matches.length > 1) throw new Error(`More than one existing tag matches ${tag.personName}. Check the Memory before changing its tags.`);
    let existingPerson = matches[0];
    if (existingPerson) {
      if (!existingPerson.id || !/^[A-Z0-9_-]{1,150}$/i.test(existingPerson.id) || used.has(existingPerson.id)) {
        throw new Error('Two selected faces match the same tag. Check the Memory before changing its tags.');
      }
      // A single-person read includes Tree links, including links omitted by the list endpoint.
      const detail = await read(`${base}/personas/${existingPerson.id}`, c);
      existingPerson = detail?.persons?.find((p: Persona) => p.id === existingPerson.id);
      if (!existingPerson) throw new Error('An existing Memory tag could not be checked.');
      const s = memoryPersonaSummary(existingPerson);
      if (normalizedName(s.name) !== normalizedName(tag.personName) && s.personId !== tag.personId) throw new Error('A Memory tag changed. Check the preview again.');
      if (s.personId && s.personId !== tag.personId) throw new Error(`The tag for ${tag.personName} is linked to another person. Check the Memory first.`);
      used.add(existingPerson.id!);
    }
    const s = existingPerson && memoryPersonaSummary(existingPerson);
    const person = existingPerson ? {
      id: existingPerson.id, extracted: true, names: existingPerson.names,
      identifiers: { ...existingPerson.identifiers, [TREE]: [`https://familysearch.org/ark:/61903/4:1:${tag.personId}`] },
      media: existingPerson.media?.map(m => ({ ...m, description })) || [],
    } : { extracted: true, names: [{ nameForms: [{ fullText: tag.personName }] }],
      identifiers: { [TREE]: [`https://familysearch.org/ark:/61903/4:1:${tag.personId}`] },
      media: [{ description, qualifiers: [{ name: 'http://gedcomx.org/RectangleRegion',
        value: [tag.rectangle.x, tag.rectangle.y, tag.rectangle.width, tag.rectangle.height].map(n => Number(n.toFixed(6))).join(',') }] }] };
    actions.push({ action: s?.personId === tag.personId ? 'keep' : existingPerson ? 'link' : 'create', tag, person });
  }
  const planHash = createHash('sha256').update(JSON.stringify(actions)).digest('hex');
  return { memoryId, base, actions, planHash, people: tags,
    memoryUrl: `https://www.familysearch.org/en/memories/memory/${memoryId}` };
}

export async function applyMemoryTags(plan: Awaited<ReturnType<typeof prepareMemoryTags>>, c: Credentials) {
  let applied = 0;
  const partial = (note: string) => ({ status: 'partial', memoryId: plan.memoryId, memoryUrl: plan.memoryUrl,
    tagsApplied: false, people: plan.people, tagsConfirmed: applied,
    note: `${note} Open the Memory to check its tags. The photo was not uploaded again.` });
  // Each existing tag is updated in place. Unselected tags are never changed.
  const operations = plan.actions.filter(a => a.action !== 'create').map(a => ({
    path: `${plan.base}/personas/${a.person.id}`, persons: [a.person], keep: a.action === 'keep',
  }));
  const creates = plan.actions.filter(a => a.action === 'create');
  if (creates.length) operations.push({ path: `${plan.base}/personas`, persons: creates.map(a => a.person), keep: false });
  for (const op of operations) {
    if (op.keep) { applied += op.persons.length; continue; }
    try {
      const r = await fetch(new URL(op.path, ORIGIN), { method: 'POST', headers: { ...headers(c), 'Content-Type': 'application/x-fs-v1+json' },
        redirect: 'manual', signal: AbortSignal.timeout(60_000), body: JSON.stringify({ persons: op.persons }) });
      await r.body?.cancel();
      if (![201,204].includes(r.status)) return partial(`FamilySearch did not confirm the tags (HTTP ${r.status}). No retry was sent.`);
      applied += op.persons.length;
    } catch { return partial('The tag request failed or timed out. Its result is unknown. No retry was sent.'); }
  }
  return { status: 'uploaded', memoryId: plan.memoryId, memoryUrl: plan.memoryUrl, tagsApplied: true,
    people: plan.people, tagsConfirmed: applied, attachedToPerson: true };
}
