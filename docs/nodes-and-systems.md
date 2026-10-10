# Pix3 Nodes & Systems — Capabilities Guide for Agents

**Read this before writing custom game logic.** It is the inventory of what the
Pix3 engine and editor already do, and how to reach each capability correctly.
If a capability exists here, **use it instead of hand-rolling it in game code** —
that is the rule CLAUDE.md's _Engine vs Game feature decision_ enforces.

- Node detail (every property, per node): [node-types-reference.md](node-types-reference.md)
- Product/architecture source of truth: [pix3-specification.md](pix3-specification.md)
- Deep-dive diagrams (operations flow, schema, rendering, state): [architecture.md](architecture.md)
- Property-schema authoring: [property-schema-reference.md](property-schema-reference.md)

---

## 0. The engine-vs-game decision (do this first)

When asked to implement a game feature:

1. **Search this doc + [node-types-reference.md](node-types-reference.md).** If a
   node, behavior, system, or runtime API already covers it, use that.
2. Ask: _"Would Godot / Unity ship this as a built-in?"_
   - **Yes → engine-level.** Implement in the runtime + editor (schema,
     `Create*Command`, registry, YAML serialization, inspector), then release
     the runtime and update the consumer. **State the plan and confirm first.**
   - **No** (game-specific rules, content, balancing) → **game-level script**.
3. Engine nodes/systems must **not** reference game domain concepts (shop, coins,
   enemies). Keep the runtime editor-agnostic and game-agnostic.
4. After adding an engine capability, **update this file**.

---

## 1. Two ways to build on Pix3

**A. In-editor user scripts** (the common path). A `Script` subclass in the
project's `scripts/` folder, attached to a node as a component and referenced in
the scene as `type: user:<ClassName>`. The game's own Vite dev server compiles it;
the editor picks the new version up on `pix3_sync` (or a save), without reloading.
A script — and every local module it imports — must not use `import.meta.hot`, a
CSS import or a non-literal `import()`: each puts Vite's HMR client on the editor
page (`pix3 check` warns, `W_EDITOR_*`). Scripts reach the engine through `this.scene` / `this.input` /
`this.node`. Example: [example-scripts/RotatingCube.ts](example-scripts/RotatingCube.ts).

**B. Consumer game project** (e.g. DeepCore) that imports `@pix3/runtime` from
npm. It drives the engine itself with `SceneManager` + `SceneRunner` +
`RuntimeRenderer` (no editor). The **same runtime APIs** below are available; the
difference is you own the loop and there is no inspector/command layer. It may
register a debug provider via `registerGameDebug(...)` (see §6).

> The runtime package (`packages/runtime`) is the contract shared by both; a
> consumer takes a change with its next `@pix3/runtime` version.

---

## 2. Nodes (scene building blocks)

Add via the editor **Create** menu / `Create*Command`, or author in `.pix3scene`
YAML, or (from a script) construct + `parent.adoptChild(child)`. Full property
tables: [node-types-reference.md](node-types-reference.md).

**Structure / base**

- `Node2D`, `Node3D` — transform containers (2D uses anchors/layout; 3D is a
  Three.js `Object3D`). `Group2D` groups 2D content.

**2D content & UI** (orthographic overlay pass; draw order = tree order)

- `Sprite2D`, `AnimatedSprite2D`, `TiledSprite2D`, `ColorRect2D` — images / frames / 9-slice-ish tiling / solid rects.
- `SpineSkeleton2D` — a Spine skeleton (`.json`/`.skel` + `.atlas`). Skeletal rigs, mesh deformation and animation mixing, i.e. what a flipbook cannot do; see the recipe below.
- UI controls: `Button2D`, `Label2D`, `Slider2D`, `Joystick2D`, `Checkbox2D`, `Bar2D`, `ScrollContainer2D`, `InventorySlot2D`.
  **Skins:** these controls are colour-driven by default and take sprites through texture slots — `Button2D` `textureNormal/Hover/Pressed/Disabled`, `Checkbox2D` `textureBox` / `textureBoxChecked` / `textureMark`, `Slider2D` `textureTrack` / `textureFill` / `textureThumb`, `Bar2D` `textureTrough` / `textureFill`, plus `ScrollContainer2D`'s thumb/track. A set slot replaces that flat colour; an unset one keeps it. `Button2D`, `Slider2D` (track+fill) and `Bar2D` (trough+fill) also take the four `sliceBorder*` nine-slice insets `TiledSprite2D` uses, so one 64x64 skin fits any size instead of smearing — and a fill that shrinks with `value` is re-cut, not squashed. A sliced skin opts out of the 2D quad batcher.
  `Label2D` is multiline: a fixed `width` word-wraps, `labelAlign`/`labelVAlign` align inside the box, and `typewriterSpeed` + `setText()`/`skipTypewriter()`/`'typewriter-complete'` give a per-character reveal.
- `Camera2D` — pan/zoom/limits/shake for the 2D pass. `CanvasLayer2D` — fixed HUD layer, unaffected by Camera2D.
- `AnimatedSprite2D` (and `AnimatedSprite3D`) play a flipbook from a **`.pix3anim`** resource — see the recipe below. Switch clips from a script with **`sprite.play('attack', { restart: true })`** (returns `false` for an unknown clip; `restart` replays the current clip from frame 0, which is how a finished one-shot is fired again — writing `currentClip` alone never restarts). A non-looping clip emits **`animation-finished`** (clip name as arg) when it stops on the last frame. For self-freeing one-shot VFX set **`freeOnFinish: true`** on the node (destroys itself when the clip ends — no component); use `core:FreeOnSignal` only when the trigger is some _other_ signal.

**Flipbook animation (`.pix3anim`)** — hand-author it; the file is plain JSON and `SceneLoader` auto-loads the resource + every frame texture (also when the node arrives via `scene.instantiate` of a prefab). Every omitted field is defaulted on load (fps 12, loop true, `playbackMode` normal, anchor 0.5/0.5, `durationMultiplier` 1). Save it next to the frames, point the node at it. **Sequence mode** (one image per frame — the common case, e.g. an impact flash):

```json
{
  "version": "1.0.0",
  "texturePath": "",
  "clips": [
    {
      "name": "burst",
      "fps": 30,
      "loop": false,
      "frames": [
        { "texturePath": "res://.../fireb0001.png" },
        { "texturePath": "res://.../fireb0002.png" }
        /* … one entry per frame … */
      ]
    }
  ]
}
```

