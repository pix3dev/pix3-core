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

/** `~/.pix3/chrome.json`: the proxy port in use and its owner, for `agent-setup --repair`. */
export const chromeStatePath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'chrome.json');

/** The port chrome-devtools-mcp is configured for by default (plan §D.4). */
export const DEFAULT_CDP_PORT = 9333;
/** Ports tried locally when 9333 belongs to someone else: 9334–9339 (never for a forward). */
export const CDP_PORT_RANGE = 6;

/** `~/.pix3/cdp-token`: the bearer token of the CDP proxy (plan §D.5), mode 0600. */
export const cdpTokenPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'cdp-token');

/** `~/.pix3/chrome-owner.log`: what the detached Chrome owner (proxy) says, for a failed start. */
export const chromeOwnerLogPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'chrome-owner.log');

/** The path the proxy serves the browser-level CDP WebSocket on. */
export const CDP_PROXY_PATH = '/pix3';

/** `ws://127.0.0.1:<port>/pix3`: what chrome-devtools-mcp's `--wsEndpoint` points at. */
export const cdpWsEndpoint = (port: number): string => `ws://127.0.0.1:${port}${CDP_PROXY_PATH}`;

/** The proxy's protocol: the `Pix3-Cdp-Proxy` field of its `/json/version`. */
export const CDP_PROXY_PROTOCOL = 1;
/** The header on every proxy answer, refusals included: tells our proxy from a foreign port. */
export const CDP_PROXY_HEADER = 'X-Pix3-Cdp-Proxy';

/** A client's nonce: the proxy answers it with {@link CDP_PROOF_HEADER} (`cdp-proof.ts`). */
export const CDP_CHALLENGE_HEADER = 'X-Pix3-Challenge';
/**
 * The proof that the listener knows the token, bound to the port the client dialled
 * (`cdp-proof.ts`: `HMAC-SHA256(sha256(token), "pix3-cdp-proof/2\n<scope>:<port>\n<challenge>")`).
 */
export const CDP_PROOF_HEADER = 'X-Pix3-Proof';
/** `local` (the client dialled the proxy) or `forward` (a `RemoteForward` of it). */
export const CDP_PROOF_SCOPE_HEADER = 'X-Pix3-Proof-Scope';
/** Sent instead of a proof when the proxy is not reachable at the `Host` port in that scope. */
export const CDP_PROOF_REFUSED_HEADER = 'X-Pix3-Proof-Refused';

/**
 * On the human's machine: `~/.pix3/cdp-forward-ports.json` (`{"ports": [9333]}`), the remote
 * ports this machine's proxy is brought to by `RemoteForward` — the only ports it signs a
 * `forward` proof for. Written by `pix3 editor --url … --remote-port <n>`.
 */
export const cdpForwardPortsPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'cdp-forward-ports.json');

/**
 * On the agent's (remote) host: `~/.pix3/remote-cdp-port.json` (`{"port": 9333}`), the one
 * `RemoteForward` port configured for this host — `pix3 editor` prints it, `agent-setup
 * --remote` connects to it; never a scan (a squatter on it must make the forward fail visibly).
 */
export const remoteCdpPortPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'remote-cdp-port.json');

/**
 * Remote SSH (plan §E.3), on the machine the agent runs on: `~/.pix3/remote-cdp-token` is the
 * token of the CDP proxy on the human's machine, copied here over SSH (never typed, never
 * printed); mode 0600.
 */
export const remoteCdpTokenPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'remote-cdp-token');

/**
 * Remote SSH: chrome-devtools-mcp's `--config` file (`wsEndpoint` + `wsHeaders`), mode 0600 —
 * the token stays out of the project's MCP config and out of the process list, which every user
 * of a shared host can read.
 */
export const remoteMcpConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'remote-cdp.json');

/**
 * `~/.pix3/cdp-mcp.json`: chrome-devtools-mcp's `--config` file on this machine (`wsEndpoint`
 * of the local proxy + `wsHeaders` with the token), mode 0600, written by `pix3 agent-setup`.
 * The project's `.mcp.json` / `.codex/config.toml` name this file only — the token is in no
 * project file and on no command line (the remote side's `remote-cdp.json`, applied locally).
 */
export const localMcpConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(pix3Home(env), 'cdp-mcp.json');
