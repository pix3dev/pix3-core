# pix3-core

Pix3 2.x: the Pix3 editor as a Vite plugin. A game is a plain Vite + TypeScript project; `@pix3/vite-plugin` serves the editor on the same dev server at `/__pix3/`, writes scene edits back to the files, and builds playable HTML. Coding agents (Codex, Claude Code) work on the same files and drive the open editor through Chrome DevTools MCP.

> **Status: pre-alpha.** The repository is seeded; `2.0.0-alpha.1` is the end of phase P1. Nothing here is published yet: the 1.6.x packages on npm come from [`pix3`](https://github.com/pix3dev/pix3).

| Package | npm | What it is |
| --- | --- | --- |
| [`packages/runtime`](packages/runtime) | `@pix3/runtime` | The engine: scene graph, nodes, scripts, ECS, audio, resources |
| [`packages/cli`](packages/cli) | `@pix3/cli` | `pix3 new`, `validate`, `check`, `smoke`, `tree`, `sfx`, `kit`, `character-compile`, `editor`, `agent-setup`, `gap` |
| [`packages/vite-plugin`](packages/vite-plugin) | `@pix3/vite-plugin` | Editor at `/__pix3/`, file API, sync barrier, build |
| [`packages/editor-core`](packages/editor-core) | `@pix3/editor-core` | The editor UI (Lit), prebuilt |
| [`packages/create-pix3`](packages/create-pix3) | `create-pix3` | `npm create pix3@latest <dir> -- --template 2d\|3d` |

## Development

Node 24 (`.nvmrc`).

```bash
npm install
npm test
npm run lint
npm run type-check
```

Docs: [`docs/pix3-specification.md`](docs/pix3-specification.md) (version of record), [`docs/nodes-and-systems.md`](docs/nodes-and-systems.md), [`docs/node-types-reference.md`](docs/node-types-reference.md). Code rules: [`AGENTS.md`](AGENTS.md).

## License

Apache-2.0, see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
