// The local album app uses the MCP tool. Credentials stay inside the MCP server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 100_000) throw new Error('The upload request is too large.');
}
const client = new Client({ name: 'family-faces-upload', version: '1.0' });
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const args = JSON.parse(input);
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve(base, 'build/index.js')], stderr: 'ignore' }));
  const result = await client.callTool({ name: args.action === 'tag-memory' ? 'tag-memory-people' : 'upload-tagged-photo', arguments: Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'action')) }, undefined, { timeout: 240_000 });
  const text = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || '';
  process.stdout.write(JSON.stringify(result.isError ? { error: text } : JSON.parse(text)) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ error: 'The MCP request did not finish. If this was an upload, check FamilySearch before you try again.' }) + '\n');
  process.exitCode = 1;
} finally {
  await client.close();
}
