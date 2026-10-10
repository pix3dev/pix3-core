import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CLI_VERSION } from '../version.ts';
import type { ProvenPort } from './cdp-proof.ts';
import {
  cdpForwardPortsPath,
  DEFAULT_CDP_PORT,
  remoteCdpPortPath,
  remoteCdpTokenPath,
} from './paths.ts';

/**
 * Remote SSH (plan §E.3): Vite and the coding agent on a remote host, the browser on the
 * human's machine. VS Code Remote SSH forwards the dev server's port to the human's machine;
 * `pix3 editor --chrome-only --url <that address>` runs Chrome and its token proxy there; an SSH
 * `RemoteForward` brings the proxy's port back to the remote host's loopback, where the agent's
 * chrome-devtools-mcp connects with the token. The token travels once, over SSH, from the
 * human's `~/.pix3/cdp-token` to the remote's `~/.pix3/remote-cdp-token`
 * (decisions A20–A23, A28 in `.plans/agent-bridge.md`). Both machines name the same remote
 * port: the remote's `--cdp-port` (stored), the human's `RemoteForward` line and `--remote-port`
 * (the proxy signs a `forward` proof only for it).
 */

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,}$/;

/** The human machine's token as copied here (its file narrowed to 0600), or null. */
export const readRemoteCdpToken = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const path = remoteCdpTokenPath(env);
  try {
    const token = readFileSync(path, 'utf8').trim();
    if (!TOKEN_SHAPE.test(token)) return null;
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    return token;
  } catch {
    return null;
  }
};

/**
 * The one `RemoteForward` port of this host (the agent's side): `--cdp-port` when given (then
 * stored), else the stored one, else 9333. Never a scan of 9333–9339: the first port that
 * answered with a proof used to win, so a squatter on 9333 relaying to the real forward on 9334
 * received the token (A28). One port, configured on both machines, makes a squatter a visible
 * failure instead (`ExitOnForwardFailure`).
 */
export const remoteCdpPort = (
  given: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number => {
  if (given !== undefined) {
    writeJson(remoteCdpPortPath(env), { port: given });
    return given;
  }
  const stored = readJson(remoteCdpPortPath(env)) as { port?: unknown } | null;
  return isPort(stored?.port) ? stored.port : DEFAULT_CDP_PORT;
};

/** The human's machine: the remote ports a `RemoteForward` brings this proxy to. */
export const readCdpForwardPorts = (env: NodeJS.ProcessEnv = process.env): number[] => {
  const stored = readJson(cdpForwardPortsPath(env)) as { ports?: unknown } | null;
  return Array.isArray(stored?.ports) ? stored.ports.filter(isPort) : [];
};

/** Record `port` as a `RemoteForward` port of this machine's proxy (it signs proofs for it). */
export const addCdpForwardPort = (port: number, env: NodeJS.ProcessEnv = process.env): void => {
  const ports = readCdpForwardPorts(env);
  if (!ports.includes(port)) writeJson(cdpForwardPortsPath(env), { ports: [...ports, port] });
};

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
};

/** `~/.ssh/config` lines on the human's machine: the proxy's port brought back here. */
export const remoteForwardLines = (remotePort: number, localPort = DEFAULT_CDP_PORT): string[] => [
  `RemoteForward 127.0.0.1:${remotePort} 127.0.0.1:${localPort}`,
  'ExitOnForwardFailure yes',
];

/**
 * The one line, run on the human's machine, that copies its token to this host: over the SSH
 * channel into a 0600 file, so it is never printed, typed, put in a shell history or a command
 * line. `tokenPath` is the local `~/.pix3/cdp-token`.
 */
export const tokenCopyLine = (
  tokenPath: string,
  host: string,
  platform: NodeJS.Platform = process.platform
): string => {
  const remote = 'umask 077 && mkdir -p ~/.pix3 && cat > ~/.pix3/remote-cdp-token';
  return platform === 'win32'
    ? // cmd and PowerShell both read `type <file> | ssh …` (PowerShell's CRLF is trimmed there).
      `type "${tokenPath}" | ssh ${host} "${remote}"`
    : `ssh ${host} '${remote}' < ${tokenPath}`;
};

/** The command the human runs on their machine (no project there: `npx` fetches the CLI). */
export const localChromeCommand = (editorUrl: string, remotePort: number): string =>
  `npx @pix3/cli@${CLI_VERSION} editor --chrome-only --url ${editorUrl} --remote-port ${remotePort}`;

/** What `pix3 editor` prints under `SSH_CONNECTION` (on the remote host). */
export const describeRemoteSession = (options: {
  readonly editorUrl: string;
  readonly publicEditorUrl?: string;
  readonly devPort: number;
  readonly token: string | null;
  /** The configured `RemoteForward` port of this host ({@link remoteCdpPort}). */
  readonly port: number;
  /** What answers on it: proven with the token, nothing, or something that cannot prove it. */
  readonly forward: ProvenPort;
}): string => {
  const { forward, port } = options;
  const url = options.publicEditorUrl ?? options.editorUrl;
  const lines = [
    'SSH session: Chrome is not launched here — it runs on the machine with your screen, and an agent',
    'here drives it through an SSH port forward of its CDP token proxy.',
    '',
    `  On your machine, once — ~/.ssh/config, under the Host you connect to, then reconnect`,
    `  (the second port is the proxy's on your machine; pix3 editor prints it there):`,
    ...remoteForwardLines(port).map(line => `      ${line}`),
    `  On your machine, each session — VS Code forwards port ${options.devPort} (its Ports tab shows the local address):`,
    `      ${localChromeCommand(url, port)}`,
    options.publicEditorUrl
      ? `    (${options.publicEditorUrl} is where a browser reached this server; dev.json publicEditorUrl)`
      : `    (use the local address of port ${options.devPort} if VS Code forwarded it to another port)`,
    '    It prints one ssh line that copies its CDP token here; run that line on your machine.',
    '  Here, once: npx pix3 agent-setup --remote, then start a new agent thread.',
    '',
  ];
  if (!options.token) {
    lines.push(
      forward.kind === 'closed'
        ? `  CDP forward: no token here yet (~/.pix3/remote-cdp-token); port ${port} is free.`
        : `  CDP forward: no token here yet (~/.pix3/remote-cdp-token); something answers on port ${port} — your forward if the SSH session is up, else someone else's: run pix3 editor again after the token copy to tell which.`
    );
  } else if (forward.kind === 'ours') {
    lines.push(
      `  CDP forward: live on 127.0.0.1:${port} — it proved it knows the token of ~/.pix3/remote-cdp-token, for this port.`
    );
  } else if (forward.kind === 'foreign') {
    lines.push(
      `  CDP forward: port ${port} on this host is held by something that does not prove the token (${forward.detail}).`,
      '  On a shared host that may be another user waiting for your token: with ExitOnForwardFailure your SSH',
      '  session cannot forward to it. Pick another port — pix3 editor --cdp-port <n> here (stored), the same',
      '  <n> in your RemoteForward line and --remote-port — and reconnect.'
    );
  } else {
    lines.push(
      `  CDP forward: nothing answers on 127.0.0.1:${port} yet (is the SSH session up with the RemoteForward line, and pix3 editor --chrome-only running on your machine?).`
    );
  }
  return `${lines.join('\n')}\n`;
};
