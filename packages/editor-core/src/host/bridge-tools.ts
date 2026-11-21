/**
 * The agent bridge's tool table (plan §D.1): names, descriptions and JSON Schemas of the `pix3`
 * tool group the editor tab registers with chrome-devtools-mcp (`devtoolstooldiscovery`) and
 * exposes on `window.__PIX3_DEBUG__` for the inline `evaluate_script` fallback.
 *
 * Data only, no imports: the CLI's kit drift spec reads this file to hold the agent kit to the
 * tools the editor really has. The implementation is `debug-bridge.ts`.
 */

export type JsonSchema = {
  readonly type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonSchema;
};

export interface BridgeToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** The tool group's name as `list_3p_developer_tools` shows it. */
export const BRIDGE_GROUP_NAME = 'pix3';

export const BRIDGE_GROUP_DESCRIPTION =
  'Pix3 editor: sync the editor with the files on disk, play the game, run frame-stepped game ' +
  'tests, read the scene and the errors. Scenes and scripts are edited as FILES, never through ' +
  'these tools; call pix3_sync after editing. Every refusal is {ok:false, reason, detail}.';

const NOT_OK =
  'Not ok is not a barrier: on gesture_in_progress or stale_modules call again; on ' +
  'expect_mismatch re-read the listed files and sync with new hashes.';

const PAGE_PARAM: JsonSchema = {
  type: 'string',
  enum: ['designer', 'agent'],
  description:
    'Which game page: "designer" (the human’s Play window — read only) or "agent" (yours). ' +
    'Default: the human’s page when it is open, else yours.',
};

export const BRIDGE_TOOLS: readonly BridgeToolSpec[] = [
  {
    name: 'pix3_status',
    description:
      'Versions, project, active scene, script status, which tab writes, scenes with edits not ' +
      'on disk yet (`dirty`, `pending` keys per scene), `gestureInProgress`, external versions ' +
      'not applied yet, `play` = {pages:[{role, url, loadId, rev, scene, ' +
      'status, paused, pausedBy?}]} (the game pages open now: "designer" = the human’s, "agent" ' +
      '= yours), error count, and `viteClient`.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pix3_sync',
    description:
      'Write the editor’s unsaved edits to disk, rescan the project and wait until the editor ' +
      'runs the files as they are on disk (the sync barrier). Call it after every batch of file ' +
      'edits and before reading a file the designer may have changed. `expect` = {path: sha256} ' +
      'of the files you wrote: a mismatch means someone else wrote them. ' +
      NOT_OK,
    inputSchema: {
      type: 'object',
      properties: {
        expect: {
          type: 'object',
          description: 'Project-relative path → sha256 the file must have on disk.',
        },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_scene',
    description:
      'Read a scene as the editor holds it: the tree of the active scene (or `path`; ' +
      '`properties` = what the file gets, unsaved inspector edits included), one node with its ' +
      'components and `saved` with `nodeId`, or the nodes whose name/type contains `find`. While ' +
      'a game page is open both also read the running game there: `live` (its components’ ' +
      'play-time state), `screen` (its origin in CSS px of THAT page, to tap it there) and ' +
      '`page` {role, loadId}; nodes only the running game has carry `runtimeOnly: true`. ' +
      '`page` picks the game page (default: the human’s when open, else yours). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'res:// or project-relative scene path.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 8 },
        nodeId: { type: 'string' },
        find: { type: 'string' },
        page: PAGE_PARAM,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_play',
    description:
      'Your own game page (window "pix3-agent-play", muted): `start` writes the editor’s ' +
      'unsaved edits and loads the game’s page with the active scene (or `scenePath`) — every ' +
      'start and `restart` is a fresh load of the files on disk, answered once the page is ready ' +
      '(`page` {url, loadId, rev}); `stop` closes it; `pause` / `resume`; `status` lists the ' +
      'pages open. The human’s Play window is theirs: control aimed at it is not_your_page. ' +
      '`run` {seed?, config?} sets up a test run, repeated by `restart`.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'pause', 'resume', 'status'] },
        scenePath: { type: 'string' },
        page: PAGE_PARAM,
        run: {
          type: 'object',
          description:
            'With start / restart: {seed?: integer (scene.random), ads?: "reward" | "skip" | ' +
            '"unavailable" or a list by show order (platform ad outcomes), config?: ' +
            '{"<nodeId>": {"<componentId>": {key: value}}}} applied before the first onStart; ' +
            'restart repeats the last one.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_game_run',
    description:
      'Run the playing game frame by frame until a predicate holds (`until`, OR), one fails ' +
      '(`fail`, OR) or a budget runs out; read `verdict` first. Runs on your own game page ' +
      '(pix3_play start opens it); after a pix3_sync that reloads the page it waits for the new ' +
      'load, a page reloaded during the run ends page_reloaded, one older than the sync that did ' +
      'not reload is page_stale (pix3_play restart). ' +
      'Predicates: {kind:"nodeProperty", name, path, op, value}, ' +
      '{kind:"gameState", path, op, value}, {kind:"newErrors"}, {kind:"nodeAppeared"|"nodeGone", name}… ' +
      'Steps far faster than real time: give async init real time with `settleMs`. ' +
      '`bot: {name, channel?, args?}` drives the game with the policy design/tests/bots/<name>.ts ' +
      '(exports {name, tick(bot)} satisfies BotPolicy — types in design/tests/bots/' +
      'pix3-test-bot.d.ts); write the file, pix3_sync, then run — no restart needed. The ' +
      'answer carries `page` {role, url, loadId}.',
    inputSchema: {
      type: 'object',
      properties: {
        until: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Assertions whose arrival ends the run. Required, except with `bot`: then the policy ends it with done(), within maxFrames.',
        },
        fail: { type: 'array', items: { type: 'object' } },
        watch: { type: 'array', items: { type: 'string' } },
        maxFrames: {
          type: 'integer',
          minimum: 1,
          maximum: 10800,
          description: 'Frame budget (default 600, at most 10800 per run; more is clamped).',
        },
        maxWallMs: {
          type: 'integer',
          minimum: 1,
          maximum: 180000,
          description: 'Wall-clock budget in ms (default 20000, at most 180000 per run).',
        },
        settleMs: { type: 'integer', minimum: 0 },
        fixedDeltaSec: { type: 'number' },
        pauseOnOutcome: { type: 'boolean' },
        bot: {
          type: 'object',
          description:
            'A stored policy: {name: "dodge"} for design/tests/bots/dodge.ts; channel ' +
            '"physical-input" (default) or "direct-action"; args = one JSON object the policy ' +
            'reads as bot.args.',
        },
      },

      additionalProperties: true,
    },
  },
  {
    name: 'pix3_screenshot',
    description:
      'Bring a surface to the front so a screenshot shows it: `game` focuses a game page ' +
      '(`page`; default the human’s when open, else yours) and answers its `page` {role, url, ' +
      'loadId} — select THAT page for take_screenshot; `viewport` the editor’s viewport. This ' +
      'tool never returns image data.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', enum: ['game', 'viewport'] }, page: PAGE_PARAM },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_render_model',
    description:
      'Look at a model: the node `nodeId` of the active scene (or all its 3D roots) as the editor ' +
      'holds it, unsaved edits and a pix3_bake included, drawn from each of `views` (iso, front, ' +
      'right, back, left, top, below, game, all, or azimuth:elevation like 30:20; default ' +
      'iso,front,right,top) into one sheet, alone on a plain background. Answers what it costs ' +
      '(meshes, drawCalls, triangles, size, center, lights, the baked nodes under it), how it ' +
      'reads (`look`: linear-luminance p10/p50/p90, near-black share, saturation, a note such as ' +
      '"reads dark" — hints, as in pix3 render) and lays the ' +
      'sheet over the editor until the next pix3_* call or a click: take_screenshot shows it. ' +
      'From the shell `pix3 bridge render` writes it to a PNG; without the editor, `pix3 render`.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        views: {
          type: 'string',
          description: 'Comma-separated views (default iso,front,right,top).',
        },
        size: {
          type: 'integer',
          minimum: 64,
          maximum: 1024,
          description: 'Tile px (default 384).',
        },
        lights: {
          type: 'string',
          enum: ['auto', 'studio', 'scene'],
          description: 'auto (default) = the scene’s lights when it has any, else a studio rig.',
        },
        background: { type: 'string', description: 'CSS colour behind the model.' },
        image: {
          type: 'boolean',
          description: 'Return the sheet as a PNG data URL in `image` instead of showing it.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_bake',
    description:
      'Show core:MergeStatic in the viewport: `apply` (default) merges the static parts of every ' +
      'node carrying core:MergeStatic in the active scene (or `nodeId`, with or without one) into ' +
      'one mesh and bakes sun, shadows and AO into it with the component’s settings, as play does; ' +
      '`clear` shows the parts again; `status` lists the baked nodes. Answers per node: parts ' +
      'merged, meshes, vertices, ms. Writes nothing; the bake stays until cleared or the scene ' +
      'reloads — apply again after editing the model.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['apply', 'clear', 'status'] },
        nodeId: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_errors',
    description:
      'Errors the editor and the game pages captured, newest last, each with `origin` ' +
      '("editor", "designer", "agent") and a page’s `loadId`; `page` keeps one page’s, `since` ' +
      '(epoch ms) limits them, `clear` empties the lists after reading.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'integer', minimum: 0 },
        clear: { type: 'boolean' },
        page: PAGE_PARAM,
      },
      additionalProperties: false,
    },
  },
];

