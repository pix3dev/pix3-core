import { ComponentBase, customElement, html, inject, state, subscribe } from '@/fw';
import { appState } from '@/state';
import type {
  ModelFeedback,
  ModelFeedbackMark,
  ModelJob,
  ModelPass,
  ModelPassMetrics,
  ModelPassParams,
} from '@/core/model-jobs-format';
import {
  FeedbackWriterLostError,
  ModelJobsService,
  newFeedbackId,
  type ModelJobSummary,
  type ModelJobsSnapshot,
} from '@/services/assets/ModelJobsService';
import { EditorTabService } from '@/services/editor/EditorTabService';
import { IconService, IconSize } from '@/services/editor/IconService';

import { burnMarks, withView, type AnnotationTool } from './sheet-annotator';
import './model-jobs-panel.ts.css';

type Verdict = ModelFeedback['verdict'];

/** A send in flight or failed: retried with the same entry, so the same `fid`. */
interface PendingSend {
  readonly jobId: string;
  readonly entry: ModelFeedback;
  readonly png: Uint8Array | null;
}

const METRICS: readonly (readonly [keyof ModelPassMetrics, string, number])[] = [
  ['silhouetteIoU', 'Silhouette IoU', 2],
  ['luminanceP50', 'Luminance p50', 2],
  ['nearBlack', 'Near black', 3],
  ['saturationMedian', 'Saturation median', 2],
  ['saturationRatio', 'Saturation ratio', 2],
  ['triangles', 'Triangles', 0],
  ['drawCalls', 'Draw calls', 0],
];

const TOOLS: readonly (readonly [AnnotationTool, string, string])[] = [
  ['rect', 'square', 'Rectangle'],
  ['point', 'crosshair', 'Point'],
  ['path', 'edit-3', 'Freehand'],
  ['arrow', 'arrow-up-right', 'Arrow'],
];

/** Ctrl/Cmd+Z → undo; Ctrl+Y or Ctrl/Cmd+Shift+Z → redo; else null. */
const markHistoryKey = (event: KeyboardEvent): 'undo' | 'redo' | null => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  return key === 'y' && !event.shiftKey ? 'redo' : null;
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (iso: string): string => timeFormat.format(new Date(iso));

const sameParams = (a: ModelPassParams, b: ModelPassParams): boolean =>
  (Object.keys(a) as (keyof ModelPassParams)[]).every(key => a[key] === b[key]);

const signed = (n: number, digits: number): string =>
  `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(digits)}`;

/** `running` / `waiting` (a `wait` before its `expiresAt`) / `wait-expired` / `done` / `failed`. */
const statusOf = (
  job: Pick<ModelJobSummary, 'status' | 'wait'>,
  now: number
): { readonly key: string; readonly label: string } => {
  if (job.status !== 'running')
    return { key: job.status, label: job.status === 'done' ? 'Done' : 'Failed' };
  if (!job.wait) return { key: 'running', label: 'Running' };
  return Date.parse(job.wait.expiresAt) > now
    ? { key: 'waiting', label: 'Waiting for you' }
    : { key: 'wait-expired', label: 'Wait expired' };
};

/**
 * Window → 3D Asset Generator (plan `.plans/model-jobs.md` Stage 2): the coding agent's model jobs
 * as they progress, and the human's answer to them. The list of jobs; the selected job's passes
 * (sheet thumbnail, stage, numbers, change against the previous pass when it was rendered the same
 * way); the selected pass's sheet large, with A/B against the previous pass; marks drawn on the
 * sheet (rect / point / freehand) with a comment and a verdict, sent as one line of
 * `feedback.jsonl` plus the sheet with the marks burned in; and what became of each entry
 * (delivered to the agent / addressed by a pass).
 *
 * Everything is read through {@link ModelJobsService}, which polls only while this panel is
 * visible. Sending is the one write, and only the writer tab may do it.
 */
@customElement('pix3-model-jobs-panel')
export class ModelJobsPanel extends ComponentBase {
  @inject(ModelJobsService)
  private readonly jobsService!: ModelJobsService;

  @inject(EditorTabService)
  private readonly editorTabs!: EditorTabService;

  @inject(IconService)
  private readonly icons!: IconService;

