import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { parseDocument } from 'yaml';

import { PROJECT_MANIFEST_FILE } from '../manifest.ts';
import {
  AGENTS_ALT_FILE,
  AGENTS_FILE,
  CLAUDE_FILE,
  formatKitReport,
  installKit,
  readProjectKitManifest,
  type InstallKitOptions,
  type KitInstallReport,
} from './install.ts';
import type { KitSource } from './kit-source.ts';

/**
 * `pix3 kit --migrate` — a 1.x project's agent kit to the 2.x kit (plan §A.4 step 2, §F.5).
 *
 * **What it covers — the kit, nothing else** (`.plans/kit.md` K5):
 *
 * 1. `.mcp.json`: the `pix3 mcp --workspace` server the 1.x kit pinned there (`npx -y
 *    @pix3/cli@1.x mcp --workspace`, or the dev form `node …/packages/cli/src/index.ts mcp`) is
 *    removed; every other server stays. A file left with no server and no other key is deleted.
 *    The 2.x agent config (`pix3-browser` = chrome-devtools-mcp) is `pix3 agent-setup`'s, which
 *    the report tells the human to run — this command does not write MCP config.
 * 2. Files the previous kit wrote (`.pix3/kit-manifest.json`) that the 2.x kit no longer ships are
 *    deleted when their bytes are still the kit's, and kept and reported when someone edited them.
 * 3. `metadata.pix3Hybrid` (the 1.x cloud link; 2.x has no cloud) leaves `pix3project.yaml`; the
 *    report prints the value it had. `metadata.agentKit` is rewritten by the install below.
 * 4. The 2.x kit is installed with `--update` semantics: every kit file still byte-identical to
 *    what the old kit wrote is replaced, every edited one is kept. An edited file that still
 *    carries 1.x guidance (`pix3 mcp`, `pix3 serve`, the live channel, the in-editor tools) is
 *    flagged, and the 2.x text is written beside it under `.pix3/kit-migrate/` for a manual merge.
 *
 * Never touched: files outside the project (`~/.codex/config.toml` — the report says what to
 * remove there), a project `.codex/config.toml` (1.x never wrote one; a `pix3 mcp` table someone
 * pasted there is reported), the project's own AGENTS.md / CLAUDE.md, scenes, scripts, assets,
 * `package.json`, `vite.config.*`. Moving a 1.x project onto Vite (`@pix3/vite-plugin`,
 * `pix3()` in `vite.config`) is plan §A.4 step 3 — optional and by hand; the report notes when the
 * project has no plugin yet.
 *
 * Idempotent: a second run finds nothing to migrate and reports the kit as current.
 */

export const MCP_CONFIG_FILE = '.mcp.json';
export const CODEX_PROJECT_CONFIG = join('.codex', 'config.toml');
/** Where the 2.x text of a kit file you edited is written, for a manual merge. */
export const MIGRATE_STAGING_DIR = '.pix3/kit-migrate';

export type MigrationAction = 'removed' | 'kept' | 'staged';

export interface MigrationStep {
  readonly path: string;
  readonly action: MigrationAction;
  readonly detail: string;
}

export interface KitMigrationReport {
  /** The kit version found before (from `.pix3/kit-manifest.json` or `metadata.agentKit`). */
  readonly from: string | null;
  readonly steps: readonly MigrationStep[];
  readonly instructions: readonly string[];
  readonly notes: readonly string[];
  readonly kit: KitInstallReport;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

const sha256 = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const writeAtomic = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
};

/**
 * Whether an MCP server entry launches the retired 1.x `pix3 mcp` channel: an argument `mcp` and
 * a pix3 CLI as the program (`pix3`, `@pix3/cli[@version]`, or the CLI's own entry file).
 */
export const isRetiredPix3McpEntry = (entry: unknown): boolean => {
  if (!isRecord(entry)) return false;
  const command = typeof entry.command === 'string' ? entry.command : '';
  const args = Array.isArray(entry.args)
    ? entry.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const words = [command, ...args];
  if (!words.includes('mcp')) return false;
  return words.some(
    word =>
      /^@pix3\/cli(@\S+)?$/.test(word) ||
      /(^|[\\/])pix3(\.cmd)?$/.test(word) ||
      /[\\/]packages[\\/]cli[\\/](src|dist)[\\/]index\.(ts|js)$/.test(word) ||
      /[\\/]@pix3[\\/]cli[\\/]dist[\\/]index\.js$/.test(word)
  );
};

