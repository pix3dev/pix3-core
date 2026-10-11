# {{PROJECT_NAME}}

A Pix3 game: a Vite + TypeScript project with `@pix3/runtime` and the Pix3 editor
(`@pix3/vite-plugin`).

```bash
npm install
npm run dev        # the game at http://localhost:5173/, the editor at http://localhost:5173/__pix3/ (*)
npm run editor     # pix3 editor: the dev server (started if needed) + the editor in Chrome for a coding agent
npm run build      # dist/index.html — one self-contained playable
npm run preview    # serve dist/ to try the build
npm run check      # pix3 check: scenes, res:// paths, components, a type-check of the scripts
npm run smoke      # pix3 smoke: run the game headless for 2 s and report what threw
```

(*) 5173 is Vite's first choice, not a promise: when it is taken Vite uses 5174, 5175, … The
address in use is what `npm run dev` / `npm run editor` prints, and `.pix3/dev.json`
(`editorUrl`) while the server runs.

**Pix3 2.0.0-alpha is not on npm yet**, so `npm install` fails until it is published. Until
then, link a pix3-core checkout instead: build it once (`npm install && npm run build -w
packages/editor-core && npm run build -w packages/vite-plugin` in the checkout), then in this
project `rm -rf node_modules && ln -s <pix3-core>/node_modules node_modules` — the checkout's
workspaces provide `@pix3/*`, Vite and the rest. The `pix3` scripts (`editor`, `check`, `smoke`)
need the CLI's bin, which the checkout links only once its CLI is built (prepack steps in its
`packages/cli`); until then run `node <pix3-core>/packages/cli/src/index.ts editor` (or `check`,
`smoke`) from this folder.

## Layout

- `scenes/` — scenes (`.pix3scene`, YAML); `scenes/main.pix3scene` is the entry scene
  (`defaultExportScenePath` in `pix3project.yaml`)
- `scripts/` — script components (`export class X extends Script`, used as `user:X`)
- `sprites/`, `audio/` — assets, referenced as `res://sprites/x.png`
- `design/` — design notes and references
- `src/main.ts` — boots the entry scene (`startGame` from `@pix3/vite-plugin/player`)
- `pix3project.yaml` — the project manifest (viewport, quality, entry scene)
- `AGENTS.md` — rules and pointers for coding agents working on this project