**Character with variants/states (weapon skins, outfits)** — one `.pix3anim` whose clips are named `<variant>.<state>` (`sword.idle`, `sword.attack`, `bow.idle`, …; a clip without the separator is a variant-less state such as `die`), an `AnimatedSprite2D` as the prefab root (`sizeMode: native` — every frame carries `sourceSize`; the frame `anchor` at the feet, so the node's position is where the character stands) and **`core:CharacterVisual2D`** on that same node (`variant`, `state`, `separator`, optional `spriteNodeId`; empty = the host itself, else its first `AnimatedSprite2D` child). Keep the sprite as the root: selecting the character then selects the drawn quad, and the viewport frames the visible art and marks the pivot at the node position — a `Group2D` wrapper frames a centred box that the frame anchor pushes off the art. Game code says `character.playState('attack', { restart: true })` and `character.setVariant('bow')` (keeps the state, restarts its clip) and never spells a clip name; both return `false` for a pair the resource lacks, no hidden fallback. A finished one-shot holds its last frame and the root emits **`state-finished`** `(state, variant)` — the component adds no movement, physics, AI or automatic transitions. `getVariants()` / `getStates(variant?)` read the vocabulary off the clip names. This is Unity's Sprite Library categories/labels + Sprite Resolver, not an AnimationTree. **`pix3 character-compile <spec.yaml>`** (`packages/cli/src/character/`) emits exactly this shape from frame PNGs named in a small spec (`clips: [{ variant, state, frames | sequence, fps?, loop? }]`) — a managed sprite folder (`sprites/<slug>/<slug>.pix3anim` + `<variant>_<state>_<nnnn>.png`, the frames copied in) plus `scenes/prefabs/<Name>.pix3scene`; pass `anchor` (y from the top) at the feet row so the node's position is where the character stands — the default is the canvas centre. It never overwrites a file with other content without `--force`, and `--dry-run` shows the plan.

**Spritesheet mode** instead: set top-level `texturePath` and give each frame a UV rect `offset:{x,y}` + `repeat:{x,y}` (these default to 0 → sample nothing, so they're required here). Frames may carry `durationMultiplier` and `events:[{signal,args}]` (fired on play-driven frame entry). Node wiring: `type: AnimatedSprite2D`, properties `animationResourcePath`, `currentClip`, `isPlaying`, `freeOnFinish` (one-shot self-destruct), `width`/`height`, `anchor`, `sizeMode`. First spawn of a runtime-instantiated clip warms its texture cache; if the first play must be pixel-perfect, spawn one invisible warm-up at level start. Authoring GUI: the editor's **Sprite Editor** produces the same file — one shell (canvas + clips rail + frame timeline) that edits both a bare image and a `.pix3anim`; selecting a frame binds the canvas to that frame's texture, and crop / rotate / flip / background-removal / generation write straight back into the frame.

**Frame presentation — `sizeMode`, per-frame `anchor`, `sourceSize`.** Two anchors are in play and they mean different things. The **node** `anchor` is a global pivot in the node's `width × height` box (y up, same as `Sprite2D.anchor`). Each **frame's** `anchor` is that frame's own origin inside its — possibly tightly cropped — raster, normalized with **y measured from the top** (image convention, like `boundingBox`). They compose: the quad is placed so the frame anchor lands on the node's position, then shifted by the node pivot. That is what makes cropping pay off — crop a frame tighter, move its anchor to the old visual centre, and the animation is pixel-identical while the PNG (and the atlas) shrinks. `sizeMode` decides how a frame fills the box: `'stretch'` (default, and what every pre-existing scene assumes) scales every frame to exactly `width × height`; `'native'` renders each frame at its own `sourceSize` scaled by one per-clip factor derived from the clip's FIRST frame, so mixed-size frames keep their relative proportions and resizing the node scales the whole animation uniformly (the editor sets `'native'` on newly created nodes). `sourceSize` is an optional per-frame `{width,height}` the editor stamps whenever a frame is added, imported or sliced, so native layout never waits on a texture load; a frame with no known size falls back to stretch, so legacy files keep working. The math lives in one shared module (`core/animated-sprite-layout.ts`) because the editor viewport draws SEPARATE proxy meshes — both apply the same resolver.

**Named frame points (sockets).** `AnimationFrame.points?: [{name, x, y, angle?}]` — points that live in frame space (normalized, y from the top; `angle` in degrees, 0 = right) and move _and rotate_ across frames: a muzzle on a barrel, a hand socket an item follows through a walk cycle. Read them from scripts — `sprite.getFramePoint('muzzle')` returns node-local `{x, y, angle}` usable directly as a child position, `getFramePointWorld('muzzle')` adds the node's world transform and accumulated Z rotation, `getClipPointNames()` lists the active clip's points; all return `null`/`[]` when the current frame doesn't define the point. Frame `events` compose naturally: an emitting frame fires `muzzle-flash`, the handler reads `getFramePoint('muzzle')`. For the "item in hand" case attach **`core:PointAttachment`** to the child (`point`, `applyRotation`, `offsetX`/`offsetY`, optional `spriteNodeId`); it parks the node on the named point every tick and leaves it alone on frames that don't define it. Authoring: the Sprite Editor's **points** canvas tool (drag the dot, drag the direction handle for the angle; the previous frame's points ghost behind as a mini onion-skin).

**Spine skeletal animation (`SpineSkeleton2D`)** — for rigs authored in the Spine
editor, when a flipbook (`.pix3anim`) is not enough: bone hierarchies, mesh
deformation, skins, and crossfaded animation mixing. Point the node at its
`skeletonPath` (`.json`/`.skel`) and `atlasPath` (`.atlas`); the page images come
from the atlas text and are resolved next to it. Once the asset loads, the
Inspector's `animation`/`skin` fields become dropdowns of the skeleton's real
names. From a script:

```ts
const hero = scene.getNode<SpineSkeleton2D>('Hero');
hero.play('run', { loop: true, mixDuration: 0.2 });
hero.queue('idle', { loop: true });
hero.setSkin('blue');
```

Editor playback is **opt-in**: a placed skeleton holds its first frame until you
press Play on the Inspector's Editor Preview row (`previewInEditor`), and Reset
rewinds to that frame without touching the authored state.

Signals: `animation-started`, `animation-finished` (non-looping end — pair with
`freeOnFinish: true` for one-shot VFX), `animation-looped`, and `spine-event` for
keyed animation events. Sizing is the node transform, not width/height. Spine is an
**optional** dependency (`@esotericsoftware/spine-threejs` `~4.3`, Spine Runtimes
License, lazily imported): the editor and the exported player register it
automatically, a consumer project calls
`setSpineModuleLoader(() => import('@esotericsoftware/spine-threejs'))` once.
Not batched/atlased and no shader-effect support (spine owns its materials); CPU
cost is per skeleton per frame, so budget dozens, not hundreds. Full property table:
`docs/node-types-reference.md` → `### SpineSkeleton2D`.

**3D content**

- `GeometryMesh` — primitive/standard-material mesh; supports **shader effects** (§4) and baked/realtime AO.
- `MeshInstance` — a loaded model (glTF). `InstancedMesh3D` — GPU-instanced copies for crowds.
- `Sprite3D`, `AnimatedSprite3D` — billboarded sprites in 3D.
- `Particles3D` — GPU-ish particle system with trails + sub-emitters + world/local sim.

**Cameras & lights**

- `Camera3D` — the single render camera (attach `core:CameraBrain` for blending).
- `VirtualCamera3D` — non-rendering "virtual camera" rigs selected by priority (§4 Camera system).
- `DirectionalLightNode`, `PointLightNode`, `SpotLightNode`, `AmbientLightNode`, `HemisphereLightNode`.

**Other**

- `AudioPlayer` — a scene-graph audio source (§4 Audio).
- `PostProcess` — enables the post-processing pipeline (§4 Post-processing).

---

## 3. Script components you can attach (`core:*` behaviors)

Attach in the inspector or in YAML `components:`. These are the pre-built,
designer-facing behaviors — prefer them over writing a script for the same
effect. Registered in
[packages/runtime/src/behaviors/register-behaviors.ts](../packages/runtime/src/behaviors/register-behaviors.ts).

| Component id               | Does                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `core:Rotate`              | Continuous rotation of a 3D node                                                                                                            |
| `core:SimpleMove`          | Simple test movement                                                                                                                        |
| `core:Sine`                | Oscillate a node along an axis                                                                                                              |
| `core:Follow`              | Smoothly follow a target node's position/rotation                                                                                           |
| `core:PinToNode`           | Pin a 2D UI node to a 3D target (screen projection)                                                                                         |
| `core:Fade`                | Fade a 2D node's opacity in/out (optional auto-destroy)                                                                                     |
| `core:RadialProgress`      | Circular progress mask on a Sprite2D                                                                                                        |
| `core:AnimationPlayer`     | Play keyframe clips on this node + descendants (§4)                                                                                         |
| `core:PointAttachment`     | Keep this node on a named frame point of a parent `AnimatedSprite2D` (hand socket, muzzle) every tick, optionally copying the point's angle |
| `core:CharacterVisual2D`   | `variant + state → clip` on an `AnimatedSprite2D` with clips named `<variant>.<state>`; `playState`/`setVariant`, `state-finished`          |
| `core:PlaySound`           | Play a sound when a node signal fires                                                                                                       |
| `core:SfxOnSignal`         | Play a **procedural** (asset-free) sound preset when a node signal fires — see §4 "Procedural SFX"                                          |
| `core:BurstOnSignal`       | Spawn a one-shot 2D particle burst at this node when a signal fires (juice)                                                                 |
| `core:FreeOnSignal`        | `queueFree` this node when a signal fires on it (e.g. `animation-finished`), after an optional delay — one-shot VFX lifecycle               |
| `core:Shake`               | Additive positional shake (juice)                                                                                                           |
| `core:PunchScale`          | Squash-and-stretch scale punch (juice)                                                                                                      |
| `core:PopIn`               | Spawn pop-in scale with overshoot (juice)                                                                                                   |
| `core:CameraBrain`         | Blend the render camera between virtual cameras (§4)                                                                                        |
| `core:Hitbox2D`            | Queryable 2D collision shape (rect/circle/polygon, group tag) — see §4 "2D collision"                                                       |
| `core:PhysicsBody2D`       | Rigid body simulated by `scene.physics2d` (static/kinematic/dynamic) — see §4 "2D physics"                                                  |
| `core:Collider2D`          | Physics shape (rect/circle/polygon, rotation-aware, may be concave); a sensor with no body is an Area2D                                     |
| `core:PhysicsWorld2D`      | Sets the 2D world gravity; attach to the scene root                                                                                         |
| `core:RevoluteJoint2D`     | Hinge with optional angle limits and a motor — flippers, swinging doors, ragdoll links                                                      |
| `core:NetworkedNode`       | Bind this node to a replicated entity — spawn one for the local player, adopt a peer's — see §4 "Multiplayer replication"                   |
| `core:ReplicatedTransform` | Replicate position/rotation: owner publishes quantized, peers interpolate on a timed buffer                                                 |

Most juice behaviors have a `triggerEvent` (a signal name) and/or `playOnStart`,
so a keyframe **event track** or a script `emit()` can fire them.

**Shader effects** (added via the inspector "Add Effect" picker or
`node.attachEffect(id)`) attach to `GeometryMesh` (3D) and to `Sprite2D` /
`AnimatedSprite2D` / `Button2D` skin (2D): `core:dissolve`, `core:rim`
(3D-only), `core:uv-scroll`, `core:flash`, `core:adjust`
(brightness/contrast/saturation), `core:grayscale`, `core:tint`. Params are
keyframe-animatable. See
[packages/runtime/src/shader-effects/](../packages/runtime/src/shader-effects/).

---

## 4. Systems (engine-level capabilities)

Each entry: **what it is → how to use it → where it lives**.

### Keyframe animation

Timeline-authored clips (position/rotation/scale/color tracks + audio + event
tracks) on `core:AnimationPlayer`. **Use:** attach `core:AnimationPlayer`, author
in the **Animation** timeline panel (keyframes — flipbook frames are a `.pix3anim`
file, see the recipe in §2), `player.play('clip')` or `autoplay`. Event tracks emit
signals (the "cutscene glue"); `finish()` fast-forwards. Signals:
`animation_started` / `animation_finished`.
See node-types-reference "AnimationPlayer" + [demo-03-animation-timeline.pix3scene](../packages/runtime/fixtures/hello-world-scenes/demo-03-animation-timeline.pix3scene).

### 3D camera system (Cinemachine-lite)

One `Camera3D` renders; attach `core:CameraBrain` to it. Add `VirtualCamera3D`
rigs (follow/look-at/damping/priority). The brain blends the render camera to the
**highest-priority visible** vcam. **Use:** raise a vcam's `priority` (animatable)
to "cut" to it; scripts can force a one-shot blend with
`brain.overrideNextBlend(sec, easing?)`. Demo: [demo-02-cinematic-camera.pix3scene](../packages/runtime/fixtures/hello-world-scenes/demo-02-cinematic-camera.pix3scene).

### Cutscene Director (`scene.cutscene`)

Play an AnimationPlayer clip as a cinematic: letterbox, input-lock, skip gesture,
CameraBrain blend in/out. **Use:**
`const {done} = this.scene.cutscene.playCinematic(nodeId, { skippableAfter, blendDuration }); await done;`
(`'finished' | 'skipped' | 'stopped'`). Camera moves/VFX/beats are authored as
clip tracks. Spec §6.13; demo: [demo-07-cutscene.pix3scene](../packages/runtime/fixtures/hello-world-scenes/demo-07-cutscene.pix3scene).

### 2D camera & layers

`Camera2D` drives the 2D pass (pan/zoom/limits, built-in additive `shake`).
`CanvasLayer2D` is a fixed HUD unaffected by the camera. Draw order follows the
scene tree (Godot-like). **Use:** add a `Camera2D`; put HUD under a `CanvasLayer2D`.

### Juice & time-scale

Fire-and-forget game feel from scripts (or the matching `core:*` presets):

- `scene.time.hitstop(ms)`, `scene.time.slowMotion(scale, {durationMs, blendMs})`, `setScale` / `reset` / `scale` / `isFrozen`. Scales gameplay `dt`; render + real-time chrome are unscaled. **Hitstop is edge-triggered:** call it when a contact _begins_, never every frame while an overlap lasts — a freeze sets gameplay `dt` to 0, so the contact that drives the call cannot separate on its own (the engine caps one freeze at the longest single request and warns once, so this degrades to a slow game instead of a frozen one).
- `scene.juice.shake(target, {amplitude=8, frequency=24, duration=0.35, decay=1.5})` (`duration: 0` = until stopped), `punchScale(target, {amount=0.3, duration=0.35, vibrato=3})`, `popIn(target, {from=0, duration=0.4, easing='backOut'})`, `flash({color='#ffffff', intensity=1, durationSec=0.2})`. The three transform effects take `duration` in seconds — **not** `durationSec` (same keys as their `core:Shake` / `core:PunchScale` / `core:PopIn` config). `target` is a node, a node query, or `'camera'` / `'camera2d'`.
- `scene.juice.burst(target, opts)` — one-shot 2D particle burst. `target` is a node, a node query, or a `{x,y}` 2D world point. Options (all defaulted, all clamped): `count` (14, max 512), `speed` (260 px/s), `spread` (radians, default `2π`), `direction` (radians, default up), `lifeSec` (0.5), `color` / `colors` (palette), `sizePx` (10), `gravityY` (-600), `fadeOut` (true), `additive` (true — the neon look), `zIndex`. Preset form: `core:BurstOnSignal`.
- `scene.juice.floatText(text, opts)` — floating score/text popup (pops in, rises, fades, frees itself; never pickable). Options: `at` (node / query / `{x,y}`), `color`, `fontSizePx` (28), `fontFamily`, `driftPx` (60 up), `durationSec` (0.8), `glow` (`true` = glow in the text colour, or a colour string), `glowStrength` (1.5), `zIndex`.
  Both spawn a runtime-only 2D node into the anchor's 2D root — no authoring, no
  YAML, nothing to clean up — and tick through `node.tick`, so a hitstop freezes
  them like every other juice effect. Call them **together with the mechanic** they
  punctuate; they are one-liners, not a later polish pass.
  Spec §6.12; demo: [demo-05-juice.pix3scene](../packages/runtime/fixtures/hello-world-scenes/demo-05-juice.pix3scene).
- `scene.juice.trail(target, opts)` — fading motion ribbon that follows a node (a ball, a dash, a projectile). Options: `lifeSec` (0.35), `widthPx` (14, tapers to 0 at the tail), `color` / `colors` (a palette is lerped head→tail), `additive` (true), `zIndex`, `maxPoints` (48, max 256). Returns a `Trail2D` — call `trail.stop()` to stop following; it then fades out and frees itself, and freeing the target does the same. Same transient lifecycle as `burst`: runtime-only node, never pickable, never serialized.

### Tweens (scene.tween)

Interpolate any number over time — the piece `scene.juice.*` leaves out (juice plays fixed
effects; a tween animates whatever the game names). Ticked on SCALED game time, so a hitstop
freezes a tween in flight; all tweens are dropped when the scene stops or changes.

- `scene.tween.to(target, props, opts)` → `TweenHandle`. `target` is a node, a node query (an unresolvable one warns once and returns an inert handle), or any plain object.
- `props` end values. On a node: `x` / `y` (→ `position.x/y`), `position: {x,y}`, `scale` (a number is uniform x/y, or `{x,y}`), `rotation` (RADIANS → `rotation.z`), `opacity`, `width` / `height`, plus any other numeric (dotted) path, e.g. `'position.x'`. On a plain object every key is a (dotted) path. Writes go through the node's public property, so a reactive schema setter redraws.
- `opts`: `durationSec` (0.3), `ease` (`'cubicOut'`; any `KeyframeEasing` name), `delaySec` (0; the start value is captured when the delay ends, not when the tween was created), `yoyo` (false — odd iterations run backwards), `repeat` (0 extra iterations; `-1` = forever), `onUpdate(t)`, `onComplete()`.
- `TweenHandle`: `cancel()` (leaves the target where it is), `finished: Promise<'completed' | 'cancelled'>` (never rejects), `isRunning`.
- `scene.tween.fadeIn(node, sec)`, `fadeOut(node, sec, {hide=true})`, `crossFade(from, to, sec)` (fades `from` out and hides it while `to` becomes visible and fades in; the handle ends when both do), `killAll(target?)`.

### Audio (buses, snapshots, one-shots)

3-bus mixer (`master`/`music`/`sfx`) with named snapshots + auto-muffle under
slow-mo. **Use from scripts:** `scene.audio.play('res://sfx/hit.ogg', { bus:'sfx', pitchVariation:0.1, volumeVariation:0.1 })`, `setBusVolume`, `applySnapshot`/`resetSnapshot`, `registerSnapshot`. **In the scene:** `AudioPlayer` node or `core:PlaySound` behavior (both take `bus`/`pitchVariation`/`volumeVariation`). node-types-reference "Buses, snapshots & scene.audio".

### Procedural SFX (no assets)

`scene.audio.sfx(preset, { volume?, pitch? })` synthesizes a one-shot on the `sfx`
bus — no audio file to find, import, or ship. Presets: `tap`, `score`, `bounce`,
`explosion`, `powerup`, `win`, `lose`, `laser`, `tick`. `pitch` is a frequency
multiplier (0.25–4; 2 = an octave up) baked into the render, not a playback-rate
stretch, so duration is unchanged. Each preset+pitch is rendered into an
`AudioBuffer` once and cached; with no Web Audio context (headless / tests) every
call is a silent no-op that never throws. **In the scene:** `core:SfxOnSignal`
(`{signal, preset, volume, pitch}`). An authored asset always beats the synth —
use `scene.audio.play()` when the project has the clip; reach for `sfx()` when it
doesn't (prototypes, jam builds, generated recipes).
Source: [packages/runtime/src/core/SfxSynth.ts](../packages/runtime/src/core/SfxSynth.ts).

### Shader effects (Construct 3-style, per-node)

Registry-backed material effects with an `enabled` toggle (zero GPU cost while
disabled — attached-but-disabled keeps its params) and typed params
(number/color/vector2/boolean) exposed as `fx.<key>.<param>` — inspectable,
keyframe-animatable, undoable. Hosts: `GeometryMesh` (standard material) and
`Sprite2D`/`AnimatedSprite2D`/`Button2D` skin (basic material; an effected 2D
mesh opts out of the quad batcher automatically). Built-ins: `core:dissolve`,
`core:rim` (3D-only), `core:uv-scroll`, `core:flash`, `core:adjust`
(brightness/contrast/saturation — e.g. dim a menu button, restore on hover),
`core:grayscale`, `core:tint`. **Use:** inspector "Add Effect", or from scripts
`node.attachEffect('core:adjust')` + `node.setEffectParam('adjust', 'brightness', 0.65)`
(short key or full id) / `node.setEffectEnabled('core:adjust', false)`. Effects
serialize with the node and render in the editor viewport too. Custom effects:
`registerShaderEffect(info)` with GLSL chunks + `targets: ['basic'|'standard']`.

### Post-processing

Add a `PostProcess` node to enable an EffectComposer pass (bloom / vignette /
chromatic aberration / AO modes). **Use:** drop one `PostProcess` node; configure
its properties. Pure-2D scenes can opt 2D in via `affect2D`.

### Localization (i18n)

Per-locale JSON tables in the project's `locales/` directory
(`locales/en.json`, `locales/ru.json`): a `strings` section (translation key →
text, `{param}` interpolation) and a `sprites` section (sprite key → `res://`
texture path, for skins with baked text). Resolution never throws: current
locale → fallback locale → the key itself (strings) / the authored texture
(sprites). **Use — text:** set `labelKey` on any `UIControl2D` (inspector has
an autocomplete widget with an "extract from literal" button); the literal
`label` stays as designer fallback, key wins when both are set. **Use — sprites:**
set `textureKey` on a `Sprite2D`, or the per-state `textureNormalKey`/
`textureHoverKey`/`texturePressedKey`/`textureDisabledKey` on a `Button2D`;
authored texture refs stay as fallback. **Use — scripts:**
`this.scene.localization.tr('mission.name.2', {n: 2})`,
`trPlural('game.wave-failed', lives)` (suffix keys `.one/.few/.many/.other` via
`Intl.PluralRules`, `{count}` auto-interpolated),
`await this.scene.localization.setLocale('ru')` (every keyed label/sprite
re-renders live), `onChange(cb)`, `trSprite(key)`; `label.setTextKey(key, params?)`
keeps dynamic labels re-resolvable on locale switch (`setText` clears the key).
**Authoring:** Window → Localization panel (Strings/Sprites tabs, per-locale
columns, missing-translation filter, preview-locale switch that live-updates the
viewport). The panel's **Scan** button extracts keys project-wide: it lists
unlocalized `label:` literals (per-item Extract creates the default-locale key
and binds `labelKey`) and script `tr()`-literal keys missing from the default
table, then seeds missing keys into other locales as `""` placeholders (empty
entries count as untranslated and fall through to the fallback locale). Rows
rename in place (pencil / double-click) — the key moves in every locale table
and `labelKey`/`textureKey` references in open scenes are rewritten, one undo.
Locale list/default live in `pix3project.yaml` (`localization:` block)
or are auto-discovered from `locales/`; a locale is a file the agent adds or removes
(kit `pix3-scene-format/project-files.md`), and locale tables get their own **Locales**
category in the asset panel's by-type view. A build bakes the config and embeds
the declared tables + localized sprites automatically. Lives in
`packages/runtime/src/core/localization/`.

### Particles

`Particles3D` — emission, trails, sub-emitters, world/local simulation space, and
`emitBurstAt(...)` for scripted bursts.

### ECS (fixed-step logic)

`ECSService` runs a deterministic fixed-step update alongside per-frame node
ticks. Games register systems/components for physics, AI, spawning, etc. **Use
(consumer):** `sceneService.getECSService()` → register systems; the runner calls
`fixedUpdate`. For bulk instanced rendering see `InstancedMesh3D` in [node-types-reference.md](node-types-reference.md).

### Physics — which tier to use

Three tiers, in increasing order of what they do for you. Pick the cheapest one
that answers the question you actually have:

| You need                                                                                                  | Use                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| "Is anything here?" — overlaps, raycasts, line of sight, no response                                      | `scene.collision2d` + `core:Hitbox2D` (§ "2D collision")                                                                    |
| Movement and collision **response** in 2D — gravity, bouncing, pushing, rotation, sensors with enter/exit | `scene.physics2d` + `core:PhysicsBody2D` / `core:Collider2D` (§ "2D physics")                                               |
| 3D rigid bodies                                                                                           | Game-level Rapier (lazy-loaded), driven from the fixed-step ECS loop. DeepCore does this; there is no built-in 3D body node |

**3D stays game-level on purpose.** Rapier's wasm is ~2 MB — larger than an
entire playable export — so it enters a build only when a project script imports
it. If asked for 3D physics, write a game-level ECS system unless building a
reusable engine node (confirm first).

### 2D physics (`scene.physics2d`, `core:PhysicsBody2D` + `core:Collider2D`)

A built-in rigid-body solver: circles and polygons (concave allowed), static /
kinematic / dynamic bodies, gravity, friction, restitution, damping, sensors,
sleeping, and swept CCD for fast movers. No joints, no capsules. Units are design
pixels with **y up**, so gravity is a negative y.

**Authoring** (Unity-style, not Godot's shape-as-child-node): put
`core:PhysicsBody2D` on the sprite and `core:Collider2D` on the same node — or on
child nodes, which is how you build a compound body. A `core:Collider2D` with
**no** body on it or any ancestor is static world geometry: one component, no
script, and that is the whole "wall" case. Gravity is either
`scene.physics2d.setGravity(x, y)` or a `core:PhysicsWorld2D` on the scene root.

**Signals** (emitted on the component's node, after the step — never mid-solve):

- `body-entered (otherNode)` / `body-exited (otherNode)` — sensors, always.
- `contact-started (otherNode)` / `contact-ended (otherNode)` — solid bodies,
  only when the body sets `emitContacts` (off by default; most games never read
  them).

**From scripts:**

```ts
const phys = this.scene.physics2d;
phys.setGravity(0, -1960);
const body = phys.getBody(this.node); // null when the node has no body
body?.applyImpulse(0, 900); // jump
body?.setVelocity(240, body.velocityY); // run
body?.teleport(x, y); // reposition without a contact impulse
phys.raycast(x1, y1, x2, y2, { group: 'walls' });
phys.overlapCircle(x, y, r, { group: 'enemy' });
```

**Characters** (`bodyType: 'kinematic'` — Godot's CharacterBody2D role). A driven
body: it pushes nothing, is pushed by nothing, and stops where geometry says.

```ts
// In onUpdate: gravity while airborne, a small downward bias while grounded so
// the character stays glued to slopes.
this.vy = this.grounded ? -60 : this.vy - 1960 * dt;
const move = this.scene.physics2d.moveAndSlide(this.node, this.vx, this.vy, dt);
this.grounded = move.isOnFloor; // also isOnWall / isOnCeiling
this.vy = move.velocityY; // the blocked component has been removed
```

`moveAndSlide` substeps so a fast character cannot sample past a thin wall, and
classifies contacts against a configurable `up` (`floorMaxAngle`, default 45 deg).
Slopes are handled by the slide itself; a **vertical step blocks** rather than
auto-climbing — same as Godot, and step-up is game logic. A kinematic character
also **does not push dynamic bodies**: a crate in the way stops it, exactly as a
wall would. To shove something, read the hit and apply an impulse to it yourself.
`moveAndCollide` is the same move without the sliding, when you want to handle
the hit yourself.

**Shapes.** `rect`, `circle`, `polygon` (concave allowed) and `capsule` — the
last is upright along local Y and sized by `height` (TOTAL height, both caps
included) plus `radius`, matching Godot. A capsule is built as a faceted
"stadium" rather than a true segment-plus-radius shape: the caps carry under 2%
radial error, which is sub-pixel at any size a 2D playable draws, and in exchange
it behaves exactly like every other convex shape. Something that must roll
perfectly smoothly wants `circle`, which is exact.

**Hinges** (`core:RevoluteJoint2D`). Pins a body to a pivot — a flipper, a
swinging door, a ragdoll link. Leave `connectedNode` empty to hinge against the
world. Angles on the authored surface are **degrees**, and a positive
`motorSpeed` spins the node the component sits on counter-clockwise:

```ts
const hinge = this.node.getComponent(RevoluteJoint2DBehavior);
hinge.config.motorSpeed = this.input.getButton('flip') ? 900 : -900;
```

`maxMotorTorque` is a real ceiling — a motor weaker than the arm's own weight
will not lift it. Hinged bodies do not collide with each other by default
(`collideConnected`), because they overlap at the pivot and a contact there
fights the joint.

Stepped in `SceneRunner`'s existing fixed-step slot, so hitstop and slow motion
dilate the simulation for free and the `fixed`/`manual` time modes make a run
reproducible. Play mode draws collider wireframes when the editor's collider
toggle is on (sensors green, sleeping bodies dim); the editor viewport draws the
authored outlines for the selected node, or for everything under **View → Collision
Shapes** (a check item).

Lives in [../packages/runtime/src/core/Physics2DService.ts](../packages/runtime/src/core/Physics2DService.ts) +
[../packages/runtime/src/core/physics-2d-narrowphase.ts](../packages/runtime/src/core/physics-2d-narrowphase.ts).

### 2D collision (`scene.collision2d`, `core:Hitbox2D`)

Lightweight query-based 2D hit-testing (Godot Area2D groups × Unity `Physics2D.Overlap*`
— no solver, no rigidbodies). Attach `core:Hitbox2D` to any 2D node: shape
(`rect`/`circle`/`polygon`), size, offset, `group` tag, `debugDraw` outline
(Godot's "Visible Collision Shapes"). Rect and circle are **axis-aligned**
(rotation ignored, scale honored — the original contract, which existing
templates depend on); `polygon` is rotation-aware and may be concave. A polygon's
vertices come either from `points` (drag them in the viewport: **Edit points** on
the component, then drag a vertex, click an edge midpoint to insert, Alt-click to
remove) or, with `polygonSource: 'frame'`, from the collision polygon of the
`AnimatedSprite2D` frame showing right now — the frame's `collisionPolygon` in the
`.pix3anim`. **Use from scripts:**
`scene.collision2d.overlapPoint(x, y, group?)` / `overlapCircle(x, y, r, group?)` /
`overlapRect(cx, cy, w, h, group?)` → `Hit2D[]`, and
`raycast(x1, y1, x2, y2, group?)` → closest hit with entry point + distance (the
sniper-laser / line-of-sight query). Coordinates are 2D world/design px (origin
center, Y up). Broadphase is a linear scan — fine for hundreds of hitboxes.
Lives in [../packages/runtime/src/core/Collision2DService.ts](../packages/runtime/src/core/Collision2DService.ts) +
[../packages/runtime/src/behaviors/Hitbox2DBehavior.ts](../packages/runtime/src/behaviors/Hitbox2DBehavior.ts);
the shared shape math (winding, convex decomposition, SAT) is in
[../packages/runtime/src/core/collision-shapes-2d.ts](../packages/runtime/src/core/collision-shapes-2d.ts).

### Input (`this.input`, `InputService`)

Polled + per-frame input, unified across pointer/keyboard: `getAxis(name)`,
`getButton(name)`, `pointerEvents` / `keyEvents` (this frame), `pointerPosition`,
`wheelDelta`, `isPointerDown`, `isHoveringUI`. Depth-counted `lock()`/`unlock()`
(used by the Cutscene Director) silences the whole polled surface at once.

**Wheel vs zoom.** `wheelDelta` (`Vector2`, per frame) holds the plain scroll
wheel only. Wheel events carrying `ctrlKey` or `metaKey` — a trackpad pinch,
which every browser reports as `wheel` + `ctrlKey`, and desktop Ctrl/⌘ + wheel —
are accumulated in `wheelZoomDelta` (`Vector2`, same units; positive `y` = pinch
in / wheel down = zoom out) and **not** in `wheelDelta`, so a `ScrollContainer2D`
or a game that scrolls on `wheelDelta` does not scroll while the player pinches.
Shift/Alt-modified wheel stays in `wheelDelta` (Shift + wheel is the browser's
horizontal scroll). `wheelModifiers` (`{ ctrl, meta, shift, alt }`, one stable
object) reports which modifiers any wheel event of the frame carried. All three
reset on every frame and are zeroed by `lock()`/`detach()`. The canvas listener
already calls `preventDefault()` on every wheel event, so Ctrl/⌘ + wheel zooms
the game, never the page. Camera zoom:
`camera.zoom *= Math.exp(-this.input.wheelZoomDelta.y * 0.01)`.
Pointer events come from the DOM Pointer Events API, so **mouse and touch are
already unified** — design every interaction for both (tap = click; don't rely
on hover). `scene.getPointer2DWorldPosition()` converts the current pointer to
2D world/design coordinates through the live 2D camera (Godot's
`get_global_mouse_position()`).

**Multi-touch is addressed, not shared.** Every finger that is down lives in a
map: `getActivePointers()` (press order, index 0 is the primary one),
`getPointer(id)`, `pointerDownCount`, `isPointerOverUI(id)`, and a `pointerId` on
every entry of `pointerEvents` (`'down' | 'move' | 'up' | 'cancel'` — a `'cancel'`
is a press _taken away_, e.g. a finger dragged off the screen edge, and must never
count as a completed tap). Anything that follows one contact — a stick, a drag, a
tap resolver — names its finger and reads only that one; UI controls do this for
you (each control owns at most one pointer).

Each physical gesture also belongs to only one control: the uppermost enabled,
visible control under the pointer wins (overlay band, effective `zIndex`, then
tree paint order). Labels and bars do not intercept input. That target keeps the
gesture until release/cancel, even if it hides or opens another panel. A modal's
close button therefore needs a fresh press; no debounce or opening delay is needed.
An unclaimed pointer can still slide onto a control; another finger is independent.

Hover follows the same topmost hit-test, rather than lighting every overlapping
control. For a modal, set `blocksPointerInput: true` on its full-screen
`ColorRect2D` backdrop: it blocks hover/presses on controls painted below it while
the modal's controls above it remain interactive. Hiding it releases the block;
opacity alone does not, so fades remain isolated. No per-button disable loop is needed.

The shared values are summaries: `isPointerDown` means "**any** finger is down", `pointerPosition` and
`activePointerId` (`@deprecated`) describe the **primary** finger only, and
`isHoveringUI` is the aggregate over all of them — gating a gesture on it is what
makes "hold a button with one thumb, drag the stick with the other" impossible, so
ask `isPointerOverUI(myPointerId)` instead. `Action_Primary` stays one shared
button raised on the first finger down and dropped by the last one up.
`scene.getPointer2DWorldPosition(pointerId)` is the addressed form of the world
conversion (null when that pointer is not down — a tap that went down and up in
one frame is already gone, so fall back to the no-argument call).

**A hidden control takes no input.** `UIControl2D` gates both channels — a real
finger and a semantic `invokeInteraction` — on `visible` being true on the control
_and every ancestor_ (`NodeBase.isVisibleInTree()`, the Godot
`is_visible_in_tree` line: boolean only, a fully transparent control still
responds). So hiding a panel is enough to take its buttons out of play; you do not
also have to disable them, and a hidden control no longer registers hover, so
`isPointerOverUI` stops claiming a finger that is over nothing. Note what this does
**not** change: `tick` still runs on hidden nodes on purpose, so components on a
hidden node (a spawner, a timer, a state machine) keep working.

### Signals (node events)

`node.connect(name, target, method)` / `disconnect` / `emit(name, ...args)`. The
decoupled event bus between nodes, scripts, animation event tracks, and juice
`triggerEvent`s. Every connection whose target is a script is dropped when that
script detaches — on its own node **and** on any other node
(`gameRoot.connect('score', this, this.onScore)` from a HUD script), via
`removeComponent`, `queueFree`/`dispose` of its node, or scene stop — even if an
override skips `super.onDetach()`. Window listeners, store subscriptions and
timers are still the script's own to clean up in `onDetach`.

### Game commands (`scene.commands`) — named intents

`register(name, handler, meta?)` / `dispatch(name, args?)` / `list()` / `log` /
`undo()`. The registry of a game's **discrete intents** — "start the game", "open
the settings", "make a move", "buy an item" — so tooling and tests can drive the
game without clicking, and every raised intent is journalled with the frame it
happened on. Names are `kebab-case`, optionally namespaced with dots
(`settings.toggle-music`); `args` must be JSON-serialisable (anything else is
refused with the offending path named); a handler that returns `{ undo() }` makes
the intent reversible through `commands.undo()`. A throwing handler is contained
the same way a script hook is (journalled, reported, loop unaffected), and
recursive dispatch is depth-capped.

**Wire a control's signal to `dispatch`, not to the method** —
`button.connect('pressed', this, () => this.scene?.commands.dispatch('start-game'))`.
That is what makes one real tap enough to prove the binding, after which every
scenario raises the intent directly. The registry **lives with the scene**: the
runner clears it on stop, so the next scene never inherits a dead intent. A
`GameDebugProvider` publishes it as `actions: () => scene.commands.list().map(c => c.name)`
rather than keeping a second, hand-maintained list.

**Boundary:** commands express intent, not continuous control. Movement, gestures
and aiming stay on input axes/controls — "drive left" as a command loses both the
analog magnitude and the per-frame cadence. The 1.x templates (now the scene corpus,
`packages/runtime/fixtures/scene-corpus/`) register their flow intents this way
(`start-game`, `open-settings`, `restart`, `cta-click`, …).

### Screen transitions

`scene.fadeToBlack(sec)` / `fadeFromBlack(sec)` / `switchCameraWithFade(id, out, in)`
/ `flash(opts)`. Real-time overlays (survive hitstop).

### Runtime spawning (`scene.instantiate`, `node.queueFree`)

Godot's `instantiate()` + `add_child()` / `queue_free()` pair for gameplay
spawning (enemies, projectile prefabs, VFX):
`const node = await scene.instantiate('res://…/prefab.pix3scene', { parent: 'enemies' })`
— the prefab (a `.pix3scene` with exactly one root node) is cloned with unique
runtime ids, adopted under `parent` (node or node-query; default = first scene
root), inherits `input`/`scene`, honors `initiallyVisible`, and its components
`onStart` on the next tick. In 2D the parent decides draw order. Despawn with
`node.queueFree()` — safe inside the node's own `onUpdate` (deferred to end of
frame, components get a proper `onDetach`); immediate `node.dispose()` is for
teardown outside the tick.

### Multiplayer replication (`scene.network`, `scene.netNodes`)

The session is `this.scene.network` — offline-safe, host-owned, and it survives
`changeScene` (it is installed at the three `SceneRunner` bootstraps, not by the
scene). `network.connect({url, token, roomId})` joins a pix3-rooms room; then
`isOnline`, `clientId`, `isHost`, `rtt`, `peers`, `vars`, `on/emit` (signals) and
`entities` are live.

**Everything networked is spawned** — an authored node has no network identity of
its own. Attach **`core:NetworkedNode`** to a _prefab_ that is also listed in the
build's `netKindTable` (the build emits it from the project's prefabs, sorted;
`registerNetworkPrefab(path)` is the fallback for a session with no built
manifest). On start it sends a spawn request and binds the `netId` the fabric
mints; when a _peer's_ entity arrives instead, `scene.netNodes`
(`NetworkNodeBinder`) instantiates that same prefab with instance id
`net:<netId>` — which is what makes every client derive identical child ids — and
the component adopts the binding rather than spawning a duplicate. `isMine`,
`ownerId` and `ownership` (`owned` / `shared` / `transferable`) come off the
replicated flags byte; `despawnOnDetach` (default on) means a `changeScene` or a
`queueFree` releases the entity.

Add **`core:ReplicatedTransform`** for movement. The owner publishes **quantized**
values and renders the node from the **dequantized** ones, so it sees exactly what
its peers do; remote copies render on a timed snapshot buffer at roughly two room
ticks of delay plus measured jitter, and the wire's `Teleport` bit snaps instead of
sliding. Two interactions worth knowing: it **turns anchored 2D layout off** on its
node (the per-frame anchor reflow and a replicated position cannot both own the
transform), and a camera following a _remote_ node should use little or no
`followDamping` — the interpolation buffer is already the smoothing, and damping on
top of it is pure added latency.

Spawn/despawn from a script: `await network.spawn('res://prefabs/bomb.pix3scene',
{ position, ownership })` → the minted `netId`, or a typed `NetworkSpawnError`
whose `kind` separates `'quota'` (this owner's 64-entity budget),
`'entity-limit'` (the room's table) and `'kind-not-allowed'`;
`network.despawn(netId)`.

The 2.x editor has no "Play Online": a build emits the table from the project's prefabs
(`netKindTable` of `virtual:pix3/scene-manifest`), and a session without one calls
`registerNetworkPrefab(path)` on every client.

### Scene transitions (change the running scene)

`await scene.changeScene('res://scenes/level2.pix3scene', { transition: 'fade', durationSec: 0.3 })`
— Godot's `change_scene_to_file`. Loads the _saved_ target file, tears down the
current scene and starts the new one at full black, then fades in. Works
identically in play-mode and exports (all scenes ship in the build). The old
scene keeps running until the new one parses, so a missing/invalid target fades
back and rejects instead of stranding a black screen; overlapping calls are
ignored. Use it to wire menu → game → results flows across separate scene files
(each scene runs standalone in the editor). `transition: 'none'` swaps instantly.

### Playable SDK (store CTA / game end / viewport)

`import { playable } from '@pix3/runtime'` — `playable.openStore(url?)` opens the
app-store page (delivery order: installed adapter → `dapi.openStoreUrl()`
(ironSource/Unity, network-configured URL) → `mraid.open` → `window.open`;
default URL via `setDefaultStoreUrl`), `playable.gameEnd()` marks the session
over (idempotent; `onGameEnd(cb)` to observe, auto-`reset()` on every
`SceneRunner.startScene`). Viewport helpers: `playable.getViewport()` /
`getOrientation()` return size + `'portrait' | 'landscape'`, and
`playable.onResize(cb)` fires on window resize/orientation change plus MRAID
`sizeChange` and DAPI `adResized`. Ad-network adapters plug in via
`setPlayableAdapter`. Use for playable-ad CTA buttons, end screens and
orientation-aware layouts (the 1.x `playable-3d` template's `user:CtaButton`, kept in
`packages/runtime/fixtures/scene-corpus/`, is a worked example).

---

## 5. Scripts-facing runtime API (the surface a `Script` sees)

Inside any `Script` subclass:

- `this.node` — the owning `NodeBase` (transform, `visible`, `getComponent`, `addComponent`, `connect`/`emit`, `findById`/`findByName`/`findByPath`, `children`, `parentNode`). `getComponent<T>(type: new (...args) => T): T | null` takes the component **class**, not a string ID — `node.getComponent(CarController)`, importing the class by relative path (`./CarController`). There is no string-based lookup (`getComponent('user:CarController')` fails); `user:*` IDs are for scene YAML only. To fetch by hand: `node.components.find(c => c instanceof CarController)`.
- `this.scene` — the `SceneService` (all of §4's `scene.*` APIs, plus `getActiveCamera()`, `getActiveCamera2D()`, `findNode(query)`, `getRootNodes()`, `getViewportInfo()`/`onViewportChanged()`/`isPortrait()`, `raycastViewport(nx,ny)`, `getAudioService`/`getAssetLoader`/`getResourceManager`/`getECSService`, plus `network` and `netNodes` for multiplayer, and `commands` for named game intents). May be `undefined` in some editor previews — guard it.
- `this.input` — the `InputService` (§4 Input).
- `this.findNode(query)` — resolve another node by id / name / slash-path, or `null` if absent (`get_node_or_null`).
- `this.getNode(query)` — same lookup but **throws** if the node is missing (`get_node`); `getNode<T>(query)` types the result. (`SceneNodeNames` is an empty augmentation point for typed names; nothing fills it in 2.x.)

**Lifecycle:** `onAttach(node)` → `onStart()` (first frame) → `onUpdate(dt)` (every
frame, `dt` is scaled game time) → `onDetach()`. Define `static getPropertySchema()`
to expose inspector-editable params (see §6). `this.config` holds params.

> **Ordering gotcha:** a node's components tick _before_ its children. Don't arm
> cross-node state in `onStart` that a child component's `onStart` will reset the
> same frame (e.g. a child camera's `CameraBrain`). Trigger such calls from a
> gameplay event or after a frame.

> **Real vs scaled time:** `onUpdate(dt)` and keyframe clips run on _scaled_
> `dt` (frozen by hitstop). Anything that must ignore hitstop/slow-mo (screen
> chrome, timers) uses `performance.now()` — mirror how `flash()`/letterbox work.

**Editor preview (draw the node your way without play mode):** implement
`tickEditorPreview(dt, ctx)` — the editor calls it on every non-play frame it
paints, for each enabled component. The viewport still renders on demand:
implementing the hook does not keep it painting — only `ctx.requestRender()`
called _during_ the tick asks for the next frame (called later, e.g. when an
asset finishes loading, it is a one-off repaint). The status bar shows **Live**
and names the script while one keeps the loop hot. Use `ctx.setAppearanceOverride({ textureRegion?, tint?,
visible? })` to change how _this component's node_ draws in the editor viewport;
it is immediate-mode (stop pushing → the proxy reverts) and never mutates or
serializes the node. `ctx.assetLoader` / `ctx.requestRender()` are also provided;
call `requestRender()` for continuous animation. For UV cropping specifically,
`Sprite2D.setTextureRegion({ x, y, width, height } | null)` shows a normalized
sub-rect of the texture (e.g. one digit of an odometer strip) — a transient,
non-serialized crop. It is per-sprite even when several sprites reuse the same
cached texture (the runtime crops a private clone that shares the GPU image), so
you never clone textures yourself. Author the region once and drive it from
**both** `onUpdate` (play) and `tickEditorPreview` (edit) so the two modes match. A
throwing `tickEditorPreview` disables the component and surfaces the error like a
play-mode hook, so the editor keeps running.

---

## 6. Editor-side rules (when an agent edits scenes/state)

- **Mutation gateway:** every state change flows UI → `CommandDispatcher.execute(CommandClass, args)` → Command → Operation → history. **Never mutate `appState` or node properties directly.** A feature = a `Command` + an `Operation` under `packages/editor-core/src/features/<area>/`. (See CLAUDE.md + AGENTS.md — binding.)
- **Property schema:** nodes and `Script`s expose `static getPropertySchema()` returning typed `PropertyDefinition`s (`getValue`/`setValue`); the Inspector renders editors from it and all edits go through `UpdateObjectPropertyOperation`. See [property-schema-reference.md](property-schema-reference.md).
- **A new node's constructor must end with `installReactiveSchemaProperties(this, TheNode.getPropertySchema)`.** Without it, a schema `setValue` that redraws (clamp, geometry rebuild, canvas repaint, material colour) runs for the Inspector but not for a script: `node.prop = x` changes the field, redraws nothing, and the getter still returns `x` — so even state-based verification reports a success that never reached the screen. `reactive-schema-coverage.spec.ts` fails if a `SceneLoader`-constructible node skips it.
- **Serialization:** scenes are `.pix3scene` YAML (`root:` tree of nodes with `properties`, `components`, `children`). Copy a known-good scene from the spec corpus (`packages/runtime/fixtures/scene-corpus/*/files/scenes/`) or a starter (`packages/create-pix3/templates/{2d,3d}/files/scenes/`).
- **2D texture filtering (project setting):** `textureFiltering` in `pix3project.yaml` is `linear` (default, smoothed) or `nearest` (crisp pixel-art). It lives on the `ProjectManifest` and is pushed to the runtime global via `setProjectTextureFiltering`; `configure2DTexture` (runtime) and the editor's sprite-texture setup both read it, so 2D sprite/UI textures pick up the mode in edit mode, play mode, and a build. 3D textures are unaffected (they keep mipmapped linear sampling).
- **2D blend modes:** every `Node2D` carries `blendMode` (`normal` | `additive` | `multiply` | `subtract`, Inspector → Style). It maps to the three.js blending constant on the materials the node itself owns and is _not_ inherited by children — set it per sprite, not on a wrapping group. Use `additive` for glow/VFX. A blended node is excluded from the 2D quad batcher (a batch run may only contain the default blend), so it costs its own draw call. Details and the "why no `screen`" note: [node-types-reference.md](node-types-reference.md) → `### Node2D`.
- **2D draw-call optimization (play mode):** a pre-launch **texture atlas** + a paint-order **quad batcher** cut a 2D frame from ~one draw call per node to a handful. The editor packer (`TextureAtlasService`) packs eligible sprite textures (Sprite2D / Button2D / AnimatedSprite2D / Bar2D — plus dynamic paths reached via script `res://` directory prefixes) into a few sheets, cached in IndexedDB, and installs a resolver on the play-mode `AssetLoader` so every texture load returns a lightweight **view** onto a shared sheet (`configure2DTexture` keeps sheets mipmap-free). The runtime `Batch2DSystem` then merges maximal contiguous same-source runs (in stamped `renderOrder`) into single draws, preserving paint order by construction (per-node opacity/tint ride vertex colors). Editor viewport rendering is unaffected (it draws its own proxy meshes). Toggles (`'auto'` default; `'off'` = byte-identical): project manifest `rendering2D.textureAtlas` / `.batching`, or `?pix3Atlas2D=off` / `?pix3Batch2D=off`, or `window.__PIX3_RENDER2D__`. `Label2D`/canvas text and `TiledSprite2D` are intentionally not atlased/batched. The player consumes a shipped `assets/.atlas/atlas-manifest.json` via `installAtlasFromManifest` when the project has one; the 2.x build does not emit one yet.
- **Editor Peek (view mask) — never confuse it with `visible`.** The author can hide or solo whole branches of the scene for their own eyes only: `NodeBase.hiddenByEditor` (set by `PeekService` on branch ROOTS; the `visible` accessor folds it in, so three.js's cascade, picking and `isVisibleInTree` — hence `UIControl2D`'s input gate — all follow), plus an editor-side solo fade in `packages/editor-core/src/services/viewport/peek-gating.ts`. It is **not serialized and not in a build**, it stays live during play (pushed into the clone by `SceneRunner.setEditorPeekMask`), and it is outside undo. Read the author's flag with `node.authoredVisible`, never `node.visible`, anywhere the AUTHORED value is meant (scene saving, state snapshots, agent reports). To hide something **in the game**, set `visible` / `initiallyVisible` — Peek cannot do it. Details: [pix3-specification.md](pix3-specification.md) → "Editor Peek (View Mask)".
- **Debug bridge (dev):** `window.__PIX3_DEBUG__` exposes the `pix3_*` tools (`call`, `tools()`) and short forms (`status`, `sync`, `scene`, `node`, `find`, `pending`, `errors`, `play.start/stop/restart/pause`) for driving the open editor (`packages/editor-core/src/host/debug-bridge.ts`; the kit's `pix3-editor` skill). Consumer games can register `registerGameDebug({name, snapshot, inspect, action})` from `@pix3/runtime` for a game-specific surface.

---

## 7. Correct-usage checklist for a new user script

0. **The script gate (do this first).** Name the node / `core:*` behavior / system above that covers the ask. If one exists, wire it — don't write a script. If none does, put the reason as the first doc-comment line: `/** engine-check: no built-in covers <X> because <reason> */`. A script duplicating a catalog capability without that line is a defect. Smells that mean "stop, a built-in exists": `setTexture()` on a timer → `AnimatedSprite2D` + `.pix3anim`; hand-lerped opacity/scale/position → `core:Fade`/`core:PopIn`/`core:PunchScale`/`core:AnimationPlayer`; a timer that only ends in `queueFree()` → `core:FreeOnSignal`; manual camera chase / `new Audio()` → `core:CameraBrain` / `scene.audio`.
1. Create `scripts/<Name>.ts`: `export class <Name> extends Script { … }` importing from `@pix3/runtime`.
2. Set defaults in the constructor's `this.config = { … }`; expose them via `static getPropertySchema()`.
3. Read the engine through `this.scene` / `this.input` / `this.node` — guard `this.scene` for previews.
4. Reference it in a scene as `type: user:<Name>`.
5. **Don't reimplement** juice/audio/animation/camera/cutscene — call the systems in §4.
6. Verify by running it: `pix3 check`, then with the editor open `pix3_sync` → `pix3_play` → `pix3_errors` (the kit's `pix3-editor` skill), or without one `pix3 smoke <scene>`. For sprite art write an SVG or generate one in the editor's Asset Generator panel.

---

## 8. Where things live

- Runtime (nodes, systems, script APIs): `packages/runtime/src/` — public surface re-exported from its `index.ts`.
- Built-in behaviors: `packages/runtime/src/behaviors/`; shader effects: `.../shader-effects/`; animation: `.../animation/`.
- Editor features (commands/operations): `packages/editor-core/src/features/<area>/`; services: `packages/editor-core/src/services/<domain>/`.
- Demo scenes + example scripts: `packages/runtime/fixtures/hello-world-scenes/`; `docs/example-scripts/`.
- Deeper docs: [node-types-reference.md](node-types-reference.md), [pix3-specification.md](pix3-specification.md), [architecture.md](architecture.md), [property-schema-reference.md](property-schema-reference.md).
