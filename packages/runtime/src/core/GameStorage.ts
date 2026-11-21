import { appLifecycle } from './AppLifecycle';

/**
 * `scene.storage`: the game's save. One JSON snapshot per game (`{ version, data }`), read once
 * before the first `onStart` (the runner awaits {@link GameStorage.open}), then a synchronous API
 * over an in-memory copy; changes are written back after {@link WRITE_DELAY_MS}, one write at a
 * time, and at once when the page goes to the background. Where it is written: the page's
 * {@link setStorageAdapter} (a native shell, a portal SDK), else `localStorage` under
 * `pix3:<namespace>:save`, else nowhere ({@link GameStorage.persistent} false).
 */

/** Where a native shell or a portal SDK keeps the save; `key` is `pix3:<namespace>:save`. */
export interface StorageAdapter {
  read(key: string): Promise<string | null>;
  write(key: string, snapshot: string): Promise<void>;
}

/**
 * A test run's save (`RunOverrides.storage`, `pix3 play --storage`, `HeadlessGameOptions.storage`):
 * `'memory'` starts empty, `{ snapshot }` starts from an {@link GameStorage.export} snapshot; both
 * stay in memory and never touch the player's real save.
 */
export type StorageRunMode = 'memory' | { readonly snapshot: unknown };

export interface StorageOpenOptions {
  /** `storage.namespace` of `pix3project.yaml` (`<namespace>:editor` for the editor's Play). */
  readonly namespace: string;
  readonly mode?: StorageRunMode | null;
}

export interface StorageResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Turns the data of version `from` into the data of version `to`; may mutate and return nothing. */
export type StorageMigration = (data: Record<string, unknown>) => Record<string, unknown> | void;

interface Snapshot {
  version: number;
  data: Record<string, unknown>;
}

/** A change is written this long after it was made (a burst of `set`s is one write). */
const WRITE_DELAY_MS = 250;

let pageAdapter: StorageAdapter | null = null;

/** Keep the save in a native shell / portal SDK instead of `localStorage`; before `startGame`. */
export function setStorageAdapter(adapter: StorageAdapter | null): void {
  pageAdapter = adapter;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A snapshot from its JSON text or object form, or the reason it is not one. */
const parseSnapshot = (input: unknown): Snapshot | string => {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      return `not JSON (${describe(error)})`;
    }
  }
  if (!isRecord(value) || !isRecord(value.data)) return 'not a { version, data } object';
  const version = value.version ?? 0;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return 'version is not a whole number';
  }
  return { version, data: value.data };
};

