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
        [--name <project name>]    --portrait: 1080×1920 (default --landscape 1920×1080)
        [--portrait|--landscape]
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
        [--no-hydrate]             each scene loaded as the game loads it (exit 1 on errors)
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
        [--out <file.wav>]         hit, explosion, powerup, click, whoosh, chime, win, lose;
                                   or "big explosion")
        [--seed <n>] [--json]
  pix3 font [add <family>]         List the fonts this CLI ships (Nunito, Rubik, Baloo 2, …);
        [--project <dir>] [--json] add copies one into fonts/ and registers it in pix3project.yaml
  pix3 play [dev|dist] [--bot <n>] The game's page (or the build) in a headless Chrome at a phone
        [--size 390x844]           size, optionally played by a bot policy; screenshot, errors;
        [--screenshot <f.png>]     a bot's bot.screenshot(name) pictures go to --shots
        [--shots <dir>]
  pix3 bridge <tool> ['<json>']    The editor tab's pix3_* tools without MCP (also screenshot,
                                   tap, swipe); the CDP token proxy of pix3 editor
  pix3 gap "<what was missing>"    Record a gap Pix3 had (you worked around it) in
        [--kind capability|tool|node|doc|other] .pix3/gaps.jsonl;
        [--detail <text>] [--context <text>] --list prints them
        [--agent <name>] [--list] [--json] [--project <dir>]
  pix3 help <command>              That command's own usage (also pix3 <command> --help)
  pix3 --version
`;

/** `pix3 <command> --help`: one entry per command the entry dispatches (spec: `bin-bundle.spec`). */
export const COMMAND_USAGE = {
  new: `Usage: pix3 new [2d|3d] [dir] [--name <project name>] [--portrait|--landscape]

  Without a starter: list them. With one: create an empty Vite + @pix3/vite-plugin project in dir
  (default pix3-<2d|3d>) with the agent kit (AGENTS.md, CLAUDE.md, .claude/skills/pix3-*, script
  types). The same as npm create pix3.

  --name name    the project name (default: from the folder)
  --portrait     a 1080×1920 design viewport (phone games: match-3, tappers, runners)
  --landscape    a 1920×1080 design viewport (the default)
`,
  editor: `Usage: pix3 editor [--project <dir>] [--stop] [--stop-chrome] [--chrome-only] [--no-chrome]
                   [--headless] [--port <n>] [--cdp-port <n>] [--url <editor url>] [--ssh <host>]
                   [--remote-port <n>]

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
  --cdp-port n     the proxy's preferred port (default 9333); over SSH: the one RemoteForward
                   port of this host (stored; never a scan)
  --url url        on your machine: open a forwarded remote editor (no project here)
  --ssh host       with --url: the host the printed token-copy line names
  --remote-port n  with --url: the remote port of your RemoteForward line (default 9333) — the
                   only one the proxy proves its token for
`,
  'agent-setup': `Usage: pix3 agent-setup [claude|codex] [--repair] [--remote] [--cdp-port <n>] [--project <dir>]

  Write the project's MCP config for chrome-devtools-mcp — .mcp.json (Claude Code) and/or
  .codex/config.toml (Codex), both by default — pointing at the token proxy through the 0600 file
  ~/.pix3/cdp-mcp.json (no token in the project or on a command line).

  --repair       rewrite an entry that drifted (version, port, token, an older launch)
  --remote       the agent runs on an SSH host, Chrome on your machine (through the forward)
  --cdp-port n   the proxy port (default: the one pix3 editor recorded, else 9333); with
                 --remote the RemoteForward port (stored; default the one pix3 editor stored)
  --project dir  project folder (default: nearest folder with pix3project.yaml)
`,
  validate: `Usage: pix3 validate [paths…] [--json] [--no-hydrate] [--project <dir>]

  paths          .pix3scene / .prefab files or folders (default: every scene and .prefab)
  --json         machine-readable report (diagnostics + sha256 of each validated file)
  --no-hydrate   do not load the scenes as the game does: no project code runs (user: component
                 properties not checked)
  --project dir  project root (default: nearest folder with pix3project.yaml)
`,
  check: `Usage: pix3 check [--json] [--no-hydrate] [--offline] [--no-sync] [--project <dir>]

  Everything \`pix3 validate\` checks, plus a TypeScript type-check of the project's scripts
  (tsc --noEmit) and a version check.

  --json         machine-readable report (diagnostics, sha256 of every checked file, typecheck,
                 kit)
  --no-hydrate   do not load the scenes as the game does (user: component properties not checked)
  --offline      never install TypeScript (fails with the command to run instead)
  --no-sync      do not ask a running Pix3 editor (.pix3/dev.json) to flush its unsaved scenes first
  --project dir  project root (default: nearest folder with pix3project.yaml)
`,
  smoke: `Usage: pix3 smoke [scene] [--changed | --all] [--frames N] [--command name[@frame]]…
                  [--timeout S] [--json] [--no-sync] [--project <dir>]

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
                 top-level scene (not a prefab or a .prefab, not scenes/ui), scenes/main.pix3scene
                 first.
  --changed      only the scenes changed files reach (needs git; exit 2 when nothing changed)
  --all          every top-level scene, whatever git says
  --frames N     frames to step (default 120 = 2 s of game time)
  --command c    dispatch the game's scene.commands entry c before frame 1, or c@N before frame N,
                 with args as a JSON object after a space: --command 'swap@30 {"x":2,"y":3}'
                 (repeatable: --command start@1 --command restart@300); an unknown one is
                 W_SMOKE_COMMAND. Drives the game's intents headless — no input, no tap.
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
  sfx: `Usage: pix3 sfx <preset|"description"> [--out <file.wav>] [--seed <n>] [--rate <hz>] [--json]