const describeEntry = (entry: unknown): string => {
  if (!isRecord(entry)) return '';
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return [String(entry.command ?? ''), ...args].join(' ').trim();
};

/** Phrases only the 1.x kit used: a file containing one still tells the agent about 1.x. */
const LEGACY_MARKERS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bpix3 mcp\b/, label: '`pix3 mcp`' },
  { pattern: /\bpix3 serve\b/, label: '`pix3 serve`' },
  { pattern: /\bpix3 read\b/, label: '`pix3 read`' },
  { pattern: /\blive channel\b/i, label: 'the live channel' },
  {
    pattern: /`(?:game_run|game_input|play_start|read_errors|set_property)`/,
    label: '1.x in-editor tools',
  },
];

export const legacyMarkersIn = (text: string): string[] =>
  LEGACY_MARKERS.filter(marker => marker.pattern.test(text)).map(marker => marker.label);

/** Remove now-empty folders from `dir` up to (not including) `stop`. */
const pruneEmptyDirs = (dir: string, stop: string): void => {
  let current = dir;
  while (current.startsWith(stop) && current !== stop) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
};

const migrateMcpConfig = (root: string, steps: MigrationStep[]): boolean => {
  const path = join(root, MCP_CONFIG_FILE);
  const text = readText(path);
  if (text === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (/\bmcp\b/.test(text) && /pix3/.test(text)) {
      steps.push({
        path: MCP_CONFIG_FILE,
        action: 'kept',
        detail: 'not valid JSON, so it was left as is; remove its 1.x `pix3 mcp` server by hand',
      });
    }
    return false;
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return false;
  const servers = parsed.mcpServers;
  const retired = Object.entries(servers).filter(([, entry]) => isRetiredPix3McpEntry(entry));
  if (retired.length === 0) return false;
  const kept = Object.fromEntries(
    Object.entries(servers).filter(([, entry]) => !isRetiredPix3McpEntry(entry))
  );
  const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'mcpServers'));
  const deleteFile = Object.keys(kept).length === 0 && Object.keys(rest).length === 0;
  if (deleteFile) rmSync(path);
  else writeAtomic(path, `${JSON.stringify({ ...parsed, mcpServers: kept }, null, 2)}\n`);
  for (const [name, entry] of retired) {
    steps.push({
      path: MCP_CONFIG_FILE,
      action: 'removed',
      detail: `mcpServers.${name} (${describeEntry(entry)}) — the 1.x live channel${deleteFile ? '; the file had nothing else and is deleted' : ''}`,
    });
  }
  return true;
};

const checkCodexConfig = (root: string, steps: MigrationStep[]): void => {
  const text = readText(join(root, CODEX_PROJECT_CONFIG));
  if (text === null) return;
  // A `[mcp_servers.<name>]` table whose body launches `pix3 … mcp`.
  const tables = text.split(/^(?=\s*\[)/m);
  for (const table of tables) {
    const header = /^\s*\[mcp_servers\.([^\]]+)\]/.exec(table);
    if (!header) continue;
    if (/"mcp"/.test(table) && /pix3/.test(table)) {
      steps.push({
        path: CODEX_PROJECT_CONFIG.split(sep).join('/'),
        action: 'kept',
        detail: `[mcp_servers.${header[1]}] launches the retired \`pix3 mcp\`; this command does not edit Codex config — delete that table by hand`,
      });
    }
  }
};

