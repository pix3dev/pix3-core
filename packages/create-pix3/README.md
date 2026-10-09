# create-pix3

```bash
npm create pix3@latest [dir] -- [--template 2d|3d] [--name <project name>] [--yes]
```

Creates an **empty** Pix3 game project: a Vite + TypeScript project with `@pix3/runtime`, the Pix3
editor (`@pix3/vite-plugin` + `@pix3/editor-core`) and the agent kit (`AGENTS.md`, `CLAUDE.md`,
`.claude/skills/`). In a terminal it asks 2D or 3D and the folder; `--yes` (or no TTY) takes `2d`
and `pix3-game`. Nothing in it plays a game — the coding agent builds that.

```bash
cd pix3-game
npm install
npm run dev     # the game at /, the editor at /__pix3/
npm run build   # dist/index.html, one self-contained file
```

## Layout

- `index.js` → `src/create.js` — the bin: parses the arguments, asks what is missing, runs
  `pix3 new <2d|3d> <dir>` of the `@pix3/cli` it depends on (its sources in a pix3-core checkout).
  Plain JavaScript (type-checked with `checkJs`): a create-* bin runs from `node_modules`, where
  Node does not strip TypeScript, and this one needs no build.
- `templates/` — composed, not duplicated:
  - `base/files/` — everything both starters share: `package.json`, `vite.config.ts` (`pix3()`),
    `index.html`, `src/main.ts` (`startGame('#app')`), `tsconfig.json`, `gitignore` (copied as
    `.gitignore`: npm drops dotfile-gitignores from tarballs), `README.md`;
  - `2d/`, `3d/` — `template.yaml` (`extends: base`, `projectType`, viewport, `entryScene`) and
    one empty `files/scenes/main.pix3scene` (2D: a stretched `Group2D` root and a background;
    3D: camera, key light, ambient).

  Placeholders: `{{PROJECT_NAME}}`, `{{PACKAGE_NAME}}` (npm-safe slug), `{{PIX3_VERSION}}` (the
  lockstep version of the `@pix3/*` packages). `@pix3/cli`'s `copy-templates` copies the folders
  into the CLI tarball. Composition is read by `packages/cli/src/templates.ts`, the copy is
  `packages/cli/src/new-project.ts`.
- `src/create.spec.ts` — the bin end to end (both starters, defaults, a refused template);
  `packages/cli/src/new-project.spec.ts` pins the starter shape file by file.

The 1.x recipes and playable templates are gone from here (owner decision 2026-10-10); the ones the
loader/saver/patch goldens need are test fixtures in `packages/runtime/fixtures/scene-corpus/`.
Record: `.plans/templates.md`.
