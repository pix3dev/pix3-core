// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runtime from '@pix3/runtime';
import {
  getSceneNodeDiskFormat,
  KNOWN_SCENE_NODE_TYPES,
  resolveSceneDiskKey,
  resolveSceneNodeType,
  type SceneDiskKeyRule,
} from '@pix3/runtime';
import ts from 'typescript';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { compileCharacter } from './character/compiler.ts';
import { CHECK_CODES, checkProject } from './check/check.ts';
import { extractCoreComponents, type RuntimeLike } from './kit/core-components.ts';
import { generateKit, type CoreComponentInfo, type KitManifestFile } from './kit/generate.ts';
import { RETIRED_EDITOR_TOOL_NAMES } from './kit/retired-editor-tools.ts';
import {
  AGENTS_ALT_FILE,
  agentKitStep,
  installKit,
  KIT_PROJECT_MANIFEST,
  PRECEDENCE_SENTENCE,
  readProjectKitManifest,
  withAltAgentsHeader,
} from './kit/install.ts';
import { kitSrcDir, repoRootOfCheckout, type KitSource } from './kit/kit-source.ts';
import { createProject } from './new-project.ts';
import { listTemplates } from './templates.ts';

/** The 1.x recipes, kept as fixture projects in the template layout (`.plans/templates.md`). */
const CORPUS_ROOT = fileURLToPath(new URL('../../runtime/fixtures/scene-corpus', import.meta.url));
import { ensureRuntimeTypes } from './types/runtime-types.ts';
import { GAP_KINDS, GAPS_FILE } from './gap/command.ts';
import { SMOKE_CODES } from './smoke/report.ts';
import { USAGE } from './usage.ts';
import { DIAGNOSTIC_CODES } from './validate/diagnostics.ts';
import { schemaForType } from './validate/level1.ts';
import { validateProject } from './validate/validate.ts';
import { CLI_VERSION } from './version.ts';
import {
  BRIDGE_REASONS,
  BRIDGE_TOOLS,
  BRIDGE_TOOL_NAMES,
} from '../../editor-core/src/host/bridge-tools.ts';

/**
 * The agent kit: generated from sources, and held to the code it describes (plan §5 B — "spec-тест
 * ловит дрейф. Иначе через месяц kit врёт").
 *
 * Drift checks run over a kit built into a temp folder from `kit-src/` + the repo sources, with the
 * `core:` table read from the runtime's registry exactly as `scripts/build-kit.mjs` does:
 * - every directive resolved;
 * - every `pix3 <command> [--flag]` the kit shows exists in the CLI's USAGE (with that flag);
 * - the editor skill's tool table is the bridge's tool table (`editor-core/src/host/bridge-tools.ts`):
 *   the same names in the same order, only params the schemas have, every `pix3_*` token in the
 *   kit a real tool, every sync/bridge reason one the code produces;
 * - no retired 1.x in-editor tool (`kit/retired-editor-tools.ts`) is named as if the bridge had it;
 * - `pix3 check --json` `files` entries are documented with the CLI's key (`{ file, sha256 }`);
 * - every diagnostic code named is one `pix3 validate` / `pix3 check` emits;
 * - every node type named in the nodes skill is a type the loader knows;
 * - every property in the nodes skill's tables is a key the loader reads (the disk-format
 *   descriptor, `scene-disk-format.ts`) for that node type;
 * - every `core:` component named exists;
 * - the `.pix3anim` reference (`pix3-scene-format/pix3anim.md`) has exactly the interfaces,
 *   fields, optionality and types of `runtime/src/core/AnimationResource.ts`, and its "Omitted →"
 *   column is what `normalizeAnimationResource` fills in; its character example compiles.
 * Then `pix3 kit` behaviour: fresh project, an AGENTS.md of the project's own, `--update` vs user
 * edits, and a smoke run on a copy of DeepCore (skipped when that checkout is absent).
 */

const scratch = mkdtempSync(join(tmpdir(), 'pix3-kit-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const coreComponents: CoreComponentInfo[] = extractCoreComponents(
  runtime as unknown as RuntimeLike
);

const buildKit = (outDir: string, kitSrc = kitSrcDir()): KitSource => {
  const manifest: KitManifestFile = generateKit({
    repoRoot: repoRootOfCheckout(),
    kitSrcDir: kitSrc,
    outDir,
    version: CLI_VERSION,
    coreComponents,
  });
  return { dir: outDir, filesDir: join(outDir, 'files'), manifest };
};

let kit: KitSource;
const texts = new Map<string, string>();

beforeAll(() => {
  kit = buildKit(join(scratch, 'kit'));
  for (const file of kit.manifest.files) {
    texts.set(file, readFileSync(join(kit.filesDir, file), 'utf8'));
  }
  // Rebuilds the shipped runtime types when the runtime sources changed since the last build.
  ensureRuntimeTypes();
}, 120_000);

const text = (file: string): string => {
  const value = texts.get(file);
  if (value === undefined) throw new Error(`kit has no ${file}`);
  // A Windows checkout (core.autocrlf) hands the kit sources over with CRLF.
  return value.replace(/\r\n/g, '\n');
};

/** Text outside fenced code blocks, and the fenced lines, separately. */
const splitFences = (source: string): { prose: string; code: string[] } => {
  const prose: string[] = [];
  const code: string[] = [];
  let fenced = false;
  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    (fenced ? code : prose).push(line);
  }
  return { prose: prose.join('\n'), code };
};

const backticked = (source: string): string[] =>
  [...splitFences(source).prose.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);