const browserStorage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export class GameStorage {
  private data: Record<string, unknown> = {};
  private dataVersion = 0;
  /** Read by {@link open}, migrated on the first access (after the autoloads' `onAttach`). */
  private pending: Snapshot | null = null;
  private materialized = false;
  private readonly migrations = new Map<number, { to: number; fn: StorageMigration }>();
  private target: { write(snapshot: string): Promise<void> | void } | null = null;
  private opened = false;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<StorageResult> = Promise.resolve({ ok: true });
  private unsubscribe: (() => void) | null = null;

  /** True when changes outlive the page (an adapter or `localStorage`); false in a test run. */
  get persistent(): boolean {
    return this.target !== null;
  }

  /** The data's schema version: the highest `to` of {@link migrate}, 0 without migrations. */
  get version(): number {
    this.materialize();
    return this.dataVersion;
  }

  /**
   * Read the save (once per page; a later call only re-arms the background flush). Never throws:
   * an unreadable store plays from memory, a corrupt snapshot starts empty.
   */
  async open(options: StorageOpenOptions): Promise<void> {
    if (!this.opened) {
      this.opened = true;
      await this.load(options);
    }
    if (this.target && !this.unsubscribe) {
      this.unsubscribe = appLifecycle.subscribe(change => {
        if (change.state === 'background' || !appLifecycle.visible) void this.flush();
      });
    }
  }

  /** Session end: stop listening to the page and write what is pending. */
  close(): Promise<StorageResult> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return this.flush();
  }

  /**
   * Register a step from save version `from` to `to` (`to > from`). Register every step before
   * the first read — in an autoload's `onAttach`, which runs before any `onStart`: the save is
   * migrated on its first access, once.
   */
  migrate(from: number, to: number, fn: StorageMigration): void {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
      console.error(`[pix3] scene.storage.migrate(${from}, ${to}): versions are whole, to > from.`);
      return;
    }
    if (this.materialized) {
      console.error(
        `[pix3] scene.storage.migrate(${from}, ${to}) came after the save was read; register ` +
          "migrations in an autoload's onAttach."
      );
      return;
    }
    this.migrations.set(from, { to, fn });
  }

  /** A copy of the value (mutating it changes nothing until {@link set}), or `fallback`. */
  get<T>(key: string, fallback: T): T {
    this.materialize();
    return Object.hasOwn(this.data, key) ? (structuredClone(this.data[key]) as T) : fallback;
  }

  has(key: string): boolean {
    this.materialize();
    return Object.hasOwn(this.data, key);
  }

  /** Store a JSON value (`undefined` removes the key); written {@link WRITE_DELAY_MS} later. */
  set(key: string, value: unknown): void {
    this.materialize();
    const json = JSON.stringify(value) as string | undefined;
    if (json === undefined) {
      this.remove(key);
      return;
    }
    this.data[key] = JSON.parse(json) as unknown;
    this.changed();
  }

  remove(key: string): void {
    this.materialize();
    if (!Object.hasOwn(this.data, key)) return;
    delete this.data[key];
    this.changed();
  }

  /** Forget every key of this game's save (other games' saves are other keys). */
  clear(): void {
    this.materialize();
    this.data = {};
    this.changed();
  }

  /**
   * Write now what is pending (after any write in flight). `{ ok: false, error }` when the store
   * refused (a full quota): the changes stay pending for the next write.
   */
  flush(): Promise<StorageResult> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = this.queue.then(() => this.writeNow());
    return this.queue;
  }

  /**
   * @internal The save as this session starts from it, without reading it (no migration runs): a
   * run recording's starting snapshot. The read one before the first access, else the live data.
   */
  startSnapshot(): Snapshot {
    const snapshot = this.materialized
      ? { version: this.dataVersion, data: this.data }
      : (this.pending ?? { version: 0, data: {} });
    return structuredClone(snapshot);
  }

  /** The save as JSON text: `{"version":n,"data":{…}}` (what {@link import} and `--storage` take). */
  export(): string {
    this.materialize();
    return JSON.stringify({ version: this.dataVersion, data: this.data });
  }

  /** Replace the save with an {@link export} snapshot (migrated); a bad one changes nothing. */
  import(snapshot: string | object): StorageResult {
    this.materialize();
    const parsed = parseSnapshot(snapshot);
    if (typeof parsed === 'string') return { ok: false, error: `snapshot is ${parsed}` };
    const migrated = this.migrated(parsed);
    if (typeof migrated === 'string') return { ok: false, error: migrated };
    this.data = migrated.data;
    this.dataVersion = migrated.version;
    this.changed();
    return { ok: true };
  }

  private async load(options: StorageOpenOptions): Promise<void> {
    const mode = options.mode ?? null;
    if (mode !== null) {
      if (mode !== 'memory') this.pending = this.parseOrReport(mode.snapshot, 'the run snapshot');
      return;
    }
    const key = `pix3:${options.namespace}:save`;
    const adapter = pageAdapter;
    let text: string | null;
    if (adapter) {
      try {
        text = await adapter.read(key);
      } catch (error) {
        console.error('[pix3] scene.storage: the adapter could not read; playing unsaved.', error);
        return;
      }
      this.target = { write: snapshot => adapter.write(key, snapshot) };
    } else {
      const local = browserStorage();
      if (!local) return;
      try {
        text = local.getItem(key);
      } catch {
        return;
      }
      this.target = { write: snapshot => local.setItem(key, snapshot) };
    }
    if (text !== null) this.pending = this.parseOrReport(text, `the save ${key}`);
  }

  private parseOrReport(input: unknown, what: string): Snapshot | null {
    const parsed = parseSnapshot(input);
    if (typeof parsed !== 'string') return parsed;
    console.error(`[pix3] scene.storage: ${what} is ${parsed}; starting empty.`);
    return null;
  }

  /** The newest version the registered migrations reach. */
  private targetVersion(): number {
    let version = 0;
    for (const { to } of this.migrations.values()) version = Math.max(version, to);
    return version;
  }

  /** `snapshot` brought to {@link targetVersion}, or why it cannot be. A newer save stays as is. */
  private migrated(snapshot: Snapshot): Snapshot | string {
    const target = this.targetVersion();
    let { version } = snapshot;
    let data = structuredClone(snapshot.data);
    while (version < target) {
      const step = this.migrations.get(version);
      if (!step) return `no migration from save version ${version} (the game is at ${target})`;
      try {
        const result = step.fn(data);
        if (result !== undefined) data = result;
      } catch (error) {
        return `migration ${version} → ${step.to} threw: ${describe(error)}`;
      }
      if (!isRecord(data)) return `migration ${version} → ${step.to} did not return an object`;
      version = step.to;
    }
    return { version, data };
  }

  private materialize(): void {
    if (this.materialized) return;
    this.materialized = true;
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot) {
      this.dataVersion = this.targetVersion();
      return;
    }
    const migrated = this.migrated(snapshot);
    if (typeof migrated === 'string') {
      // The save stays as it is on disk for a build whose migration works; this session plays
      // from memory rather than overwrite it.
      console.error(`[pix3] scene.storage: ${migrated}; playing unsaved, the save is kept.`);
      this.target = null;
      void this.close();
      this.dataVersion = this.targetVersion();
      return;
    }
    this.data = migrated.data;
    this.dataVersion = migrated.version;
    if (migrated.version !== snapshot.version) this.changed();
  }

  private changed(): void {
    this.dirty = true;
    if (!this.target || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, WRITE_DELAY_MS);
  }

  private async writeNow(): Promise<StorageResult> {
    const target = this.target;
    if (!target || !this.dirty) return { ok: true };
    const snapshot = JSON.stringify({ version: this.dataVersion, data: this.data });
    this.dirty = false;
    try {
      await target.write(snapshot);
      return { ok: true };
    } catch (error) {
      this.dirty = true;
      return { ok: false, error: describe(error) };
    }
  }
}
