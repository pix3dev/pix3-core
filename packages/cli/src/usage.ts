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
        [--seed N] [--ads <outcomes>]
        [--seed N] [--config '<json>'] a test run: scene.random seeded, component config overridden
        [--golden <f.json> [--write]] the run's end state + events pinned in a file (exit 1 on a diff)
        [--record <f> [--every N]] the run as a replay file; --replay <f> plays one back, exact,
        [--replay <f>]             comparing checkpoints (exit 1 with the interval and paths)
  pix3 tree [scene] [--json]       One line per node (type#id, pos, size, layout, components,
        [--depth N] [--types A,B]  prefab instances); no scene = project overview
        [--props] [--project <dir>]
  pix3 grid <scene> --parent <id>  Write rows × cols instances of a prefab under a node, once
        --prefab <res://…>         (a board's cells, a level page): plain YAML, centred on the
        --rows R --cols C          parent, row 0 on top; --checker for alternate cells,
        [--step W[xH]] [--replace] --replace rewrites an earlier run's cells
  pix3 kit [--update]              Install (or update) the agent kit: AGENTS.md, CLAUDE.md,
        [--migrate]                .claude/skills/pix3-*, script types; --migrate: a 1.x kit
        [--project <dir>]          → 2.x (drops the pix3 mcp server, retired files, pix3Hybrid)
  pix3 character-compile <spec>    A 2D character from frame PNGs: <slug>.pix3anim with
        [--dry-run] [--force]      <variant>.<state> clips + a prefab with
        [--json] [--project <dir>] core:CharacterVisual2D (refuses to overwrite)
  pix3 sfx <preset|"text">         Synthesize a sound effect offline into a WAV (coin, jump,
        [--out <file.wav>]         hit, explosion, powerup, click, whoosh, chime, win, lose,
                                   deny; or "big explosion")
        [--seed <n>] [--json]
  pix3 font [add <family>]         List the fonts this CLI ships (Nunito, Rubik, Baloo 2, …);
        [--project <dir>] [--json] add copies one into fonts/ and registers it in pix3project.yaml
  pix3 play [dev|dist] [--bot <n>] The game's page (or the build) in a headless Chrome at a phone
        [--size 390x844]           size, optionally played by a bot policy; screenshot, errors;
        [--screenshot <f.png>]     a bot's bot.screenshot(name) pictures go to --shots
        [--shots <dir>] [--frames N] [--bot-args '<json>']
        [--seed N] [--config '<json>'] [--safe-area T,R,B,L]
        [--reduced-motion] [--storage memory|'<json>'|<file>]
        [--ads reward|skip|unavailable|<list>] [--json]
        [--run '<json>']           --run: one pix3_game_run on the page (dev or dist);
        [--golden <f.json> [--write]] a bot/--run round's end pinned in a file (exit 1 on a diff)
        [--profile] [--tree]       --profile: frame/logic/render ms, activities, draw calls;
                                   --tree: the live object tree at the end
        [--record <f> [--every N]] the run as a replay file (dev server); --replay <f> plays one
        [--replay <f>]             on the page, a picture at the divergence
  pix3 render <scene|prefab>       Draw a model from several sides into one PNG sheet (headless
        [--node <id>] [--views iso,front,right,top|all|az:el] Chrome; the scene starts, so
        [--size 512] [--out <f.png>] core:MergeStatic bakes); mesh, draw-call, triangle counts,
        [--lights auto|studio|scene] how it reads (luminance, near-black, saturation);
        [--reference <img>] [--json] --reference: compared with it, its palette;
        [--job <id> --stage <name>]  --job: a pass of a model job (its scene, views, reference),
        [--note <text>] [--force <reason>] stages in order unless --force says why
  pix3 model <subcommand> [<id>]   A model job in .pix3/model-jobs/: stages, passes (pix3
        new <id> --target <scene|prefab> render --job), the human's feedback from the editor's
        [--node <id>] [--title <text>] 3D Asset Generator panel; next: where it stands
        [--reference <img>] [--reference-background <hex>]
        [--stages a,b,c] [--views <list>] [--size N]
        feedback <id> [--wait] [--timeout <s>] [--json]
        next <id> [--json] | done <id> [--failed <reason>] [--force]
        list [--json] | rm <id>    (each takes --project <dir>)
  pix3 bridge <tool> ['<json>']    The editor tab's pix3_* tools without MCP (also screenshot,
                                   tap, swipe, render); the CDP token proxy of pix3 editor
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
                  [--seed N] [--config '<json>'] [--ads <outcomes>] [--timeout S] [--json] [--no-sync]
                  [--golden <file.json> [--write] [--tolerance '<path>=<eps>,…']] [--project <dir>]
                  [--record <file.pix3replay> [--every N]]
       pix3 smoke --replay <file.pix3replay> [--timeout S] [--json] [--project <dir>]

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
  --seed N       seed scene.random, so the same run replays (the same board, the same spawns)
  --config json  override component config for the run: '{"<nodeId>": {"<componentId>":
                 {"moves": 3}}}' — set before the first onStart; a wrong address is an error
  --ads o        what every platform ad show does: reward | skip | unavailable, or a list by show
                 order (reward,skip); without it every show is unavailable, as in a build with no
                 portal adapter
  --timeout S    wall-clock limit in seconds (default 20) → exit 2, E_SMOKE_TIMEOUT
  --golden f     compare the run's end with a golden file: { gameState: the registerGameDebug
                 snapshot, analytics: [{name, props}] in order }; exit 1 with one line per path that
                 differs (expected → actual), exit 2 when the file is missing. Paths are the
                 pix3_game_run gameState paths rooted at the file: gameState.score.best,
                 analytics.0.props.level; arrays of items with a unique id are matched by id.
                 Give the run the same flags (--seed, --frames, --config, …) every time; needs a scene
  --write        record the golden instead (only a clean run with something to pin)
  --tolerance t  numeric paths allowed to drift, each covering what is below it:
                 'gameState.stats.avg=0.01,gameState.units=0.5'; everything else is exact
  --record f     write the run as a replay file: the inputs from outside the game (--command here),
                 its settings and checkpoints of the gameState and the live tree every 30 ticks
  --every N      ticks between checkpoints of --record (1 = every tick: the exact tick of a
                 divergence, a bigger file)
  --replay f     play a recording back (pix3 play --record or smoke --record): its scene, settings,
                 inputs and ticks, comparing every checkpoint. MATCH, or DIVERGED between tick A and
                 B with the paths that differ (state.score, tree.player.p.0) and both checkpoints
                 written beside the file as <file>.tick-B.recorded.json / .replayed.json
  --json         machine-readable report
  --no-sync      do not ask a running Pix3 editor (.pix3/dev.json) to flush its unsaved scenes first
  --project dir  project folder (default: nearest folder with pix3project.yaml)

  Exit: 0 = no errors, 1 = errors, a --golden that differs / was not written, or a replay that
  diverged or stopped, 2 = could not run (no scene, bundle failure, unsupported, timeout, no golden
  file, a file that is not a recording — E_SMOKE_REPLAY_FILE — or E_RUNTIME_VERSION: the project
  installs another @pix3/runtime than this CLI runs).
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
  grid: `Usage: pix3 grid <scene> --parent <node id> --prefab <res://…> --rows R --cols C
                 [--step W[xH]] [--id <pattern>] [--name <pattern>] [--props '<json>']
                 [--checker '<json>'] [--replace] [--dry-run] [--json] [--project <dir>]

  Writes rows × cols instances of one prefab as children of a node of the scene, once — a board's
  backing cells, a level-select page — instead of typing 64 near-identical YAML blocks. The result
  is ordinary YAML (one instance: entry per cell with its position and overrides): the editor
  shows it, pix3 tree lists it, you edit it like any node. Nothing repeats at run time; pieces a
  script moves are still spawned by the script.

  scene          the .pix3scene to write into (res://, project-relative or a path)
  --parent id    the node the cells go under (a Group2D of this scene, not a prefab instance)
  --prefab res   the prefab every cell instances (res://scenes/prefabs/cell.pix3scene)
  --rows --cols  how many (or --size CxR); at most 1024 cells
  --step W[xH]   distance between cell centres in the parent's units (default: the prefab root's
                 width x height). The grid is centred on the parent's origin, row 0 at the top
                 (Y up), col 0 on the left: an 8x8 of 124 puts cell-0-0 at (-434, 434)
  --id pattern   cell ids, with {row} {col} {i} (default <prefab root id>-{row}-{col}: cell-3-5)
  --name pattern cell names (default "<prefab root name> {row}-{col}")
  --props json   property overrides for every cell; {row} {col} {i} fill in its strings
  --checker json overrides for the cells where row + col is odd, over --props (a two-tone board:
                 --checker '{"texture":{"type":"texture","url":"res://sprites/cell-b.svg"}}')
  --replace      the parent already holds cells of this --id pattern (an earlier run): rewrite
                 them in place; without it the command refuses and writes nothing
  --dry-run      print the scene as it would be written, write nothing
  --json         {scene, parent, prefab, rows, cols, step, first, last, written, replaced}
  --project dir  project folder (default: nearest folder with pix3project.yaml, else cwd)

  Comments and the rest of the file stay as written. Then: pix3 tree <scene> --depth 4, pix3 check.
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
                 [--run '<json>' | --bot <name> [--bot-args '<json>']] [--seed N] [--config '<json>']
                 [--frames N]
                 [--seconds S] [--safe-area T,R,B,L] [--no-safe-area-overlay] [--reduced-motion]
                 [--storage memory|'<json>'|<file>] [--ads reward|skip|unavailable|<a,b,…>]
                 [--screenshot <file.png>] [--shots <dir>] [--profile] [--tree] [--json]
                 [--golden <file.json> [--write] [--tolerance '<path>=<eps>,…']] [--project <dir>]
                 [--record <file.pix3replay> [--every N]]
       pix3 play --replay <file.pix3replay> [--seconds S] [--json] [--project <dir>]

  The game's own page in a private headless Chrome at a phone's size — the dev server (default,
  when one runs) or the built dist/index.html as it ships ('dist', or when no server runs) —
  optionally driven by a test run or a bot policy. No editor, no MCP: an agent's way to check the
  real page, the build included, with real input at a device size.

  dev | dist     the running dev server (?clean, no editor link) or dist/index.html (file://);
                 a URL or a folder holding index.html works too
  --size WxH     the viewport in CSS px (default 390x844, a phone); --scale the device pixel ratio
                 (default 3, 2 with --run/--bot: every frame is painted, and DPR 3 is a slow round)
  --safe-area    emulate a notch and a home indicator: top,right,bottom,left CSS px (an iPhone 14:
                 47,0,34,0) — the page's env(safe-area-inset-*), what layout.safeArea nodes avoid.
                 Every picture shades those bands in translucent magenta with a dashed edge, so a
                 screenshot shows what would sit under the notch or the home indicator;
                 --no-safe-area-overlay takes the shading off (the page itself never has it)
  --scene path   boot another scene (dev server only)
  --run json     one pix3_game_run on the page, its params as JSON: until/fail predicates, watch,
                 monkey, bot (physical-input or direct-action), control, maxFrames, pauseOnOutcome…
                 '{"until":[{"kind":"frames","n":120}],"bot":{"name":"menu"}}'. The page's own test
                 host runs it (the editor's code; on dev imported by the page with the policies Vite
                 serves, on dist injected with the policy compiled here) and the report is the one
                 the bridge returns ("run" in --json). On a page a negative control restores
                 state only through the game's reset(seed) (no scene restart in place), and
                 reach proofs last only as long as the page
  --bot name     run design/tests/bots/<name>.ts on the page in real time: the editor's bot API (tap, swipe,
                 press, axis, moveTo, command, nodes, gameState, done) on DOM input events —
                 physical-input only. Ends at done() or after --frames game frames (default 7200,
                 two minutes of game time, however slowly the page paints); --seconds is the
                 wall-clock limit (default 300 with --run or a bot; without one, how long the page
                 runs: 3).
                 The game ticks a fixed 1/60 s per frame while a bot plays, so a frame number means
                 the same game time on any machine, and it stays paused on the frame of done()
  --seed N       seed scene.random for this run (dev and dist: injected into the page), so a
                 bot meets the same board every time
  --config json  override component config for this run (dev and dist):
                 '{"<nodeId>": {"<componentId>": {"moves": 3}}}' — a short round, a set target;
                 a wrong node, component or key is an error
  --reduced-motion  scene.app.reducedMotion true for this run (dev and dist), whatever the
                 system or the game's own toggle says: shakes a quarter as far, no flash
  --storage      the save scene.storage plays with, in memory (dev and dist; the real save is
                 never read or written): memory = empty, or a snapshot as scene.storage.export()
                 returns it, '{"version":1,"data":{"best":10}}', inline or in a file
  --ads          what every platform ad show does (dev and dist), whatever adapter the game has:
                 reward | skip | unavailable, or a list by show order (reward,skip,unavailable —
                 unavailable after it). Without it the dev page shows its placeholder (a few
                 seconds of real time) and a build answers unavailable
  --bot-args     one JSON object the policy reads as bot.args ('{"target":"lose"}'): one policy,
                 several variants
  --screenshot   save a PNG of the page at the end (with a bot: the frame of its verdict)
  --shots dir    where bot.screenshot(name) saves <name>.png — the game is frozen on the frame the
                 policy asked on, photographed, then runs on (default: beside --screenshot, else
                 .pix3/screenshots/play-<time>/)
  --profile      measure the run (dev and dist alike; the CLI injects the debug overlay's collector):
                 the wall-clock frame interval (mean, p50/p95/p99, worst, frames >33.4 ms), the
                 game's work per frame, logic per tick and per frame, render per painted frame,
                 the FrameProfiler activities the game reports (scene.reportFrameProfilerActivities),
                 draw calls / triangles / geometries / textures / programs (and programs linked
                 while measured), JS heap, Long Animation Frames, the GPU string. The first second
                 is warm-up and excluded. With --bot the game ticks 4 fixed 1/60 s ticks per
                 painted frame: compare logic per tick; frame interval is the page's throughput.
                 Headless Chrome renders on SwiftShader (said in the report): render ms there are
                 not a device's — logic ms and the counters are. Give it --seconds 6 or more
  --tree         print the running game's object tree at the end (dev and dist): every node
                 (Type#id) and every object the game made at run time (Type "name") under it,
                 ×N for an instanced mesh, hidden for one not visible; capped at 250 children an
                 object and 5000 in all. The same tree as /?debug's Scene tab and
                 __PIX3_PLAYER__.debug.tree()
  --json         machine-readable report (with --tree: "tree" {count, truncated, roots})
  --golden f     compare the run's end with a golden file: { gameState: the registerGameDebug
                 snapshot, analytics: [{name, props}] in order }; exit 1 with one line per path that
                 differs (expected → actual), exit 2 when the file is missing. Paths are the
                 pix3_game_run gameState paths rooted at the file: gameState.score.best,
                 analytics.0.props.level; arrays of items with a unique id are matched by id.
                 Needs --bot or --run (a fixed-step round); give it the same flags
                 (--seed, --config, --bot-args, …) every time
  --write        record the golden instead (only a clean run with something to pin)
  --tolerance t  numeric paths allowed to drift, each covering what is below it:
                 'gameState.stats.avg=0.01,gameState.units=0.5'; everything else is exact
  --record f     write the run as a replay file (dev server only): the inputs from outside the game
                 (the bot's taps and commands, a trip to the background, ad outcomes), its settings,
                 every tick's time step and checkpoints every 30 ticks; replay it in Node with
                 pix3 smoke --replay f (exact) or here with --replay
  --every N      ticks between checkpoints of --record (1 = every tick)
  --replay f     play a recording back on the dev page at its screen (best-effort): MATCH, or
                 DIVERGED between tick A and B with the differing paths, both checkpoints beside
                 the file and <file>.tick-B.png, the page on that tick

  Exit 0 = the page ran frames, nothing threw, the bot or the run passed (an until met, or the
  policy's done(true)) and a --golden matched; 1 = errors, a failed or crashed bot, a run that
  failed, timed out or was refused, a page that never booted or whose loop ran no frame, a golden
  that differs or was not written, a replay that diverged or stopped; 2 = could not run (no Chrome,
  nothing to play, no such policy, no golden file, --record/--replay on a build, a file that is not
  a recording).
`,
  render: `Usage: pix3 render <scene.pix3scene|res://…> [--node <id>] [--views <list>] [--size 512]
                   [--out <file.png>] [--lights auto|studio|scene] [--background '#8f9aa6']
                   [--frames N] [--reference <image> [--reference-background <hex>]] [--json]
                   [--project <dir>]
       pix3 render --job <id> --stage <name> [--note "<text>"] [--force "<reason>"] [flags above]

  A scene or prefab — or one node of it — drawn from several sides into ONE PNG sheet (two
  columns, each tile labelled), in a private headless Chrome: look at a model you built (Read
  the PNG) before you call it done. The scene loads and its components start as in play
  (core:MergeStatic merges and bakes in onReady), --frames frames run (default 2), then a camera
  framing the visible meshes takes each view. No dev server or editor needed. Prints the PNG
  path and what was drawn: meshes, draw calls, triangles, size; then how it reads, inside the
  model's mask: linear luminance p10/p50/p90, near-black share, saturation, flat share, and a
  note (reads dark / reads dim / desaturated) — hints, never a failure.

  --node id      only that node's subtree (the rest is hidden; the camera frames it)
  --views list   comma list of iso, front, right, back, left, top, below, game, or az:el in
                 degrees (azimuth 0 = from +Z, 90 = from +X; elevation above the horizon);
                 all = every named view. Default iso,front,right,top
  --size px      one tile's side, 64–2048 (default 512)
  --out file     where the PNG goes (default .pix3/renders/<scene>[-<node>].png)
  --lights m     auto (default: the scene's lights, a studio rig when it has none), studio
                 (always the rig; the scene's are switched off), scene (only the scene's)
  --background c the clear colour (default #8f9aa6)
  --frames N     frames to run before drawing (default 2)
  --reference f  an image of the model as it should look, from the FIRST view: drawn as the first
                 tile and compared — silhouette IoU, luminance by height band, saturation ratio —
                 and its palette (hex colours, background excluded) printed; all hints
  --reference-background hex   the reference's background colour, when it has no alpha and its
                 corners do not show it (otherwise a failed mask is reported)
  --json         machine-readable report (look, reference)

  A pass of a model job (pix3 model new): --job id --stage name. The scene, node, reference (and
  its background), views and size come from the job; a flag given here wins and is recorded in
  the pass's params. The sheet and the report go into .pix3/model-jobs/<id>/passes/NN-<stage>/
  (--out is refused), the pass into job.json, with its metrics; feedback already delivered is
  marked addressed by it. Stages go in order: the first pass is the first stage, then the same
  stage again or the next one; anything else is refused (exit 2) unless --force "<reason>"
  (kept in the pass). A render that fails or logs a page error records nothing.
  --job id       the job        --stage name   the pass's stage
  --note text    what this pass changes (kept in the pass)
  --force reason why this pass skips the stage order

  Exit 0 = drawn, no page error; 1 = the scene failed, nothing visible, or the page logged an
  error; 2 = could not run (no Chrome, no such file, no project) or a refused pass.
`,
  bridge: `Usage: pix3 bridge <pix3_tool> ['<json params>'] [--project <dir>]
       pix3 bridge screenshot [--target game|viewport] [--page designer|agent] [--out <file.png>]
       pix3 bridge tap <x> <y> | --node <id> [--touch]
       pix3 bridge swipe <x1> <y1> <x2> <y2> | --from <id> --to <id> [--touch] [--ms 180]
       pix3 bridge render [--node <id>] [--views <list>] [--size 384] [--lights auto|studio|scene]
                          [--background <colour>] [--out <file.png>]

  The open editor tab's pix3_* tools, its screenshot and real pointer input, from the command line —
  the same tab and CDP token proxy the pix3-browser MCP server uses ('pix3 editor' started them),
  for an agent that cannot load that server: a subagent, CI, a session not restarted after
  agent-setup. The CLI reads the token itself and never prints it.

  <pix3_tool>    pix3_status, pix3_sync, pix3_scene, pix3_play, pix3_game_run, pix3_errors, … (the
                 pix3_ prefix may be dropped); params as one JSON object. Prints the tool's JSON
                 answer; exit 1 when it is {ok:false}.
  screenshot     bring a game page (default) or the editor's viewport to the front and save a PNG
                 (default .pix3/screenshots/<target>-<time>.png); prints the path. The game page:
                 --page designer (the human's Play window; the default while it is open) or agent
                 (yours), its debug overlay hidden for the capture. Exact phone sizes: pix3 play
                 --size
  tap            a press and release on your game page at its CSS px, or at a node's origin
                 (pix3_scene's screen on that page); refused (page_reloaded) when the page
                 reloaded since the node was read, and never on the human's page (not_your_page)
  swipe          a drag between two page points or two nodes, over --ms milliseconds
  render         pix3_render_model to a PNG: the node (default: the scene's 3D roots) of the
                 active scene as the editor holds it — unsaved edits and a pix3_bake included —
                 from each view (as pix3 render's --views), alone on a plain background; prints
                 the path (default .pix3/renders/editor-<node>.png) and meshes, draw calls,
                 triangles, size, the baked nodes. pix3 bridge bake '{"action":"apply"}' first to
                 see core:MergeStatic's bake (pix3_bake: apply | clear | status, nodeId?)
  --touch        touch events (a phone finger) instead of the mouse

  The game runs on its own page, in a process of its own: pix3_play start opens yours. A
  pix3_play start whose window does not open (popup_blocked) is opened as a new tab in the
  Chrome 'pix3 editor' started. With two editor tabs open the CLI talks to the writer.
`,
  model: `Usage: pix3 model new <id> --target <scene|prefab|res://…> [--node <id>] [--title <text>]
                       [--reference <image> [--reference-background <hex>]]
                       [--stages blockout,structure,form,material,bake] [--views <list>] [--size N]
       pix3 model feedback <id> [--wait] [--timeout <s>] [--json]
       pix3 model next <id> [--json]
       pix3 model done <id> [--failed <reason>] [--force]
       pix3 model list [--json]
       pix3 model rm <id>
       (each takes --project <dir>)

  The journal of one model you build, in .pix3/model-jobs/<id>/ (local, not in git): its stages,
  every pass pix3 render --job draws (sheet, report, metrics), and what the human says about them
  in the editor's 3D Asset Generator panel (Window menu): text, marks drawn on a pass's sheet, a
  verdict (accept / needs changes).

  new        opens a job on a scene or prefab (it must exist; stored as res://); the reference is
             copied into the job and its sha256 kept; --stages (default blockout, structure,
             form, material, bake), --views and --size are what each pass renders by default
  feedback   prints what the human sent and you have not seen yet — pass, verdict, text, marks
             in words (front: rect 30%×20%, top right) and the marked sheet to Read — and marks
             it delivered; your next render --job marks it addressed. --wait: when there is
             none, wait for it (the panel shows "waiting for you"), polling every second, up to
             --timeout seconds (default 540; then exit 0 with "No feedback yet")
  next       the stages and their passes, what --stage may come next, the last verdict, new
             feedback
  done       closes the job; refused while there is undelivered feedback or no pass of the last
             stage, unless --force (what was skipped is kept as the result). --failed <reason>
             closes it as failed
  list       every job: status, passes, last stage, waiting
  rm         deletes a job (refused while a feedback --wait on it is alive)

  Exit 0 = done; 1 = refused (no such job, a taken id, open feedback); 2 = bad
  arguments or no project.
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