/** The text of the `## <prefix>…` section of a Markdown file, up to the next `## `. */
const h2Section = (source: string, prefix: string): string => {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.startsWith(`## ${prefix}`));
  if (start < 0) throw new Error(`no "## ${prefix}" section`);
  let end = start + 1;
  let fenced = false;
  for (; end < lines.length; end++) {
    if (/^\s*(```|~~~)/.test(lines[end])) fenced = !fenced;
    if (!fenced && /^## /.test(lines[end])) break;
  }
  return lines.slice(start, end).join('\n');
};

describe('kit drift', () => {
  it('ships the files the plan lists, with every directive resolved', () => {
    expect(kit.manifest.files).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'CLAUDE.md',
        '.claude/skills/pix3-scene-format/SKILL.md',
        '.claude/skills/pix3-scene-format/pix3anim.md',
        '.claude/skills/pix3-nodes/SKILL.md',
        '.claude/skills/pix3-nodes/reference.md',
        '.claude/skills/pix3-scripts/SKILL.md',
        '.claude/skills/pix3-scripts/reference.md',
        '.claude/skills/pix3-verify/SKILL.md',
        '.claude/skills/pix3-editor/SKILL.md',
        'design/tests/bots/pix3-test-bot.d.ts',
      ])
    );
    expect(text('CLAUDE.md')).toBe('@AGENTS.md\n');
    for (const [file, content] of texts) {
      expect(content, file).not.toMatch(/\{\{/);
      if (file !== 'CLAUDE.md') expect(content, file).toContain(CLI_VERSION);
    }
    for (const file of kit.manifest.files.filter(f => f.endsWith('/SKILL.md'))) {
      const front = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(text(file));
      expect(front?.[1], `${file} front matter`).toBe(file.split('/')[2]);
    }
    expect(kit.manifest.sources).toEqual(
      expect.arrayContaining([
        'docs/pix3-specification.md',
        'docs/node-types-reference.md',
        'docs/nodes-and-systems.md',
        'packages/cli/kit-includes/engine-api-map.md',
      ])
    );
  });

  it('names only CLI commands and flags that exist', () => {
    const usageBlock = (command: string): string => {
      const lines = USAGE.split('\n');
      const out: string[] = [];
      let inside = false;
      for (const line of lines) {
        if (/^ {2}pix3 /.test(line)) inside = line.startsWith(`  pix3 ${command}`);
        if (inside) out.push(line);
      }
      return out.join('\n');
    };
    const invocations: string[] = [];
    for (const [, content] of texts) {
      for (const span of backticked(content)) {
        const pinned = /@pix3\/cli@\S+\s+(\S.*)$/.exec(span);
        if (span.startsWith('pix3 ')) invocations.push(span);
        else if (pinned) invocations.push(`pix3 ${pinned[1]}`);
      }
      for (const line of splitFences(content).code) {
        const trimmed = line.trim();
        if (trimmed.startsWith('pix3 ')) invocations.push(trimmed.replace(/\s+#.*$/, ''));
      }
    }
    expect(invocations.length).toBeGreaterThan(10);
    const problems: string[] = [];
    for (const invocation of invocations) {
      const [, command, ...rest] = invocation.split(/\s+/);
      if (command.startsWith('-')) {
        if (!USAGE.includes(`pix3 ${command}`)) problems.push(invocation);
        continue;
      }
      const block = usageBlock(command);
      if (!block) {
        problems.push(`${invocation}: no command "${command}"`);
        continue;
      }
      for (const flag of rest.filter(word => word.startsWith('--'))) {
        const name = flag.replace(/[=].*$/, '').replace(/[^\w-]+$/, '');
        if (name === '--help') continue; // every command takes it
        if (!block.includes(name)) problems.push(`${invocation}: ${command} has no ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("names only npm scripts the starter's package.json has, and AGENTS.md names all of them", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(repoRootOfCheckout(), 'packages/create-pix3/templates/base/files/package.json'),
        'utf8'
      )
    ) as { scripts: Record<string, string> };
    const scripts = Object.keys(pkg.scripts);
    const problems: string[] = [];
    for (const [file, content] of texts) {
      for (const match of content.matchAll(/\bnpm run ([a-z][\w:-]*)/g)) {
        if (!scripts.includes(match[1])) problems.push(`${file}: npm run ${match[1]}`);
      }
    }
    expect(problems).toEqual([]);
    for (const script of scripts) expect(text('AGENTS.md')).toContain(`\`npm run ${script}\``);
    expect(pkg.scripts.editor).toBe('pix3 editor');
  });

  const EDITOR_SKILL = '.claude/skills/pix3-editor/SKILL.md';

  /** `reason: '…'` literals of the sync barrier, the flush and the sync apply — what a sync answers. */
  const syncReasons = (): Set<string> => {
    const repo = repoRootOfCheckout();
    const out = new Set<string>();
    for (const file of [
      'packages/vite-plugin/src/sync/barrier.ts',
      'packages/editor-core/src/services/project/FlushService.ts',
      'packages/editor-core/src/host/SyncApplyService.ts',
    ]) {
      const source = readFileSync(join(repo, file), 'utf8');
      for (const match of source.matchAll(/reason: '([a-z_]+)'/g)) out.add(match[1]);
    }
    return out;
  };

  it("the editor skill's tool table is the bridge's, and every pix3_* token is a real tool", () => {
    const section = h2Section(text(EDITOR_SKILL), '2. The tools');
    const rows = section
      .split('\n')
      .filter(line => line.startsWith('| `pix3_'))
      .map(line =>
        line
          .split(/(?<!\\)\|/)
          .slice(1, -1)
          .map(cell => cell.trim())
      );
    expect(rows.map(cells => cells[0].replace(/`/g, ''))).toEqual([...BRIDGE_TOOL_NAMES]);
    const problems: string[] = [];
    for (const [name, params] of rows) {
      const tool = BRIDGE_TOOLS.find(t => `\`${t.name}\`` === name);
      if (!tool) continue;
      const schema = tool.inputSchema.properties ?? {};
      // Backticked words of the params cell that look like a parameter (`name` or `name?`); the
      // value lists (`start\|stop…`, `{path: sha256}`) are not parameters.
      const named = [...params.matchAll(/`([a-zA-Z]+)(\?)?`/g)].map(m => ({
        name: m[1],
        optional: m[2] === '?',
      }));
      for (const param of named) {
        if (!(param.name in schema)) problems.push(`${tool.name}: no param ${param.name}`);
        const required = tool.inputSchema.required?.includes(param.name) ?? false;
        if (required === param.optional)
          problems.push(`${tool.name}: ${param.name} is ${required ? 'required' : 'optional'}`);
      }
      for (const required of tool.inputSchema.required ?? []) {
        if (!named.some(p => p.name === required))
          problems.push(`${tool.name}: required ${required} not listed`);
      }
    }
    expect(problems).toEqual([]);

    const tools = new Set(BRIDGE_TOOL_NAMES);
    const unknown: string[] = [];
    for (const [file, content] of texts) {
      for (const match of content.matchAll(/\bpix3_[a-z_]+\b/g)) {
        if (!tools.has(match[0])) unknown.push(`${file}: ${match[0]}`);
      }
    }
    expect(unknown).toEqual([]);
    // Every tool is explained in the editor skill, and AGENTS.md sends the agent there.
    for (const name of BRIDGE_TOOL_NAMES) expect(text(EDITOR_SKILL)).toContain(`\`${name}\``);
    expect(text('AGENTS.md')).toContain('pix3-editor/SKILL.md');
  });

  it("tells the agent when to record a gap, with the CLI's kinds and file", () => {
    const agents = text('AGENTS.md');
    const shown = /pix3 gap "[^"]*" --kind ([a-z|]+)/.exec(agents);
    expect(shown?.[1].split('|')).toEqual([...GAP_KINDS]);
    expect(agents).toContain(GAPS_FILE.split(sep).join('/'));
    expect(agents).toMatch(/work around/);
  });

  it('quotes only verdict phrases and APIs the running game really has', () => {
    // The verification guidance folded in from 1.x (`.plans/kit.md` K3) quotes what a run
    // answers; an upper-case phrase in backticks must be one GameTestService produces.
    const source = readFileSync(
      join(repoRootOfCheckout(), 'packages/editor-core/src/services/game-test/GameTestService.ts'),
      'utf8'
    );
    const phrases = [...text(EDITOR_SKILL).matchAll(/`([A-Z][A-Z ]{6,}[A-Z])\b[^`]*`/g)].map(
      m => m[1]
    );
    expect(phrases).toEqual(
      expect.arrayContaining(['PRECONDITION ALREADY MET', 'SCENE NOT RENDERABLE'])
    );
    expect(phrases.filter(phrase => !source.includes(phrase))).toEqual([]);
    expect(typeof runtime.registerGameDebug).toBe('function');
  });

  it('names only sync and bridge reasons the code produces', () => {
    const known = new Set<string>([...BRIDGE_REASONS, ...syncReasons()]);
    expect(known.has('stale')).toBe(true);
    expect(known.has('expect_mismatch')).toBe(true);
    const section = h2Section(text(EDITOR_SKILL), '4. A not-ok sync');
    const named = section
      .split('\n')
      .filter(line => line.startsWith('| `') && !line.startsWith('| `reason`'))
      .flatMap(line => [...line.split('|')[1].matchAll(/`([a-z_]+)`/g)].map(m => m[1]));
    expect(named.length).toBeGreaterThan(4);
    expect(named.filter(reason => !known.has(reason))).toEqual([]);
    // `reason: "…"` anywhere in the kit's prose.
    const problems: string[] = [];
    for (const [file, content] of texts) {
      for (const match of content.matchAll(/reason: "([a-z_]+)"/g)) {
        if (!known.has(match[1])) problems.push(`${file}: ${match[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('names no retired 1.x tool as if the bridge had it', () => {
    // The 1.x in-editor agent had ~100 tools (frozen in `kit/retired-editor-tools.ts`); the
    // bridge has seven `pix3_*` tools. A kit that tells an agent to call `game_run` /
    // `read_errors` / `set_property` sends it after a tool it does not have. (The scene-format
    // skill's recipe table names in-editor tools on purpose: it translates them into file edits
    // and bridge calls.)
    const editorTools = new Set(RETIRED_EDITOR_TOOL_NAMES);
    expect(editorTools.size).toBeGreaterThan(BRIDGE_TOOL_NAMES.length);
    const files = [
      'AGENTS.md',
      '.claude/skills/pix3-verify/SKILL.md',
      '.claude/skills/pix3-scripts/SKILL.md',
      EDITOR_SKILL,
    ];
    const problems: string[] = [];
    for (const file of files) {
      for (const match of text(file).matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)) {
        if (editorTools.has(match[1])) problems.push(`${file}: ${match[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("documents `pix3 check --json` files entries with the CLI's own key", () => {
    // `CheckReport.files` is `{ file, sha256 }[]`; round 2 of the trial found the kit saying
    // `{ path, sha256 }`. The runtime shape is asserted in the type-check test below.
    // Only the kit's own prose: the included spec documents other `{ path, sha256 }` shapes
    // (`.pix3/ack.json`) that are right as written.
    const problems: string[] = [];
    for (const file of ['AGENTS.md', '.claude/skills/pix3-verify/SKILL.md']) {
      const content = text(file);
      for (const match of content.matchAll(/\{\s*"?(\w+)"?\s*(?::[^,}]*)?,\s*"?sha256"?\b/g)) {
        if (match[1] !== 'file') problems.push(`${file}: ${match[0]}`);
      }
      if (/path \+ sha256/.test(content)) problems.push(`${file}: "path + sha256"`);
    }
    expect(problems).toEqual([]);
  });

  it('names only diagnostic codes that validate / check emit', () => {
    const known = [
      ...Object.keys(DIAGNOSTIC_CODES),
      ...Object.keys(CHECK_CODES),
      ...Object.keys(SMOKE_CODES),
    ];
    const problems: string[] = [];
    for (const [file, content] of texts) {
      for (const match of content.matchAll(/\b([EW]_[A-Z0-9_]+\*?)/g)) {
        const code = match[1];
        const ok = code.endsWith('*')
          ? known.some(k => k.startsWith(code.slice(0, -1)))
          : known.includes(code);
        if (!ok) problems.push(`${file}: ${code}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('names only core: components that exist', () => {
    const ids = new Set(coreComponents.map(c => c.id));
    const problems: string[] = [];
    for (const [file, content] of texts) {
      for (const match of content.matchAll(/\bcore:([A-Z][A-Za-z0-9]+)/g)) {
        if (!ids.has(`core:${match[1]}`)) problems.push(`${file}: core:${match[1]}`);
      }
    }
    expect(problems).toEqual([]);
    expect(coreComponents.length).toBeGreaterThan(20);
    expect(text('.claude/skills/pix3-scripts/reference.md')).toContain('### `core:PopIn`');
  });

  const PIX3ANIM = '.claude/skills/pix3-scene-format/pix3anim.md';

  /** `export interface X { … }` of `AnimationResource.ts`: member name → optional + type text. */
  const runtimeAnimationInterfaces = (): Map<
    string,
    Map<string, { optional: boolean; type: string }>
  > => {
    const path = join(repoRootOfCheckout(), 'packages/runtime/src/core/AnimationResource.ts');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
    const out = new Map<string, Map<string, { optional: boolean; type: string }>>();
    for (const statement of source.statements) {
      if (!ts.isInterfaceDeclaration(statement)) continue;
      const exported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      const members = new Map<string, { optional: boolean; type: string }>();
      for (const member of statement.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        members.set(member.name.getText(source), {
          optional: member.questionToken !== undefined,
          type: member.type.getText(source).replace(/\s+/g, ' '),
        });
      }
      out.set(statement.name.text, members);
    }
    return out;
  };

  /** The reference's `### \`X\`` tables: field → { optional, type cell, default cell }. */
  const referenceTables = (): Map<
    string,
    Map<string, { optional: boolean; type: string; omitted: string }>
  > => {
    const out = new Map<
      string,
      Map<string, { optional: boolean; type: string; omitted: string }>
    >();
    let current: Map<string, { optional: boolean; type: string; omitted: string }> | null = null;
    for (const line of text(PIX3ANIM).split('\n')) {
      const heading = /^### `(\w+)`$/.exec(line);
      if (heading) {
        current = new Map();
        out.set(heading[1], current);
        continue;
      }
      if (/^#{1,3} /.test(line)) current = null;
      if (!current || !line.startsWith('| `')) continue;
      const cells = line
        .split(/(?<!\\)\|/)
        .slice(1, -1)
        .map(cell => cell.trim());
      const field = /^`(\w+)(\?)?`$/.exec(cells[0]);
      if (!field) continue;
      current.set(field[1], {
        optional: field[2] === '?',
        type: cells[1].replace(/`/g, '').replace(/\\\|/g, '|'),
        omitted: cells[2],
      });
    }
    return out;
  };

  it('the .pix3anim reference is the runtime format: every interface, field, type and default', () => {
    // Fails when `AnimationResource.ts` changes and the kit's reference does not (plan §F.5 (б)).
    const runtimeInterfaces = runtimeAnimationInterfaces();
    const reference = referenceTables();
    expect(runtimeInterfaces.has('AnimationResource')).toBe(true);
    expect([...reference.keys()].sort()).toEqual([...runtimeInterfaces.keys()].sort());
    const problems: string[] = [];
    for (const [name, members] of runtimeInterfaces) {
      const documented = reference.get(name) ?? new Map();
      expect([...documented.keys()], name).toEqual([...members.keys()]);
      for (const [field, member] of members) {
        const row = documented.get(field);
        if (!row) continue;
        if (row.optional !== member.optional)
          problems.push(`${name}.${field}: ${member.optional ? 'optional' : 'required'} in code`);
        if (row.type !== member.type)
          problems.push(`${name}.${field}: type ${member.type} in code, ${row.type} in the kit`);
      }
    }
    // The playback-mode union, spelled out in prose.
    const union = readFileSync(
      join(repoRootOfCheckout(), 'packages/runtime/src/core/AnimationResource.ts'),
      'utf8'
    ).match(/export type AnimationPlaybackMode = (.+);/)?.[1];
    expect(union).toBeDefined();
    expect(text(PIX3ANIM)).toContain(
      `\`AnimationPlaybackMode\` is \`${union?.replace(/'/g, '"')}\``
    );

    // "Omitted →": what `normalizeAnimationResource` fills in for an empty file / clip / frame.
    const empty = runtime.normalizeAnimationResource({ clips: [{ frames: [{}] }] });
    const actual: Record<string, Record<string, unknown>> = {
      AnimationResource: { ...empty, clips: [] },
      AnimationClip: { ...empty.clips[0], frames: [] },
      AnimationFrame: { ...empty.clips[0].frames[0] },
    };
    expect(runtime.normalizeAnimationResource({}).clips).toEqual([]);
    expect(empty.clips[0].name).toBe('clip-1');
    expect(reference.get('AnimationClip')?.get('name')?.omitted).toContain('clip-<n>');
    expect(empty.clips[0].frames[0].sourceSize).toEqual({ width: 0, height: 0 });
    expect(reference.get('AnimationFrame')?.get('sourceSize')?.omitted).toContain('boundingBox');
    for (const [name, values] of Object.entries(actual)) {
      for (const [field, value] of Object.entries(values)) {
        if ((name === 'AnimationClip' && field === 'name') || field === 'sourceSize') continue;
        const cell = reference.get(name)?.get(field)?.omitted.replace(/`/g, '') ?? '';
        let documented: unknown;
        try {
          documented = JSON.parse(cell);
        } catch {
          problems.push(`${name}.${field}: "Omitted →" is not JSON (${cell})`);
          continue;
        }
        if (JSON.stringify(documented) !== JSON.stringify(value))
          problems.push(
            `${name}.${field}: loader fills ${JSON.stringify(value)}, kit says ${cell}`
          );
      }
    }
    expect(problems).toEqual([]);
    // The skill and AGENTS.md lead to it.
    expect(text('.claude/skills/pix3-scene-format/SKILL.md')).toContain('pix3anim.md');
    expect(text('AGENTS.md')).toContain('pix3anim.md');
  });

  it('the character in the .pix3anim reference is what pix3 character-compile writes', () => {
    // The example spec in the reference compiles, and the clip names and component it describes
    // are the compiler's.
    const yaml = /```yaml\n(# art\/goblin\.yaml[\s\S]*?)```/.exec(text(PIX3ANIM))?.[1];
    expect(yaml).toBeDefined();
    const spec = parse(yaml ?? '') as {
      name: string;
      anchor: { x: number; y: number };
      clips: { variant?: string; state: string; fps?: number }[];
    };
    const compiled = compileCharacter({
      name: spec.name,
      slug: spec.name.toLowerCase(),
      anchor: spec.anchor,
      clips: spec.clips.map(clip => ({
        variant: clip.variant ?? '',
        state: clip.state,
        frames: [{ path: 'f.png', width: 8, height: 8 }],
        ...(clip.fps !== undefined ? { fps: clip.fps } : {}),
      })),
    });
    expect(compiled.animation.clips.map(clip => clip.name)).toEqual([
      'sword.idle',
      'sword.attack',
      'die',
    ]);
    expect(compiled.prefabPath).toBe('scenes/prefabs/Goblin.pix3scene');
    expect(text(PIX3ANIM)).toContain(`instance: res://${compiled.prefabPath}`);
    expect(compiled.prefabYaml).toContain('core:CharacterVisual2D');
  });

  const NODES_FILES = [
    '.claude/skills/pix3-nodes/SKILL.md',
    '.claude/skills/pix3-nodes/reference.md',
  ];

  const BOT_DTS = 'design/tests/bots/pix3-test-bot.d.ts';

  /** Member names of `export interface <name> { … }` (brace-matched: the body nests `{ x; y }`). */
  const interfaceMembers = (source: string, name: string): string[] => {
    const start = source.indexOf(`export interface ${name} {`);
    if (start < 0) return [];
    let depth = 0;
    let end = start;
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}' && --depth === 0) {
        end = index;
        break;
      }
    }
    const members = new Set<string>();
    // A method (`nodes(query: string)`) or a property (`readonly frame: number`, `name?: string`).
    for (const match of source
      .slice(start, end)
      .matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[(?:]/gm)) {
      members.add(match[1]);
    }
    return [...members];
  };

  it('the bot policy types are the harness contract (editor-core game-bots.ts)', () => {
    // The policy author's completion list: a member missing here is a member nobody calls, and a
    // policy written without the NEXT-tick rule reads as a game that ignores input.
    const source = readFileSync(
      join(repoRootOfCheckout(), 'packages/editor-core/src/services/game-test/game-bots.ts'),
      'utf8'
    );
    const dts = text(BOT_DTS);
    for (const name of ['Pix3TestBot', 'BotPolicy', 'BotNodeView'] as const) {
      const members = interfaceMembers(source, name);
      expect(members.length, `${name} read off game-bots.ts`).toBeGreaterThan(2);
      expect(dts).toContain(`declare interface ${name} {`);
      const block = dts.slice(dts.indexOf(`declare interface ${name} {`));
      const body = block.slice(0, block.indexOf('\n}\n'));
      expect(
        members.filter(member => !new RegExp(`^\\s*(?:readonly\\s+)?${member}\\b`, 'm').test(body)),
        `${BOT_DTS} is missing members of ${name}`
      ).toEqual([]);
    }
    expect(interfaceMembers(source, 'Pix3TestBot').length).toBeGreaterThanOrEqual(11);
    expect(dts).toContain('NEXT tick');
    // An import would make the file a module and its interfaces invisible to the policies.
    expect(dts).not.toMatch(/^\s*(import|export)\s/m);
  });

  it('names only node types the loader knows', () => {
    // Words shaped like a node type (`…2D`, `…3D`, `…Node`, `…Light`, `…Mesh`, `…Player`) that
    // the nodes skill uses for something else: base classes and engine classes.
    const notNodeTypes = new Set(['UIControl2D', 'AnimationPlayer', 'InstancedMesh']);
    const nodeShaped = /^[A-Z][A-Za-z0-9]*(?:2D|3D|Node|Light|Mesh|Player|Instance)$/;
    const problems: string[] = [];
    for (const file of NODES_FILES) {
      for (const span of backticked(text(file))) {
        if (!nodeShaped.test(span) || notNodeTypes.has(span)) continue;
        if (resolveSceneNodeType(span) === null) problems.push(`${file}: ${span}`);
      }
      for (const match of text(file).matchAll(/^#{2,4} ([A-Z][A-Za-z0-9]*(?:2D|3D|Node))\b/gm)) {
        if (!KNOWN_SCENE_NODE_TYPES.includes(match[1]))
          problems.push(`${file}: heading ${match[1]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every property in the nodes skill tables is a key the loader reads', () => {
    const expand = (token: string): string[] => {
      const [first, ...rest] = token.split('/');
      const out = [first];
      for (const part of rest) {
        if (first.includes('.')) out.push(`${first.slice(0, first.lastIndexOf('.') + 1)}${part}`);
        else {
          const tail = /[A-Z][a-z0-9]*$/.exec(first);
          out.push(tail ? `${first.slice(0, tail.index)}${part}` : part);
        }
      }
      return out;
    };
    const names = (cell: string, backtickedOnly: boolean): string[] => {
      const spans = [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1]);
      const raw = spans.length > 0 ? spans : backtickedOnly ? [] : cell.split(',');
      return raw
        .map(part =>
          part
            .replace(/\\/g, '')
            .replace(/\(.*?\)/g, '')
            .trim()
        )
        .filter(part => /^[A-Za-z][A-Za-z0-9.]*(?:\/[A-Za-z0-9]+)*\*?$/.test(part))
        .flatMap(expand);
    };
    const accepted = (type: string, name: string, row: string): string | null => {
      const format = getSceneNodeDiskFormat(type);
      if (!format) return `${type} has no disk format`;
      const schema = schemaForType(format);
      if (name.endsWith('*')) {
        const prefix = name.slice(0, -1);
        return schema.some(p => p.name.startsWith(prefix)) ||
          Object.keys(format.extras).some(k => k.startsWith(prefix))
          ? null
          : `nothing starts with ${prefix}`;
      }
      if (name.includes('.')) {
        const [block, key] = name.split('.');
        const rule: SceneDiskKeyRule | undefined = format.extras[block];
        return rule?.nested?.[key] ? null : `${block}.${key} is not read`;
      }
      const resolution = resolveSceneDiskKey(format, schema, name);
      // A schema property the file never stores may be listed if the row says so.
      if (resolution.kind === 'not-stored' && /not saved/i.test(row)) return null;
      return resolution.kind === 'schema' ||
        resolution.kind === 'extra' ||
        resolution.kind === 'write-only'
        ? null
        : `${name}: ${resolution.kind}${'diskPath' in resolution ? ` (belongs at ${resolution.diskPath})` : ''}`;
    };
    const problems: string[] = [];
    let checked = 0;
    for (const file of NODES_FILES) {
      let type: string | null = null;
      let quickReference = false;
      let tableHeader: string | null = null;
      let fenced = false;
      for (const line of text(file).split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
        if (fenced) continue;
        const heading = /^#{2,4} (.+)$/.exec(line);
        if (heading) {
          const word = /^`?([A-Za-z0-9]+)/.exec(heading[1])?.[1] ?? '';
          type = resolveSceneNodeType(word);
          quickReference = /quick reference/i.test(heading[1]);
          continue;
        }
        if (!line.startsWith('|')) {
          tableHeader = null;
          continue;
        }
        if (/^\|\s*-/.test(line)) continue;
        const cells = line
          .split(/(?<!\\)\|/)
          .slice(1, -1)
          .map(c => c.trim());
        if (tableHeader === null) {
          // Only property tables: `| Key |` / `| Property |` (per type), `| Node Type |` (summary).
          tableHeader = cells[0].replace(/`/g, '').toLowerCase();
          continue;
        }
        if (!['key', 'property', 'node type'].includes(tableHeader)) continue;
        if (quickReference) {
          const rowType = resolveSceneNodeType(cells[0]);
          if (!rowType) continue; // NodeBase: not a scene type
          for (const name of names(cells[1] ?? '', false)) {
            checked += 1;
            const problem = accepted(rowType, name, line);
            if (problem) problems.push(`${file} quick reference ${rowType}: ${problem}`);
          }
          continue;
        }
        if (!type) continue;
        for (const name of names(cells[0], true)) {
          checked += 1;
          const problem = accepted(type, name, line);
          if (problem) problems.push(`${file} ${type}: ${problem}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    expect(problems).toEqual([]);
  });
});

// --- pix3 kit behaviour ------------------------------------------------------------------------

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

let counter = 0;
const freshRecipe = (withKit: boolean): string => {
  const template = listTemplates(CORPUS_ROOT).find(t => t.id === 'recipe-tapper-2d');
  if (!template) throw new Error('recipe-tapper-2d missing');
  const dir = join(scratch, `p${++counter}`);
  createProject({
    template,
    dir,
    postCreateSteps: withKit ? [agentKitStep(kit, ensureRuntimeTypes())] : [],
  });
  return dir;
};

describe('pix3 kit', () => {
  it('installs everything into a fresh project', () => {
    const root = freshRecipe(true);
    for (const file of kit.manifest.files) {
      expect(readFileSync(join(root, file), 'utf8')).toBe(text(file));
    }
    expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toBe(
      '{ "extends": "./.pix3/tsconfig.check.json" }\n'
    );
    expect(existsSync(join(root, '.pix3/types/@pix3/runtime/index.d.ts'))).toBe(true);
    expect(existsSync(join(root, '.pix3/types/@types/three/index.d.ts'))).toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^\.pix3\/$/m);
    // The agent's MCP config is `pix3 agent-setup`, not the kit.
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    const manifest = parse(readFileSync(join(root, 'pix3project.yaml'), 'utf8')) as {
      metadata: { agentKit: { version: string; files: string[] }; templateId: string };
    };
    expect(manifest.metadata.templateId).toBe('recipe-tapper-2d');
    expect(manifest.metadata.agentKit.version).toBe(CLI_VERSION);
    expect(manifest.metadata.agentKit.files).toEqual(
      expect.arrayContaining(['AGENTS.md', 'CLAUDE.md', 'tsconfig.json'])
    );
    const owned = readProjectKitManifest(root);
    expect(owned?.files['AGENTS.md']).toBe(sha256(join(root, 'AGENTS.md')));
  });

  it('a starter (npm create pix3) keeps its own tsconfig.json and gets no .pix3/types', () => {
    for (const id of ['2d', '3d']) {
      const template = listTemplates().find(t => t.id === id);
      if (!template) throw new Error(`${id} missing`);
      const root = join(scratch, `starter-${id}-${++counter}`);
      createProject({
        template,
        dir: root,
        postCreateSteps: [agentKitStep(kit, ensureRuntimeTypes())],
      });
      for (const file of kit.manifest.files) {
        if (file === 'tsconfig.json') continue;
        expect(readFileSync(join(root, file), 'utf8')).toBe(text(file));
      }
      const tsconfig = readFileSync(join(root, 'tsconfig.json'), 'utf8');
      expect(tsconfig).toContain('"moduleResolution": "bundler"');
      expect(tsconfig).not.toContain('.pix3/tsconfig.check.json');
      expect(existsSync(join(root, '.pix3/types'))).toBe(false);
      // The template's .gitignore already covers .pix3/: not appended twice.
      expect(readFileSync(join(root, '.gitignore'), 'utf8').match(/^\.pix3\/$/gm)).toHaveLength(1);
    }
  });

  it("keeps a project's own AGENTS.md and CLAUDE.md, and says what to link", () => {
    const root = freshRecipe(false);
    writeFileSync(join(root, 'AGENTS.md'), '# Our rules\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Claude notes\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    const report = installKit(root, kit, { runtimeTypes: ensureRuntimeTypes() });
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# Our rules\n');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Claude notes\n');
    const alt = readFileSync(join(root, AGENTS_ALT_FILE), 'utf8');
    expect(alt).toBe(withAltAgentsHeader(text('AGENTS.md')));
    // The TODO survives in the file itself, not only in the one-time report.
    expect(alt.split('\n')[0]).toBe(text('AGENTS.md').split('\n')[0]);
    expect(alt).toContain(PRECEDENCE_SENTENCE);
    expect(alt).toContain('See AGENTS.pix3.md for the Pix3 engine rules.');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(
      /^node_modules\/\n[\s\S]*^\.pix3\/$/m
    );
    expect(report.instructions.join('\n')).toContain('AGENTS.pix3.md');
    expect(report.instructions.join('\n')).toContain('@AGENTS.pix3.md');
    expect(report.instructions.join('\n')).toContain(PRECEDENCE_SENTENCE);

    // Repeated on every run until the project's AGENTS.md links ours, then quiet.
    const again = installKit(root, kit, { runtimeTypes: ensureRuntimeTypes() });
    expect(again.instructions.join('\n')).toContain(PRECEDENCE_SENTENCE);
    expect(again.files.find(f => f.path === AGENTS_ALT_FILE)?.action).toBe('unchanged');
    writeFileSync(
      join(root, 'AGENTS.md'),
      '# Our rules\n\nSee AGENTS.pix3.md for the Pix3 engine rules.\n'
    );
    const linked = installKit(root, kit, { runtimeTypes: ensureRuntimeTypes() });
    expect(linked.instructions.join('\n')).not.toContain(PRECEDENCE_SENTENCE);
    writeFileSync(join(root, 'AGENTS.md'), '# Our rules\n');

    // Without a CLAUDE.md of its own, ours imports both.
    rmSync(join(root, 'CLAUDE.md'));
    installKit(root, kit, { runtimeTypes: ensureRuntimeTypes() });
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n@AGENTS.pix3.md\n');
  });

  it('--update replaces kit files the user did not touch and skips the ones they edited', () => {
    const root = freshRecipe(true);
    const edited = '.claude/skills/pix3-nodes/SKILL.md';
    writeFileSync(join(root, edited), `${text(edited)}\nOur own note.\n`);

    // A newer kit: every template gains a line.
    const src = join(scratch, `kit-src-${++counter}`);
    cpSync(kitSrcDir(), src, { recursive: true });
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
      );
    for (const file of walk(src)) writeFileSync(file, `${readFileSync(file, 'utf8')}\nNEW LINE\n`);
    const newer = buildKit(join(scratch, `kit-${counter}`), src);

    const plain = installKit(root, newer, { runtimeTypes: ensureRuntimeTypes() });
    expect(plain.files.find(f => f.path === 'AGENTS.md')?.action).toBe('outdated');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(text('AGENTS.md'));

    const update = installKit(root, newer, { update: true, runtimeTypes: ensureRuntimeTypes() });
    const action = (path: string) => update.files.find(f => f.path === path)?.action;
    expect(action('AGENTS.md')).toBe('updated');
    expect(action('.claude/skills/pix3-verify/SKILL.md')).toBe('updated');
    expect(action(edited)).toBe('skipped-edited');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('NEW LINE');
    expect(readFileSync(join(root, edited), 'utf8')).toContain('Our own note.');
    expect(readFileSync(join(root, edited), 'utf8')).not.toContain('NEW LINE');
    // The edited file keeps its old ownership hash, so it stays "edited" on the next update too.
    const owned = readProjectKitManifest(root);
    expect(owned?.files[edited]).not.toBe(sha256(join(root, edited)));
    expect(existsSync(join(root, KIT_PROJECT_MANIFEST))).toBe(true);
  });

  it("a bot policy in a starter type-checks under pix3 check with the kit's declarations", async () => {
    const template = listTemplates().find(t => t.id === '2d');
    if (!template) throw new Error('2d missing');
    const root = join(scratch, `starter-bots-${++counter}`);
    createProject({
      template,
      dir: root,
      postCreateSteps: [agentKitStep(kit, ensureRuntimeTypes())],
    });
    // The starter's own tsconfig runs against its node_modules: this checkout's.
    symlinkSync(join(repoRootOfCheckout(), 'node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(
      join(root, 'design/tests/bots/dodge.ts'),
      [
        'export default {',
        "  name: 'dodge',",
        '  tick(bot) {',
        "    const hero = bot.nodes('Hero')[0];",
        "    if (hero && hero.position.x < 0) bot.press('ArrowRight', 2);",
        "    bot.axis('move', bot.frame % 2 ? 1 : -1);",
        "    if (bot.frame > 30) bot.done(true, 'survived 30 ticks');",
        '  },',
        '} satisfies BotPolicy;',
        '',
      ].join('\n')
    );
    const run = () =>
      checkProject(root, {
        hydrate: false,
        offline: true,
        validate: options => validateProject(options),
      });
    const report = await run();
    expect(report.typecheck).toMatchObject({ mode: 'project', tsconfig: 'tsconfig.json' });
    expect(report.diagnostics.filter(d => d.code === 'E_TYPE')).toEqual([]);
    expect(report.files.map(f => f.file)).toEqual(
      expect.arrayContaining(['design/tests/bots/dodge.ts'])
    );

    // A call the harness does not have is a type error at the policy, not a silent no-op.
    writeFileSync(
      join(root, 'design/tests/bots/typo.ts'),
      'export default { tick(bot) { bot.fly(); } } satisfies BotPolicy;\n'
    );
    const typo = (await run()).diagnostics.filter(d => d.code === 'E_TYPE');
    expect(typo).toEqual([expect.objectContaining({ file: 'design/tests/bots/typo.ts', line: 1 })]);
    expect(typo[0].message).toContain("'fly'");
  }, 120_000);

  it('the TypeScript examples in the kit type-check against the shipped runtime types', async () => {
    const root = freshRecipe(true);
    const blocks: { file: string; code: string }[] = [];
    for (const file of ['AGENTS.md', '.claude/skills/pix3-scripts/SKILL.md']) {
      for (const match of text(file).matchAll(/^```ts\n([\s\S]*?)^```/gm)) {
        if (/^import /m.test(match[1])) blocks.push({ file, code: match[1] });
      }
    }
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    blocks.forEach((block, index) => {
      // Each example is a module of its own; rename its class so two examples do not collide.
      const name = /export class (\w+)/.exec(block.code)?.[1] ?? 'Example';
      const code = block.code.replace(new RegExp(`\\b${name}\\b`, 'g'), `${name}Example${index}`);
      writeFileSync(join(root, 'scripts', `KitExample${index}.ts`), code);
    });
    const report = await checkProject(root, {
      hydrate: false,
      offline: false,
      validate: options => validateProject(options),
    });
    expect(report.diagnostics.filter(d => d.code === 'E_TYPE')).toEqual([]);
    expect(report.typecheck.files).toBeGreaterThan(blocks.length);
    // The `files` entry shape the verify skill documents (`{ file, sha256 }`).
    expect(report.files.length).toBeGreaterThan(0);
    expect(Object.keys(report.files[0]).sort()).toEqual(['file', 'sha256']);
  }, 60_000);

  const deepCore = join(repoRootOfCheckout(), '..', 'DeepCore');
  it.skipIf(!existsSync(join(deepCore, 'pix3project.yaml')))(
    'DeepCore copy: kit leaves its AGENTS.md and tsconfig.json alone, then check runs its tsconfig',
    async () => {
      const copy = join(scratch, 'DeepCore');
      cpSync(deepCore, copy, {
        recursive: true,
        filter: source => {
          const rel = relative(deepCore, source).split(sep)[0];
          return rel !== '.git' && rel !== 'node_modules';
        },
      });
      const agentsBefore = sha256(join(copy, 'AGENTS.md'));
      const tsconfigBefore = sha256(join(copy, 'tsconfig.json'));
      // `update`: the checkout's kit may be from an older CLI; without it the recorded version stays
      // the old one (by design) and the version assertion below would depend on DeepCore's state.
      const report = installKit(copy, kit, { update: true });
      expect(report.types).toBe('own-tsconfig');
      expect(sha256(join(copy, 'AGENTS.md'))).toBe(agentsBefore);
      expect(sha256(join(copy, 'tsconfig.json'))).toBe(tsconfigBefore);
      expect(existsSync(join(copy, AGENTS_ALT_FILE))).toBe(true);
      expect(existsSync(join(copy, '.pix3', 'types'))).toBe(false);
      const manifest = parse(readFileSync(join(copy, 'pix3project.yaml'), 'utf8')) as {
        metadata: Record<string, unknown>;
      };
      expect(manifest.metadata.pix3Hybrid).toBeDefined(); // kept
      expect((manifest.metadata.agentKit as { version: string }).version).toBe(CLI_VERSION);

      const checked = await checkProject(copy, {
        hydrate: false,
        offline: true,
        validate: options => validateProject(options),
      });
      expect(checked.typecheck.mode).toBe('project');
      expect(checked.typecheck.tsconfig).toBe('tsconfig.json');
      // The copy has no node_modules: one E_DEPENDENCIES_MISSING instead of a tsc cascade of
      // "Cannot find module" errors (the trial run saw ~250 of them).
      expect(checked.typecheck.typescript).toBeNull();
      expect(checked.typecheck.skipped).toContain('npm install');
      const errors = checked.diagnostics.filter(d => d.severity === 'error');
      expect(errors.filter(d => d.code === 'E_TYPE')).toEqual([]);
      expect(errors.filter(d => d.code === 'E_DEPENDENCIES_MISSING')).toHaveLength(1);
      expect(checked.kit.upToDate).toBe(true);
    },
    120_000
  );
});
