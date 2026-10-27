<!-- Pix3 agent kit {{version}} — generated from docs/nodes-and-systems.md, packages/cli/kit-includes/engine-api-map.md and the runtime's component registry. Do not edit: pix3 kit --update regenerates it. -->
# Script API reference

Generated from the engine's own documentation and code; `SKILL.md` beside it is the practical
part. **A lookup file, not a read:** find the heading in the contents below and grep it. The runtime's declarations are in
`.pix3/types/@pix3/runtime/` (or `node_modules/@pix3/runtime` when the project has its own
`tsconfig.json`). Source paths quoted here (`src/…`, `packages/…`) are files of the Pix3 engine
repository, not of this project.

## Contents

{{toc}}

## The surface a `Script` sees

{{include:docs/nodes-and-systems.md#Scripts-facing runtime API}}

## Engine API map — beyond `SKILL.md`

### Nodes

{{include:packages/cli/kit-includes/engine-api-map.md#Nodes}}

### `this.scene`

{{include:packages/cli/kit-includes/engine-api-map.md#`this.scene`}}

### `this.input`

{{include:packages/cli/kit-includes/engine-api-map.md#`this.input`}}

## Capability catalog — nodes

{{include:docs/nodes-and-systems.md#Nodes (scene building blocks)|shift=1}}

## Capability catalog — `core:*` behaviours

{{include:docs/nodes-and-systems.md#Script components you can attach|shift=1}}

## `core:` components — every config key

Read from the runtime's component registry for this CLI's version: the keys a `config:` block
may carry, their type, the default a fresh component has, and the inspector's range/options.

{{generated:core-components}}
