import { SFX_PRESET_NAMES } from './sfx/synth.ts';
import { CLI_VERSION } from './version.ts';

/**
 * Every help text of `pix3`, in one module: the overview ({@link USAGE}, `pix3 help`) and each
 * command's own ({@link COMMAND_USAGE}, `pix3 <command> --help` / `pix3 help <command>`, and the
 * line under a usage error). Specs read it without running the CLI (the kit drift spec checks
 * every command the kit names against it; `bin-bundle.spec` that every command answers `--help`
 * with its entry here).
 */
export const USAGE = `pix3 ${CLI_VERSION}

Usage:
  pix3 new                         List the starters (2d, 3d)
  pix3 new <2d|3d> [dir]           Create an empty project (dir defaults to pix3-<2d|3d>)
        [--name <project name>]
  pix3 editor [--project <dir>]    Find (or start, detached) the project's Vite dev server
        [--stop] [--chrome-only]   from .pix3/dev.json and open the editor in Chrome, its
        [--no-chrome] [--port <n>] CDP behind the token proxy ws://127.0.0.1:9333/pix3 (next
        [--cdp-port <n>]           free port when taken); --stop-chrome ends that Chrome.
        [--headless] [--stop-chrome] Over SSH: prints what to run on your machine instead;
        [--url <editor url>]       there, --url opens a forwarded remote editor (no project)
        [--ssh <host>]             and prints the line that copies the token to <host>
  pix3 agent-setup [claude|codex]  Write the project's MCP config for chrome-devtools-mcp
        [--repair] [--cdp-port <n>] (.mcp.json, .codex/config.toml, with the proxy token);
        [--remote]                 --repair fixes an entry that drifted (version, port,
        [--project <dir>]          token, the P1 --browserUrl launch); --remote: the agent
                                   is on an SSH host, Chrome on your machine (forwarded)
  pix3 validate [paths…] [--json]  Strict scene check: schema, references, guards, then
        [--no-hydrate]             hydration with the real loader (exit 1 on errors)
  pix3 check [--json]              validate + TypeScript check of the scripts + version
        [--no-hydrate] [--offline] check (exit 1 on errors)
        [--project <dir>]
  pix3 smoke [scene] [--json]      Run the game headless in Node for N frames (no browser):
        [--changed | --all]        script throws with frame + stack, console errors, missing
        [--frames N] [--timeout S] res:// (exit 1 on errors, 2 when it cannot run). No scene =
        [--project <dir>]          the scenes git changes reach, else every top-level scene
  pix3 tree [scene] [--json]       One line per node (type#id, pos, size, layout, components,
        [--depth N] [--types A,B]  prefab instances); no scene = project overview
        [--props] [--project <dir>]
  pix3 kit [--update]              Install (or update) the agent kit: AGENTS.md, CLAUDE.md,
        [--migrate]                .claude/skills/pix3-*, script types; --migrate: a 1.x kit
        [--project <dir>]          → 2.x (drops the pix3 mcp server, retired files, pix3Hybrid)
  pix3 character-compile <spec>    A 2D character from frame PNGs: <slug>.pix3anim with
        [--dry-run] [--force]      <variant>.<state> clips + a prefab with
        [--json] [--project <dir>] core:CharacterVisual2D (refuses to overwrite)
  pix3 sfx <preset|"text">         Synthesize a sound effect offline into a WAV (coin, jump,
        [--out <file.wav>]         hit, explosion, powerup, click; or "big explosion")
        [--seed <n>] [--json]
  pix3 gap "<what was missing>"    Record a gap Pix3 had (you worked around it) in
        [--kind capability|tool|node|doc|other] .pix3/gaps.jsonl;
        [--detail <text>] [--context <text>] --list prints them
        [--agent <name>] [--list] [--json] [--project <dir>]
  pix3 help <command>              That command's own usage (also pix3 <command> --help)
  pix3 --version
`;

