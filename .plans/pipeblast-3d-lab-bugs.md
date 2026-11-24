# Bugs and gaps from the PipeBlast 3D style lab (2026-11-24)

Found while building a 3D "toy plastic + liquid" lab scene in PipeBlast
(`PipeBlast/scenes/lab/pipe3d-pbr.pix3scene`, `scripts/PipeLabPbr.ts`) on runtime / editor
2.0.0-alpha.11 → alpha.13. Source records: `PipeBlast/.pix3/gaps.jsonl`, entries from
2026-11-24T12:03Z on. Each item names the workaround the lab uses, so the workaround can be deleted
when the item lands. B1–B4 are fixed (2026-11-24, after alpha.13); B5 is open; R, K and E are
feature gaps, not started.

## Bugs

- **B1. The editor writes invalid YAML when an Inspector edit adds the first key to an empty
  `config: {}`.** Changing a `configSelect` (Board) on `user:PipeLabPbr`, whose component was saved
  as `config: {}`, wrote `config:` followed by `board: 5x6` at column 0. `pix3 validate` fails at
  `board`, and Play loads the file without the edit (the Inspector says 5x6, the game shows 3x3).
  Workaround: write the config in block form by hand so later merges have a block to merge into.
  Repro: a component with `config: {}` → change any config value in the Inspector → save.
  **Fixed.** Two causes: `resolvePath` in `scene-patch-writer.ts` kept no container slot for the
  component segment, so the empty-flow map's indent came out 0; and `leafOps` in `scene-diff.ts`
  also emitted `delete config` (the old `{}` leaf), which would have dropped the new key. Test:
  `scene-patch.spec.ts` "a component's empty `config: {}`…". The lab's block-form workaround can go.
- **B2. `pix3 play` with a stale `.pix3/dev.json` (dev server dead) reports `no-player, 0 frame(s)`
  and still writes a screenshot** instead of saying the server is down.
  **Fixed.** `pix3 play` probes the server `dev.json` names and refuses a dead one (exit 2, no
  fallback to an old build); a page that never gets a running player now reports the navigation
  error or the requests that failed / answered ≥ 400. Test: `play.spec.ts`.
