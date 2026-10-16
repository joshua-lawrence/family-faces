interface MemoryPersona {
  id?: string;
  display?: { name?: string };
  names?: { nameForms?: { fullText?: string }[] }[];
  identifiers?: Record<string, string[]>;
  media?: { qualifiers?: { name?: string; value?: string }[] }[];
}

const TREE_ID = 'http://familysearch.org/v1/FamilyTreePerson';
const REGION = 'http://gedcomx.org/RectangleRegion';

function treePersonId(value: string): string | null {
  if (/^[A-Z0-9]{4}-[A-Z0-9]{3}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['familysearch.org', 'www.familysearch.org'].includes(url.hostname) || url.username || url.password) return null;
    return url.pathname.match(/^\/ark:\/61903\/4:1:([A-Z0-9]{4}-[A-Z0-9]{3})\/?$/)?.[1] || null;
  } catch { return null; }
}

export function memoryPersonaSummary(person: MemoryPersona) {
  const identifiers = person.identifiers?.[TREE_ID];
  const personId = Array.isArray(identifiers) ? identifiers.filter(x => typeof x === 'string').map(treePersonId).find(Boolean) || null : null;
  const nameForms = Array.isArray(person.names) ? person.names.flatMap(n => Array.isArray(n.nameForms) ? n.nameForms : []) : [];
  const name = typeof person.display?.name === 'string' ? person.display.name
    : nameForms.find(n => typeof n.fullText === 'string')?.fullText || '';
  const media = Array.isArray(person.media) ? person.media : [];
  const regions = media.flatMap(m => Array.isArray(m.qualifiers) ? m.qualifiers : [])
    .filter(q => q.name === REGION && typeof q.value === 'string').map(q => {
      const parts = q.value!.split(',').map(x => x.trim());
      const [x, y, width, height] = parts.map(Number);
      if (parts.length !== 4 || parts.some(x => !x) || ![x,y,width,height].every(Number.isFinite) ||
          x < 0 || y < 0 || width <= 0 || height <= 0 || x+width > 1.000001 || y+height > 1.000001) return null;
      return { x, y, width, height };
    }).filter(r => r !== null);
  return { memoryPersonId: typeof person.id === 'string' ? person.id : null, name, personId,
    personUrl: personId ? `https://www.familysearch.org/en/tree/person/details/${personId}` : null,
    regions, regionScope: !regions.length ? null : regions.every(r => r.x === 0 && r.y === 0 && r.width === 1 && r.height === 1)
      ? 'whole-photo' : 'region' };
}

export async function readMemoryPeople(memoryId: string, sessionId: string, userAgent: string) {
  if (!/^[A-Z0-9_-]{1,100}$/i.test(memoryId)) throw new Error('Provide a valid FamilySearch Memory ID.');
  if (!sessionId) throw new Error('The saved browser session has no FamilySearch access token. Run login-with-browser.');
  const url = new URL(`https://api.familysearch.org/platform/memories/memories/${encodeURIComponent(memoryId)}/personas`);
  url.searchParams.set('includeTreeIdentifier', 'true');
  let response: Response;
  const options = { method:'GET', redirect:'manual' as const, signal:AbortSignal.timeout(30_000),
    headers:{Authorization:`Bearer ${sessionId}`, Accept:'application/x-fs-v1+json', 'User-Agent':userAgent} };
  let treeIdentifiersAvailable = true;
  try {
    response = await fetch(url, options);
    // Some Memories have tags with no Tree links. The API rejects the identifier
    // request for these, but still permits reading their names and rectangles.
    if (response.status === 400) {
      await response.body?.cancel();
      url.searchParams.set('includeTreeIdentifier', 'false');
      treeIdentifiersAvailable = false;
      response = await fetch(url, {...options, signal:AbortSignal.timeout(30_000)});
    }
  } catch { throw new Error('The FamilySearch tag request failed or timed out.'); }
  if (response.status === 204) return { memoryId, people: [], total: 0 };
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Could not read Memory tags (HTTP ${response.status}).`);
  }
  let data: {persons?: MemoryPersona[]};
  try { data = await response.json(); } catch { throw new Error('FamilySearch returned an invalid tag response.'); }
  if (!data || !Array.isArray(data.persons)) throw new Error('FamilySearch returned an invalid tag response.');
  const people = data.persons.filter(p => p && typeof p === 'object').map(memoryPersonaSummary);
  return { memoryId, people, total:people.length, treeIdentifiersAvailable };
}
