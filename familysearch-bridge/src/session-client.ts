import { prepareMemoryTags, applyMemoryTags, validateMemoryId, type MemoryTagOptions } from './memory-tags.js';
import { downloadMemoryArtifact, memorySummary, memoryType, type MemoryArtifact } from './memories.js';
import { readMemoryPeople } from './memory-people.js';
import { preparePhotoUpload, photoUploadPreview, uploadPreparedPhoto, uploadPreparedTaggedPhoto, validatePhotoTags,
  type PhotoUploadOptions, type TaggedPhotoOptions } from './photo-upload.js';

const BASE_URL = 'https://www.familysearch.org';

export class FamilySearchSessionError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'FamilySearchSessionError';
  }
}

function requestError(status: number, detail?: string): FamilySearchSessionError {
  if (status === 401) {
    return new FamilySearchSessionError(
      'FamilySearch rejected the saved session (HTTP 401). Sign in to FamilySearch again, then check the photos and tags.',
      status,
    );
  }
  if (status === 403) {
    return new FamilySearchSessionError(
      'FamilySearch denied access (HTTP 403). Check your saved session and access to the selected person.',
      status,
    );
  }
  return new FamilySearchSessionError(
    detail?.trim() ? `${detail.trim()} (HTTP ${status}).` : `FamilySearch request failed (HTTP ${status}).`,
    status,
  );
}

interface CardEventDetails {
  date?: { originalText?: string; localizedText?: string };
  place?: { originalText?: string; localizedText?: string };
}

interface CardEvent {
  details?: CardEventDetails;
}

export interface PersonCard {
  id?: string;
  name?: string;
  gender?: string;
  lifespan?: string;
  birth?: CardEvent;
  death?: CardEvent;
  living?: boolean;
  mePersonCisId?: string;
  genderConclusion?: { details?: { gender?: string } };
}

export function formatCardEvent(event?: CardEvent): { date?: string; place?: string } {
  return {
    date: event?.details?.date?.localizedText || event?.details?.date?.originalText,
    place: event?.details?.place?.localizedText || event?.details?.place?.originalText,
  };
}

export function formatCardBirthDeath(card: PersonCard): { birth: string; death: string } {
  const birthDetails = formatCardEvent(card.birth);
  const birth =
    birthDetails.date || birthDetails.place
      ? `${birthDetails.date || 'Unknown date'} - ${birthDetails.place || 'Unknown place'}`
      : 'Unknown';

  if (card.living) {
    return { birth, death: 'Living' };
  }

  const deathDetails = formatCardEvent(card.death);
  const death =
    deathDetails.date || deathDetails.place
      ? `${deathDetails.date || 'Unknown date'} - ${deathDetails.place || 'Unknown place'}`
      : 'Unknown';

  return { birth, death };
}

export interface SessionClientOptions {
  sessionId?: string;
  fsAnid?: string;
  cookies?: string;
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

export class FamilySearchSessionClient {
  private cookies: string;
  private sessionId: string;

  constructor(options: SessionClientOptions) {
    this.cookies = options.cookies || buildCookieHeader(options.sessionId, options.fsAnid);
    this.sessionId = options.sessionId || this.cookies.match(/(?:^|;\s*)fssessionid=([^;]+)/)?.[1] || '';
  }

  isAuthenticated(): boolean {
    return Boolean(this.cookies);
  }

  setSession(sessionId: string, fsAnid?: string, cookies?: string): void {
    this.cookies = cookies || buildCookieHeader(sessionId, fsAnid);
    this.sessionId = sessionId || this.cookies.match(/(?:^|;\s*)fssessionid=([^;]+)/)?.[1] || '';
  }

  private cookieHeader(): string {
    return this.cookies;
  }

  private async request<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    if (!this.cookies) {
      throw new FamilySearchSessionError('Not authenticated. Set a browser session cookie first.');
    }