  @state() private snap: ModelJobsSnapshot | null = null;
  @state() private writer: 'self' | 'other' | 'none' = 'none';
  /** The pass on the big sheet; null follows the latest. */
  @state() private selectedSeq: number | null = null;
  /** B of the A/B: the previous pass's sheet instead of this one. */
  @state() private showPrevious = false;
  @state() private tool: AnnotationTool | null = 'rect';
  @state() private marks: ModelFeedbackMark[] = [];
  /** Marks undone since the last new one, most recent last (redo). */
  @state() private undone: ModelFeedbackMark[] = [];
  @state() private text = '';
  @state() private sending = false;
  @state() private sendError: string | null = null;

  private pending: PendingSend | null = null;
  private visible = false;
  private observer: IntersectionObserver | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposers: (() => void)[] = [];

  /** The marked PNG; a seam so specs need no canvas. */
  protected renderMarkedSheet = burnMarks;

  connectedCallback(): void {
    super.connectedCallback();
    this.snap = this.jobsService.snapshot();
    this.writer = appState.project.host.writer;
    this.scheduleExpiry();
    this.disposers.push(
      this.jobsService.subscribe(() => this.onSnapshot()),
      subscribe(appState.project.host, () => {
        this.writer = appState.project.host.writer;
      })
    );
    if (typeof IntersectionObserver === 'undefined') {
      this.setVisible(true);
    } else {
      this.observer = new IntersectionObserver(entries =>
        this.setVisible(entries.some(entry => entry.isIntersecting))
      );
      this.observer.observe(this);
    }
  }

  disconnectedCallback(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.observer?.disconnect();
    this.observer = null;
    this.setVisible(false);
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    super.disconnectedCallback();
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.jobsService.setPanelVisible(visible);
  }

  private onSnapshot(): void {
    const previous = this.snap;
    this.snap = this.jobsService.snapshot();
    if (previous?.selectedId !== this.snap.selectedId) this.resetPass();
    else if (
      this.selectedSeq !== null &&
      !this.snap.job?.passes.some(p => p.seq === this.selectedSeq)
    )
      this.resetPass();
    this.scheduleExpiry();
  }

  /** Re-render when the first live `wait` expires, so "Waiting for you" turns by itself. */
  private scheduleExpiry(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const now = Date.now();
    const next = Math.min(
      ...(this.snap?.jobs ?? [])
        .map(job => (job.wait ? Date.parse(job.wait.expiresAt) : Infinity))
        .filter(at => at > now)
    );
    if (Number.isFinite(next))
      this.expiryTimer = setTimeout(
        () => {
          this.requestUpdate();
          this.scheduleExpiry();
        },
        next - now + 50
      );
  }

  private resetPass(): void {
    this.selectedSeq = null;
    this.showPrevious = false;
    this.clearMarks();
  }

  private clearMarks(): void {
    this.marks = [];
    this.undone = [];
    this.pending = null;
  }

  // --- derived ---------------------------------------------------------------------------------

  private get job(): ModelJob | null {
    return this.snap?.job ?? null;
  }

  private get pass(): ModelPass | null {
    const passes = this.job?.passes ?? [];
    return (
      (this.selectedSeq === null ? null : passes.find(p => p.seq === this.selectedSeq)) ??
      passes.at(-1) ??
      null
    );
  }

  private previousOf(pass: ModelPass | null): ModelPass | null {
    const passes = this.job?.passes ?? [];
    const at = pass ? passes.indexOf(pass) : -1;
    return at > 0 ? passes[at - 1] : null;
  }

  private get canWrite(): boolean {
    return this.writer === 'self';
  }

  // --- actions ---------------------------------------------------------------------------------

  private selectJob(id: string): void {
    this.jobsService.select(id);
  }

  private selectPass(seq: number): void {
    if (this.pass?.seq === seq) return;
    this.selectedSeq = seq;
    this.showPrevious = false;
    this.clearMarks();
  }

  private addMark(mark: ModelFeedbackMark): void {
    const pass = this.pass;
    if (!pass || !this.canWrite) return;
    // Marks belong to this sheet: a pass that lands meanwhile must not take them over.
    this.selectedSeq = pass.seq;
    this.marks = [...this.marks, withView(pass.sheet, mark)];
    this.undone = [];
    this.pending = null;
  }

  private undoMark(): void {
    const last = this.marks.at(-1);
    if (!last || this.sending) return;
    this.marks = this.marks.slice(0, -1);
    this.undone = [...this.undone, last];
    this.pending = null;
  }

