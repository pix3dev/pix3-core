import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { chromeStatePath } from './paths.ts';

/**
 * `~/.pix3/chrome.json` — the proxy port `pix3 editor` last launched (or found) Chrome behind,
 * the profile it used and the processes that hold it. Written by the Chrome owner once its proxy
 * listens, removed by it when Chrome is gone. `pix3 agent-setup --repair` reads the port into the
 * MCP config when 9333 was taken and another port had to be used (plan §D.4).
 */
export interface ChromeState {
  readonly port: number;
  readonly profile: string;
  readonly startedAt: string;
  /** The editor URL the last launch opened. */
  readonly editorUrl?: string;
  /** The detached owner process: holds the pipe and serves the proxy (`pix3 editor --stop-chrome`). */
  readonly ownerPid?: number;
  readonly chromePid?: number;
  /** The proxy's protocol (`CDP_PROXY_PROTOCOL`); absent in a P1 record (open debugging port). */
  readonly proxy?: number;
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

/** Remove the record — only the one `ownerPid` wrote, so a newer owner's record survives. */
export const removeChromeState = (ownerPid: number, env: NodeJS.ProcessEnv = process.env): void => {
  if (readChromeState(env)?.ownerPid === ownerPid) rmSync(chromeStatePath(env), { force: true });
};
