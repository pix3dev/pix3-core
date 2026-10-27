/**
 * Runtime modules a playable build may replace with a throwing stub when nothing in the project
 * mentions them (plan §B.6 item 2; port of the 1.x `strippable-runtime-modules.ts`).
 *
 * Why a stub and not a runtime refactor: the plugin already owns the `load` hook, so "leave this
 * out" costs one stub and changes no `@pix3/runtime` API — which matters because the package is
 * consumed by external projects. See `../pix3/.plans/done/playable-export-size.md` §2 Р3/Р4.
 *
 * The table is only safe because of two invariants, both enforced by
 * `strippable-runtime-modules.spec.ts` against the real import graph of `packages/runtime/src`:
 *
 * 1. Every **value** importer of a listed module — and every module that reaches it through the
 *    lazy getter that constructs it (`SceneService.physics2d`, `JuiceApi.trail`) — is either
 *    itself listed ({@link StrippableRuntimeModule.importers}), neutralised for this purpose
 *    ({@link NEUTRALISED_IMPORTERS}), or explicitly excused as a lazy construction site
 *    ({@link StrippableRuntimeModule.lazyValueImporters}); and that getter's name is a keep-name.
 * 2. Behaviour ids match `behaviors/register-behaviors.ts`.
 *
 * Besides its keep-names, a module is kept by any mention of one of its **value exports** (the
 * build reads them from the real source: {@link valueExportNames}) — the barrel re-exports every
 * one, so `import { pointInPolygon } from '@pix3/runtime'` must keep `collision-shapes-2d` rather
 * than hand the game a stub that throws (or a constant that reads `undefined`).
 *
 * If the runtime grows a new importer of a listed module, the spec fails and the entry has to be
 * re-justified instead of quietly shipping a broken build.
 */
export interface StrippableRuntimeModule {
  /** Path under `packages/runtime/src`, without extension. */
  readonly modulePath: string;
  /**
   * Names that keep the module in the bundle when the project mentions any of them — the class
   * name plus, for script components, the registry id as it appears in scene YAML
   * (`type: core:Follow`).
   */
  readonly keepWhenMentioned: readonly string[];
  /**
   * Entries of this table that keep this module alive: value importers, and modules that reach
   * it through a lazy getter of a module that is always kept (`this.scene?.physics2d` in a
   * behaviour that imports only the service's types). Such a module can only be stripped once all
   * of them are — the build runs that fixpoint.
   */
  readonly importers?: readonly string[];
  /**
   * Value importers that are NOT strippable, excused because they only construct the module
   * lazily on a path unreachable for a project that never mentions it. Each one needs a comment
   * saying why.
   */
  readonly lazyValueImporters?: readonly string[];
}

/**
 * Importers whose references do not pin anything, because they cannot survive in a player bundle
 * on their own:
 *
 * - `core/SceneLoader` — the `switch` over every node type; a case whose type never appears in a
 *   shipped scene is dead code that only constructs the stub.
 * - `index` — the package barrel; the bundler drops re-exports nobody imports.
 * - `behaviors/register-behaviors` — registers classes by id into a `Map`; a stub registers fine
 *   and `ScriptRegistry.createComponent` reports the throw.
 * - `core/SceneSaver` — never constructed by a player (see `SceneManager`'s optional saver), so it
 *   tree-shakes out with everything it imports.
 *
 * @internal The import-graph guard (`strippable-runtime-modules.spec.ts`) reads it.
 */
export const NEUTRALISED_IMPORTERS = [
  'core/SceneLoader',
  'index',
  'behaviors/register-behaviors',
  'core/SceneSaver',
] as const;