const removeHybridMetadata = (root: string, steps: MigrationStep[]): void => {
  const path = join(root, PROJECT_MANIFEST_FILE);
  const text = readText(path);
  if (text === null) return;
  const doc = parseDocument(text);
  const value = doc.getIn(['metadata', 'pix3Hybrid']);
  if (value === undefined) return;
  const plain = doc.toJS() as { metadata?: { pix3Hybrid?: unknown } };
  doc.deleteIn(['metadata', 'pix3Hybrid']);
  writeAtomic(path, doc.toString({ indent: 2 }));
  steps.push({
    path: PROJECT_MANIFEST_FILE,
    action: 'removed',
    detail: `metadata.pix3Hybrid (${JSON.stringify(plain.metadata?.pix3Hybrid)}) — the 1.x cloud link; 2.x has no cloud`,
  });
};

const removeRetiredKitFiles = (
  root: string,
  source: KitSource,
  steps: MigrationStep[],
  instructions: string[]
): void => {
  const previous = readProjectKitManifest(root);
  if (!previous) return;
  const current = new Set([
    ...source.manifest.files,
    AGENTS_ALT_FILE, // where AGENTS.md lands beside a project's own
    'tsconfig.json', // the kit's, without a tsconfig of the project's own
  ]);
  for (const [file, hash] of Object.entries(previous.files)) {
    if (current.has(file)) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    if (sha256(readFileSync(path)) === hash) {
      rmSync(path);
      pruneEmptyDirs(dirname(path), join(root, '.claude'));
      steps.push({ path: file, action: 'removed', detail: 'a file the 2.x kit no longer ships' });
    } else {
      steps.push({
        path: file,
        action: 'kept',
        detail: 'a file the 2.x kit no longer ships, edited since the kit wrote it',
      });
      instructions.push(
        `${file} is no longer part of the kit, and you edited it: keep what you need from it elsewhere and delete it.`
      );
    }
  }
};

/** Kit files the install skipped (edited) that still tell the agent about 1.x: stage the 2.x text. */
const stageEditedLegacyFiles = (
  root: string,
  source: KitSource,
  kit: KitInstallReport,
  steps: MigrationStep[],
  instructions: string[]
): void => {
  for (const outcome of kit.files) {
    if (outcome.action !== 'skipped-edited' || outcome.path === CLAUDE_FILE) continue;
    const sourceFile = outcome.path === AGENTS_ALT_FILE ? AGENTS_FILE : outcome.path;
    if (!source.manifest.files.includes(sourceFile)) continue;
    const current = readText(join(root, outcome.path)) ?? '';
    const markers = legacyMarkersIn(current);
    if (markers.length === 0) continue;
    // The project's own AGENTS.md (the kit went to AGENTS.pix3.md) is not a kit file.
    if (outcome.path === AGENTS_FILE && kit.files.some(f => f.path === AGENTS_ALT_FILE)) continue;
    const staged = `${MIGRATE_STAGING_DIR}/${outcome.path}`;
    writeAtomic(join(root, staged), readFileSync(join(source.filesDir, sourceFile), 'utf8'));
    steps.push({
      path: outcome.path,
      action: 'staged',
      detail: `edited by you and still the 1.x kit (mentions ${markers.join(', ')}); the 2.x text is in ${staged}`,
    });
    instructions.push(
      `Merge ${outcome.path} by hand: it still tells the agent about 1.x (${markers.join(', ')}). Compare it with ${staged}, keep your additions, then run pix3 kit --update (it skips files you edited, so copy the 2.x text over if you want the kit to own it again).`
    );
  }
};

const readPreviousVersion = (root: string): string | null => {
  const manifest = readProjectKitManifest(root);
  if (manifest?.version) return manifest.version;
  const text = readText(join(root, PROJECT_MANIFEST_FILE));
  if (text === null) return null;
  try {
    const plain = parseDocument(text).toJS() as { metadata?: { agentKit?: { version?: unknown } } };
    const version = plain?.metadata?.agentKit?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
};

const hasBrowserServer = (root: string): boolean => {
  const text = readText(join(root, MCP_CONFIG_FILE));
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) && isRecord(parsed.mcpServers) && 'pix3-browser' in parsed.mcpServers;
  } catch {
    return false;
  }
};