    const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: 'application/json',
        Cookie: this.cookieHeader(),
        Referer: 'https://www.familysearch.org/en/',
        'User-Agent': BROWSER_USER_AGENT,
      },
    });

    if (response.status === 401) {
      await response.body?.cancel();
      throw requestError(response.status);
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (!response.ok) throw requestError(response.status);
      throw new FamilySearchSessionError(
        `FamilySearch returned an invalid JSON response (HTTP ${response.status}).`,
        response.status,
      );
    }

    if (
      typeof data === 'object' &&
      data !== null &&
      'status' in data &&
      (data as { status?: string }).status === 'UNAUTHORIZED'
    ) {
      throw requestError(401);
    }

    if (
      typeof data === 'object' &&
      data !== null &&
      'errorCode' in data &&
      String((data as { errorCode?: string | number }).errorCode) === '15'
    ) {
      throw new FamilySearchSessionError(
        'Request blocked by FamilySearch security (error 15). Re-run login-with-browser to refresh cookies.',
        403,
      );
    }

    if (!response.ok) {
      const message = typeof data === 'object' && data !== null && 'message' in data &&
        typeof (data as { message?: unknown }).message === 'string'
        ? (data as { message: string }).message : undefined;
      throw requestError(response.status, message);
    }

    return data as T;
  }

  async validateSession(fallback?: {
    displayName?: string;
    personId?: string;
  }): Promise<{ displayName: string; personId: string; cisId: string }> {
    if (fallback?.personId) {
      try {
        const person = await this.getPersonCard(fallback.personId);
        return {
          displayName: person.name || fallback.displayName || 'Authenticated FamilySearch user',
          personId: fallback.personId,
          cisId: person.mePersonCisId || '',
        };
      } catch (error) {
        if (error instanceof FamilySearchSessionError && [401, 403].includes(error.statusCode || 0)) throw error;
        // Fall through to search-based validation.
      }
    }
    const data = await this.request<{
      entries?: Array<{
        content?: {
          gedcomx?: {
            persons?: Array<{
              id?: string;
              names?: Array<{ nameForms?: Array<{ fullText?: string }> }>;
            }>;
          };
        };
      }>;
    }>('/service/search/tree/v2/personas', {
      count: 1,
      offset: 0,
      'q.givenName': 'John',
      'q.surname': 'Smith',
    });

    if (!data.entries?.length) {
      throw new FamilySearchSessionError('Session cookie is invalid or expired', 401);
    }

    return {
      displayName: fallback?.displayName || 'Authenticated FamilySearch user',
      personId: fallback?.personId || '',
      cisId: '',
    };
  }

  async searchPersons(params: {
    name?: string;
    birthDate?: string;
    birthPlace?: string;
    deathDate?: string;
    deathPlace?: string;
    gender?: 'MALE' | 'FEMALE';
    limit?: number;
  }) {
    const query: Record<string, string | number> = {
      count: params.limit || 10,
      offset: 0,
      'm.defaultFacets': 'on',
    };

    if (params.name) {
      const parts = params.name.trim().split(/\s+/);
      if (parts.length === 1) {
        query['q.surname'] = parts[0];
      } else {
        query['q.givenName'] = parts.slice(0, -1).join(' ');
        query['q.surname'] = parts[parts.length - 1];
      }
    }

    if (params.birthDate) query['q.birthLikeDate.from'] = params.birthDate;
    if (params.birthPlace) query['q.birthLikePlace'] = params.birthPlace;
    if (params.deathDate) query['q.deathLikeDate.from'] = params.deathDate;
    if (params.deathPlace) query['q.deathLikePlace'] = params.deathPlace;
    if (params.gender) query['q.sex'] = params.gender === 'MALE' ? 'Male' : 'Female';

    const data = await this.request<{
      entries?: Array<{
        id?: string;
        title?: string;
        content?: {
          gedcomx?: {
            persons?: Array<{
              gender?: { type?: string };
              names?: Array<{ nameForms?: Array<{ fullText?: string }> }>;
              facts?: Array<{
                type?: string;
                date?: { original?: string };
                place?: { original?: string };
              }>;
            }>;
          };
        };
      }>;
    }>('/service/search/tree/v2/personas', query);

    return (data.entries || []).map((entry) => {
      const person = entry.content?.gedcomx?.persons?.[0];
      const birthEvent = person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Birth');
      const deathEvent = person?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Death');

      return {
        id: entry.id || 'Unknown',
        name: person?.names?.[0]?.nameForms?.[0]?.fullText || entry.title || 'Unknown',
        gender: person?.gender?.type?.replace('http://gedcomx.org/', '') || 'Unknown',
        birth: birthEvent
          ? `${birthEvent.date?.original || 'Unknown date'} - ${birthEvent.place?.original || 'Unknown place'}`
          : 'Unknown',
        death: deathEvent
          ? `${deathEvent.date?.original || 'Unknown date'} - ${deathEvent.place?.original || 'Unknown place'}`
          : 'Unknown',
      };
    });
  }

  async getPersonCard(personId: string): Promise<PersonCard> {
    return this.request<PersonCard>(`/service/tree/tree-data/v8/person/${personId}/card`, { treeId: 'PRIVATE' });
  }

  async getPersonMemories(personId: string, type: 'all' | 'photo' | 'document' = 'all', limit = 100, offset = 0) {
    const data = await this.request<{ artifact?: MemoryArtifact[]; totalArtifactsSpanningPages?: number }>(
      `/service/memories/presentation/persons/personsByTreePersonId/${encodeURIComponent(personId)}/artifacts`,
      { includeAssociatedArtifacts: true, includeDatesPlaces: true, artifactCategory: 'ANY', community: true },
    );
    const memories = (data.artifact || []).filter(memory => {
      const category = memoryType(memory);
      return category && (type === 'all' || category === type);
    });
    return {
      personId, type, totalMatching: memories.length,
      totalMemories: data.totalArtifactsSpanningPages ?? data.artifact?.length ?? 0,
      offset, memories: memories.slice(offset, offset + limit).map(memorySummary),
    };
  }

  async downloadMemory(memoryId: string, options: { outputDir?: string; filename?: string; variant?: 'original' | 'preview' | 'thumbnail' } = {}) {
    const memory = await this.request<MemoryArtifact>(
      `/service/memories/presentation/artifacts/${encodeURIComponent(memoryId)}`,
      { includeAssociatedArtifacts: true },
    );
    return downloadMemoryArtifact(memory, {
      cookies: this.cookies, sessionId: this.sessionId, userAgent: BROWSER_USER_AGENT, ...options,
    });
  }

  async getMemoryPeople(memoryId: string) {
    return readMemoryPeople(memoryId, this.sessionId, BROWSER_USER_AGENT);
  }

  async uploadPersonPhoto(options: PhotoUploadOptions) {
    if (!this.sessionId) throw new FamilySearchSessionError('The saved browser session has no FamilySearch access token. Run login-with-browser first.');
    const photo = await preparePhotoUpload(options);
    const person = await this.getPersonCard(photo.personId);
    if (!person.id || person.id.toUpperCase() !== photo.personId || !person.name) {
      throw new Error('FamilySearch did not confirm the selected person. Check the person ID before uploading.');
    }
    if (options.dryRun) return { status: 'ready', dryRun: true, ...photoUploadPreview(photo, person.name),
      action: 'Upload this photo as a new FamilySearch Memory and attach it to this person. No photo has been sent.' };
    return uploadPreparedPhoto(photo, person.name, { sessionId: this.sessionId, userAgent: BROWSER_USER_AGENT });
  }

  async uploadTaggedPhoto(options: TaggedPhotoOptions) {
    if (!this.sessionId) throw new FamilySearchSessionError('The saved browser session has no FamilySearch access token. Run login-with-browser first.');
    const tags = validatePhotoTags(options.people);
    const photo = await preparePhotoUpload({ ...options, personId: tags[0].personId });
    const names = new Map<string, string>();
    for (const id of new Set(tags.map(t => t.personId))) {
      const person = await this.getPersonCard(id);
      if (!person.id || person.id.toUpperCase() !== id || !person.name) {
        throw new Error(`FamilySearch did not confirm person ${id}. Check the person ID before uploading.`);
      }
      names.set(id, person.name);
    }
    const people = tags.map(t => ({ ...t, personName: names.get(t.personId)! }));
    if (options.dryRun) return { status: 'ready', dryRun: true, ...photoUploadPreview(photo, people[0].personName), people,
      action: 'Upload this photo once and link the selected face tags to these people. No photo has been sent.' };
    return uploadPreparedTaggedPhoto(photo, people, { sessionId: this.sessionId, userAgent: BROWSER_USER_AGENT });
  }

  async tagMemoryPeople(options: MemoryTagOptions) {
    if (!this.sessionId) throw new FamilySearchSessionError('The saved browser session has no FamilySearch access token. Run login-with-browser first.');
    validateMemoryId(options.memoryId);
    const tags = validatePhotoTags(options.people);
    const names = new Map<string, string>();
    for (const id of new Set(tags.map(t => t.personId))) {
      const person = await this.getPersonCard(id);
      if (!person.id || person.id.toUpperCase() !== id || !person.name) throw new Error(`FamilySearch did not confirm person ${id}.`);
      names.set(id, person.name);
    }
    const credentials = { sessionId: this.sessionId, userAgent: BROWSER_USER_AGENT };
    const plan = await prepareMemoryTags(options.memoryId, tags.map(t => ({ ...t, personName: names.get(t.personId)! })), credentials);
    if (options.dryRun) return { status: 'ready', dryRun: true, memoryId: plan.memoryId, memoryUrl: plan.memoryUrl,
      planHash: plan.planHash, people: plan.people, tagActions: plan.actions.map(a => ({ personId: a.tag.personId, action: a.action, memoryPersonId: a.person.id || null })),
      action: 'Finish the selected tags on this existing Memory. The photo will not be uploaded again.' };
    if (options.expectedPlanHash && options.expectedPlanHash !== plan.planHash) throw new Error('The Memory tags changed. Check the preview again.');
    return applyMemoryTags(plan, credentials);
  }

  async getPersonDetails(personId: string) {
    const [card, notes] = await Promise.all([
      this.getPersonCard(personId),
      this.request<{ notes?: unknown[] }>(`/service/tree/tree-data/v8/person/${personId}/notes/all`).catch(() => ({ notes: [] })),
    ]);

    return { card, notes: notes.notes || [] };
  }

  async getFamilyMembers(personId: string) {
    return this.request<{
      parents?: Array<{
        parent1?: PersonSummary;
        parent2?: PersonSummary;
        children?: PersonSummary[];
      }>;
      spouses?: Array<{
        spouse1?: PersonSummary;
        spouse2?: PersonSummary;
        children?: PersonSummary[];
        event?: { details?: { date?: { original?: string }; place?: { localizedText?: string } } };
      }>;
    }>(`/service/tree/tree-data/r9/family-members/person/${personId}`, {
      includePhotos: true,
      treeId: 'PRIVATE',
    });
  }

  async getAncestors(personId: string, generations = 4) {
    const gens = Math.min(Math.max(generations, 1), 8);
    const data = await this.request<{ ancestors?: AncestorGeneration[][] }>(
      `/service/tree/tree-data/r9/portrait-pedigree/${personId}`,
      {
        numGenerations: gens,
        treeId: 'PRIVATE',
        includePhotos: false,
        includeTempleRollupStatus: false,
        includeFullHasSiblings: true,
        includeRecordHints: false,
        includeSpouseAncestry: false,
      },
    );

    const lines: string[] = [];
    const seen = new Set<string>([personId]);
    const formatPerson = (person?: PersonSummary) => {
      if (!person) return 'Unknown';
      const year = person.lifespan?.match(/\d{4}/)?.[0] || person.birth?.date?.match(/\d{4}/)?.[0] || '?';
      return `${person.name || 'Unknown'} (${year}) [${person.id || '?'}]`;
    };
    const addAncestor = (person: PersonSummary | undefined, generation: number) => {
      if (!person?.id || seen.has(person.id)) return;
      seen.add(person.id);
      const prefix = '  '.repeat(generation);
      const relation = person.gender === 'FEMALE' ? 'Mother' : person.gender === 'MALE' ? 'Father' : 'Ancestor';
      lines.push(`${prefix}${relation}: ${formatPerson(person)}`);
    };

    if (!data.ancestors?.length) {
      return [`No ancestors found for person ${personId}`];
    }

    const rootCouple = data.ancestors[0]?.[0];
    const rootPerson = rootCouple?.parent1?.id === personId ? rootCouple.parent1 : rootCouple?.parent2;
    lines.push(`Root: ${formatPerson(rootPerson || { id: personId, name: 'Unknown' })}`);

    for (let generation = 1; generation < data.ancestors.length; generation++) {
      const couples = data.ancestors[generation] || [];
      for (const couple of couples) {
        addAncestor(couple.parent1, generation);
        addAncestor(couple.parent2, generation);
      }
    }

    return lines;
  }

  async getDescendants(personId: string, generations = 2) {
    const gens = Math.min(Math.max(generations, 1), 3);
    const lines: string[] = [];
    const visited = new Set<string>();

    const formatPerson = (person?: PersonSummary) => {
      if (!person) return 'Unknown';
      const year = person.lifespan?.match(/\d{4}/)?.[0] || '?';
      return `${person.name || 'Unknown'} (${year}) [${person.id || '?'}]`;
    };

    const walk = async (currentId: string, depth: number, prefix: string) => {
      if (depth > gens || visited.has(currentId)) return;
      visited.add(currentId);

      const family = await this.getFamilyMembers(currentId);
      const children = new Map<string, PersonSummary>();

      for (const spouseGroup of family.spouses || []) {
        for (const child of spouseGroup.children || []) {
          if (child.id) children.set(child.id, child);
        }
      }

      for (const parentGroup of family.parents || []) {
        for (const child of parentGroup.children || []) {
          if (child.id && child.id !== currentId) children.set(child.id, child);
        }
      }

      for (const child of children.values()) {
        lines.push(`${prefix}Child: ${formatPerson(child)}`);
        if (depth < gens && child.id) {
          await walk(child.id, depth + 1, prefix + '  ');
        }
      }
    };

    const root = await this.getPersonCard(personId);
    lines.push(`Root: ${formatPerson({ id: personId, name: root.name, lifespan: root.lifespan })}`);
    await walk(personId, 1, '');

    if (lines.length === 1) {
      lines.push('  No descendants found.');
    }

    return lines;
  }

  async searchRecords(params: {
    givenName?: string;
    surname?: string;
    birthDate?: string;
    birthPlace?: string;
    deathDate?: string;
    deathPlace?: string;
    collectionId?: string;
    limit?: number;
  }) {
    const query: Record<string, string | number> = {
      count: params.limit || 10,
      offset: 0,
      'm.defaultFacets': 'on',
      'm.facetNestCollectionInCategory': 'on',
      'm.queryRequireDefault': 'on',
    };

    if (params.givenName) query['q.givenName'] = params.givenName;
    if (params.surname) query['q.surname'] = params.surname;
    if (params.birthDate) query['q.birthLikeDate.from'] = params.birthDate;
    if (params.birthPlace) query['q.birthLikePlace'] = params.birthPlace;
    if (params.deathDate) query['q.deathLikeDate.from'] = params.deathDate;
    if (params.deathPlace) query['q.deathLikePlace'] = params.deathPlace;
    if (params.collectionId) query['f.collectionId'] = params.collectionId;

    const data = await this.request<{
      entries?: Array<{
        id?: string;
        title?: string;
        content?: {
          gedcomx?: {
            description?: { title?: string };
            persons?: Array<{
              gender?: { type?: string };
              names?: Array<{ nameForms?: Array<{ fullText?: string }> }>;
              facts?: Array<{
                type?: string;
                date?: { original?: string };
                place?: { original?: string };
              }>;
            }>;
          };
        };
      }>;
    }>('/service/search/hr/v2/personas', query);

    return (data.entries || []).map((record) => {
      const primaryPerson = record.content?.gedcomx?.persons?.[0];
      const birthFact = primaryPerson?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Birth');
      const deathFact = primaryPerson?.facts?.find((fact) => fact.type === 'http://gedcomx.org/Death');

      return {
        id: record.id || 'Unknown',
        name: primaryPerson?.names?.[0]?.nameForms?.[0]?.fullText || record.title || 'Unknown',
        gender: primaryPerson?.gender?.type?.replace('http://gedcomx.org/', '') || 'Unknown',
        birth: birthFact
          ? `${birthFact.date?.original || 'Unknown date'} - ${birthFact.place?.original || 'Unknown place'}`
          : 'Unknown',
        death: deathFact
          ? `${deathFact.date?.original || 'Unknown date'} - ${deathFact.place?.original || 'Unknown place'}`
          : 'Unknown',
        collection: record.content?.gedcomx?.description?.title || 'Unknown collection',
      };
    });
  }
}

interface PersonSummary {
  id?: string;
  name?: string;
  gender?: string;
  lifespan?: string;
  birth?: { date?: string; place?: string };
}

interface AncestorGeneration {
  parent1?: PersonSummary;
  parent2?: PersonSummary;
}

function buildCookieHeader(sessionId?: string, fsAnid?: string): string {
  const parts: string[] = [];
  if (sessionId) parts.push(`fssessionid=${sessionId}`);
  if (fsAnid) parts.push(`fs_anid=${fsAnid}`);
  return parts.join('; ');
}
