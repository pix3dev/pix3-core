import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { cdpTokenPath } from './paths.ts';

/**
 * `~/.pix3/cdp-token` (plan §D.5): the bearer token the CDP proxy of `pix3 editor` asks for and
 * `pix3 agent-setup` writes into chrome-devtools-mcp's `--wsHeaders`. Created once, mode 0600,
 * never rotated by the CLI — delete the file to rotate, then `pix3 agent-setup --repair` and a
 * new `pix3 editor` (the running proxy keeps the token it started with).
 */

const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,}$/;

/** The token, or null when the file is missing or does not hold one. */
export const readCdpToken = (env: NodeJS.ProcessEnv = process.env): string | null => {
  try {
    const token = readFileSync(cdpTokenPath(env), 'utf8').trim();
    return TOKEN_SHAPE.test(token) ? token : null;
  } catch {
    return null;
  }
};

/**
 * The token, created when there is none. A file another process wrote in the meantime wins
 * (`wx`), so two first runs agree on one token. A file group or others can read is narrowed to
 * 0600 (POSIX; Windows has no mode bits — the profile directory's ACL is what protects it there).
 */
export const ensureCdpToken = (env: NodeJS.ProcessEnv = process.env): string => {
  const path = cdpTokenPath(env);
  const existing = readCdpToken(env);
  if (existing) {
    narrowMode(path);
    return existing;
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  try {
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another `pix3` wrote it first, or the file holds no token: theirs wins, a broken one is
    // replaced.
    const theirs = readCdpToken(env);
    if (theirs) return theirs;
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
    narrowMode(path);
    return token;
  }
};

const narrowMode = (path: string): void => {
  if (process.platform === 'win32') return;
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch {
    // unreadable stat: the read above already succeeded or failed on its own
  }
};