Synthesizes a short sound effect offline into a 16-bit mono WAV (22.05 kHz: half the bytes of 44.1,
which a single-file build embeds as base64 — --rate 44100 when a sound needs the top octave).
  presets     ${SFX_PRESET_NAMES.join(', ')}
  description words that name a preset ("coin pickup", "big explosion"), plus modifiers:
              high/low, short/long, soft
  --out       output file (default: audio/<preset>.wav in the project root)
  --seed      a variation of the preset (same seed, same sound); default: the preset as tuned
  --rate      sample rate in Hz, 8000..48000 (default 22050)
  --json      print { path, res, durationMs, preset, seed, modifiers, bytes, peak, params }
Reference it from a scene or script as res://<path inside the project>.
`,
  font: `Usage: pix3 font [list] [--json]
       pix3 font add <family> [--project <dir>] [--json]

  A Label2D without a font file renders in whatever the machine has (Arial here, DejaVu on a
  headless Linux), so text looks different everywhere. This CLI carries six display families
  (Latin, two also Cyrillic; SIL OFL 1.1 / Apache 2.0); add copies one family's woff2 files and its
  licence into fonts/ and adds its faces to fonts: in pix3project.yaml, which the editor, the game
  and pix3 smoke load before the first frame. Then set labelFontFamily (and labelFontWeight to the
  weight it prints) on the labels and buttons. Idempotent; refuses to overwrite a different file.
  A single-file build embeds every registered face (~10–20 KB each).

  list        the families, weight, scripts, licence, look (default)
  add <name>  family or slug, any case: Nunito, "Lilita One", lilita-one
  --json      machine-readable (the catalog; or {family, weight, copied, registered})
`,
  play: `Usage: pix3 play [dev|dist|<url>|<dir>] [--size 390x844] [--scale 3] [--scene <res path>]
                 [--bot <name>] [--seconds S] [--screenshot <file.png>] [--shots <dir>] [--json]
                 [--project <dir>]

  The game's own page in a private headless Chrome at a phone's size — the dev server (default,
  when one runs) or the built dist/index.html as it ships ('dist', or when no server runs) —
  optionally played by a bot policy. No editor, no MCP: an agent's way to check the real page,
  the build included, with real input at a device size.

  dev | dist     the running dev server (?clean, no editor link) or dist/index.html (file://);
                 a URL or a folder holding index.html works too
  --size WxH     the viewport in CSS px (default 390x844, a phone); --scale the device pixel ratio
  --scene path   boot another scene (dev server only)
  --bot name     run design/tests/bots/<name>.ts on the page: the editor's bot API (tap, swipe,
                 press, axis, moveTo, command, nodes, gameState, done) on DOM input events —
                 physical-input only. Ends at done() or after --seconds (default 60 with a bot, 3
                 without). The game ticks a fixed 1/60 s per frame while a bot plays, so a frame
                 number means the same game time on any machine, and it stays paused on the frame
                 of done()
  --screenshot   save a PNG of the page at the end (with a bot: the frame of its verdict)
  --shots dir    where bot.screenshot(name) saves <name>.png — the game is frozen on the frame the
                 policy asked on, photographed, then runs on (default: beside --screenshot, else
                 .pix3/screenshots/play-<time>/)
  --json         machine-readable report

  Exit 0 = the page ran, nothing threw, the bot passed; 1 = errors, a failed or crashed bot, or a
  page that never booted; 2 = could not run (no Chrome, nothing to play, no such policy).
`,
  bridge: `Usage: pix3 bridge <pix3_tool> ['<json params>'] [--project <dir>]
       pix3 bridge screenshot [--target game|viewport] [--aspect free|16:9|9:16|4:3] [--out <file.png>]
       pix3 bridge tap <x> <y> | --node <id> [--touch]
       pix3 bridge swipe <x1> <y1> <x2> <y2> | --from <id> --to <id> [--touch] [--ms 180]

  The open editor tab's pix3_* tools, its screenshot and real pointer input, from the command line —
  the same tab and CDP token proxy the pix3-browser MCP server uses ('pix3 editor' started them),
  for an agent that cannot load that server: a subagent, CI, a session not restarted after
  agent-setup. The CLI reads the token itself and never prints it.

  <pix3_tool>    pix3_status, pix3_sync, pix3_scene, pix3_play, pix3_game_run, pix3_errors, … (the
                 pix3_ prefix may be dropped); params as one JSON object. Prints the tool's JSON
                 answer; exit 1 when it is {ok:false}.
  screenshot     bring the game (default) or the viewport to the front and save a PNG of the tab
                 (default .pix3/screenshots/<target>-<time>.png); prints the path. --aspect sets
                 the Game tab's frame first (it stays; also pix3_play's "aspect" param) — exact
                 phone sizes: pix3 play --size
  tap            a press and release at page CSS px, or at a node's origin (pix3_scene's screen —
                 during play, where the running node is on the Game tab)
  swipe          a drag between two page points or two nodes, over --ms milliseconds
  --touch        touch events (a phone finger) instead of the mouse
`,
  gap: `Usage: pix3 gap "<what was missing>" [--kind capability|tool|node|doc|other] [--detail <text>]
                [--context <text>] [--agent <name>] [--json] [--project <dir>]
       pix3 gap --list [--json] [--project <dir>]

  Record, in .pix3/gaps.jsonl, something Pix3 lacked that you worked around — not your own
  mistakes or the game's features. One line per record: the summary is at most 200 characters —
  put the rest in --detail.

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
