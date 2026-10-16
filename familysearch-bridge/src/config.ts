import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const configDir = path.join(os.homedir(), '.familysearch-mcp');
export const configPath = path.join(configDir, 'config.json');

export interface FamilySearchConfig {
  cookies: string;
  sessionId: string;
  fsAnid: string;
  userDisplayName: string;
  userPersonId: string;
}

export const defaultConfig: FamilySearchConfig = {
  cookies: '',
  sessionId: '',
  fsAnid: '',
  userDisplayName: '',
  userPersonId: '',
};

export function ensureConfigDir(): void {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

export function loadConfig(): FamilySearchConfig {
  ensureConfigDir();
  if (!fs.existsSync(configPath)) {
    return { ...defaultConfig };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ...defaultConfig, ...parsed };
  } catch (error) {
    console.error('Could not read the saved FamilySearch configuration.');
    return { ...defaultConfig };
  }
}

export function saveConfig(config: FamilySearchConfig): void {
  ensureConfigDir();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}
