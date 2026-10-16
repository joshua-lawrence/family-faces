import { mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

export interface MemoryArtifact {
  id: string | number;
  title?: string;
  description?: string;
  category?: string;
  contentCategory?: string;
  mimeType?: string;
  originalFilename?: string;
  size?: number;
  thumbMobileUrl?: string;
  thumbUrl?: string;
}

export function memoryType(memory: MemoryArtifact): 'photo' | 'document' | null {
  if (memory.category === 'PDF') return 'document';
  if (memory.category === 'IMAGE') return memory.contentCategory === 'DOCUMENT' ? 'document' : 'photo';
  return null;
}

export function memorySummary(memory: MemoryArtifact) {
  return {
    memoryId: String(memory.id),
    title: memory.title || memory.originalFilename || 'Untitled memory',
    description: memory.description || '',
    type: memoryType(memory),
    mimeType: memory.mimeType || '',
    originalFilename: memory.originalFilename || '',
    size: memory.size,
    pageUrl: `https://www.familysearch.org/en/memories/memory/${encodeURIComponent(memory.id)}`,
  };
}

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/tiff': '.tif', 'image/heic': '.heic', 'image/bmp': '.bmp',
  'application/pdf': '.pdf',
};

function validateDownloadUrl(url: URL): void {
  const allowed = url.hostname === 'familysearch.org' || url.hostname.endsWith('.familysearch.org') ||
    url.hostname === 'fscdn.org' || url.hostname.endsWith('.fscdn.org');
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('The download URL must use HTTPS on a FamilySearch server.');
  }
}

function safeFilename(value: string): string {
  const cleaned = basename(value.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^\.+/, '').replace(/[.\s]+$/, '').trim();
  if (!cleaned) throw new Error('Provide a valid file name.');
  if (cleaned.length > 180) throw new Error('The file name must have 180 characters or fewer.');
  return cleaned;
}

export async function downloadMemoryArtifact(
  memory: MemoryArtifact,
  options: { cookies: string; sessionId: string; userAgent: string; outputDir?: string; filename?: string; variant?: 'original' | 'preview' | 'thumbnail' },
) {
  if (!memoryType(memory)) throw new Error('This tool downloads photos and documents only.');
  const preview = options.variant === 'preview' || options.variant === 'thumbnail';
  const previewUrl = options.variant === 'thumbnail' ? memory.thumbUrl || memory.thumbMobileUrl : memory.thumbMobileUrl || memory.thumbUrl;
  if (preview && !previewUrl) throw new Error('FamilySearch has no image preview for this memory.');
  let url = new URL(preview ? previewUrl! : `https://www.familysearch.org/memories/orchestration/download/${encodeURIComponent(memory.id)}`, 'https://www.familysearch.org');
  const signal = AbortSignal.timeout(120_000);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    validateDownloadUrl(url);
    const headers: Record<string, string> = {
      Accept: 'image/*, application/pdf, application/octet-stream',
      'User-Agent': options.userAgent,
      Referer: 'https://www.familysearch.org/en/',
    };
    // CDN redirects must not receive the browser cookies or bearer token.
    if (url.hostname === 'www.familysearch.org') {
      headers.Cookie = options.cookies;
      if (options.sessionId) headers.Authorization = `Bearer ${options.sessionId}`;
    }
    try {
      response = await fetch(url, { headers, redirect: 'manual', signal });
    } catch {
      throw new Error('The download request failed or timed out.');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('The download has an invalid redirect.');
      url = new URL(location, url);
      continue;
    }
    break;
  }
  if (!response?.ok) {
    await response?.body?.cancel();
    throw new Error(`FamilySearch could not download this memory (HTTP ${response?.status}). Check your session and access to the memory.`);
  }
  const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf' && mimeType !== 'application/octet-stream') {
    await response.body?.cancel();
    throw new Error('FamilySearch did not return an image or document. Sign in again if the session expired.');
  }
  if (!response.body || Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    throw new Error('The file is empty or exceeds the 100 MB download limit.');
  }

  let filename = safeFilename(options.filename || (!preview && memory.originalFilename) || `memory-${memory.id}${preview ? `-${options.variant}` : ''}${EXTENSIONS[mimeType] || '.bin'}`);
  if (!extname(filename) && EXTENSIONS[mimeType]) filename += EXTENSIONS[mimeType];
  const directory = options.outputDir?.startsWith('~/') ? join(homedir(), options.outputDir.slice(2)) :
    options.outputDir || join(homedir(), 'Downloads', 'FamilySearch');
  await mkdir(resolve(directory), { recursive: true });
  const extension = extname(filename);
  const stem = basename(filename, extension);
  let path = join(resolve(directory), filename);
  let file;
  for (let suffix = 0; suffix < 1000; suffix++) {
    path = join(resolve(directory), suffix ? `${stem} (${suffix})${extension}` : filename);
    try {
      file = await open(path, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (!file) {
    await response.body.cancel();
    throw new Error('Could not create a unique download file. Choose a different name.');
  }
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error('The file exceeds the 100 MB download limit.');
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await file.write(chunk, offset, chunk.byteLength - offset);
        offset += result.bytesWritten;
      }
    }
    if (!bytes) throw new Error('FamilySearch returned an empty file.');
  } catch (error) {
    await file.close();
    await unlink(path);
    throw error;
  }
  await file.close();
  return { memoryId: String(memory.id), path, filename: basename(path), mimeType, bytes };
}