const usesVitePlugin = (root: string): boolean => {
  const text = readText(join(root, 'package.json'));
  if (text === null) return false;
  try {
    const pkg = JSON.parse(text) as { dependencies?: Json; devDependencies?: Json };
    return Boolean(
      pkg.dependencies?.['@pix3/vite-plugin'] ?? pkg.devDependencies?.['@pix3/vite-plugin']
    );
  } catch {
    return false;
  }
};

/** Migrate the kit of the project at `root` (see the module comment for exactly what). */
export const migrateKit = (
  root: string,
  source: KitSource,
  options: Pick<InstallKitOptions, 'runtimeTypes'> = {}
): KitMigrationReport => {
  const from = readPreviousVersion(root);
  const steps: MigrationStep[] = [];
  const instructions: string[] = [];
  const notes: string[] = [];

  const removedMcp = migrateMcpConfig(root, steps);
  checkCodexConfig(root, steps);
  removeHybridMetadata(root, steps);
  removeRetiredKitFiles(root, source, steps, instructions);

  const previousFiles = readProjectKitManifest(root)?.files ?? {};
  const kit = installKit(root, source, { ...options, update: true });
  stageEditedLegacyFiles(root, source, kit, steps, instructions);
  // The 1.x kit's own AGENTS.md, edited since: install treats it as the project's and puts the
  // 2.x kit in AGENTS.pix3.md beside it — but the edited copy still teaches 1.x.
  const agentsText = readText(join(root, AGENTS_FILE));
  const agentsMarkers = agentsText === null ? [] : legacyMarkersIn(agentsText);
  if (
    previousFiles[AGENTS_FILE] !== undefined &&
    agentsMarkers.length > 0 &&
    kit.files.some(f => f.path === AGENTS_ALT_FILE)
  ) {
    steps.push({
      path: AGENTS_FILE,
      action: 'kept',
      detail: `your edited copy of the 1.x kit (mentions ${agentsMarkers.join(', ')}); the 2.x kit is now ${AGENTS_ALT_FILE}`,
    });
    instructions.push(
      `Remove the 1.x kit text from ${AGENTS_FILE} (keep your own rules) — it contradicts ${AGENTS_ALT_FILE}.`
    );
  }

  const wasOneX = from !== null && /^1\./.test(from);
  if ((removedMcp || wasOneX) && !hasBrowserServer(root)) {
    instructions.push(
      'Connect the agent to the 2.x editor: npx pix3 agent-setup (writes the pix3-browser server — chrome-devtools-mcp — into .mcp.json and .codex/config.toml), then start a new agent thread.'
    );
  }
  if (removedMcp || wasOneX) {
    instructions.push(
      'If ~/.codex/config.toml has an [mcp_servers.pix3] table running `@pix3/cli … mcp` (printed by the 1.x `pix3 setup`), delete it; this command never edits files outside the project.'
    );
  }
  if (!usesVitePlugin(root)) {
    notes.push(
      "No @pix3/vite-plugin in package.json: the 2.x editor is served by the project's own Vite dev server at /__pix3/. Adding it (pix3() in vite.config) is a separate, manual step (plan §A.4 step 3); the kit does not do it."
    );
  }
  return { from, steps, instructions, notes, kit };
};

export const formatMigrationReport = (report: KitMigrationReport, root: string): string => {
  const lines: string[] = [
    `Pix3 kit migration ${report.from ?? '(no kit recorded)'} → ${report.kit.version} in ${root}`,
  ];
  const label: Record<MigrationAction, string> = {
    removed: 'removed',
    kept: 'KEPT',
    staged: 'STILL 1.x',
  };
  if (report.steps.length === 0) lines.push('  nothing of the 1.x kit left to remove');
  for (const step of report.steps) {
    lines.push(`  ${label[step.action].padEnd(9)} ${step.path}: ${step.detail}`);
  }
  const kitText = formatKitReport({ ...report.kit, instructions: [] }, root)
    .split('\n')
    .slice(1)
    .filter(Boolean);
  lines.push(...kitText);
  for (const note of report.notes) lines.push(`note: ${note}`);
  for (const instruction of [...report.kit.instructions, ...report.instructions]) {
    lines.push(`TODO: ${instruction}`);
  }
  return `${lines.join('\n')}\n`;
};
