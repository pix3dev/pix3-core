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
  'expect_mismatch re-read the listed files and sync with new hashes; on stale follow ' +
  '`playing`: "agent" → pix3_play restart (or stop) then sync again, "designer" → wait or ask.';

export const BRIDGE_TOOLS: readonly BridgeToolSpec[] = [
  {
    name: 'pix3_status',
    description:
      'Versions, project, active scene, script status, which tab writes, scenes with edits not ' +
      'on disk yet (`dirty`, `pending` keys per scene), `gestureInProgress`, external versions ' +
      'not applied yet, play state with its owner, error count, and `viteClient` (true = Vite’s ' +
      'HMR client reached the editor page; `pix3 check` names the script that did it).',
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
      'Read a scene as the editor holds it: the tree ({nodeId, type, name, properties, ' +
      'children…}) of the active scene (or `path`; `properties` = what the file gets, unsaved ' +
      'inspector edits included), one node with its components and `saved` (the node as the scene ' +
      'file gets it) and `screen` (its origin on the page in CSS px, to click or drag it) with ' +
      '`nodeId`, or the nodes whose name/type contains `find`. Read-only: change scenes by ' +
      'editing the .pix3scene file, then pix3_sync.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'res:// or project-relative scene path.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 8 },
        nodeId: { type: 'string' },
        find: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_play',
    description:
      'Play mode. `start` runs the active scene (or `scenePath`) and records you as the owner; ' +
      '`stop`, `restart` (stop → apply deferred file changes → start) and `pause` work on any ' +
      'session an agent started; a session the designer started from the UI is refused with ' +
      'reason not_owner, even with `force`. `status` returns playOwner and startedAt.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'pause', 'status'] },
        scenePath: { type: 'string' },
        force: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_game_run',
    description:
      'Run the playing game frame by frame until a predicate holds (`until`, OR), one fails ' +
      '(`fail`, OR) or a budget runs out; read `verdict` first. Needs a running play session ' +
      '(pix3_play start). Predicates: {kind:"nodeProperty", name, path, op, value}, ' +
      '{kind:"gameState", path, op, value}, {kind:"newErrors"}, {kind:"nodeAppeared"|"nodeGone", name}… ' +
      'Steps far faster than real time: give async init real time with `settleMs`. ' +
      '`bot: {name, channel?}` drives the game with the policy design/tests/bots/<name>.ts ' +
      '(exports {name, tick(bot)}); write the file, pix3_sync, then run — no restart needed.',
    inputSchema: {
      type: 'object',
      properties: {
        until: { type: 'array', items: { type: 'object' } },
        fail: { type: 'array', items: { type: 'object' } },
        watch: { type: 'array', items: { type: 'string' } },
        maxFrames: { type: 'integer', minimum: 1 },
        maxWallMs: { type: 'integer', minimum: 1 },
        settleMs: { type: 'integer', minimum: 0 },
        fixedDeltaSec: { type: 'number' },
        pauseOnOutcome: { type: 'boolean' },
        bot: {
          type: 'object',
          description:
            'A stored policy: {name: "dodge"} for design/tests/bots/dodge.ts; channel ' +
            '"physical-input" (default) or "direct-action".',
        },
      },
      required: ['until'],
      additionalProperties: true,
    },
  },
  {
    name: 'pix3_screenshot',
    description:
      'Bring the surface to the front so a screenshot shows it: `game` focuses the running ' +
      'game’s tab, `viewport` the active scene’s viewport. Then call chrome-devtools-mcp’s own ' +
      'take_screenshot — this tool never returns image data.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', enum: ['game', 'viewport'] } },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'pix3_errors',
    description:
      'Console and runtime errors the editor captured (script throws during play, load errors), ' +
      'newest last; `since` (epoch ms) limits them, `clear` empties the list after reading.',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'integer', minimum: 0 }, clear: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
];

export const BRIDGE_TOOL_NAMES: readonly string[] = BRIDGE_TOOLS.map(tool => tool.name);

/** Refusal reasons the bridge itself produces (tool answers may carry their own). */
export const BRIDGE_REASONS = [
  'unknown_tool',
  'invalid_params',
  'not_owner',
  'already_playing',
  'not_playing',
  'refused',
  'no_scene',
  'not_found',
  'error',
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
