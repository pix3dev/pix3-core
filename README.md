# pix3-core

Pix3 2.x: the Pix3 editor as a Vite plugin. A game is a plain Vite + TypeScript project; `@pix3/vite-plugin` serves the editor on the same dev server at `/__pix3/`, writes scene edits back to the files, and builds playable HTML. Coding agents (Codex, Claude Code) work on the same files and drive the open editor through Chrome DevTools MCP.

> **Status: development alpha.** `2.0.0-alpha.2` is on npm under the `next` tag. Cross-platform checks and end-to-end dogfood are still being completed. The 1.6.x packages on `latest` come from [`pix3`](https://github.com/pix3dev/pix3).

## Building a new game with an agent

`create-pix3` / `pix3 new` installs the agent kit. Before writing game code in this
engine checkout, read `.claude/skills/pix3-game-dev/SKILL.md` and
`docs/nodes-and-systems.md`. In a generated game project, start with the installed
`pix3-nodes`, `pix3-scripts` and `pix3-editor` skills. Keep `startGame` + the Vite
plugin, authored `.pix3scene` files, native runtime UI controls and InputService.
The actual game must be editable and testable at `/__pix3/`; importing
RuntimeRenderer around a custom HTML/canvas game is not the default new-game workflow.

Treat visual references as UX requirements: identify the player's actions,
recognizable content, feedback and target device sizes. Create a reusable skinned
UI kit, then verify it through real input and visual inspection in the editor.
Do not leave layout and polish to the human merely because an editor is available.

| Package                                        | npm                 | What it is                                                                                                          |
| ---------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`packages/runtime`](packages/runtime)         | `@pix3/runtime`     | The engine: scene graph, nodes, scripts, ECS, audio, resources                                                      |
| [`packages/cli`](packages/cli)                 | `@pix3/cli`         | `pix3 new`, `validate`, `check`, `smoke`, `tree`, `sfx`, `kit`, `character-compile`, `editor`, `agent-setup`, `gap` |
| [`packages/vite-plugin`](packages/vite-plugin) | `@pix3/vite-plugin` | Editor at `/__pix3/`, file API, sync barrier, build                                                                 |
| [`packages/editor-core`](packages/editor-core) | `@pix3/editor-core` | The editor UI (Lit), prebuilt                                                                                       |
| [`packages/create-pix3`](packages/create-pix3) | `create-pix3`       | `npm create pix3@next <dir> -- --template 2d\|3d`                                                                   |

## Development

Node 24 (`.nvmrc`).

```bash
npm install
npm test
npm run lint
npm run type-check
```

CI runs these checks and the package scan on Linux, Windows and macOS. For changes to the scene
writer, also run `npm run test:corpus` (requires the sibling `../DeepCore` checkout, or pass a
project directory with `npm run test:corpus -- <dir>`).

Docs: [`docs/pix3-specification.md`](docs/pix3-specification.md) (version of record), [`docs/nodes-and-systems.md`](docs/nodes-and-systems.md), [`docs/node-types-reference.md`](docs/node-types-reference.md). Code rules: [`AGENTS.md`](AGENTS.md).

## Releasing

