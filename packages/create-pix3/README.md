# create-pix3

`npm create pix3@latest <dir> -- --template <id> --yes` — scaffolds a Vite + TS game project with `@pix3/runtime`, `@pix3/vite-plugin` and the agent kit.

- `templates/` — the project templates (history from `pix3/src/templates/projects`). `@pix3/cli`'s `copy-templates` copies them into the CLI tarball too.
- `src/recipes.ts` — the recipe catalog; `templates/recipes.spec.ts` holds it and the shipped `recipe-*` folders to the same set.

The scaffolder itself is P1 work (plan `pix3/.plans/pix3-core.md` §G.2).