export const STRIPPABLE_RUNTIME_MODULES: readonly StrippableRuntimeModule[] = [
  // --- script components (`core:` behaviours) ---
  { modulePath: 'behaviors/RotateBehavior', keepWhenMentioned: ['RotateBehavior', 'core:Rotate'] },
  {
    modulePath: 'behaviors/SimpleMoveBehavior',
    keepWhenMentioned: ['SimpleMoveBehavior', 'core:SimpleMove'],
  },
  { modulePath: 'behaviors/SineBehavior', keepWhenMentioned: ['SineBehavior', 'core:Sine'] },
  {
    modulePath: 'behaviors/PinToNodeBehavior',
    keepWhenMentioned: ['PinToNodeBehavior', 'core:PinToNode'],
  },
  { modulePath: 'behaviors/FollowBehavior', keepWhenMentioned: ['FollowBehavior', 'core:Follow'] },
  { modulePath: 'behaviors/FadeBehavior', keepWhenMentioned: ['FadeBehavior', 'core:Fade'] },
  {
    modulePath: 'behaviors/RadialProgressBehavior',
    keepWhenMentioned: ['RadialProgressBehavior', 'core:RadialProgress'],
  },
  {
    modulePath: 'behaviors/PlaySoundBehavior',
    keepWhenMentioned: ['PlaySoundBehavior', 'core:PlaySound'],
  },
  {
    modulePath: 'behaviors/SfxOnSignalBehavior',
    keepWhenMentioned: ['SfxOnSignalBehavior', 'core:SfxOnSignal'],
  },
  {
    modulePath: 'behaviors/BurstOnSignalBehavior',
    keepWhenMentioned: ['BurstOnSignalBehavior', 'core:BurstOnSignal'],
  },
  {
    modulePath: 'behaviors/FreeOnSignalBehavior',
    keepWhenMentioned: ['FreeOnSignalBehavior', 'core:FreeOnSignal'],
  },
  {
    modulePath: 'behaviors/Hitbox2DBehavior',
    keepWhenMentioned: ['Hitbox2DBehavior', 'core:Hitbox2D'],
  },
  {
    modulePath: 'behaviors/PointAttachmentBehavior',
    keepWhenMentioned: ['PointAttachmentBehavior', 'core:PointAttachment'],
  },
  {
    modulePath: 'behaviors/CharacterVisual2DBehavior',
    keepWhenMentioned: ['CharacterVisual2DBehavior', 'core:CharacterVisual2D'],
  },
  {
    modulePath: 'behaviors/ReplicatedTransformBehavior',
    keepWhenMentioned: ['ReplicatedTransformBehavior', 'core:ReplicatedTransform'],
  },
  {
    modulePath: 'behaviors/NetworkedNodeBehavior',
    keepWhenMentioned: ['NetworkedNodeBehavior', 'core:NetworkedNode'],
    importers: ['behaviors/ReplicatedTransformBehavior'],
  },

  // --- node types ---
  {
    modulePath: 'nodes/2D/ColorRect2D',
    keepWhenMentioned: ['ColorRect2D'],
    // `UIControl2D.findPointerTarget` only tests `instanceof ColorRect2D`; against the stub that is
    // false for every node, which is exactly right when no scene places one.
    lazyValueImporters: ['nodes/2D/UI/UIControl2D'],
  },
  { modulePath: 'nodes/2D/CanvasLayer2D', keepWhenMentioned: ['CanvasLayer2D'] },
  { modulePath: 'nodes/2D/TiledSprite2D', keepWhenMentioned: ['TiledSprite2D'] },
  { modulePath: 'nodes/2D/SpineSkeleton2D', keepWhenMentioned: ['SpineSkeleton2D'] },
  {
    modulePath: 'nodes/2D/AnimatedSprite2D',
    keepWhenMentioned: ['AnimatedSprite2D'],
    importers: ['behaviors/PointAttachmentBehavior', 'behaviors/CharacterVisual2DBehavior'],
  },
  { modulePath: 'nodes/2D/UI/Bar2D', keepWhenMentioned: ['Bar2D'] },
  { modulePath: 'nodes/2D/UI/Checkbox2D', keepWhenMentioned: ['Checkbox2D'] },
  { modulePath: 'nodes/2D/UI/InventorySlot2D', keepWhenMentioned: ['InventorySlot2D'] },
  { modulePath: 'nodes/2D/UI/Joystick2D', keepWhenMentioned: ['Joystick2D'] },
  { modulePath: 'nodes/2D/UI/Slider2D', keepWhenMentioned: ['Slider2D'] },
  { modulePath: 'nodes/3D/AmbientLightNode', keepWhenMentioned: ['AmbientLightNode'] },
  { modulePath: 'nodes/3D/DirectionalLightNode', keepWhenMentioned: ['DirectionalLightNode'] },
  { modulePath: 'nodes/3D/HemisphereLightNode', keepWhenMentioned: ['HemisphereLightNode'] },
  { modulePath: 'nodes/3D/PointLightNode', keepWhenMentioned: ['PointLightNode'] },
  { modulePath: 'nodes/3D/SpotLightNode', keepWhenMentioned: ['SpotLightNode'] },
  {
    modulePath: 'nodes/2D/UI/ScrollContainer2D',
    keepWhenMentioned: ['ScrollContainer2D'],
    // `UIControl2D`'s pointer routing only tests `instanceof ScrollContainer2D` on a control's
    // ancestors — false against the stub, right when no scene places one.
    lazyValueImporters: ['nodes/2D/UI/UIControl2D'],
  },
  {
    modulePath: 'nodes/3D/Particles3D',
    keepWhenMentioned: ['Particles3D'],
    // `SceneRunner.updateBillboardSprites` only tests `instanceof Particles3D` — false for every
    // node against the stub, which is right when no scene places one (the ColorRect2D precedent).
    lazyValueImporters: ['core/SceneRunner'],
  },
  // 3D nodes `SceneRunner` only tests with `instanceof` (render passes, billboards, AO): false
  // against a stub, right in a 2D game that never places one.
  {
    modulePath: 'nodes/3D/GeometryMesh',
    keepWhenMentioned: ['GeometryMesh'],
    lazyValueImporters: ['core/SceneRunner'],
  },
  {
    modulePath: 'nodes/3D/InstancedMesh3D',
    keepWhenMentioned: ['InstancedMesh3D'],
    lazyValueImporters: ['core/SceneRunner'],
  },
  {
    modulePath: 'nodes/3D/Sprite3D',
    keepWhenMentioned: ['Sprite3D'],
    lazyValueImporters: ['core/SceneRunner'],
  },
  {
    modulePath: 'nodes/3D/AnimatedSprite3D',
    keepWhenMentioned: ['AnimatedSprite3D'],
    lazyValueImporters: ['core/SceneRunner'],
  },
  // The cutscene chain: `scene.cutscene` constructs the API lazily, which reaches the camera
  // brain (`getComponent(CameraBrainBehavior)`), which reaches the virtual cameras.
  {
    modulePath: 'core/CutsceneApi',
    keepWhenMentioned: ['cutscene', 'CutsceneApi'],
    lazyValueImporters: ['core/SceneService'],
  },
  {
    modulePath: 'behaviors/CameraBrainBehavior',
    keepWhenMentioned: ['CameraBrainBehavior', 'core:CameraBrain'],
    importers: ['core/CutsceneApi'],
  },
  {
    modulePath: 'nodes/3D/VirtualCamera3D',
    keepWhenMentioned: ['VirtualCamera3D'],
    importers: ['behaviors/CameraBrainBehavior'],
  },
  {
    modulePath: 'nodes/PostProcess',
    keepWhenMentioned: ['PostProcess'],
    // `SceneRunner` only tests `instanceof PostProcess` to find the scene's post-fx node.
    lazyValueImporters: ['core/SceneRunner'],
  },

  // --- 2D collision and physics ---
  {
    // The polygon math: winding, convex decomposition, SAT, the world transform. It has no
    // keep-names of its own — it is exactly as needed as the two services that use it, and the
    // fixpoint below works that out.
    modulePath: 'core/collision-shapes-2d',
    keepWhenMentioned: [],
    importers: ['core/Collision2DService', 'core/Physics2DService', 'core/physics-2d-narrowphase'],
  },
  {
    modulePath: 'core/world-transform-2d',
    keepWhenMentioned: [],
    importers: ['core/Collision2DService', 'core/Physics2DService'],
  },
  {
    modulePath: 'core/collision-polygon-config',
    keepWhenMentioned: [],
    importers: ['behaviors/Hitbox2DBehavior', 'behaviors/Collider2DBehavior'],
  },
  {
    // Query-only 2D collision. `SceneService.collision2d` constructs it lazily, and a project that
    // never writes the word cannot reach that getter — the NetworkService precedent, one line down.
    modulePath: 'core/Collision2DService',
    keepWhenMentioned: ['collision2d', 'Collision2D', 'Hitbox2D', 'core:Hitbox2D'],
    // Hitbox2DBehavior imports only its TYPES, but reaches the service through the lazy
    // `scene.collision2d` getter: a kept behaviour (placed by a scene, or constructed by a script
    // as `new Hitbox2DBehavior()`) must keep the service — so it is an importer for the fixpoint.
    importers: ['behaviors/Hitbox2DBehavior'],
    lazyValueImporters: ['core/SceneService'],
  },
  {
    modulePath: 'core/physics-2d-narrowphase',
    keepWhenMentioned: [],
    importers: ['core/Physics2DService'],
  },
  {
    // ~20 KiB of solver. Same lazy-getter argument as `collision2d`; and `SceneRunner` reaches it
    // through `SceneService.stepPhysics2D`, so it adds no value import of its own.
    modulePath: 'core/Physics2DService',
    keepWhenMentioned: [
      'physics2d',
      'Physics2D',
      'PhysicsBody2D',
      'core:PhysicsBody2D',
      'Collider2D',
      'core:Collider2D',
      'core:PhysicsWorld2D',
      'core:RevoluteJoint2D',
      'RevoluteJoint2D',
    ],
    // The four behaviours import only types from here but reach the service through the lazy
    // `scene.physics2d` getter (same as Hitbox2D): each one kept keeps the solver.
    importers: [
      'behaviors/PhysicsBody2DBehavior',
      'behaviors/Collider2DBehavior',
      'behaviors/PhysicsWorld2DBehavior',
      'behaviors/RevoluteJoint2DBehavior',
    ],
    lazyValueImporters: ['core/SceneService'],
  },
  {
    modulePath: 'behaviors/PhysicsBody2DBehavior',
    keepWhenMentioned: ['PhysicsBody2DBehavior', 'core:PhysicsBody2D'],
  },
  {
    modulePath: 'behaviors/Collider2DBehavior',
    keepWhenMentioned: ['Collider2DBehavior', 'core:Collider2D'],
  },
  {
    modulePath: 'behaviors/PhysicsWorld2DBehavior',
    keepWhenMentioned: ['PhysicsWorld2DBehavior', 'core:PhysicsWorld2D'],
  },
  {
    modulePath: 'behaviors/RevoluteJoint2DBehavior',
    keepWhenMentioned: ['RevoluteJoint2DBehavior', 'core:RevoluteJoint2D'],
  },

  // --- tweens and trails ---
  {
    // `SceneService.tween` constructs it lazily, and the per-frame `updateTweens` hook is a null
    // check on an instance nobody made — so a project that never writes the word cannot reach the
    // getter (the `collision2d` / `network` precedent above).
    modulePath: 'core/TweenApi',
    keepWhenMentioned: ['tween', 'Tween', 'TweenApi'],
    lazyValueImporters: ['core/SceneService'],
  },
  {
    // The motion ribbon. `JuiceApi.trail()` is its only construction site, and nothing else in
    // the runtime reaches it.
    modulePath: 'core/trail-2d',
    keepWhenMentioned: ['trail', 'Trail2D'],
    lazyValueImporters: ['core/JuiceApi'],
  },

  // --- multiplayer ---
  {
    // ~59 KiB with its protocol tree. `SceneService.network` is a getter that constructs one
    // lazily "so single-player scripts can touch it freely" — but a project that never writes the
    // word `network` anywhere cannot reach that getter, and any project that does keeps the real
    // service (see `NETWORK_MENTION_NAMES` in `scan.ts`).
    modulePath: 'net/NetworkService',
    keepWhenMentioned: [
      'network',
      'Network',
      'NetworkService',
      'setNetworkPrefabTable',
      'NetworkedNode',
      'ReplicatedTransform',
      // `SceneService.netNodes` builds a binder on `this.network`: the same lazy construction.
      'netNodes',
    ],
    importers: ['behaviors/NetworkedNodeBehavior', 'behaviors/ReplicatedTransformBehavior'],
    // `NetworkNodeBinder` reads `host.network`, but only `SceneService.netNodes` constructs it
    // (a keep-name above), so it reaches the service only where the project said so.
    lazyValueImporters: ['core/SceneService', 'core/NetworkNodeBinder'],
  },
];

