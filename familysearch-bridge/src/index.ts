import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { cardSummary, familySummary } from './family.js';
import { loadConfig, saveConfig, type FamilySearchConfig } from './config.js';
import {
  FamilySearchSessionClient,
  FamilySearchSessionError,
  formatCardBirthDeath,
} from './session-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loginScriptPath = join(__dirname, '..', 'scripts', 'browser-login.mjs');

let config: FamilySearchConfig = loadConfig();
const sessionClient = new FamilySearchSessionClient({
  sessionId: config.sessionId,
  fsAnid: config.fsAnid,
  cookies: config.cookies,
});

const persistConfig = () => saveConfig(config);

const server = new McpServer({
  name: 'familysearch',
  version: '2.0.0',
});

function isAuthenticated(): boolean {
  return sessionClient.isAuthenticated();
}

function authRequiredText(): string {
  return 'Not authenticated. Run login-with-browser or set-session-cookie first.';
}

function formatError(error: unknown): string {
  if (error instanceof FamilySearchSessionError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}

function extractCookieValue(cookieHeader: string, name: string): string {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] || '';
}

function applySessionCookies(cookies: string, sessionId?: string, fsAnid?: string): void {
  config.cookies = cookies.trim();
  config.sessionId = sessionId?.trim() || extractCookieValue(config.cookies, 'fssessionid');
  config.fsAnid = fsAnid?.trim() || extractCookieValue(config.cookies, 'fs_anid');
  sessionClient.setSession(config.sessionId, config.fsAnid, config.cookies);
}

server.tool(
  'set-session-cookie',
  'Authenticate using browser cookies copied from familysearch.org (DevTools console: copy(document.cookie))',
  {
    cookies: z
      .string()
      .optional()
      .describe('Full cookie string from document.cookie (recommended)'),
    sessionId: z
      .string()
      .optional()
      .describe('The fssessionid cookie alone (may be blocked without bot-protection cookies)'),
    fsAnid: z.string().optional().describe('Optional fs_anid cookie value'),
  },
  async ({ cookies, sessionId, fsAnid }: { cookies?: string; sessionId?: string; fsAnid?: string }) => {
    if (!cookies && !sessionId) {
      return {
        content: [{ type: 'text', text: 'Provide either cookies (full string, recommended) or sessionId.' }],
      };
    }

    applySessionCookies(cookies || '', sessionId, fsAnid);

    try {
      const user = await sessionClient.validateSession({
        displayName: config.userDisplayName,
        personId: config.userPersonId,
      });
      config.userDisplayName = user.displayName;
      config.userPersonId = user.personId;
      persistConfig();

      return {
        content: [
          {
            type: 'text',
            text: `Browser session saved. Authenticated as ${user.displayName}${user.personId ? ` (${user.personId})` : ''}.`,
          },
        ],
      };
    } catch (error) {
      config.cookies = '';
      config.sessionId = '';
      persistConfig();
      return {
        content: [{ type: 'text', text: `Session validation failed: ${formatError(error)}` }],
      };
    }
  },
);

