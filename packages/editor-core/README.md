# @pix3/editor-core

The Pix3 editor (Lit, Valtio, Golden Layout), shipped as prebuilt ESM and mounted by `@pix3/vite-plugin` through `mountEditor(el, host: EditorHost)`.

## Status: source snapshot, not yet ported

`src/` is a copy, without history, of the editor directories that pix3-core keeps (plan `pix3/.plans/pix3-core.md` §F.1), taken from `pix3` at **`5442a097042cd482eb86c6be08da0768c19badf9`**. Directories are copied whole; the trims, seams and rewrites of §F.1–F.2 are the port's work, so `git diff` against that commit is the port's record.

Until the port makes it compile, this package is outside `npm run lint`, `type-check` and `test`. Three specs elsewhere read from it already: `create-pix3/templates/recipes.spec.ts` (`parseRoutine`), `cli/src/validate/validate.golden.spec.ts` (`src/templates/*.pix3scene`) and `cli/src/kit.spec.ts` (`services/agent/AgentToolRegistry.ts`, as text).

- `src/` — `core`, `fw`, `state`, `types`, kept `ui/*`, `services/*`, `features/*`, `main.ts`, the shell, and `templates/` (startup scene, build templates).
- `assets/` — images the viewport loads by absolute URL today (`/cam.png`, `/lamp.png`, `/particles.png`); they move to `/__pix3/assets/` (plan §B.1).
- `services/agent` keeps its name in the snapshot; the port moves it to `services/game-test`.
