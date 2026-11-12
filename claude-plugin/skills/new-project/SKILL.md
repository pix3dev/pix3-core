---
name: new-project
description: Create a new Pix3 game project and hand over to a session inside it. Use when the user asks to create, start or set up a Pix3 game or project ("make a game with Pix3", "new pix3 project", "создай pix3 проект", "сделай игру на pix3"), including when they describe the game in the same message. Not for work inside an existing Pix3 project — that project's own AGENTS.md and skills cover it.
---

# New Pix3 project

Pix3 is an HTML5 2D/3D game engine with a visual editor. A game is a plain Vite + TypeScript
project; the editor runs on the same dev server at `/__pix3/`. This skill only creates the
project. Everything about building the game lives in the project itself (`AGENTS.md`,
`CLAUDE.md`, `.claude/skills/pix3-*`), versioned with the engine the project uses.

## 1. Check the machine

- `node -v` must be 24.15 or newer within Node 24. If Node is missing or older, tell the user to
  install Node 24 LTS from https://nodejs.org/ and stop.
- Google Chrome is needed later, for the editor the agent drives. Mention it if it is not
  installed; it does not block creating the project.

## 2. Decide, don't interrogate

Take what the user said; ask only when the folder would overwrite something.

- **Folder**: the name the user gave, else a short kebab-case name from the game idea, else
  `pix3-game`. It must not exist yet, and must not be inside another Pix3 project (no
  `pix3project.yaml` in the current folder or its parents).
- **2D or 3D**: `2d` unless the user asks for 3D or the idea needs it (a 3D world, a 3D camera).
- **Orientation**: `--portrait` for a phone game played one-handed (tapper, match-3, runner,
  merge, idle); otherwise leave it out (landscape 1920×1080).

Say what you chose in one line.

## 3. Create

Run these as they are; `--yes` keeps npm and `create-pix3` from prompting.

```bash
npm create --yes pix3@next <folder> -- --template <2d|3d> [--portrait] --yes
cd <folder>
npm install
npx pix3 agent-setup claude
```

`npm install` may warn that install scripts were not run (esbuild); the project still builds.
`agent-setup` writes `.mcp.json` with the `pix3-browser` server — the agent's access to the
editor in Chrome.

If the user already described the game, write their description to `<folder>/design/brief.md`
as they said it, and copy reference images they attached into `<folder>/design/refs/`. Do not
turn it into a design document yourself — the session in the project does that with the kit.

## 4. Hand over

The project's instructions, skills and `.mcp.json` load only in a session **started in the
project folder**. This session cannot build the game properly; do not start writing game code
here. Tell the user:

```bash
cd <folder>
claude
```

then approve the `pix3-browser` MCP server when asked, and describe the game (or say "build the
game from design/brief.md" if you saved one). `npm run dev` shows the game at
`http://localhost:5173/` and the editor at `http://localhost:5173/__pix3/`.

## Don't

- Don't clone `pix3dev/pix3-core` or `pix3dev/pix3` to make a game — they are the engine and the
  entry page, not a game template.
- Don't send the user to `editor.pix3.dev`: that is the archived 1.x editor, a different format.
- Don't build the game as a custom canvas or HTML page outside the project's scenes and editor.