/**
 * The subset of {@link STRIPPABLE_RUNTIME_MODULES} that can leave a build in which
 * `mentions(name)` is false for every name the entry (and, transitively, every entry that imports
 * it) is kept by.
 */
export const resolveStrippableRuntimeModules = (
  mentions: (name: string) => boolean,
  /** The module's value exports (from its real source); each one keeps it like a keep-name. */
  exportsOf: (modulePath: string) => readonly string[] = () => []
): readonly StrippableRuntimeModule[] => {
  const byPath = new Map(STRIPPABLE_RUNTIME_MODULES.map(entry => [entry.modulePath, entry]));
  const stripped = new Set(
    STRIPPABLE_RUNTIME_MODULES.filter(
      entry =>
        !entry.keepWhenMentioned.some(mentions) && !exportsOf(entry.modulePath).some(mentions)
    ).map(entry => entry.modulePath)
  );

  // A module survives as long as anything that imports it survives. Iterate until that settles:
  // un-stripping ReplicatedTransformBehavior, say, has to also rescue NetworkedNodeBehavior and
  // through it NetworkService.
  for (let changed = true; changed; ) {
    changed = false;
    for (const modulePath of [...stripped]) {
      const importers = byPath.get(modulePath)?.importers ?? [];
      if (importers.some(importer => !stripped.has(importer))) {
        stripped.delete(modulePath);
        changed = true;
      }
    }
  }

  return STRIPPABLE_RUNTIME_MODULES.filter(entry => stripped.has(entry.modulePath));
};

