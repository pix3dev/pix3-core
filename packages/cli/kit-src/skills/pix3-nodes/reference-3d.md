<!-- Pix3 agent kit {{version}} — generated from docs/node-types-reference.md. Do not edit: pix3 kit --update regenerates it. -->
# Pix3 node reference — 3D and post-processing

The 3D node types and `PostProcess`, with their properties; the 2D nodes are in `reference.md`
beside it. A 2D game needs none of this except `PostProcess`. **Grep `### <NodeName>`** for one
node instead of reading this file. Keys are YAML keys under `properties:`; `position` /
`rotation` / `scale` go in the `transform:` block. Source paths quoted here (`src/…`,
`packages/…`) are files of the Pix3 engine repository, not of this project.

## Contents

{{toc}}

{{include:docs/node-types-reference.md#3D Nodes|heading}}

{{include:docs/node-types-reference.md#Post-processing|heading}}
