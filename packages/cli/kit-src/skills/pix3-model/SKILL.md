---
name: pix3-model
description: How to build a 3D model (a prop, a building, a vehicle) from GeometryMesh parts against a reference image, stage by stage, as a model job — `pix3 model new`, `pix3 render --job`, the human's feedback from the editor's 3D Asset Generator panel (`pix3 model feedback`), `pix3 model done`. Use when asked to make, rebuild or improve a 3D model, especially from a concept picture.
---

<!-- Pix3 agent kit {{version}} -->
# Build a 3D model as a job

You are the model generator: you write `GeometryMesh` parts into a prefab, render them, look,
and change one thing at a time. A **model job** keeps that loop honest — the stages in order,
every pass's sheet and numbers, and what the human said about them — in `.pix3/model-jobs/<id>/`
(local, not in git; never edit its files by hand). The human watches the passes in the editor
(Window → 3D Asset Generator) and answers there: a comment, marks drawn on a sheet, a verdict.

The shape kinds, modifiers and colours are `pix3-nodes` → `reference-3d.md` → `### GeometryMesh`;
how a model reads (colour from the reference, gradients, bevels, light, the bake) is its
"Making a model read well". Read those two sections before the first pass.

## The loop

```bash
pix3 model new tower --target res://scenes/prefabs/tower.prefab --reference design/references/tower.png
pix3 render --job tower --stage blockout --note "3 boxes: base, shaft, roof"
#   Read the sheet it prints (the reference is the first tile), then the look: and reference: lines
pix3 model next tower            # where the job stands, which --stage may come next
pix3 model feedback tower        # whenever a render ends with "N new feedback"
pix3 model done tower            # after a pass of the last stage, with no undelivered feedback
```

- The prefab must exist before `new` (an empty `root: []` is fine). The job keeps the target, the
  node (`--node`), the reference (copied), `--views` and `--size`; `render --job` takes them from
  it — a flag you pass to `render` wins and is recorded with the pass.
- `--reference-background <hex>` on `new` when the concept has no alpha and its corners do not
  show the background (otherwise the reference line says `mask failed`).
- The default stages are `blockout, structure, form, material, bake` (`--stages` to change them).
  A pass is the first stage, then the same stage again or the next one. A jump is refused; when
  it is really right (the model has no separate structure), `--force "<why>"` — the reason stays
  in the pass for the human to see.

## The stages

| Stage | Done when | Typical parts |
| --- | --- | --- |
| `blockout` | the silhouette and proportions match the reference from its view | `box`, `cylinder`, `sphere` — sizes and positions only |
| `structure` | every identity-defining part exists, attached where it belongs (nothing floats, nothing buried) | the part list, pivots, `mirror` / `array` for repeats |
| `form` | each part has its real shape kind and its bevels | `extrude` / `lathe` / `tube` / `roundedBox`, `shape.bevel`, `taper` / `bend` |
| `material` | colours and values read like the reference | palette from `--reference`, `vertexColors` gradient / noise, roughness |
| `bake` | one draw call, baked light and AO, still reading well | `core:MergeStatic` on the model's root; the `MergeStatic … vertices, … ms` line |

## Before the first pass

1. **Look at the reference and write down** (in your reply, briefly): the object, its parts from
   big to small, the 3–5 features that make it *this* object, and what the one view hides
   (its back, its depth). A single picture cannot show hidden sides — say what you assumed.
2. **Classify every part's surface before picking a kind** — by how the surface behaves, not how
   big it is:

| The part is… | Use | Not |
| --- | --- | --- |
| one smooth continuous mass turned around an axis (a tower body, a dome, a barrel, a bottle) | `lathe` | stacked cylinders |
| a profile with depth (a gable, a blade, an arch, a bracket, a cog) | `extrude` (`points` with `r` for rounded corners, `bevel`) | a box |
| long and thin along a path (a pipe, a cable, a rail, a handle) | `tube` | boxes in a row |
| a rigid block with flat faces (a crate, a slab, a panel) | `box` / `roundedBox` | — |
| relief too small to change the silhouette at game zoom (rivets, seams) | colour (`vertexColors`), or nothing | separate meshes |

## Each pass

- **One defect per pass.** Pick the worst difference on the sheet, fix only that, render, and
  write before → after in your reply and in `--note`: "roof pitch: IoU 0.62 → 0.71", "base too
  dark: luminance p50 0.08 → 0.19". Two changes in one pass and you cannot tell which helped.
- **Bevel where light catches** and where it shows at gameplay zoom — roof edges, wall corners,
  pillars — not on small repeated blocks (no visible gain, slower bake).
- **Colours come from the reference**: its palette (hex) is on the `reference:` line; author the
  material `#ffffff` and colour with `vertexColors`, never one flat colour per part.
- **Light from the camera's side**: render from the game camera's angle (`--views <az>:<el>`
  with the job's other views); a key light behind the subject leaves every visible face dark.
- **The numbers are hints, the picture decides.** Silhouette IoU is blind to everything inside
  the outline and two views of one model score below 0.8; `notCompared` means there was no
  comparison at all, not a zero. Keep a change only if the sheet looks better.
- **Say what still does not match** after each pass. "Improved" is not "done".

## The human's feedback

- A render that ends with `N new feedback — pix3 model feedback <id>`: run it. Each entry gives
  the pass, the verdict, the text and the marks in words (`front: rect 20%×15%, top right`), and
  a marked sheet — Read it. Your next pass marks it addressed; the panel shows the human that.
- `needs changes`: stay on the stage and fix what was marked first. `accepted`: move on.
- When the human is around, ask for a look at the key stages (`blockout`, `form`, `material`) and
  wait for the answer instead of guessing: `pix3 model feedback <id> --wait` (polls every second,
  gives up after `--timeout` seconds, default 540, with "No feedback yet" — then carry on or ask
  again). Their verdict is not required to finish; undelivered feedback is.

## Finishing

`pix3 model done <id>` needs a pass of the last stage and no undelivered feedback (`--force`
records what was skipped; `--failed "<why>"` gives up honestly). Then `pix3 check`, and look at
the model in the game at gameplay zoom (`pix3-verify`, `pix3-editor`). `pix3 model list` shows
every job, `pix3 model rm <id>` deletes one.
