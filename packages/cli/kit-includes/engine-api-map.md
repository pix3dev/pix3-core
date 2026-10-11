# Engine API map — the rest of what a game script can call

The scripts skill (`.claude/skills/pix3-scripts/SKILL.md`) has the surface most scripts use —
lifecycle, members, transforms, signals, spawning, juice, tweens, audio, input, traps. This map is
the rest. Everything named exists and is exported from `@pix3/runtime`; search the declarations
(`.pix3/types/`) only for what neither names, and say in one line what you were missing.

## Nodes (`NodeBase`)

- `queueFree()` is safe inside `onUpdate`; `dispose()` only outside the tick.
- Every `UIControl2D` (`Button2D`, `Slider2D`, `Checkbox2D`, `Joystick2D`, `InventorySlot2D`,
  `ScrollContainer2D`) emits `'pressed'`, `'released'`, `'click'`, `'pointerdown'`,
  `'pointerup'`; `Checkbox2D` / `InventorySlot2D` also `'toggled'`. Read a control's value from
  its properties (`Slider2D.value`, `Checkbox2D.checked`) inside the handler.
- Constructed at runtime with the scene YAML's property names, a `Sprite2D` too:
  `new Sprite2D({ id, texturePath: 'res://sprites/ph-circle.png', width, height })`.
- 2D node types: `ColorRect2D`, `Sprite2D`, `TiledSprite2D`, `AnimatedSprite2D`, `Group2D`,
  `Label2D`, `Button2D`, `Slider2D`, `Checkbox2D`, `Bar2D`, `Joystick2D`, `InventorySlot2D`,
  `ScrollContainer2D`, `Camera2D`, `CanvasLayer2D` (HUD layer, drawn after post-fx, never
  blooms), `SpineSkeleton2D`.
- 3D node types: `Node3D`, `Camera3D`, `VirtualCamera3D`, `GeometryMesh`, `MeshInstance`,
  `InstancedMesh3D`, `Sprite3D`, `AnimatedSprite3D`, `Particles3D`, lights (`Ambient`,
  `Hemisphere`, `Directional`, `Point`, `Spot`), `PostProcess` (bloom / vignette /
  chromatic aberration; `affect2D: true` for 2D scenes), `AudioPlayer`.

## `this.scene` (`SceneService`)

- Cameras: `getActiveCamera()`, `getActiveCamera2D()`. `getPointer2DWorldPosition(pointerId)`
  is null once that finger is up (Godot's `get_global_mouse_position()` for the primary one).
- Autoloads by name too: `scene.getAutoload<GameState>('GameState')`.
- Groups (a node's `groups: [enemies]` in the scene, `node.addToGroup('enemies')` at run time):
  `scene.getNodesInGroup('enemies')` lists the running scene's members in tree order;
  `scene.callGroup('enemies', 'onAlarm', 3)` calls that method on every component that has it
  (returns the count, warns once when none has it).
- Real-time overlays that survive hitstop: `scene.fadeToBlack(sec, onDone?)`,
  `scene.fadeFromBlack(sec, onDone?)`, `scene.switchCameraWithFade(cameraId, outSec, inSec,
  onDone?)`, `scene.flash({ color, intensity, durationSec })`.
- Time: `scene.time.setScale`, `reset`, `scale`, `isFrozen` beside `hitstop` / `slowMotion`.
- Juice presets as components: `core:BurstOnSignal`, `core:SfxOnSignal`, `core:Shake`,
  `core:PunchScale`, `core:PopIn`, `core:Fade`.
- Tweens: `finished` is a `Promise<'completed' | 'cancelled'>`; `props` may also be `scale` as a
  number (uniform) or `{x, y}`, or any numeric dotted path; on a plain object every key is a
  dotted path. `crossFade` is the in-scene counterpart of `changeScene`'s fade (state and panel
  switches). A trail is freed with its node.
- Audio: `setBusVolume(bus, v, fadeSec)`, `applySnapshot(name)`, `stopAll()`.
- **2D physics (`scene.physics2d`)**: `core:PhysicsBody2D` (`static | kinematic | dynamic`,
  `mass`, `restitution`, `friction`, `linearDamping`, `fixedRotation`, `bullet`, `emitContacts`)
  **and** `core:Collider2D` (`rect | circle | polygon | capsule`, `isSensor`, `group`) on the
  same node; a `core:Collider2D` alone is static geometry. Gravity is negative Y
  (`core:PhysicsWorld2D` on the root or `scene.physics2d.setGravity(0, -1800)`; top-down =
  `(0, 0)`). A body: `applyForce`, `wake()`, `velocityX/Y`, `isSleeping` beside `setVelocity`,
  `applyImpulse`, `teleport(x, y, rot?)`; queries `raycast(...)`, `overlapCircle(...)`,
  `overlapRect(...)`, `moveAndSlide(...)`; signals on the node: `body-entered` / `body-exited`
  (sensors), `contact-started` / `contact-ended` (with `emitContacts`). Joints:
  `core:RevoluteJoint2D`.
- Game intents: `scene.commands` also has `list()` and `log` — how tests and the menu drive the
  game without clicking.
- The debug surface `pix3_game_run`'s `gameState` predicates read: `import { registerGameDebug }
  from '@pix3/runtime'`; in `onStart`: `this.disposeDebug = registerGameDebug({ name, version: 1,
  snapshot: () => ({ …JSON-safe state… }), inspect: (query, args) => …, action: (name, args) =>
  … })`, call the returned disposer in `onDetach`. Global and last-wins — only the running
  scene's flow/rules script registers one (extend it, do not add a second).
- Cutscenes: `scene.cutscene.playCinematic(id, {…})`; camera blends via `core:CameraBrain` +
  `VirtualCamera3D`.
- Multiplayer: `scene.network`, `scene.netNodes`, `core:NetworkedNode`,
  `core:ReplicatedTransform` (only when the brief says multiplayer).

## `this.input` (`InputService`) — pointer and touch are already unified

- Wheel: `input.wheelDelta` (plain scroll wheel only); `input.wheelZoomDelta` (Ctrl/⌘ + wheel
  and trackpad pinch — use it for camera zoom, it is excluded from `wheelDelta`);
  `input.wheelModifiers` (`{ ctrl, meta, shift, alt }`). The canvas already `preventDefault()`s
  every wheel event, so ctrl-wheel never zooms the page.
- Fingers: `input.getActivePointers()`, `input.getPointer(id)`, `input.pointerDownCount`. Gate
  gestures on `input.isPointerOverUI(pointerId)`, not on `isHoveringUI`.
- Actions: `getButton('Action_Primary')`, the arrows / WASD axes of `getAxis(name)`;
  `lock()` / `unlock()`.
- A tap-to-place mechanic: on a `'down'` event, `scene.getPointer2DWorldPosition(ev.pointerId)`,
  convert to the board's local space (`board.worldToLocal` or subtract the board's world
  position), place the node, `scene.juice.burst({ x, y })`, `scene.audio.sfx('tap')`.
