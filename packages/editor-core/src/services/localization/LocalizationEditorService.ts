import { subscribe } from 'valtio/vanilla';
import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { SceneJournalService } from '@/services/project/SceneJournalService';
import { SceneWriteConflictError } from '@/services/project/write-errors';
import { readDiskVersion } from '@/services/project/disk/disk-version';
import { toProjectPath } from '@/services/project/disk/project-paths';
import { HostNoticeService } from '@/host/HostNoticeService';
import { HostService } from '@/host/HostService';
import { LocalizationService, setActiveLocalization, type LocaleTable } from '@pix3/runtime';
import type { LocalizationSettings } from '@/core/ProjectManifest';
import {
  diffLocaleTables,
  findClobberedLocaleKeys,
  mergeLocaleTables,
  recordLocaleWrite,
  type LocaleKeyRef,
  type LocaleLedger,
} from '@/core/locale-table-merge';

const LOCALES_DIR = 'locales';

/** Which half of a locale table an entry lives in: UI strings or localized sprite paths. */
export type LocaleTableSection = 'strings' | 'sprites';

/** How many keys a notice names before "and N more". */
const NOTICE_KEYS = 4;
/** A write refused because the disk moved is merged and retried at most this often. */
const MAX_WRITE_ATTEMPTS = 3;

/** The last disk version of a table the editor confirmed (read, followed or written). */
interface LocaleBaseline {
  readonly sha: string;
  readonly table: LocaleTable;
}

/** `locales/<id>.json` → `<id>`, else null. */
export function localeOfPath(path: string): string | null {
  const match = /^locales\/([^/]+)\.json$/i.exec(toProjectPath(path));
  return match ? match[1] : null;
}

/** Human-readable default names for common locale ids (used when a table has no `$meta.name`). */
const LOCALE_DISPLAY_NAMES: Record<string, string> = {
  en: 'English',
  ru: 'Русский',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
};

/**
 * Editor-side authoring layer for localization. Owns the **editor-preview**
 * {@link LocalizationService} (the active-localization pointer while editing, so
 * viewport label proxies resolve translations), loads `locales/*.json` at project
 * open, and exposes an authoring API (read/edit/save tables, switch preview
 * locale, missing-key diff). It mirrors UI-facing counters into
 * `appState.localization`; the actual tables stay here (state-vs-scene-graph
 * separation). All *undoable* mutations run through Commands/Operations that call
 * into this service — the service persists + feeds the preview + bumps `revision`.
 *
 * **The files are the truth** (`.plans/write-model.md` W20): every table has a baseline (the
 * last disk version the editor confirmed); a write is `If-Match` on it (`createOnly` for a new
 * file); a refused write and an external version (`ExternalReloadService`, after
 * `ExternalChangeService` settled it; a deletion straight from the `pix3:fs` frame) go through
 * the key-level merge of `locale-table-merge.ts` — the agent's keys come in, the editor's
 * unwritten edits of other keys stay and are written on top, a key both changed keeps the disk
 * value with a notice and the editor's table in the journal. Writes run one at a time.
 */
@injectable()
export class LocalizationEditorService {
  @inject(ProjectStorageService)
  private readonly storage!: ProjectStorageService;

  @inject(HostNoticeService)
  private readonly notices!: HostNoticeService;

  @inject(SceneJournalService)
  private readonly journal!: SceneJournalService;

  @inject(HostService)
  private readonly hostService!: HostService;