/** @internal The tool names in table order — the kit's drift spec (`cli/src/kit.spec.ts`) reads it. */
export const BRIDGE_TOOL_NAMES: readonly string[] = BRIDGE_TOOLS.map(tool => tool.name);

/**
 * Refusal reasons the bridge itself produces (tool answers may carry their own).
 * @internal The kit's drift spec holds the kit's reasons to this list; the code returns literals.
 */
export const BRIDGE_REASONS = [
  'unknown_tool',
  'invalid_params',
  'refused',
  'no_scene',
  'not_found',
  'error',
  // the game on its own page (§2.2 of plan play-in-page)
  'no_game_page',
  'not_your_page',
  'popup_blocked',
  'flush_failed',
  'page_reloaded',
  'page_stale',
] as const;

/**
 * Check `params` against the subset of JSON Schema the tool table uses (type, required, enum,
 * additionalProperties, minimum/maximum, items). chrome-devtools-mcp validates the 3p path with
 * ajv; this covers the inline `__PIX3_DEBUG__.call` path the same way. Returns the problem or null.
 */
export function validateParams(schema: JsonSchema, value: unknown, at = 'params'): string | null {
  if (schema.type && !matchesType(schema.type, value)) {
    return `${at} must be ${schema.type === 'integer' ? 'an integer' : `of type ${schema.type}`}`;
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    return `${at} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return `${at} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum)
      return `${at} must be <= ${schema.maximum}`;
  }
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = validateParams(schema.items, value[i], `${at}[${i}]`);
      if (problem) return problem;
    }
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) return `${at} needs "${key}"`;
    }
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false) return `${at} has an unknown key "${key}"`;
        continue;
      }
      if (item === undefined) continue;
      const problem = validateParams(property, item, `${at}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

const matchesType = (type: NonNullable<JsonSchema['type']>, value: unknown): boolean => {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
      return typeof value === type;
  }
};
