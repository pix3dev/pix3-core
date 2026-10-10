# {{PROJECT_NAME}}

A Pix3 game: a Vite + TypeScript project with `@pix3/runtime` and the Pix3 editor
(`@pix3/vite-plugin`).

```bash
npm install
npm run dev        # the game at http://localhost:5173/, the editor at http://localhost:5173/__pix3/
npm run editor     # pix3 editor: the dev server (started if needed) + the editor in Chrome for a coding agent
npm run build      # dist/index.html — one self-contained playable
npm run preview    # serve dist/ to try the build
npm run check      # pix3 check: scenes, res:// paths, components, a type-check of the scripts
npm run smoke      # pix3 smoke: run the game headless for 2 s and report what threw
```

## Layout

- `scenes/` — scenes (`.pix3scene`, YAML); `scenes/main.pix3scene` is the entry scene
  (`defaultExportScenePath` in `pix3project.yaml`)
- `scripts/` — script components (`export class X extends Script`, used as `user:X`)
- `sprites/`, `audio/` — assets, referenced as `res://sprites/x.png`
- `design/` — design notes and references
- `src/main.ts` — boots the entry scene (`startGame` from `@pix3/vite-plugin/player`)
- `pix3project.yaml` — the project manifest (viewport, quality, entry scene)
- `AGENTS.md` — rules and pointers for coding agents working on this project