/** `pix3 <command> --help`: one entry per command the entry dispatches (spec: `bin-bundle.spec`). */
export const COMMAND_USAGE = {
  new: `Usage: pix3 new [2d|3d] [dir] [--name <project name>]

  Without a starter: list them. With one: create an empty Vite + @pix3/vite-plugin project in dir
  (default pix3-<2d|3d>) with the agent kit (AGENTS.md, CLAUDE.md, .claude/skills/pix3-*, script
  types). The same as npm create pix3.

  --name name    the project name (default: from the folder)
`,
  editor: `Usage: pix3 editor [--project <dir>] [--stop] [--stop-chrome] [--chrome-only] [--no-chrome]
                   [--headless] [--port <n>] [--cdp-port <n>] [--url <editor url>] [--ssh <host>]

  Find the project's Vite dev server (.pix3/dev.json), or start it detached, and open the editor
  (/__pix3/) in a Chrome whose DevTools are reachable only through the token proxy
  ws://127.0.0.1:9333/pix3 (the next free port up to 9339 when that one is taken). Idempotent.
  Over SSH it prints what to run on your machine instead of starting Chrome.

  --project dir    project folder (default: nearest folder with pix3project.yaml)
  --stop           stop the dev server this command started
  --stop-chrome    close the Chrome (and its proxy) pix3 editor started
  --no-chrome      only the dev server
  --chrome-only    only Chrome, for a dev server that already runs
  --headless       headless Chrome (a plain tab)
  --port n         the dev server's port (Vite --port --strictPort)
  --cdp-port n     the proxy's preferred port (default 9333)
  --url url        on your machine: open a forwarded remote editor (no project here)
  --ssh host       with --url: the host the printed token-copy line names
`,
  'agent-setup': `Usage: pix3 agent-setup [claude|codex] [--repair] [--remote] [--cdp-port <n>] [--project <dir>]

  Write the project's MCP config for chrome-devtools-mcp — .mcp.json (Claude Code) and/or
  .codex/config.toml (Codex), both by default — pointing at the token proxy through the 0600 file
  ~/.pix3/cdp-mcp.json (no token in the project or on a command line).

  --repair       rewrite an entry that drifted (version, port, token, an older launch)
  --remote       the agent runs on an SSH host, Chrome on your machine (found through the forward)
  --cdp-port n   the proxy port (default: the one pix3 editor recorded, else 9333)
  --project dir  project folder (default: nearest folder with pix3project.yaml)
`,
  validate: `Usage: pix3 validate [paths…] [--json] [--no-hydrate] [--project <dir>]

  paths          .pix3scene files or folders (default: every scene in the project)
  --json         machine-readable report (diagnostics + sha256 of each validated file)
  --no-hydrate   level 1 only: no project code runs (user: component properties not checked)
  --project dir  project root (default: nearest folder with pix3project.yaml)
`,
  check: `Usage: pix3 check [--json] [--no-hydrate] [--offline] [--no-sync] [--project <dir>]

  Everything \`pix3 validate\` checks, plus a TypeScript type-check of the project's scripts
  (tsc --noEmit) and a version check.

  --json         machine-readable report (diagnostics, sha256 of every checked file, typecheck,
                 kit)
  --no-hydrate   validate level 1 only (user: component properties not checked)
  --offline      never install TypeScript (fails with the command to run instead)
  --no-sync      do not ask a running Pix3 editor (.pix3/dev.json) to flush its unsaved scenes first
  --project dir  project root (default: nearest folder with pix3project.yaml)
`,
  smoke: `Usage: pix3 smoke [scene] [--changed | --all] [--frames N] [--timeout S] [--json] [--no-sync] [--project <dir>]

  Run the game headless in Node — no browser, no editor: the project's scripts compiled, the scene
  loaded by the real loader, N frames of 1/60 s stepped by the real SceneRunner. Reports every
  script throw (onAttach/onStart/onUpdate, with script name, frame and stack), console.error/warn,
  unhandled rejections, missing res:// files and per-frame step time. Nothing is rendered; audio,
  input and network are inert.

  scene          .pix3scene to run (res://, project-relative or a path) — the surest way to test
                 the game: pix3 smoke scenes/main.pix3scene. With no scene, several run one after
                 another, a line each: in a git repo with uncommitted changes, the top-level scenes
                 those changes reach (the scene, a prefab/overlay it instances, a user: script it
                 attaches); otherwise — or when a changed scene/script reaches none — every
                 top-level scene (not a prefab, not scenes/ui), scenes/main.pix3scene first.
  --changed      only the scenes changed files reach (needs git; exit 2 when nothing changed)
  --all          every top-level scene, whatever git says
  --frames N     frames to step (default 120 = 2 s of game time)
  --timeout S    wall-clock limit in seconds (default 20) → exit 2, E_SMOKE_TIMEOUT
  --json         machine-readable report
  --no-sync      do not ask a running Pix3 editor (.pix3/dev.json) to flush its unsaved scenes first
  --project dir  project folder (default: nearest folder with pix3project.yaml)

  Exit: 0 = no errors, 1 = errors, 2 = could not run (no scene, bundle failure, unsupported, timeout,
  or E_RUNTIME_VERSION: the project installs another @pix3/runtime than this CLI runs).
`,
  tree: `Usage: pix3 tree [scene] [--depth N] [--types A,B] [--props] [--json] [--project <dir>]

  One line per node — type#id "name", position, size, anchor layout, components, prefab
  instances (↳ instance res://… (N overrides, M properties)) — indented by depth. Read this instead of the
  whole .pix3scene when you need to find your way around a scene. A node anchored by margins
  (layout: left/right/top/bottom) shows them — layout=left/top(left=40,top=30) — and the pos and
  size they give at the design size (the parent's size, viewportBaseSize for a root; ? where the
  file does not say enough), not the 0 its file holds on that axis.

  scene          .pix3scene (res://, project-relative or a path). Without one: every scene and
                 prefab in the project with node counts, node types and components.
  --depth N      stop N levels below the roots (0 = roots only); cut subtrees show "… +K below"
  --types A,B    only nodes of these types (or carrying these components; \`instance\` = prefab
                 instances), with their ancestors as "·" context lines
  --props        also print each node's properties that differ from the type's defaults
  --json         the same as nested JSON
  --project dir  project folder (default: nearest folder with pix3project.yaml, else cwd)
`,
  kit: `Usage: pix3 kit [--update] [--migrate] [--project <dir>]

  Install the agent kit into a project: AGENTS.md, CLAUDE.md, .claude/skills/pix3-*, the script
  types (.pix3/types). An existing file is left alone unless --update; a file you edited is never
  overwritten.

  --update       replace kit files that are unedited and out of date
  --migrate      a 1.x kit → 2.x: drop the pix3 mcp server from .mcp.json, the retired files and
                 metadata.pix3Hybrid, then --update (edited files kept and reported)
  --project dir  project folder (default: nearest folder with pix3project.yaml)
`,
  'character-compile': `Usage: pix3 character-compile <spec.yaml|spec.json> [--project <dir>] [--dry-run] [--force] [--json]

  Build a 2D character from frame PNGs: <sprites>/<slug>/<slug>.pix3anim (clips named
  <variant>.<state>), the frames copied beside it as <variant>_<state>_<nnnn>.png, and the prefab
  <prefabs>/<Name>.pix3scene — an AnimatedSprite2D root with core:CharacterVisual2D. Game code
  then says character.playState('attack', { restart: true }) / character.setVariant('bow').

  The spec (paths relative to the spec file):
    name: Goblin                    # display name and prefab file name
    slug: goblin                    # sprite folder (default: from name)
    anchor: { x: 0.5, y: 0.9 }      # where the node position lands, y from the top (the feet)
    defaultVariant: sword           # the pair the prefab starts on (default: the first clip's)
    defaultState: idle
    spriteDirectory: sprites        # default sprites
    prefabDirectory: scenes/prefabs # default scenes/prefabs
    clips:
      - { variant: sword, state: idle, fps: 10, frames: [art/sword/idle_1.png, art/sword/idle_2.png] }
      - { variant: sword, state: attack, sequence: art/sword/attack }   # art/sword/attack_<n>.png
      - { state: die, sequence: art/die, loop: false }                  # no variant: clip "die"

  Defaults are proposals and are printed as warnings: fps 12; loop false for attack, die, death,
  hit and hurt, true otherwise. Frames must be PNG.

  --project dir  project root (default: nearest folder with pix3project.yaml)
  --dry-run      print what would be written, write nothing
  --force        replace files that exist with other bytes (default: refuse, write nothing)
  --json         machine-readable report

  Exit: 0 = written (or nothing to do), 1 = refused (bad spec, missing frame, existing files),
  2 = usage or no project.
`,
  sfx: `Usage: pix3 sfx <preset|"description"> [--out <file.wav>] [--seed <n>] [--json]

Synthesizes a short sound effect offline into a 44.1 kHz 16-bit mono WAV.
  presets     ${SFX_PRESET_NAMES.join(', ')}
  description words that name a preset ("coin pickup", "big explosion"), plus modifiers:
              high/low, short/long, soft
  --out       output file (default: audio/<preset>.wav in the project root)
  --seed      a variation of the preset (same seed, same sound); default: the preset as tuned
  --json      print { path, res, durationMs, preset, seed, modifiers, bytes, peak, params }
Reference it from a scene or script as res://<path inside the project>.
`,
  gap: `Usage: pix3 gap "<what was missing>" [--kind capability|tool|node|doc|other] [--detail <text>]
                [--context <text>] [--agent <name>] [--json] [--project <dir>]
       pix3 gap --list [--json] [--project <dir>]

  Record, in .pix3/gaps.jsonl, something Pix3 lacked that you worked around — not your own
  mistakes or the game's features. One line per record.

  --kind k       capability, tool, node, doc or other (default other)
  --detail text  what you did instead
  --context text the file or task it happened in
  --agent name   who records it (default: from the environment — claude-code, codex)
  --list         print the recorded gaps
  --json         machine-readable output
  --project dir  project folder (default: nearest folder with pix3project.yaml)
`,
} as const satisfies Record<string, string>;

export type CommandName = keyof typeof COMMAND_USAGE;

export const isCommandName = (name: string): name is CommandName =>
  Object.prototype.hasOwnProperty.call(COMMAND_USAGE, name);
