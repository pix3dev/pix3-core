import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromeStatePath } from './paths.ts';

/**
 * `~/.pix3/chrome.json` — the debugging port `pix3 editor` last launched (or found) Chrome on,
 * and the profile it used. `pix3 agent-setup --repair` reads the port into the MCP config when
 * 9333 was taken and another port had to be used (plan §D.4).
 */
export interface ChromeState {
  readonly port: number;
  readonly profile: string;
  readonly startedAt: string;
  /** The editor URL the last launch opened. */
  readonly editorUrl?: string;
}

export const readChromeState = (env: NodeJS.ProcessEnv = process.env): ChromeState | null => {
  try {
    const parsed = JSON.parse(readFileSync(chromeStatePath(env), 'utf8')) as Partial<ChromeState>;
    return typeof parsed.port === 'number' && typeof parsed.profile === 'string'
      ? (parsed as ChromeState)
      : null;
  } catch {
    return null;
  }
};

export const writeChromeState = (
  state: ChromeState,
  env: NodeJS.ProcessEnv = process.env
): void => {
  const path = chromeStatePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
};