- **B3. Kit docs name a PostProcess value the runtime rejects.** `pix3-nodes/reference-3d.md` lists
  `aoMode: ssao`; alpha.13 accepts only `inherit | off | baked | realtime | adaptive`.
  **Fixed** in `docs/node-types-reference.md` (the kit's copy is generated from it), with a test
  that the row lists exactly `AO_MODES` (`PostProcessAOMode.spec.ts`).
- **B4. `pix3 check` fails with `E_EDITOR_UNSYNCED` while an editor tab is open and does not
  flush**; only `--no-sync` passes. (Seen with an editor tab in a background window.)
  **Fixed.** Cause (reproduced in headless Chrome with `Page.setWebLifecycleState frozen`): Chrome
  freezes a background tab, it answers no flush, and the 15 s wait ends in `timeout`. The tab now
  reports `{type:'state', unsaved}` on `/__pix3/ws` (`host/unsaved-report.ts`) and writes its edits
  when it goes hidden; `Barrier.flush` takes a writer's silence after `unsaved: false` as flushed
  (3 s wait). A tab frozen *with* unsaved edits still fails, and the message says to bring it to the
  front. Tests: `plugin.spec.ts`, `unsaved-report.spec.ts`.
- **B5. A reload with the cache disabled can leave the play page without a player** (one module
  answers 400); navigating to the URL again works. Not narrowed down.
  **Open.** Not reproduced: 6 cache-disabled reloads of `/?debug&role=designer` on a 3D starter,
  plain and with a `PostProcess` node on a fresh dep cache, all booted with no ≥ 400. `pix3 play`
  now names the failing request, so the next occurrence says which module and status.

## Renderer settings a scene or script cannot reach

- **R1. No tone mapping or exposure for the 3D pass.** `RuntimeRenderer` leaves `NoToneMapping`;
  glossy white plastic clips to flat white.
- **R2. With a PostProcess node active, tone mapping is skipped entirely.** three ignores
  `renderer.toneMapping` when rendering into the HDR buffer and the effect stack has no
  tone-mapping effect, so highlights clip and exposure does nothing. Lab workaround (must not go
  into a game): append a postprocessing `ToneMappingEffect` to the running composer through the dev
  global `__PIX3_PLAYER__`.
- **R3. PostProcess has no antialiasing option.** The composer's buffers are not multisampled, so
  every post-processed edge is aliased and SSAO darkens the jagged depth edges (dashed dark pixels
  on silhouettes). Setting the composer's `multisampling` from a script broke the depth resolve on
  an Adreno / D3D11 machine (`glBlitFramebuffer: Depth/stencil buffer format combination not
  allowed for blit`, every frame). Lab workaround: an FXAA pass appended after tone mapping.
- **R4. The shadow-map type, shadow radius / bias and a PMREM environment cannot be set from a
  scene, and a script cannot set the shadow type before the first frame.** Switching
  `shadowMap.type` to VSM from a script's first `onBeforeRender` happens mid-frame: programs
  compiled for PCF sample a VSM map and WebGL drops those draws (`Mismatch between texture format
  and sampler type`). Lab workaround: set it in `onStart` through `__PIX3_PLAYER__.renderer`.
- **R5. No scene-file way to set the 3D background or an environment map.** `SceneRunner`
  hardcodes `scene.background` `#202020` and no environment; a 2D `ColorRect` background draws
  over 3D. Workaround: the script walks up to the three `Scene` and sets `background`,
  `environment` and `environmentIntensity`, restoring them on detach.

## Baking (`core:MergeStatic` / `mergeStatic`)

- **K1. The component exposes too few bake settings**: only `sunDirection`, `shadows`,
  `aoSamples`, `subdivide`, `exposure`, `saturation`. Missing: sky / ground / ambient colours (the
  default ground is brown `#8a7a66`), `aoDistance`, `aoFalloff`, `aoBackFaces`, sun size and
  intensity. Workaround: call `mergeStatic(node, { bake })` from a script.
- **K2. `mergeStatic` bakes synchronously on the main thread with no persistent cache.** A
  52.8k-vertex tray: 2.4–3.7 s on a desktop, blocking the first frame; the in-memory `cacheKey`
  does not survive a reload. A build-time bake or an IndexedDB cache would make baked AO usable on
  mobile. The lab ended up replacing the bake with analytic AO for this reason.
- **K3. `GeometryMesh` plane has no segments**, so a baked floor has no vertices to carry shadows
  or AO; `subdivide` on an extrude also splits the caps' long sliver triangles (633k vertices and a
  30 s bake at `subdivide: 0.06`). Workaround: a script-made `PlaneGeometry(…, 72, 72)`.
- **K4. `GeometryMesh` extrudes cannot place edge loops along fillets**, so a per-vertex bake on a
  moulded shape (a tray with rounded pockets) shows sawtooth along every edge. The lab builds the
  tray as a swept mesh in a script instead.

## Editor preview

- **E1. No supported way for `tickEditorPreview` to show generated 3D content in edit mode.** The
  kit says preview child nodes are deliberately not offered. The lab adds a plain three `Group`
  (not a `NodeBase`) under the component's node: it renders, the saver and the hierarchy skip it,
  and it follows the node's transform — but none of that is a documented contract.
- **E2. No "preview stopped / component disabled" callback.** The lab polls `this.enabled` from a
  mesh's `onBeforeRender` to drop its preview objects.
- **E3. The editor viewport ignores `scene.environment` and a script's renderer settings**, so a
  PBR look differs between edit mode and Play. The lab uses matcap materials in the preview.

## What this adds up to

A 3D scene that wants a tone-mapped, antialiased, softly lit look currently has to reach the
renderer and the post-processing composer through a dev global. One project-level block
(`render3d`: tone mapping + exposure, shadow type and softness, environment, background, post AA)
would remove R1–R5 and E3 together.