Versions are lockstep (`2.0.0-alpha.N` for all five packages, plan §A.3); internal dependencies are pinned to that exact version, and a new project's `@pix3/*` versions are the same number (`{{PIX3_VERSION}}` is the CLI's own version). Every package has `publishConfig: { access: "public", tag: "next" }`, so a prerelease never lands on `latest` (which stays 1.6.x from [`pix3`](https://github.com/pix3dev/pix3)) even without `--tag`.

**1. Bump** (on a clean `main`):

```bash
npm version 2.0.0-alpha.N --no-git-tag-version   # the root package.json only
npm run version:sync                             # stamp it into every package and internal dependency
npm install                                      # the lockfile records the workspace versions
git commit -am "release: 2.0.0-alpha.N" && git tag v2.0.0-alpha.N
```

**2. Check what would ship:**

```bash
npm run release:check            # pack, scan, then a scratch 2D project on the tarballs
npm run release:check -- --keep  # the same, and leave the project to try by hand
```

It runs `npm pack` for every package into a temp dir (each `prepack` builds what `files` lists), prints each tarball's name, size and file count, and refuses a tarball with a spec, fixture, plan, test harness, unexpected source map, the Spine runtime, a secret-looking file or value, or an absolute path of this machine; it checks the manifests (no `private`, the lockstep version, exact internal pins, `publishConfig.tag`, every `main` / `bin` / `exports` target present, LICENSE and README). Then, outside the repo, it installs the packed `create-pix3` with the packed `@pix3/cli`, runs its bin for a 2D project, points the project's `@pix3/*` dependencies at the tarballs (everything else from the registry), and runs `npm install`, `npm run check`, `npm run smoke`, `npm run build` (`dist/index.html` must exist). With `--keep` it prints the project's path; `npm run dev`, `npm run editor` and `npx pix3 agent-setup` work there as in a published project. A failure exits non-zero and keeps the temp dir. `--pack-only` stops after the scan (what CI runs).

**3. Publish** from CI: push the tag.

```bash
git push origin main v2.0.0-alpha.N
```

`.github/workflows/publish.yml` (npm Trusted Publishing, OIDC: no token, provenance attached by npm) checks that the tag equals the root version, runs `npm ci`, lint, type-check, tests and the full `npm run release:check`, then `npm publish` for each package in dependency order — a prerelease to `next`, a plain `X.Y.Z` to `latest`. A version already on npm is skipped, so re-running a failed run finishes the publish. Actions → "Publish" → Run workflow is a dry run (`npm publish --dry-run`) unless it runs on a `v*` tag with `dry_run` off. On npmjs.com every package's trusted publisher must be repository `pix3dev/pix3-core`, workflow `publish.yml`, environment `npm` (the GitHub environment `npm` can carry a required reviewer).

By hand instead, in dependency order, from a logged-in npm account with 2FA and publish rights on the `@pix3` scope (and on `create-pix3`):

```bash
cd packages/runtime     && npm publish --tag next && cd ../..
cd packages/editor-core && npm publish --tag next && cd ../..
cd packages/vite-plugin && npm publish --tag next && cd ../..
cd packages/cli         && npm publish --tag next && cd ../..
cd packages/create-pix3 && npm publish --tag next && cd ../..
git push origin main v2.0.0-alpha.N
```

or from the root, one at a time in the same order: `npm publish -w packages/runtime --tag next`, then `-w packages/editor-core`, `-w packages/vite-plugin`, `-w packages/cli`, `-w packages/create-pix3`. npm asks for the 2FA code (or pass `--otp <code>`). `prepack` builds `editor-core`, `vite-plugin` and `cli` again, so publish from the commit `release:check` passed on. The final `2.0.0` goes out with `--tag latest`, which overrides `publishConfig.tag` (CI picks it from the version).

**4. Verify:**

```bash
npm view @pix3/runtime dist-tags      # latest: 1.6.x, next: 2.0.0-alpha.N (the same for every package)
npm view create-pix3 dist-tags
npm create pix3@next my-game -- --template 2d --yes
cd my-game && npm install && npm run check && npm run build
```

**5. Move `latest` where there is no stable release.** npm always keeps a `latest` tag, and Trusted Publishing cannot move a dist-tag (OIDC covers `npm publish` only). `@pix3/editor-core`, `@pix3/vite-plugin` and `create-pix3` have no 1.x, so their `latest` would stay on an old alpha — and a bare `npm create pix3` takes `latest`. The publish run's summary lists each package whose `latest` lags with the command; from a logged-in account with 2FA:

```bash
for p in @pix3/editor-core @pix3/vite-plugin create-pix3; do npm dist-tag add "$p@2.0.0-alpha.N" latest; done
```

`@pix3/runtime` and `@pix3/cli` keep `latest` on 1.6.x until `2.0.0`.

## License

Apache-2.0, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