server.tool(
  'login-with-browser',
  'Connect with the signed-in Chrome session on macOS using Keychain, or open a browser sign-in window. Validate and save the session locally.',
  {},
  async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [loginScriptPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `Browser login exited with code ${code}`));
        });
      });
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Browser login failed: ${formatError(error)}` }],
      };
    }

    config = loadConfig();
    sessionClient.setSession(config.sessionId, config.fsAnid, config.cookies);

    if (!isAuthenticated()) {
      return {
        content: [{ type: 'text', text: 'Browser login did not save a session cookie.' }],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Browser login complete. Session saved to ~/.familysearch-mcp/config.json.',
        },
      ],
    };
  },
);

server.tool('get-current-user', 'Get information about the currently authenticated user', {}, async () => {
  if (!isAuthenticated()) {
    return { content: [{ type: 'text', text: authRequiredText() }] };
  }

  try {
    const user = await sessionClient.validateSession({
      displayName: config.userDisplayName,
      personId: config.userPersonId,
    });
    config.userDisplayName = user.displayName;
    config.userPersonId = user.personId;
    persistConfig();

    return {
      content: [
        {
          type: 'text',
          text: `Current user: ${user.displayName}\nPerson ID: ${user.personId || 'Unknown'}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error fetching user info: ${formatError(error)}` }],
    };
  }
});

server.tool(
  'search-persons',
  'Search for person records in FamilySearch',
  {
    name: z.string().optional().describe('Name to search for'),
    birthDate: z.string().optional().describe('Birth date (YYYY-MM-DD)'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death date (YYYY-MM-DD)'),
    deathPlace: z.string().optional().describe('Death place'),
    gender: z.enum(['MALE', 'FEMALE']).optional().describe('Gender'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
  },
  async (params) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const persons = await sessionClient.searchPersons(params);
      if (!persons.length) {
        return { content: [{ type: 'text', text: 'No persons found matching your search criteria.' }] };
      }

      const resultsText = persons
        .map(
          (person, index) =>
            `${index + 1}. ${person.name} (${person.id})\n   Gender: ${person.gender}\n   Birth: ${person.birth}\n   Death: ${person.death}`,
        )
        .join('\n\n');

      return {
        content: [{ type: 'text', text: `Found ${persons.length} matching records:\n\n${resultsText}` }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching persons: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-person',
  'Get detailed information about a specific person',
  {
    personId: z.string().describe('Person ID'),
  },
  async ({ personId }: { personId: string }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const { card } = await sessionClient.getPersonDetails(personId);
      const gender = card.gender || card.genderConclusion?.details?.gender || 'Unknown';
      const { birth, death } = formatCardBirthDeath(card);

      return {
        content: [
          {
            type: 'text',
            text: `Person Details:\nID: ${personId}\nName: ${card.name || 'Unknown'}\nGender: ${gender}\nLifespan: ${card.lifespan || 'Unknown'}\nBirth: ${birth}\nDeath: ${death}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching person details: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-person-profile',
  'Get structured name, dates, places, and living status for a FamilySearch person.',
  { personId: z.string().trim().regex(/^[A-Z0-9]+-[A-Z0-9]+$/i) },
  async ({ personId }: { personId: string }) => {
    if (!isAuthenticated()) return { isError: true, content: [{ type: 'text', text: authRequiredText() }] };
    try {
      const card = await sessionClient.getPersonCard(personId);
      return { content: [{ type: 'text', text: JSON.stringify(cardSummary(card, personId), null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Could not get profile: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-person-family',
  'Get a person and their parent families, spouses, and children as structured data. Parent families can include siblings. No external records are changed.',
  { personId: z.string().trim().regex(/^[A-Z0-9]+-[A-Z0-9]+$/i) },
  async ({ personId }: { personId: string }) => {
    if (!isAuthenticated()) return { content: [{ type: 'text', text: authRequiredText() }] };
    try {
      const [card, family] = await Promise.all([sessionClient.getPersonCard(personId), sessionClient.getFamilyMembers(personId)]);
      return { content: [{ type: 'text', text: JSON.stringify({ person: cardSummary(card, personId), family: familySummary(family) }, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Could not get family: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-ancestors',
  'Get ancestors of a specific person',
  {
    personId: z.string().describe('Person ID'),
    generations: z.number().optional().describe('Number of generations (default: 4, max: 8)'),
  },
  async ({ personId, generations = 4 }: { personId: string; generations?: number }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getAncestors(personId, generations);
      return {
        content: [
          {
            type: 'text',
            text: `Ancestors (${Math.min(generations || 4, 8)} generations):\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching ancestors: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-descendants',
  'Get descendants of a specific person',
  {
    personId: z.string().describe('Person ID'),
    generations: z.number().optional().describe('Number of generations (default: 2, max: 3)'),
  },
  async ({ personId, generations = 2 }: { personId: string; generations?: number }) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const lines = await sessionClient.getDescendants(personId, generations);
      return {
        content: [
          {
            type: 'text',
            text: `Descendants (${Math.min(generations || 2, 3)} generations):\n\n${lines.join('\n')}`,
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error fetching descendants: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'search-records',
  'Search for historical records in FamilySearch',
  {
    givenName: z.string().optional().describe('Given name'),
    surname: z.string().optional().describe('Surname/last name'),
    birthDate: z.string().optional().describe('Birth date (YYYY-MM-DD)'),
    birthPlace: z.string().optional().describe('Birth place'),
    deathDate: z.string().optional().describe('Death date (YYYY-MM-DD)'),
    deathPlace: z.string().optional().describe('Death place'),
    collectionId: z.string().optional().describe('Specific collection ID to search in'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
  },
  async (params) => {
    if (!isAuthenticated()) {
      return { content: [{ type: 'text', text: authRequiredText() }] };
    }

    try {
      const records = await sessionClient.searchRecords(params);
      if (!records.length) {
        return { content: [{ type: 'text', text: 'No records found matching your search criteria.' }] };
      }

      const resultsText = records
        .map(
          (record, index) =>
            `${index + 1}. ${record.name} (${record.id})\n   Gender: ${record.gender}\n   Birth: ${record.birth}\n   Death: ${record.death}\n   Collection: ${record.collection}`,
        )
        .join('\n\n');

      return {
        content: [{ type: 'text', text: `Found ${records.length} matching records:\n\n${resultsText}` }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error searching records: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-person-memories',
  "List photos and documents in a person's FamilySearch Memories. Use the memoryId to download an item.",
  {
    personId: z.string().trim().min(1).max(50).describe('FamilySearch person ID'),
    type: z.enum(['all', 'photo', 'document']).optional().describe('Filter by type (default: all photos and documents)'),
    limit: z.number().int().min(1).max(200).optional().describe('Maximum number of results (default: 100)'),
    offset: z.number().int().min(0).optional().describe('Number of matching items to skip (default: 0)'),
  },
  async ({ personId, type = 'all', limit = 100, offset = 0 }: {
    personId: string; type?: 'all' | 'photo' | 'document'; limit?: number; offset?: number;
  }) => {
    if (!isAuthenticated()) return { content: [{ type: 'text', text: authRequiredText() }] };
    try {
      const result = await sessionClient.getPersonMemories(personId, type, limit, offset);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Could not list Memories: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'get-memory-people',
  'Read all people tagged in a FamilySearch Memory, including linked tree person IDs and saved regions when present. Whole-photo regions link a person to the photo but do not select a particular face. Names without a tree link are returned with personId null. This only reads FamilySearch.',
  {
    memoryId: z.string().trim().regex(/^[A-Z0-9_-]{1,100}$/i).describe('Memory ID from get-person-memories or a FamilySearch memory page'),
  },
  async ({ memoryId }: { memoryId: string }) => {
    if (!isAuthenticated()) return { content: [{ type: 'text', text: authRequiredText() }], isError: true };
    try {
      const result = await sessionClient.getMemoryPeople(memoryId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Could not read Memory tags: ${formatError(error)}` }], isError: true };
    }
  },
);

server.tool(
  'download-memory',
  'Download a FamilySearch Memory photo or document to a local file. Returns the absolute file path. Existing files are kept.',
  {
    memoryId: z.string().trim().regex(/^\d+$/).describe('Memory ID from get-person-memories or a FamilySearch memory page'),
    outputDir: z.string().trim().min(1).optional().describe('Local output directory (default: ~/Downloads/FamilySearch)'),
    filename: z.string().trim().min(1).optional().describe('Optional file name (default: the original file name)'),
    variant: z.enum(['original', 'preview', 'thumbnail']).optional().describe('Original attachment (default), FamilySearch image preview, or smaller thumbnail for cards'),
  },
  async ({ memoryId, outputDir, filename, variant }: { memoryId: string; outputDir?: string; filename?: string; variant?: 'original' | 'preview' | 'thumbnail' }) => {
    if (!isAuthenticated()) return { content: [{ type: 'text', text: authRequiredText() }] };
    try {
      const result = await sessionClient.downloadMemory(memoryId, { outputDir, filename, variant });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Could not download Memory: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'upload-person-photo',
  'Upload one local photo as a new FamilySearch Memory and attach it to the selected person. This changes FamilySearch. Use only for a photo and person selected by the user. Set dryRun to true to check the file and person without sending the photo. Each upload creates a new Memory.',
  {
    personId: z.string().trim().regex(/^[A-Z0-9]{4}-[A-Z0-9]{3}$/i).describe('FamilySearch person ID to attach the photo to'),
    filePath: z.string().trim().min(1).describe('Absolute local path or ~/ path to a JPEG, PNG, TIFF, or BMP photo (up to 15 MB)'),
    title: z.string().trim().min(1).max(250).optional().describe('Photo title (default: file name without its extension)'),
    description: z.string().trim().max(2000).optional().describe('Optional description of the photo'),
    dryRun: z.boolean().optional().describe('True validates and previews the upload without sending photo data (default: false)'),
  },
  async (options: { personId: string; filePath: string; title?: string; description?: string; dryRun?: boolean }) => {
    if (!isAuthenticated()) return { isError: true, content: [{ type: 'text', text: authRequiredText() }] };
    try {
      const result = await sessionClient.uploadPersonPhoto(options);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Could not upload photo: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'upload-tagged-photo',
  'Upload one local photo once as a FamilySearch Memory, then tag the selected faces and link them to FamilySearch people. This changes FamilySearch. Use only for a photo, people, and face rectangles selected by the user. Set dryRun to true for a preview. A partial result means the photo exists: check its Memory and do not upload it again.',
  {
    filePath: z.string().trim().min(1).describe('Absolute local photo path, up to 15 MB'),
    people: z.array(z.object({
      personId: z.string().trim().regex(/^[A-Z0-9]{4}-[A-Z0-9]{3}$/i),
      rectangle: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
        width: z.number().positive().max(1), height: z.number().positive().max(1) })
        .describe('Face rectangle as fractions of the full upright image: x,y are its top-left corner'),
    })).min(1).max(100).describe('One tag per selected face; a person can appear more than once'),
    title: z.string().trim().min(1).max(250).optional(),
    description: z.string().trim().max(2000).optional(),
    dryRun: z.boolean().optional().describe('Preview without sending photo data (default: false)'),
  },
  async (options: import('./photo-upload.js').TaggedPhotoOptions & Record<string, unknown>) => {
    if (!isAuthenticated()) return { isError: true, content: [{ type: 'text', text: authRequiredText() }] };
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await sessionClient.uploadTaggedPhoto(options), null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Could not upload tagged photo: ${formatError(error)}` }] };
    }
  },
);

server.tool(
  'tag-memory-people',
  'Finish selected face tags on an existing FamilySearch Memory. This changes FamilySearch but does not upload a photo. Reuse matching tags and preserve unselected tags. Use only for people and face regions selected by the user; preview with dryRun first.',
  {
    memoryId: z.string().regex(/^[A-Z0-9_-]{1,100}$/i),
    people: z.array(z.object({ personId: z.string().trim().regex(/^[A-Z0-9]{4}-[A-Z0-9]{3}$/i),
      rectangle: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
        width: z.number().positive().max(1), height: z.number().positive().max(1) }) })).min(1).max(100),
    dryRun: z.boolean().optional(),
    expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  },
  async (options: import('./memory-tags.js').MemoryTagOptions & Record<string, unknown>) => {
    if (!isAuthenticated()) return { isError: true, content: [{ type: 'text', text: authRequiredText() }] };
    try { return { content: [{ type: 'text', text: JSON.stringify(await sessionClient.tagMemoryPeople(options), null, 2) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: `Could not finish tags: ${formatError(error)}` }] }; }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('FamilySearch server is running');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
