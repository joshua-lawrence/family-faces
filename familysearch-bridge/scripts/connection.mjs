import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConnection } from '../build/connection.js';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1000) throw new Error('The connection request is too large.');
}
const client = new Client({ name: 'family-faces-connection', version: '1.0' });
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const { action } = JSON.parse(input);
  if (!['status', 'connect'].includes(action)) throw new Error('Choose a connection action.');
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve(base, 'build/index.js')], stderr: 'ignore' }));
  const result = await checkConnection(name => client.callTool({ name, arguments: {} }, undefined,
    { timeout: name === 'login-with-browser' ? 360_000 : 70_000 }), action === 'connect');
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ status: 'error', connected: false,
    note: 'The FamilySearch connection check did not finish. Click Connect FamilySearch to try again.' }) + '\n');
} finally {
  await client.close();
}