  private redoMark(): void {
    const next = this.undone.at(-1);
    if (!next || this.sending) return;
    this.undone = this.undone.slice(0, -1);
    this.marks = [...this.marks, next];
    this.pending = null;
  }

  /**
   * A press anywhere in the panel keeps the keyboard here (the sheet cancels the default focus of
   * its pointerdown), so Ctrl+Z after drawing reaches {@link onKeyDown}, not the viewport.
   */
  private onPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, button, a, [tabindex]:not(.model-jobs)')) return;
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
  }

  /**
   * Ctrl+Z / Ctrl+Y inside the panel undo and redo marks, never the scene: the event stops here,
   * before the shell's global keybindings on `window`. A text field keeps its own text undo.
   */
  private onKeyDown(event: KeyboardEvent): void {
    const action = markHistoryKey(event);
    if (!action) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'undo') this.undoMark();
    else this.redoMark();
  }

  private onText(event: Event): void {
    this.text = (event.target as HTMLTextAreaElement).value;
    this.pending = null;
  }

  private async openTarget(): Promise<void> {
    const job = this.job;
    if (job) await this.editorTabs.openResourceTab('scene', job.target);
  }

  /** Send / Accept / Needs changes: one entry, retried with the same id until it lands. */
  private async send(verdict: Verdict): Promise<void> {
    const job = this.job;
    if (!job || this.sending || !this.canWrite) return;
    // Everything the entry is made of is taken now; the draft is locked while it is in flight.
    const pass = this.pass;
    const marks = [...this.marks];
    const text = this.text.trim();
    this.sending = true;
    this.sendError = null;
    try {
      let sent = this.pending;
      if (!sent || sent.jobId !== job.id || sent.entry.verdict !== verdict) {
        const id = newFeedbackId();
        const src = pass ? this.snap?.images[pass.sheet.file] : undefined;
        const marked = marks.length > 0 && pass && src;
        const png = marked ? await this.renderMarkedSheet(src, pass.sheet, marks) : null;
        sent = {
          jobId: job.id,
          png,
          entry: {
            v: 1,
            id,
            at: new Date().toISOString(),
            pass: pass?.seq ?? null,
            text,
            verdict,
            marks: marked ? marks : [],
            ...(png ? { image: `feedback/${id}.png` } : {}),
          },
        };
        this.pending = sent;
      }
      await this.jobsService.sendFeedback(sent.jobId, sent.entry, sent.png);
      // Clear the draft only if it is still the one that was sent (not another job's or pass's).
      if (this.pending === sent) {
        this.pending = null;
        this.marks = [];
        this.text = '';
      }
    } catch (error) {
      this.sendError =
        error instanceof FeedbackWriterLostError
          ? `${error.message} Your draft is kept.`
          : `Not sent: ${error instanceof Error ? error.message : String(error)}. Your draft is kept.`;
    } finally {
      this.sending = false;
    }
  }

  // --- rendering -------------------------------------------------------------------------------

  protected render() {
    const snap = this.snap;
    return html`
      <section
        class="model-jobs"
        tabindex="-1"
        @keydown=${this.onKeyDown}
        @pointerdown=${this.onPointerDown}
      >
        <header class="mj-head">
          <span class="mj-head-title">
            ${this.icons.getIcon('box', IconSize.SMALL)}<span>3D Asset Generator</span>
          </span>
          <button
            type="button"
            class="mj-icon-btn"
            title="Refresh"
            aria-label="Refresh"
            @click=${() => this.jobsService.refresh()}
          >
            ${this.icons.getIcon('refresh-cw', IconSize.SMALL)}
          </button>
        </header>
        <div class="mj-body">
          ${snap?.pollError
            ? html`<p class="mj-error" role="alert">
                Cannot read the model jobs: ${snap.pollError}. Retrying.
              </p>`
            : null}
          ${snap?.indexError ? html`<p class="mj-error">${snap.indexError}</p>` : null}
          ${this.renderJobList()} ${this.renderJob()}
        </div>
      </section>
    `;
  }

  private renderJobList() {
    const jobs = this.snap?.jobs ?? [];
    if (jobs.length === 0)
      return html`<p class="mj-empty">
        No model jobs yet. The coding agent starts one with <code>pix3 model new</code>, and its
        passes show up here.
      </p>`;
    const now = Date.now();
    return html`
      <ul class="mj-jobs" aria-label="Model jobs">
        ${jobs.map(job => {
          const status = statusOf(job, now);
          const selected = job.id === this.snap?.selectedId;
          return html`<li>
            <button
              type="button"
              class="mj-job ${selected ? 'is-selected' : ''}"
              aria-pressed=${selected ? 'true' : 'false'}
              data-job-id=${job.id}
              @click=${() => this.selectJob(job.id)}
            >
              <span class="mj-job__title">${job.title}</span>
              <span class="mj-status mj-status--${status.key}">${status.label}</span>
              <span class="mj-job__meta">
                ${job.passes === 1 ? '1 pass' : `${job.passes} passes`}${job.stage
                  ? ` · ${job.stage}`
                  : ''}
                · ${when(job.updatedAt)}
              </span>
            </button>
          </li>`;
        })}
      </ul>
    `;
  }

  private renderJob() {
    const snap = this.snap;
    if (!snap?.selectedId) return null;
    if (snap.jobMissing)
      return html`<p class="mj-empty">
        Job <code>${snap.selectedId}</code> is not on disk (removed, or not written yet).
      </p>`;
    const job = snap.job;
    if (!job)
      return snap.jobError
        ? html`<p class="mj-error">${snap.jobError}</p>`
        : html`<p class="mj-empty">Reading…</p>`;
    const status = statusOf(job, Date.now());
    return html`
      <section class="mj-job-view" aria-label=${`Job ${job.title}`}>
        ${snap.jobError ? html`<p class="mj-error">${snap.jobError}</p>` : null}
        <div class="mj-job-head">
          <div class="mj-job-head__text">
            <h3 class="mj-job-head__title">${job.title}</h3>
            <span class="mj-target" title=${job.target}
              >${job.target}${job.node ? html` · node <code>${job.node}</code>` : null}</span
            >
          </div>
          <span class="mj-status mj-status--${status.key}">${status.label}</span>
          <button type="button" class="mj-btn" @click=${() => void this.openTarget()}>
            ${this.icons.getIcon('external-link', IconSize.SMALL)}<span>Open target</span>
          </button>
        </div>
        ${job.result ? html`<p class="mj-result">${job.result}</p>` : null}
        ${job.passes.length === 0
          ? html`<p class="mj-empty">
              No passes yet: the first is rendered with
              <code>pix3 render --job ${job.id} --stage ${job.stages[0]}</code>.
            </p>`
          : html`${this.renderPassStrip(job)} ${this.renderPassDetails()} ${this.renderSheet()}`}
        ${this.renderComposer()} ${this.renderFeedback(job)}
      </section>
    `;
  }

  private renderPassStrip(job: ModelJob) {
    const current = this.pass;
    return html`
      <ol class="mj-passes" aria-label="Passes">
        ${job.passes.map(pass => {
          const src = this.snap?.images[pass.sheet.file];
          const iou = pass.metrics.silhouetteIoU;
          return html`<li>
            <button
              type="button"
              class="mj-pass ${pass === current ? 'is-selected' : ''}"
              aria-pressed=${pass === current ? 'true' : 'false'}
              data-seq=${pass.seq}
              title=${pass.note ?? `Pass ${pass.seq}`}
              @click=${() => this.selectPass(pass.seq)}
            >
              <span class="mj-pass__thumb">
                ${src ? html`<img src=${src} alt="" draggable="false" />` : null}
              </span>
              <span class="mj-pass__label">
                <span class="mj-pass__seq">#${pass.seq}</span> ${pass.stage}
                ${pass.forced
                  ? html`<span
                      class="mj-pass__forced"
                      title=${`Stage order bypassed: ${pass.forced}`}
                      aria-label="Stage order bypassed"
                      >${this.icons.getIcon('alert-triangle', 12)}</span
                    >`
                  : null}
              </span>
              <span class="mj-pass__metric">
                ${pass.metrics.notCompared
                  ? 'not compared'
                  : iou !== undefined
                    ? `IoU ${iou.toFixed(2)}`
                    : ''}
              </span>
            </button>
          </li>`;
        })}
      </ol>
    `;
  }

  private renderPassDetails() {
    const pass = this.pass;
    if (!pass) return null;
    const previous = this.previousOf(pass);
    const comparable = previous !== null && sameParams(pass.params, previous.params);
    const rows = METRICS.filter(([key]) => pass.metrics[key] !== undefined);
    return html`
      <div class="mj-pass-details">
        <div class="mj-pass-details__head">
          <strong>Pass ${pass.seq} · ${pass.stage}</strong>
          <span class="mj-dim">${when(pass.at)}</span>
        </div>
        ${pass.note ? html`<p class="mj-note">${pass.note}</p>` : null}
        ${pass.forced
          ? html`<p class="mj-forced">
              ${this.icons.getIcon('alert-triangle', 12)}<span
                >Stage order bypassed: ${pass.forced}</span
              >
            </p>`
          : null}
        ${pass.metrics.notCompared
          ? html`<p class="mj-not-compared">Not compared: ${pass.metrics.notCompared}</p>`
          : null}
        ${rows.length
          ? html`<dl class="mj-metrics">
              ${rows.map(([key, label, digits]) => {
                const value = pass.metrics[key] as number | null;
                const before = comparable
                  ? (previous.metrics[key] as number | null | undefined)
                  : undefined;
                const delta =
                  typeof value === 'number' && typeof before === 'number' ? value - before : null;
                return html`<div class="mj-metric" data-metric=${key}>
                  <dt>${label}</dt>
                  <dd>
                    ${value === null ? '—' : value.toFixed(digits)}
                    ${delta !== null
                      ? html`<span class="mj-delta">${signed(delta, digits)}</span>`
                      : null}
                  </dd>
                </div>`;
              })}
            </dl>`
          : null}
        ${previous && !comparable
          ? html`<p class="mj-dim mj-no-delta">
              No change shown: pass ${previous.seq} was rendered under other conditions.
            </p>`
          : null}
      </div>
    `;
  }

  private renderSheet() {
    const pass = this.pass;
    if (!pass) return null;
    const previous = this.previousOf(pass);
    const shown = this.showPrevious && previous ? previous : pass;
    const src = this.snap?.images[shown.sheet.file];
    const drawing = this.canWrite && !this.sending && shown === pass;
    return html`
      <div class="mj-sheet">
        <div class="mj-sheet__bar">
          <div class="mj-segment" role="group" aria-label="Compare with the previous pass">
            <button
              type="button"
              aria-pressed=${shown === pass ? 'true' : 'false'}
              class="mj-segment__btn"
              @click=${() => (this.showPrevious = false)}
            >
              A · #${pass.seq}
            </button>
            <button
              type="button"
              aria-pressed=${shown !== pass ? 'true' : 'false'}
              class="mj-segment__btn"
              ?disabled=${!previous}
              title=${previous ? `Previous pass #${previous.seq}` : 'No previous pass'}
              @click=${() => (this.showPrevious = true)}
            >
              B · ${previous ? `#${previous.seq}` : '—'}
            </button>
          </div>
          <span class="mj-sheet__spacer"></span>
          ${TOOLS.map(
            ([tool, icon, label]) =>
              html`<button
                type="button"
                class="mj-icon-btn ${this.tool === tool ? 'is-active' : ''}"
                aria-pressed=${this.tool === tool ? 'true' : 'false'}
                title=${label}
                aria-label=${label}
                ?disabled=${!drawing}
                data-tool=${tool}
                @click=${() => (this.tool = tool)}
              >
                ${this.icons.getIcon(icon, IconSize.SMALL)}
              </button>`
          )}
          <button
            type="button"
            class="mj-icon-btn"
            title="Undo mark (Ctrl+Z)"
            aria-label="Undo mark"
            ?disabled=${!drawing || this.marks.length === 0}
            @click=${() => this.undoMark()}
          >
            ${this.icons.getIcon('corner-up-left', IconSize.SMALL)}
          </button>
          <button
            type="button"
            class="mj-icon-btn"
            title="Redo mark (Ctrl+Y)"
            aria-label="Redo mark"
            ?disabled=${!drawing || this.undone.length === 0}
            @click=${() => this.redoMark()}
          >
            ${this.icons.getIcon('corner-up-right', IconSize.SMALL)}
          </button>
        </div>
        ${src
          ? html`<pix3-sheet-annotator
              .src=${src}
              .sheet=${shown.sheet}
              .marks=${shown === pass ? this.marks : []}
              .tool=${drawing ? this.tool : null}
              .label=${`Pass ${shown.seq} sheet`}
              @mark-add=${(event: CustomEvent<ModelFeedbackMark>) => this.addMark(event.detail)}
            ></pix3-sheet-annotator>`
          : html`<p class="mj-empty">Loading the sheet…</p>`}
        ${shown !== pass
          ? html`<p class="mj-dim">Showing pass ${shown.seq}; switch to A to draw marks.</p>`
          : html`<p class="mj-dim">
              The first tile is the reference.
              ${this.marks.length
                ? `${this.marks.length} mark${this.marks.length === 1 ? '' : 's'}: ${this.marks.map(m => m.view).join(', ')}`
                : ''}
            </p>`}
      </div>
    `;
  }

  private renderComposer() {
    const disabled = !this.canWrite || this.sending;
    const hasContent = this.text.trim().length > 0 || this.marks.length > 0;
    return html`
      <div class="mj-composer">
        ${this.canWrite
          ? null
          : html`<p class="mj-readonly">
              ${this.icons.getIcon('lock', 12)}<span
                >${this.writer === 'other'
                  ? 'Another editor tab holds writing to this project. Take over in that banner to send feedback from here.'
                  : 'This tab cannot write to the project yet, so feedback cannot be sent.'}</span
              >
            </p>`}
        <textarea
          class="mj-text"
          rows="3"
          aria-label="Comment for the agent"
          placeholder="What should change? Marks on the sheet go with it."
          .value=${this.text}
          ?disabled=${!this.canWrite || this.sending}
          @input=${this.onText}
        ></textarea>
        ${this.sendError ? html`<p class="mj-error" role="alert">${this.sendError}</p>` : null}
        <div class="mj-actions">
          <button
            type="button"
            class="mj-btn mj-btn--primary"
            data-action="send"
            ?disabled=${disabled || !hasContent}
            @click=${() => void this.send(null)}
          >
            ${this.icons.getIcon('send', IconSize.SMALL)}<span>Send</span>
          </button>
          <button
            type="button"
            class="mj-btn"
            data-action="accept"
            ?disabled=${disabled}
            @click=${() => void this.send('accept')}
          >
            ${this.icons.getIcon('check', IconSize.SMALL)}<span>Accept</span>
          </button>
          <button
            type="button"
            class="mj-btn"
            data-action="changes"
            ?disabled=${disabled}
            @click=${() => void this.send('changes')}
          >
            ${this.icons.getIcon('alert-circle', IconSize.SMALL)}<span>Needs changes</span>
          </button>
        </div>
      </div>
    `;
  }

  private renderFeedback(job: ModelJob) {
    const entries = [...(this.snap?.feedback ?? [])].reverse();
    if (entries.length === 0) return null;
    return html`
      <h4 class="mj-section">Feedback</h4>
      <ol class="mj-feedback" aria-label="Feedback">
        ${entries.map(entry => {
          const state = job.feedback[entry.id];
          const delivery = !state
            ? { key: 'pending', label: 'Not delivered yet' }
            : state.addressedBy === null
              ? { key: 'delivered', label: 'Delivered' }
              : { key: 'addressed', label: `Addressed in pass ${state.addressedBy}` };
          return html`<li class="mj-feedback__item" data-feedback-id=${entry.id}>
            <div class="mj-feedback__head">
              <span class="mj-dim"
                >${when(entry.at)}${entry.pass ? ` · pass ${entry.pass}` : ''}</span
              >
              ${entry.verdict
                ? html`<span class="mj-verdict mj-verdict--${entry.verdict}"
                    >${entry.verdict === 'accept' ? 'Accepted' : 'Needs changes'}</span
                  >`
                : null}
              <span class="mj-delivery mj-delivery--${delivery.key}">${delivery.label}</span>
            </div>
            ${entry.text ? html`<p class="mj-feedback__text">${entry.text}</p>` : null}
            ${entry.marks.length
              ? html`<p class="mj-dim">
                  ${entry.marks.length} mark${entry.marks.length === 1 ? '' : 's'}:
                  ${entry.marks.map(m => `${m.view} ${m.shape}`).join(', ')}
                </p>`
              : null}
          </li>`;
        })}
      </ol>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pix3-model-jobs-panel': ModelJobsPanel;
  }
}
