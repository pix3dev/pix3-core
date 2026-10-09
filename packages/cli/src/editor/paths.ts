import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where `pix3 editor` keeps what is shared across projects (plan §D.4): the Chrome profile and
 * the record of the debugging port it chose. `PIX3_HOME` overrides `~/.pix3` (specs, and a
 * machine where the home directory is not writable).
 */
export const pix3Home = (env: NodeJS.ProcessEnv = process.env): string =>
  env.PIX3_HOME || join(homedir(), '.pix3');

/** The Chrome profile `pix3 editor` launches with (Chrome ≥136 refuses the default profile). */
export const chromeProfileDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.PIX3_CHROME_PROFILE || join(pix3Home(env), 'chrome');

/** Fallback profile when the home directory cannot be written. */
export const chromeProfileFallbackDir = (): string => join(tmpdir(), 'pix3-chrome');

/** `~/.pix3/chrome.json`: the debugging port in use, for `agent-setup --repair`. */
export const chromeStatePath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'chrome.json');

/** The port chrome-devtools-mcp is configured for by default (plan §D.4). */
export const DEFAULT_CDP_PORT = 9333;
/** Ports tried when 9333 belongs to someone else: 9334–9339. */
export const CDP_PORT_RANGE = 6;
