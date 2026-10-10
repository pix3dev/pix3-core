import { CLI_VERSION } from './version.ts';

/**
 * The `pix3` help text — its own module so specs (the kit drift spec checks every command the kit
 * names against it) can read it without running the CLI.
 */
export const USAGE = `pix3 ${CLI_VERSION}

Usage:
  pix3 new                         List the starters (2d, 3d)
  pix3 new <2d|3d> [dir]           Create an empty project (dir defaults to pix3-<2d|3d>)
        [--name <project name>]
  pix3 editor [--project <dir>]    Find (or start, detached) the project's Vite dev server
        [--stop] [--chrome-only]   from .pix3/dev.json and open the editor in Chrome, its
        [--no-chrome] [--port <n>] CDP behind the token proxy ws://127.0.0.1:9333/pix3 (next
        [--cdp-port <n>]           free port when taken); --stop-chrome ends that Chrome
        [--headless] [--stop-chrome]
  pix3 agent-setup [claude|codex]  Write the project's MCP config for chrome-devtools-mcp
        [--repair] [--cdp-port <n>] (.mcp.json, .codex/config.toml, with the proxy token);
        [--project <dir>]          --repair fixes an entry that drifted (version, port,
                                   token, the P1 --browserUrl launch)
  pix3 validate [paths…] [--json]  Strict scene check: schema, references, guards, then
        [--no-hydrate]             hydration with the real loader (exit 1 on errors)
  pix3 check [--json]              validate + TypeScript check of the scripts + merge-log +
        [--no-hydrate] [--offline] version check (exit 1 on errors)
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
  pix3 --version
`;