interface ValueExports {
  readonly classNames: ReadonlySet<string>;
  readonly functionNames: ReadonlySet<string>;
  readonly otherNames: ReadonlySet<string>;
}

/** The value exports of a runtime module's source, by kind (what the stub has to re-declare). */
const valueExportsOf = (moduleSource: string): ValueExports => {
  const classNames = new Set<string>();
  const functionNames = new Set<string>();
  const otherNames = new Set<string>();

  const declarationPattern =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(class|const|function|async\s+function|let|var|enum)\s+([A-Za-z0-9_$]+)/g;
  for (const match of moduleSource.matchAll(declarationPattern)) {
    if (match[1] === 'class') {
      classNames.add(match[2]);
    } else if (match[1].endsWith('function')) {
      functionNames.add(match[2]);
    } else {
      otherNames.add(match[2]);
    }
  }

  // `export { a, b as c }` re-export lists (rare in node modules, but cheap to cover).
  const listPattern = /export\s*\{([^}]*)\}(?!\s*from)/g;
  for (const match of moduleSource.matchAll(listPattern)) {
    for (const clause of match[1].split(',')) {
      const name = clause
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (
        name &&
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) &&
        !classNames.has(name) &&
        !functionNames.has(name)
      ) {
        otherNames.add(name);
      }
    }
  }
  return { classNames, functionNames, otherNames };
};

