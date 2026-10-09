import { CLI_VERSION } from './version.ts';

/**
 * The `pix3` help text — its own module so specs (the kit drift spec checks every command the kit
 * names against it) can read it without running the CLI.
 */
export const USAGE = `pix3 ${CLI_VERSION}

Usage:
  pix3 new                         List recipes and templates
  pix3 new <recipe> [dir]          Create a project (dir defaults to the recipe id)
        [--name <project name>]
  pix3 editor [--project <dir>]    Find (or start, detached) the project's Vite dev server
        [--stop] [--chrome-only]   from .pix3/dev.json and open the editor in Chrome with
        [--no-chrome] [--port <n>] remote debugging on 9333 (next free port when taken)
        [--cdp-port <n>] [--headless]
  pix3 agent-setup [claude|codex]  Write the project's MCP config for chrome-devtools-mcp
        [--repair] [--cdp-port <n>] (.mcp.json, .codex/config.toml); --repair fixes an
        [--project <dir>]          entry that drifted (version, port)
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
        [--project <dir>]          .claude/skills/pix3-*, script types
  pix3 sfx <preset|"text">         Synthesize a sound effect offline into a WAV (coin, jump,
        [--out <file.wav>]         hit, explosion, powerup, click; or "big explosion")
        [--seed <n>] [--json]
  pix3 --version
`;