  private preview: LocalizationService | null = null;
  /** In-memory authoring tables keyed by locale id (source of truth while editing). */
  private readonly tables = new Map<string, LocaleTable>();
  private settings: LocalizationSettings | null = null;
  /** Identity of the project whose tables are currently loaded (guards re-loads). */
  private loadedProjectKey: string | null = null;
  private previewLocale = '';
  private disposeProjectSub?: () => void;
  private disposeFsSub?: () => void;
  private initialized = false;
  private readonly baselines = new Map<string, LocaleBaseline>();
  private readonly ledgers = new Map<string, LocaleLedger>();
  /** Writes and merges, one at a time (a merge must not race a write on the same baseline). */
  private queue: Promise<void> = Promise.resolve();
  private loading: Promise<void> = Promise.resolve();
  /** Listeners told which keys an external version changed (the panel's typing guard). */
  private readonly externalListeners = new Set<(locale: string, keys: LocaleKeyRef[]) => void>();

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.disposeProjectSub = subscribe(appState.project, () => {
      this.loading = this.syncFromProject();
    });
    if (HostService.isInstalled()) {
      // A deletion is final: it needs no settling, and ExternalChangeService does not deliver it.
      this.disposeFsSub = this.hostService.host.events.onFs(frame => {
        for (const event of frame.events) {
          if (event.kind !== 'file' || (event.op !== 'delete' && event.op !== 'rename')) continue;
          const gone = event.op === 'rename' ? (event.from ?? '') : event.path;
          const projectPath = this.hostService.projectPath(gone);
          if (projectPath !== null && localeOfPath(projectPath)) {
            void this.applyExternal(projectPath);
          }
        }
      });
    }
    this.loading = this.syncFromProject();
  }

  dispose(): void {
    this.disposeProjectSub?.();
    this.disposeProjectSub = undefined;
    this.disposeFsSub?.();
    this.disposeFsSub = undefined;
    this.baselines.clear();
    this.ledgers.clear();
    this.externalListeners.clear();
    setActiveLocalization(null);
    this.preview?.dispose();
    this.preview = null;
    this.tables.clear();
    this.settings = null;
    this.loadedProjectKey = null;
    this.previewLocale = '';
    this.initialized = false;
  }

  // ---- project lifecycle ---------------------------------------------------

  private projectKey(): string | null {
    const p = appState.project;
    return p.id ? `${p.backend}:${p.id}` : null;
  }

  /** (Re)load tables when a different project opens, or clear on close. */
  private async syncFromProject(): Promise<void> {
    const key = this.projectKey();
    if (key === this.loadedProjectKey) return;
    this.loadedProjectKey = key;

    // Reset state for the new (or absent) project.
    setActiveLocalization(null);
    this.preview?.dispose();
    this.preview = null;
    this.tables.clear();
    this.baselines.clear();
    this.ledgers.clear();
    this.settings = null;
    this.previewLocale = '';

    if (!key) {
      this.mirrorSlice();
      return;
    }

    try {
      await this.loadTables();
    } catch (error) {
      console.warn('[Localization] Failed to load project locales', error);
    }
    this.mirrorSlice();
  }

  /** Resolve the effective settings (manifest block, else auto-discovered from `locales/`). */
  private async resolveSettings(): Promise<LocalizationSettings | null> {
    const fromManifest = appState.project.manifest?.localization;
    if (fromManifest && fromManifest.locales.length > 0) {
      return fromManifest;
    }
    // Zero-config: discover `locales/*.json`. Empty ⇒ localization inert.
    const discovered = await this.discoverLocaleIds();
    if (discovered.length === 0) return null;
    const defaultLocale = discovered.includes('en') ? 'en' : discovered[0];
    return { defaultLocale, locales: discovered };
  }

  private async discoverLocaleIds(): Promise<string[]> {
    try {
      const entries = await this.storage.listDirectory(LOCALES_DIR);
      return entries
        .filter(e => e.kind === 'file' && e.name.toLowerCase().endsWith('.json'))
        .map(e => e.name.slice(0, -'.json'.length))
        .sort();
    } catch {
      return []; // no locales/ directory
    }
  }

  private async loadTables(): Promise<void> {
    const settings = await this.resolveSettings();
    this.settings = settings;
    if (!settings) return;

    for (const locale of settings.locales) {
      const { table, baseline } = await this.readTableFile(locale);
      this.tables.set(locale, table);
      if (baseline) this.baselines.set(locale, baseline);
    }

    // Build the preview instance from the loaded tables and activate it.
    const preview = this.ensurePreview();
    for (const table of this.tables.values()) {
      preview.setTable(table);
    }
    this.previewLocale = settings.defaultLocale;
    void preview.setLocale(settings.defaultLocale);
  }

  /**
   * Ensure the editor-preview {@link LocalizationService} exists and is the active
   * localization pointer (so viewport label proxies resolve translations). Built
   * lazily so authoring a first locale into a previously-inert project activates
   * the preview without a project reload.
   */
  private ensurePreview(): LocalizationService {
    if (!this.preview) {
      const preview = new LocalizationService();
      preview.configure({
        defaultLocale: this.settings?.defaultLocale ?? 'en',
        fallbackLocale: this.settings?.fallbackLocale,
        locales: this.settings?.locales,
      });
      this.preview = preview;
      if (!this.previewLocale) {
        this.previewLocale = this.settings?.defaultLocale ?? 'en';
      }
      setActiveLocalization(preview);
    }
    return this.preview;
  }

  private async readTableFile(
    locale: string
  ): Promise<{ table: LocaleTable; baseline: LocaleBaseline | null }> {
    try {
      const version = await readDiskVersion(this.storage, pathOf(locale));
      if (version) {
        const table = parseTableFile(locale, version.text);
        return { table, baseline: { sha: version.hash, table: cloneTable(table) } };
      }
    } catch {
      // broken file: below
    }
    // Missing/broken file ⇒ empty table (still declared; panel can populate it). No baseline:
    // a broken file is never written over (the first write is `createOnly`, and is refused).
    return { table: emptyTable(locale), baseline: null };
  }

  // ---- read API (panel / inspector widget) --------------------------------

  isActive(): boolean {
    return this.settings !== null;
  }

  getLocales(): string[] {
    return this.settings ? [...this.settings.locales] : [];
  }

  getDefaultLocale(): string {
    return this.settings?.defaultLocale ?? '';
  }

  getPreviewLocale(): string {
    return this.previewLocale;
  }

  /**
   * Effective runtime localization config (manifest block, else auto-discovered),
   * for injection into the play-mode SceneRunner. Null ⇒ localization inert.
   */
  getRuntimeConfig(): { defaultLocale: string; fallbackLocale?: string; locales: string[] } | null {
    if (!this.settings) return null;
    return {
      defaultLocale: this.settings.defaultLocale,
      ...(this.settings.fallbackLocale ? { fallbackLocale: this.settings.fallbackLocale } : {}),
      locales: [...this.settings.locales],
    };
  }

  getLocaleDisplayName(locale: string): string {
    return (
      this.tables.get(locale)?.meta?.name ?? LOCALE_DISPLAY_NAMES[locale] ?? locale.toUpperCase()
    );
  }

  /** Union of keys in `section` across all locales (default locale first), for autocomplete. */
  getAllKeys(section: LocaleTableSection = 'strings'): string[] {
    const keys = new Set<string>();
    const def = this.getDefaultLocale();
    for (const k of Object.keys(this.tables.get(def)?.[section] ?? {})) keys.add(k);
    for (const table of this.tables.values()) {
      for (const k of Object.keys(table[section])) keys.add(k);
    }
    return [...keys].sort();
  }

  getEntry(locale: string, key: string, section: LocaleTableSection = 'strings'): string {
    return this.tables.get(locale)?.[section][key] ?? '';
  }

  /** Whether `locale` records an entry for `key` — even an empty `""` placeholder
   *  (getEntry can't distinguish an absent key from a seeded placeholder). */
  hasEntry(locale: string, key: string, section: LocaleTableSection = 'strings'): boolean {
    return key in (this.tables.get(locale)?.[section] ?? {});
  }

  /** Whether a key resolves (current-or-fallback) in the preview locale — as a
   *  string or as a sprite path (the inspector widget serves both labelKey and
   *  textureKey properties, which share the `localization-key` editor hint). */
  keyResolvesInPreview(key: string): boolean {
    if (!this.preview) return false;
    return this.preview.has(key) || this.preview.trSprite(key) !== null;
  }

  /** The preview-locale translation of `key` (falls back to the key itself). */
  resolveInPreview(key: string): string {
    return this.preview?.tr(key) ?? key;
  }

  /** Keys present (non-empty) in the default locale but missing/empty in `locale`. */
  getMissing(locale: string, section: LocaleTableSection = 'strings'): string[] {
    const def = this.getDefaultLocale();
    if (!def || locale === def) return [];
    const defEntries = this.tables.get(def)?.[section] ?? {};
    const locEntries = this.tables.get(locale)?.[section] ?? {};
    return Object.keys(defEntries).filter(k => !(locEntries[k] ?? '').trim());
  }

  // ---- mutation API (called by Operations; persists + refreshes preview) ---

  /** Switch the editor preview locale. Returns a Promise (may load a table). */
  async setPreviewLocale(locale: string): Promise<void> {
    if (!this.preview || !this.settings) return;
    if (!this.settings.locales.includes(locale)) return;
    this.previewLocale = locale;
    await this.preview.setLocale(locale);
    this.mirrorSlice();
  }

  /** Set/clear a single entry (translation or sprite path). Persists the file and re-feeds the preview. */
  async setEntry(
    locale: string,
    key: string,
    value: string,
    section: LocaleTableSection = 'strings'
  ): Promise<void> {
    if (!key) return;
    const table = this.ensureTable(locale);
    if (value) {
      table[section][key] = value;
    } else {
      delete table[section][key];
    }
    this.preview?.setTable(table);
    await this.saveLocale(locale);
    this.mirrorSlice();
  }

  /** Remove a key from every locale. Returns the removed values for undo. */
  async removeKey(
    key: string,
    section: LocaleTableSection = 'strings'
  ): Promise<Record<string, string>> {
    const removed: Record<string, string> = {};
    for (const [locale, table] of this.tables) {
      if (key in table[section]) {
        removed[locale] = table[section][key];
        delete table[section][key];
        this.preview?.setTable(table);
        await this.saveLocale(locale);
      }
    }
    this.mirrorSlice();
    return removed;
  }

  /**
   * Move a key to a new name in every locale table that has it. Returns the moved
   * values per locale (for undo — renaming back restores them exactly), or null
   * when `oldKey` resolves nowhere or `newKey` is already taken in the section.
   * Symmetric: undo = `renameKey(newKey, oldKey, section)`.
   */
  async renameKey(
    oldKey: string,
    newKey: string,
    section: LocaleTableSection = 'strings'
  ): Promise<Record<string, string> | null> {
    if (!oldKey || !newKey || oldKey === newKey) return null;
    let found = false;
    for (const table of this.tables.values()) {
      if (oldKey in table[section]) found = true;
      if (newKey in table[section]) return null;
    }
    if (!found) return null;

    const moved: Record<string, string> = {};
    for (const [locale, table] of this.tables) {
      if (!(oldKey in table[section])) continue;
      moved[locale] = table[section][oldKey];
      delete table[section][oldKey];
      table[section][newKey] = moved[locale];
      this.preview?.setTable(table);
      await this.saveLocale(locale);
    }
    this.mirrorSlice();
    return moved;
  }

  /**
   * Seed keys missing from `locale` as `""` placeholders (extraction template
   * fill, design §4.5) so translators see the full key set. Returns the keys
   * actually seeded (already-present keys are left untouched) for undo.
   */
  async seedMissingKeys(
    locale: string,
    keys: string[],
    section: LocaleTableSection = 'strings'
  ): Promise<string[]> {
    const table = this.ensureTable(locale);
    const seeded = keys.filter(key => !(key in table[section]));
    if (seeded.length === 0) return [];
    for (const key of seeded) table[section][key] = '';
    this.preview?.setTable(table);
    await this.saveLocale(locale);
    this.mirrorSlice();
    return seeded;
  }

  /**
   * Remove previously seeded placeholder keys (undo of {@link seedMissingKeys}).
   * Entries the author has since filled in are kept.
   */
  async unseedKeys(
    locale: string,
    keys: string[],
    section: LocaleTableSection = 'strings'
  ): Promise<void> {
    const table = this.tables.get(locale);
    if (!table) return;
    let changed = false;
    for (const key of keys) {
      if (key in table[section] && table[section][key] === '') {
        delete table[section][key];
        changed = true;
      }
    }
    if (!changed) return;
    this.preview?.setTable(table);
    await this.saveLocale(locale);
    this.mirrorSlice();
  }

  /** Re-insert removed key values across locales (undo of {@link removeKey}). */
  async restoreKey(
    key: string,
    values: Record<string, string>,
    section: LocaleTableSection = 'strings'
  ): Promise<void> {
    for (const [locale, value] of Object.entries(values)) {
      const table = this.ensureTable(locale);
      table[section][key] = value;
      this.preview?.setTable(table);
      await this.saveLocale(locale);
    }
    this.mirrorSlice();
  }

  private ensureTable(locale: string): LocaleTable {
    let table = this.tables.get(locale);
    if (!table) {
      table = { locale, strings: {}, sprites: {} };
      this.tables.set(locale, table);
    }
    return table;
  }

  /** Write `locale`'s table if it differs from its baseline (queued; resolves once done). */
  private saveLocale(locale: string): Promise<void> {
    return this.enqueue(() => this.writeLocale(locale));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(error => console.error('[Localization]', error));
    return this.queue;
  }

  /**
   * Write every table with edits the disk does not have yet (sync step 0, with the scenes'
   * flush): an edit whose write failed without a conflict (the dev server was down) is retried.
   */
  async flush(): Promise<void> {
    await this.loading;
    for (const locale of this.tables.keys()) {
      if (this.hasUnwrittenEdits(locale)) void this.saveLocale(locale);
    }
    await this.queue;
  }

  /** Whether `locale` has edits its baseline (the disk the editor knows) does not. */
  hasUnwrittenEdits(locale: string): boolean {
    const table = this.tables.get(locale);
    if (!table) return false;
    return diffLocaleTables(this.baselineTable(locale), table).length > 0;
  }

  /** The table the disk has as far as the editor knows (no file = an empty table). */
  private baselineTable(locale: string): LocaleTable {
    return this.baselines.get(locale)?.table ?? emptyTable(locale);
  }

  private async writeLocale(locale: string): Promise<void> {
    const path = pathOf(locale);
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const table = this.tables.get(locale);
      if (!table) return;
      const base = this.baselines.get(locale) ?? null;
      if (!this.hasUnwrittenEdits(locale)) return;
      const written = cloneTable(table);
      try {
        // writeTextFile does not create parent dirs; ensure `locales/` exists first.
        if (!base) await this.storage.createDirectory(LOCALES_DIR);
        const sha = await this.storage.writeTextFile(
          path,
          serializeTableFile(written),
          base ? { baseHash: base.sha } : { createOnly: true }
        );
        this.ledgers.set(
          locale,
          recordLocaleWrite(
            this.ledgers.get(locale) ?? new Map(),
            this.baselineTable(locale),
            written
          )
        );
        this.baselines.set(locale, { sha, table: written });
        return;
      } catch (error) {
        if (!(error instanceof SceneWriteConflictError)) {
          // No answer, a read-only tab, …: the edit stays in memory and the next write or sync
          // retries it.
          console.error(`[Localization] Failed to save locale "${locale}"`, error);
          return;
        }
        // The disk moved since the baseline: take it in, keep the edits it did not touch, retry.
        const outcome = await this.followDisk(locale, false);
        if (outcome !== 'followed') return;
      }
    }
    console.error(`[Localization] ${path}: gave up writing after ${MAX_WRITE_ATTEMPTS} conflicts`);
  }

  // ---- external versions (plan §C.3 for a locale table) -------------------

  /**
   * Whatever is on disk now at `path` (a `locales/<id>.json`): a new table appears, a deleted one
   * goes, a changed one is merged key by key with the editor's unwritten edits.
   */
  async applyExternal(path: string): Promise<void> {
    const locale = localeOfPath(path);
    if (!locale || !this.initialized) return;
    await this.loading;
    if (this.loadedProjectKey === null) return;
    await this.enqueue(async () => {
      if ((await this.followDisk(locale, true)) === 'followed' && this.hasUnwrittenEdits(locale)) {
        await this.writeLocale(locale);
      }
    });
  }

  /** Called with the keys of a locale an external version changed (before the panel re-renders). */
  onExternalKeys(listener: (locale: string, keys: LocaleKeyRef[]) => void): () => void {
    this.externalListeners.add(listener);
    return () => this.externalListeners.delete(listener);
  }

  private async followDisk(
    locale: string,
    fromFrame: boolean
  ): Promise<'unchanged' | 'followed' | 'unreadable'> {
    const path = pathOf(locale);
    let version;
    try {
      version = await readDiskVersion(this.storage, path);
    } catch {
      version = null;
    }
    if (!version) {
      this.removeTable(locale);
      return 'followed';
    }
    const base = this.baselines.get(locale) ?? null;
    if (base?.sha === version.hash) return 'unchanged';
    let external: LocaleTable;
    try {
      external = parseTableFile(locale, version.text);
    } catch (error) {
      // The last good table stays; the version arrives again once it parses.
      console.warn(
        `[Localization] File not readable: ${path} (${error instanceof Error ? error.message : String(error)}). Keeping the last good version.`
      );
      return 'unreadable';
    }

    const local = this.tables.get(locale);
    if (!local) {
      if (!this.acceptsLocale(locale)) return 'unchanged';
      this.addTable(locale, external, { sha: version.hash, table: cloneTable(external) });
      return 'followed';
    }

    const before = cloneTable(local);
    const clobbered = findClobberedLocaleKeys(this.ledgers.get(locale) ?? new Map(), external);
    this.ledgers.delete(locale);
    const { merged, dropped } = mergeLocaleTables(this.baselineTable(locale), external, local);
    if (dropped.length > 0) {
      await this.journal.recordRejectedDraft(
        path,
        serializeTableFile(local),
        'editor table replaced by a merge with an external version'
      );
      const names = dropped.map(d => describeKey(d));
      this.notices.show({
        key: `locale-merge:${path}`,
        tone: 'warn',
        message: `${path} changed on disk while you were editing it: your change to ${dropped.length} key${dropped.length === 1 ? ' was' : 's was'} dropped, the disk value kept.`,
        detail:
          `${listNames(names)}. ` + (this.journal.available ? 'Your version is in History.' : ''),
      });
    }
    this.tables.set(locale, merged);
    this.baselines.set(locale, { sha: version.hash, table: cloneTable(external) });
    if (clobbered.length > 0 && fromFrame) this.offerRestore(locale, clobbered);
    const changed = diffLocaleTables(before, merged);
    for (const listener of [...this.externalListeners]) listener(locale, changed);
    this.preview?.setTable(merged);
    this.mirrorSlice();
    return 'followed';
  }

  /** "An agent overwrote your edit" — its file was written from a read older than the editor's write. */
  private offerRestore(
    locale: string,
    clobbered: ReadonlyArray<LocaleKeyRef & { readonly written: string | null }>
  ): void {
    const path = pathOf(locale);
    this.notices.show({
      key: `locale-clobber:${path}`,
      tone: 'warn',
      message: `An agent overwrote your edit in ${path}.`,
      detail: `${listNames(clobbered.map(describeKey))} — it wrote a file it read before you saved them.`,
      actions: [
        {
          label: 'Restore my edit',
          run: async () => {
            const table = this.ensureTable(locale);
            for (const { section, key, written } of clobbered) {
              if (written === null) delete table[section][key];
              else table[section][key] = written;
            }
            this.preview?.setTable(table);
            this.mirrorSlice();
            await this.saveLocale(locale);
          },
        },
      ],
    });
  }

  /** In a project that declares its locales (`pix3project.yaml`), only those have tables. */
  private acceptsLocale(locale: string): boolean {
    const declared = appState.project.manifest?.localization?.locales;
    return !declared || declared.length === 0 || declared.includes(locale);
  }

  private addTable(locale: string, table: LocaleTable, baseline: LocaleBaseline): void {
    this.tables.set(locale, table);
    this.baselines.set(locale, baseline);
    if (!this.settings) {
      this.settings = { defaultLocale: locale, locales: [locale] };
      this.previewLocale = locale;
    } else if (!this.settings.locales.includes(locale)) {
      const locales = [...this.settings.locales, locale].sort();
      const defaultLocale =
        locales.includes('en') && !this.isDeclared() ? 'en' : this.settings.defaultLocale;
      this.settings = { ...this.settings, defaultLocale, locales };
    }
    this.ensurePreview().setTable(table);
    void this.preview?.setLocale(this.previewLocale);
    this.mirrorSlice();
  }

  private removeTable(locale: string): void {
    const table = this.tables.get(locale);
    const hadEdits = this.hasUnwrittenEdits(locale) && this.baselines.has(locale);
    this.baselines.delete(locale);
    this.ledgers.delete(locale);
    if (!table) return;
    const path = pathOf(locale);
    if (hadEdits) {
      void this.journal.recordRejectedDraft(
        path,
        serializeTableFile(table),
        'editor table dropped: the file was deleted on disk'
      );
      this.notices.show({
        key: `locale-merge:${path}`,
        tone: 'warn',
        message: `${path} was deleted on disk while you were editing it.`,
        detail: this.journal.available ? 'Your version is in History.' : '',
      });
    }
    this.preview?.setTable(emptyTable(locale));
    if (this.isDeclared()) {
      // Still declared by the manifest: an empty table, as when the file is missing at load.
      this.tables.set(locale, emptyTable(locale));
    } else if (this.settings) {
      this.tables.delete(locale);
      const locales = this.settings.locales.filter(l => l !== locale);
      if (locales.length === 0) {
        this.settings = null;
        this.previewLocale = '';
        setActiveLocalization(null);
        this.preview?.dispose();
        this.preview = null;
      } else {
        const defaultLocale =
          this.settings.defaultLocale === locale
            ? locales.includes('en')
              ? 'en'
              : locales[0]
            : this.settings.defaultLocale;
        this.settings = { ...this.settings, defaultLocale, locales };
        if (this.previewLocale === locale) {
          this.previewLocale = defaultLocale;
          void this.preview?.setLocale(defaultLocale);
        }
      }
    }
    this.mirrorSlice();
  }

  private isDeclared(): boolean {
    return (appState.project.manifest?.localization?.locales.length ?? 0) > 0;
  }

  private mirrorSlice(): void {
    const slice = appState.localization;
    const locales = this.getLocales();
    const missingCounts: Record<string, number> = {};
    for (const locale of locales) {
      missingCounts[locale] = this.getMissing(locale).length;
    }
    slice.locales = locales;
    slice.defaultLocale = this.getDefaultLocale();
    slice.previewLocale = this.previewLocale;
    slice.missingCounts = missingCounts;
    slice.revision += 1;
  }
}