/** Every value export name of a module's source (the names that keep it besides the table's). */
export const valueExportNames = (moduleSource: string): string[] => {
  const { classNames, functionNames, otherNames } = valueExportsOf(moduleSource);
  return [...classNames, ...functionNames, ...otherNames];
};

/**
 * A drop-in replacement for a runtime module's source: same value exports, but every class throws
 * if anything ever constructs it. Derived from the real source rather than hardcoded, so a renamed
 * export cannot silently drift — and if a name is missed, the bundler fails the build with "no
 * matching export" instead of shipping something broken.
 *
 * Types and interfaces need no stubs: the bundler erases type-only usages, so the importing module
 * no longer references those names at all.
 */
export const buildStrippedModuleSource = (moduleSource: string, modulePath: string): string => {
  const { classNames, functionNames, otherNames } = valueExportsOf(moduleSource);

  const strippedError = (name: string): string =>
    JSON.stringify(
      `[Pix3] ${name} was stripped from this build because nothing in the project referenced it at build time.`
    );

  const lines = [`// Stripped from this build: nothing in the project mentions ${modulePath}.`];
  for (const name of classNames) {
    lines.push(
      `export class ${name} {`,
      `  static getPropertySchema() { return []; }`,
      `  constructor() { throw new Error(${strippedError(name)}); }`,
      `}`
    );
  }
  for (const name of functionNames) {
    lines.push(`export function ${name}() { throw new Error(${strippedError(name)}); }`);
  }
  for (const name of otherNames) {
    lines.push(`export const ${name} = undefined;`);
  }
  if (classNames.size === 0 && functionNames.size === 0 && otherNames.size === 0) {
    lines.push('export {};');
  }

  return lines.join('\n') + '\n';
};
