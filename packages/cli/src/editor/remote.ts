import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, statSync } from 'node:fs';

import { CLI_VERSION } from '../version.ts';
import { proveCdpProxy } from './cdp-proof.ts';
import { CDP_PORT_RANGE, DEFAULT_CDP_PORT, remoteCdpTokenPath } from './paths.ts';

/**
 * Remote SSH (plan §E.3): Vite and the coding agent on a remote host, the browser on the
 * human's machine. VS Code Remote SSH forwards the dev server's port to the human's machine;
 * `pix3 editor --chrome-only --url <that address>` runs Chrome and its token proxy there; an SSH
 * `RemoteForward` brings the proxy's port back to the remote host's loopback, where the agent's
 * chrome-devtools-mcp connects with the token. The token travels once, over SSH, from the
 * human's `~/.pix3/cdp-token` to the remote's `~/.pix3/remote-cdp-token`
 * (decisions A20–A23 in `.plans/agent-bridge.md`).
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

export interface ForwardState {
  /** The port the forward answers on (with the proof of the token), or null. */
  readonly live: number | null;
  /** The port to put in `RemoteForward`: the live one, else the first that nothing holds. */
  readonly suggested: number | null;
  /** Ports something else holds on this host, with what. */
  readonly taken: Array<{ port: number; detail: string }>;
}

/**
 * Where the forward of the human's proxy is on this host's loopback. Every port is asked for
 * the proof of the token (`cdp-proof.ts`) — the token itself is never sent to a port here: on a
 * shared host another user may hold it. Without a token only free ports can be told.
 */
export const findCdpForward = async (
  token: string | null,
  options: { readonly preferred?: number; readonly fetch?: typeof fetch } = {}
): Promise<ForwardState> => {
  const preferred = options.preferred ?? DEFAULT_CDP_PORT;
  // No token yet: a random one cannot be proven, so every answer reads as "taken".
  const probeToken = token ?? randomBytes(32).toString('base64url');
  const taken: Array<{ port: number; detail: string }> = [];
  let suggested: number | null = null;
  for (let port = preferred; port <= preferred + CDP_PORT_RANGE; port++) {
    const state = await proveCdpProxy(port, probeToken, options.fetch);
    if (state.kind === 'ours') return { live: port, suggested: port, taken };
    if (state.kind === 'closed') suggested ??= port;
    else taken.push({ port, detail: state.detail });
  }
  return { live: null, suggested, taken };
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
export const localChromeCommand = (editorUrl: string): string =>
  `npx @pix3/cli@${CLI_VERSION} editor --chrome-only --url ${editorUrl}`;

/** What `pix3 editor` prints under `SSH_CONNECTION` (on the remote host). */
export const describeRemoteSession = (options: {
  readonly editorUrl: string;
  readonly publicEditorUrl?: string;
  readonly devPort: number;
  readonly token: string | null;
  readonly forward: ForwardState;
}): string => {
  const { forward } = options;
  const port = forward.suggested ?? DEFAULT_CDP_PORT;
  const url = options.publicEditorUrl ?? options.editorUrl;
  const lines = [
    'SSH session: Chrome is not launched here — it runs on the machine with your screen, and an agent',
    'here drives it through an SSH port forward of its CDP token proxy.',
    '',
    '  On your machine, once — ~/.ssh/config, under the Host you connect to, then reconnect:',
    ...remoteForwardLines(port).map(line => `      ${line}`),
    `  On your machine, each session — VS Code forwards port ${options.devPort} (its Ports tab shows the local address):`,
    `      ${localChromeCommand(url)}`,
    options.publicEditorUrl
      ? `    (${options.publicEditorUrl} is where a browser reached this server; dev.json publicEditorUrl)`
      : `    (use the local address of port ${options.devPort} if VS Code forwarded it to another port)`,
    '    It prints one ssh line that copies its CDP token here; run that line on your machine.',
    '  Here, once: npx pix3 agent-setup --remote, then start a new agent thread.',
    '',
  ];
  for (const skipped of forward.taken) lines.push(`  Port ${skipped.port}: ${skipped.detail}`);
  if (!options.token) {
    lines.push('  CDP forward: no token here yet (~/.pix3/remote-cdp-token).');
  } else if (forward.live !== null) {
    lines.push(
      `  CDP forward: live on 127.0.0.1:${forward.live} — it proved it knows the token of ~/.pix3/remote-cdp-token.`
    );
  } else {
    lines.push(
      `  CDP forward: nothing answers with the token on ports ${DEFAULT_CDP_PORT}–${DEFAULT_CDP_PORT + CDP_PORT_RANGE} yet (is the SSH session up with the RemoteForward line, and pix3 editor --chrome-only running on your machine?).`
    );
  }
  return `${lines.join('\n')}\n`;
};