// ---- file (de)serialization -------------------------------------------------

const pathOf = (locale: string): string => `${LOCALES_DIR}/${locale}.json`;

const emptyTable = (locale: string): LocaleTable => ({ locale, strings: {}, sprites: {} });

function cloneTable(table: LocaleTable): LocaleTable {
  return {
    locale: table.locale,
    strings: { ...table.strings },
    sprites: { ...table.sprites },
    ...(table.meta ? { meta: { ...table.meta } } : {}),
  };
}

const describeKey = (ref: LocaleKeyRef): string =>
  ref.section === 'strings' ? ref.key : `${ref.key} (sprite)`;

const listNames = (names: readonly string[]): string =>
  `${names.slice(0, NOTICE_KEYS).join('; ')}${names.length > NOTICE_KEYS ? `; and ${names.length - NOTICE_KEYS} more` : ''}`;

/** Parse a `locales/<locale>.json` file into a runtime {@link LocaleTable}. */
function parseTableFile(locale: string, text: string): LocaleTable {
  const parsed = JSON.parse(text) as {
    $meta?: LocaleTable['meta'];
    meta?: LocaleTable['meta'];
    strings?: Record<string, unknown>;
    sprites?: Record<string, unknown>;
  };
  return {
    locale,
    strings: toStringRecord(parsed.strings),
    sprites: toStringRecord(parsed.sprites),
    meta: parsed.$meta ?? parsed.meta,
  };
}

/** Serialize a table to the on-disk format: `$meta` + sorted `strings`/`sprites`. */
function serializeTableFile(table: LocaleTable): string {
  const payload: Record<string, unknown> = {
    $meta: {
      locale: table.locale,
      name: table.meta?.name ?? LOCALE_DISPLAY_NAMES[table.locale] ?? table.locale.toUpperCase(),
      ...(table.meta?.direction ? { direction: table.meta.direction } : {}),
    },
    strings: sortRecord(table.strings),
    sprites: sortRecord(table.sprites),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}
