import { inject, injectable } from '@/fw/di';
import { hostFailureOf, type EditorHost } from '@/host/EditorHost';
import { HostService } from '@/host/HostService';
import {
  MODEL_JOBS_DIR,
  parseModelFeedback,
  parseModelJob,
  parseModelJobIndex,
  type ModelFeedback,
  type ModelJob,
  type ModelJobIndex,
} from '@/core/model-jobs-format';

/** One row of `index.json`. */
export type ModelJobSummary = ModelJobIndex['jobs'][number];

/** What the 3D Asset Generator panel draws: the last good read of every file it follows. */
export interface ModelJobsSnapshot {
  /** `index.json`'s jobs; empty when there is no index yet. */
  readonly jobs: readonly ModelJobSummary[];
  /** `index.json` exists but does not validate. */
  readonly indexError: string | null;
  readonly selectedId: string | null;
  /** The selected job, or null before its first read / when it is gone. */
  readonly job: ModelJob | null;
  /** The selected job's `job.json` is not on disk (deleted, or the index is ahead of it). */
  readonly jobMissing: boolean;
  /** `job.json` does not validate (the last good read stays in `job`). */
  readonly jobError: string | null;
  /** `feedback.jsonl`'s well-formed entries, oldest first, first of a repeated id wins. */
  readonly feedback: readonly ModelFeedback[];
  /** Job-relative sheet path (`passes/03-form/sheet.png`) → blob URL. */
  readonly images: Readonly<Record<string, string>>;
  /** The last poll failed (the dev server is gone, …); polling backs off until one succeeds. */
  readonly pollError: string | null;
}

/** The send cannot finish here: another tab holds writing. The draft stays; nothing retries. */
export class FeedbackWriterLostError extends Error {
  constructor() {
    super('Another editor tab took over writing; the feedback was not sent.');
  }
}

const POLL_MS = 1500;
const MAX_BACKOFF_MS = 30_000;
const APPEND_ATTEMPTS = 5;

const INDEX = `${MODEL_JOBS_DIR}/index.json`;
const jobFile = (id: string, path: string): string => `${MODEL_JOBS_DIR}/${id}/${path}`;

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** `f-<ms>-<rand>`: made once per send and reused by every retry of it. */
export const newFeedbackId = (now = Date.now()): string =>
  `f-${now}-${Math.random().toString(36).slice(2, 8).padEnd(4, '0')}`;

/** `feedback.jsonl` text → entries (first of a repeated id wins); broken lines are skipped. */
const parseFeedbackLines = (text: string): ModelFeedback[] => {
  const seen = new Set<string>();
  const entries: ModelFeedback[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseModelFeedback(line);
    if ('error' in entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
};

/** True when the line's `id` is `fid`, whether or not the rest of it validates. */
const lineHasId = (line: string, fid: string): boolean => {
  try {
    return (JSON.parse(line) as { id?: unknown }).id === fid;
  } catch {
    return false;
  }
};

/**
 * Model jobs (`.pix3/model-jobs/`, plan `.plans/model-jobs.md` Stage 2) for the 3D Asset Generator
 * panel: reads through the host's file API (`.pix3/` is neither served statically nor in
 * `pix3:fs`), so it polls.
 *
 * **Polling.** While at least one panel is visible and the document is not hidden, one loop runs:
 * a tick `head`s `index.json` and the selected job's `job.json` + `feedback.jsonl`, reads only what
 * changed, then schedules the next tick 1.5 s after it ends (never two at once). A failed tick
 * doubles the delay up to 30 s; a good one resets it. Selecting another job bumps a generation
 * counter, and every await in a tick checks it, so a late answer for the previous job is dropped.
 * A job that is gone, or listed by the index before its `job.json` exists, is a state, not an
 * error. Images are blob URLs, revoked when the selection changes or the service is disposed.
 *
 * **Sending feedback** ({@link ModelJobsService.sendFeedback}, plan "Запись панели"): the PNG
 * first, `createOnly` (`exists` on a retry is success); then the line, appended to
 * `feedback.jsonl` with `If-Match` of the read (`createOnly` for the first line), skipped when the
 * id is already there, re-read and retried on `base_mismatch`. Losing the writer stops it.
 */
@injectable()
export class ModelJobsService {
  @inject(HostService)
  private readonly hostService!: HostService;

  private jobs: readonly ModelJobSummary[] = [];
  private indexError: string | null = null;
  private selectedId: string | null = null;
  private job: ModelJob | null = null;
  private jobMissing = false;
  private jobError: string | null = null;
  private feedback: readonly ModelFeedback[] = [];
  private images: Record<string, string> = {};
  private pollError: string | null = null;

  /** sha256 of the last read of each followed file (`null` = absent), to read only on change. */
  private indexSha: string | null | undefined;
  private jobSha: string | null | undefined;
  private feedbackSha: string | null | undefined;

  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private visiblePanels = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private tickAgain = false;
  private failures = 0;
  private visibilityListening = false;

  private readonly onVisibility = (): void => this.schedule(0);

  snapshot(): ModelJobsSnapshot {
    return {
      jobs: this.jobs,
      indexError: this.indexError,
      selectedId: this.selectedId,
      job: this.job,
      jobMissing: this.jobMissing,
      jobError: this.jobError,
      feedback: this.feedback,
      images: { ...this.images },
      pollError: this.pollError,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A panel became visible (`true`) or hidden / removed (`false`). Polling runs while the count
   * is above zero; each `true` must be matched by one `false`.
   */
  setPanelVisible(visible: boolean): void {
    this.visiblePanels = Math.max(0, this.visiblePanels + (visible ? 1 : -1));
    if (this.visiblePanels > 0 && !this.visibilityListening && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
      this.visibilityListening = true;
    }
    if (this.visiblePanels === 0) this.stopListening();
    this.schedule(0);
  }

  /** Follow another job (or none). Late answers for the previous one are dropped. */
  select(id: string | null): void {
    if (id === this.selectedId) return;
    this.generation += 1;
    this.selectedId = id;
    this.job = null;
    this.jobMissing = false;
    this.jobError = null;
    this.feedback = [];
    this.jobSha = undefined;
    this.feedbackSha = undefined;
    this.revokeImages();
    this.emit();
    this.refresh();
  }

  /** Poll now (after a send, or when the panel shows). */
  refresh(): void {
    this.schedule(0);
  }

  /**
   * Append one feedback entry to its job (plan "Запись панели"); `png` is the sheet with the marks
   * drawn, written first as `entry.image`. Idempotent for one `entry.id`: call it again with the
   * same entry after any failure. Rejects with {@link FeedbackWriterLostError} when this tab is no
   * longer the writer.
   */
  async sendFeedback(jobId: string, entry: ModelFeedback, png: Uint8Array | null): Promise<void> {
    const files = this.host.files;
    const guard = <T>(work: Promise<T>, accept: string): Promise<T | null> =>
      work.catch(error => {
        const code = hostFailureOf(error)?.code;
        if (code === 'writer_superseded') throw new FeedbackWriterLostError();
        if (code === accept) return null;
        throw error;
      });

    if (png && entry.image)
      await guard(files.write(jobFile(jobId, entry.image), png, { createOnly: true }), 'exists');

    const path = jobFile(jobId, 'feedback.jsonl');
    const line = `${JSON.stringify(entry)}\n`;
    const appendOnce = async (): Promise<boolean> => {
      const read = await files.read(path);
      if (read === null)
        return (await guard(files.write(path, line, { createOnly: true }), 'exists')) !== null;
      const text = decode(read.bytes);
      if (text.split('\n').some(existing => lineHasId(existing, entry.id))) return true;
      const separator = text === '' || text.endsWith('\n') ? '' : '\n';
      const write = files.write(path, `${text}${separator}${line}`, { ifMatch: read.sha256 });
      return (await guard(write, 'base_mismatch')) !== null;
    };
    for (let attempt = 0; ; attempt += 1) {
      if (await appendOnce()) break;
      if (attempt === APPEND_ATTEMPTS - 1)
        throw new Error('feedback.jsonl kept changing while sending; try again.');
    }
    this.refresh();
  }

  dispose(): void {
    this.stopListening();
    this.visiblePanels = 0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.generation += 1;
    this.revokeImages();
    this.listeners.clear();
  }

  // --- polling -----------------------------------------------------------------------------------

  private get host(): EditorHost {
    return this.hostService.host;
  }

  private get polling(): boolean {
    return (
      this.visiblePanels > 0 &&
      HostService.isInstalled() &&
      !(typeof document !== 'undefined' && document.visibilityState === 'hidden')
    );
  }

  private stopListening(): void {
    if (!this.visibilityListening) return;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.visibilityListening = false;
  }

  private schedule(delay: number): void {
    if (this.ticking) {
      this.tickAgain = this.tickAgain || delay === 0;
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.polling) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (!this.polling) return;
    this.ticking = true;
    try {
      await this.poll();
      this.failures = 0;
      if (this.pollError !== null) {
        this.pollError = null;
        this.emit();
      }
    } catch (error) {
      this.failures += 1;
      this.pollError = error instanceof Error ? error.message : String(error);
      this.emit();
    } finally {
      this.ticking = false;
      const again = this.tickAgain;
      this.tickAgain = false;
      this.schedule(again ? 0 : Math.min(POLL_MS * 2 ** this.failures, MAX_BACKOFF_MS));
    }
  }

  private async poll(): Promise<void> {
    const files = this.host.files;
    const generation = this.generation;
    const stale = (): boolean => generation !== this.generation;

    const indexHead = await files.head(INDEX);
    if ((indexHead?.sha256 ?? null) !== this.indexSha) {
      const read = indexHead ? await files.read(INDEX) : null;
      this.indexSha = read?.sha256 ?? null;
      const parsed = read ? parseModelJobIndex(decode(read.bytes)) : { v: 1 as const, jobs: [] };
      if ('error' in parsed) this.indexError = `index.json: ${parsed.error}`;
      else {
        this.indexError = null;
        this.jobs = [...parsed.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
      this.emit();
    }
    if (stale()) return;
    if (this.selectedId === null) {
      if (this.jobs.length > 0) this.select(this.jobs[0].id);
      return;
    }

    const id = this.selectedId;
    const jobPath = jobFile(id, 'job.json');
    const jobHead = await files.head(jobPath);
    if (stale()) return;
    if ((jobHead?.sha256 ?? null) !== this.jobSha) {
      const read = jobHead ? await files.read(jobPath) : null;
      if (stale()) return;
      this.jobSha = read?.sha256 ?? null;
      this.jobMissing = read === null;
      if (read === null) {
        this.job = null;
        this.jobError = null;
      } else {
        const parsed = parseModelJob(decode(read.bytes));
        if ('error' in parsed) this.jobError = `job.json: ${parsed.error}`;
        else {
          this.job = parsed;
          this.jobError = null;
        }
      }
      this.emit();
    }

    const feedbackPath = jobFile(id, 'feedback.jsonl');
    const feedbackHead = await files.head(feedbackPath);
    if (stale()) return;
    if ((feedbackHead?.sha256 ?? null) !== this.feedbackSha) {
      const read = feedbackHead ? await files.read(feedbackPath) : null;
      if (stale()) return;
      this.feedbackSha = read?.sha256 ?? null;
      this.feedback = read ? parseFeedbackLines(decode(read.bytes)) : [];
      this.emit();
    }

    if (this.job) await this.loadImages(id, this.job, stale);
  }

  /** Blob URLs for every pass's sheet (immutable files, read once; the reference is its first tile). */
  private async loadImages(id: string, job: ModelJob, stale: () => boolean): Promise<void> {
    const wanted = job.passes.map(pass => pass.sheet.file).filter(path => !(path in this.images));
    for (const path of wanted) {
      const read = await this.host.files.read(jobFile(id, path));
      if (stale()) return;
      if (!read) continue; // not written yet: the next poll looks again
      const type = IMAGE_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png';
      this.images[path] = URL.createObjectURL(new Blob([read.bytes as BlobPart], { type }));
      this.emit();
    }
  }

  private revokeImages(): void {
    for (const url of Object.values(this.images)) URL.revokeObjectURL(url);
    this.images = {};
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
