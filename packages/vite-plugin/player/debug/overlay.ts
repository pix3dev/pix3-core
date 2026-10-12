import { openEditor } from '../dev/editor-link';
import { LONG_FRAME_MS, type FrameRing } from './frame-stats';
import type { DebugSession, DebugSnapshot } from './session';

/**
 * The debug overlay's DOM: a panel over the game's top-right corner, in a shadow root so the
 * game's CSS cannot reach it (and its CSS cannot reach the game). The chart repaints at 8 Hz and
 * the text at 2 Hz (each text refresh closes an averaging window), from timers rather than the game's frame listener, so a slow page shows a
 * slow overlay instead of a slower game.
 */

const CHART_MS = 125;
const TEXT_EVERY = 4;
const CHART_CEILING_MS = 50;
const COLLAPSED_KEY = 'pix3:debug:collapsed';

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed; top: 8px; right: 8px; z-index: 2147483647;
  width: min(320px, calc(100vw - 16px)); max-height: calc(100vh - 16px);
  overflow: hidden auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.25) transparent;
  box-sizing: border-box; padding: 8px 10px;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #e8e8e8; background: rgba(18, 18, 20, 0.88); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
  user-select: text;
}
.panel.collapsed { width: auto; }
.panel.collapsed .body { display: none; }
header { display: flex; align-items: center; gap: 6px; }
.title { font-weight: 600; color: #ffcf33; margin-right: auto; white-space: nowrap; }
.fps { font-weight: 600; min-width: 4.5em; text-align: right; white-space: nowrap; }
button {
  font: inherit; color: inherit; background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.16); border-radius: 4px; padding: 1px 7px; cursor: pointer;
}
button:hover:not(:disabled) { background: rgba(255,255,255,0.16); }
button:disabled { opacity: 0.4; cursor: default; }
button[aria-pressed="true"] { background: rgba(255,207,51,0.25); border-color: #ffcf33; }
canvas { display: block; width: 100%; height: 64px; margin-top: 6px; }
.legend { display: flex; flex-wrap: wrap; gap: 2px 10px; color: #a0a0a0; margin-top: 2px; }
.legend > span { white-space: nowrap; }
.legend i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; vertical-align: -1px; }
section { margin-top: 8px; }
h3 { all: unset; display: block; color: #a0a0a0; text-transform: uppercase; font-size: 10px;
  letter-spacing: 0.06em; border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 3px; }
.row { display: flex; justify-content: space-between; gap: 8px; }
.row > :first-child { min-width: 0; color: #a0a0a0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row > :last-child { flex: none; max-width: 70%; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.warn { color: #ffb454; }
.bad { color: #ff6b6b; }
.muted { color: #707070; }
.error { color: #ff6b6b; word-break: break-word; margin-top: 2px; }
.error small { display: block; color: #a0a0a0; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
`;

const COLORS = {
  logic: '#ffcf33',
  render: '#4ea1ff',
  other: 'rgba(255,255,255,0.22)',
  grid: 'rgba(255,255,255,0.18)',
  over: '#ff6b6b',
};

const ms = (value: number | null, digits = 1): string =>
  value === null ? '–' : `${value.toFixed(digits)} ms`;
const num = (value: number | null | undefined): string =>
  value === null || value === undefined ? '–' : value.toLocaleString('en-US');
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const row = (label: string, value: string, cls = ''): string =>
  `<div class="row"><span>${escapeHtml(label)}</span><span class="${cls}">${value}</span></div>`;
const section = (title: string, body: string): string =>
  `<section><h3>${escapeHtml(title)}</h3>${body}</section>`;

const readCollapsed = (): boolean => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};

const writeCollapsed = (collapsed: boolean): void => {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Per-viewer convenience only.
  }
};

export class DebugOverlay {
  private readonly host = document.createElement('div');
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly fps: HTMLElement;
  private readonly sections: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly stepButton: HTMLButtonElement;
  private readonly collapseButton: HTMLButtonElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;

  constructor(
    private readonly session: DebugSession,
    private readonly editorUrl: string | null = null
  ) {
    this.host.className = 'pix3-debug-overlay';
    const root = this.host.attachShadow({ mode: 'open' });
    this.root = root;
    root.innerHTML = `<style>${STYLE}</style>
<div class="panel" part="panel">
  <header>
    <span class="title">Pix3 debug</span>
    <span class="fps">– fps</span>
    <button type="button" data-action="pause" aria-pressed="false" title="Freeze the game (manual time mode)">Pause</button>
    <button type="button" data-action="step" title="Advance one frame while paused" disabled>Step</button>
    ${editorUrl ? '<button type="button" data-action="editor" title="Open this project in the Pix3 editor">Editor</button>' : ''}
    <button type="button" data-action="collapse" title="Collapse">Hide</button>
  </header>
  <div class="body">
    <canvas></canvas>
    <div class="legend"><span><i style="background:${COLORS.logic}"></i>logic</span><span><i style="background:${COLORS.render}"></i>render</span><span><i style="background:${COLORS.other}"></i>other</span><span class="muted">lines: 16.7 / 33.3 ms</span></div>
    <div class="sections"></div>
    <section><button type="button" data-action="reset" title="Reset percentiles, long frames and the program count">Reset stats</button></section>
  </div>
</div>`;
    const pick = <T extends Element>(selector: string): T => root.querySelector(selector) as T;
    this.panel = pick('.panel');
    this.canvas = pick('canvas');
    this.fps = pick('.fps');
    this.sections = pick('.sections');
    this.pauseButton = pick('[data-action="pause"]');
    this.stepButton = pick('[data-action="step"]');
    this.collapseButton = pick('[data-action="collapse"]');
    root.addEventListener('click', this.onClick);
    // Keep the game's own listeners (a tap-to-jump on `window`) out of the panel's clicks.
    for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'keydown']) {
      this.panel.addEventListener(type, event => event.stopPropagation());
    }
    this.setCollapsed(readCollapsed());
  }

  mount(): void {
    document.body.appendChild(this.host);
    this.render();
    this.timer = setInterval(() => this.tick(), CHART_MS);
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.host.remove();
  }

  /** The timer: the chart every tick; every {@link TEXT_EVERY}th, a new window and the text. */
  private tick(): void {
    this.ticks += 1;
    const withText = this.ticks % TEXT_EVERY === 0;
    // Only the timer closes windows: a click must not cut one short (an empty window reads "–").
    if (withText) this.session.rollWindow();
    if (!this.panel.classList.contains('collapsed')) drawChart(this.canvas, this.session.ring);
    if (withText) this.render();
  }

  private render(): void {
    const snapshot = this.session.snapshot();
    this.renderHeader(snapshot);
    if (this.panel.classList.contains('collapsed')) return;
    drawChart(this.canvas, this.session.ring);
    this.sections.innerHTML = renderSections(snapshot);
  }

  private renderHeader(snapshot: DebugSnapshot): void {
    const fps = snapshot.window.fps;
    this.fps.textContent = snapshot.paused
      ? 'paused'
      : fps === null
        ? '– fps'
        : `${fps.toFixed(0)} fps`;
    this.fps.className = `fps ${fps !== null && fps < 50 && !snapshot.paused ? 'warn' : ''}`;
    this.pauseButton.textContent = snapshot.paused ? 'Resume' : 'Pause';
    this.pauseButton.setAttribute('aria-pressed', String(snapshot.paused));
    this.stepButton.disabled = !snapshot.paused;
  }

  private readonly onClick = (event: Event): void => {
    const action = (event.target as Element | null)
      ?.closest('[data-action]')
      ?.getAttribute('data-action');
    switch (action) {
      case 'pause':
        if (this.session.paused) this.session.resume();
        else this.session.pause();
        break;
      case 'step':
        this.session.step();
        break;
      case 'reset':
        this.session.resetStats();
        break;
      case 'editor':
        if (this.editorUrl) {
          const button = this.root.querySelector('[data-action="editor"]') as HTMLButtonElement;
          void openEditor(this.editorUrl).then(outcome => {
            if (outcome !== 'already-open') return;
            button.textContent = 'Editor is open';
            setTimeout(() => (button.textContent = 'Editor'), 3000);
          });
        }
        return;
      case 'collapse':
        this.setCollapsed(!this.panel.classList.contains('collapsed'));
        break;
      default:
        return;
    }
    this.render();
  };

  private setCollapsed(collapsed: boolean): void {
    this.panel.classList.toggle('collapsed', collapsed);
    this.collapseButton.textContent = collapsed ? 'Show' : 'Hide';
    this.collapseButton.title = collapsed ? 'Expand' : 'Collapse';
    writeCollapsed(collapsed);
  }
}

/** Stacked bars, oldest left: logic, render, then the rest of the frame (`dt` − work). */
const drawChart = (canvas: HTMLCanvasElement, ring: FrameRing): void => {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, width, height);
  const y = (valueMs: number): number =>
    height - (Math.min(valueMs, CHART_CEILING_MS) / CHART_CEILING_MS) * height;
  const bar = width / ring.capacity;
  const offset = ring.capacity - ring.length;
  for (let i = 0; i < ring.length; i += 1) {
    const at = ring.indexOf(i);
    const x = (offset + i) * bar;
    const w = Math.max(1, bar - (bar > 2 ? 0.5 * dpr : 0));
    const logic = ring.logicMs[at];
    const render = ring.renderMs[at];
    const frame = Math.max(ring.frameMs[at], logic + render);
    g.fillStyle = COLORS.other;
    g.fillRect(x, y(frame), w, height - y(frame));
    g.fillStyle = COLORS.render;
    g.fillRect(x, y(logic + render), w, y(logic) - y(logic + render));
    g.fillStyle = COLORS.logic;
    g.fillRect(x, y(logic), w, height - y(logic));
    if (frame > LONG_FRAME_MS) {
      g.fillStyle = COLORS.over;
      g.fillRect(x, 0, w, 2 * dpr);
    }
  }
  g.fillStyle = COLORS.grid;
  for (const line of [1000 / 60, 1000 / 30]) g.fillRect(0, Math.round(y(line)), width, dpr);
};

const renderSections = (s: DebugSnapshot): string => {
  const w = s.window;
  const st = s.stability;
  const parts: string[] = [];

  parts.push(
    section(
      'Frame',
      row('frame (avg)', ms(w.frameMs)) +
        row('logic / render', `${ms(w.logicMs, 2)} / ${ms(w.renderMs, 2)}`) +
        row('other (not the game)', ms(w.unaccountedMs)) +
        row('rAF lateness', ms(w.rafLatenessMs, 2)) +
        row('p50 / p95 / p99', `${ms(st.p50Ms, 0)} / ${ms(st.p95Ms, 0)} / ${ms(st.p99Ms, 0)}`) +
        row(
          `> ${LONG_FRAME_MS.toFixed(0)} ms`,
          `${num(st.longCount)} of ${num(st.sampleCount)}${st.longPercent === null ? '' : ` (${st.longPercent.toFixed(1)}%)`}`,
          st.longPercent !== null && st.longPercent > 1 ? 'warn' : ''
        ) +
        row('worst', ms(st.worstMs), st.worstMs !== null && st.worstMs > 50 ? 'bad' : '') +
        row('frame #', num(s.frameNumber))
    )
  );

  if (w.activities.length > 0) {
    parts.push(
      section(
        'Activities (self, per frame)',
        w.activities
          .slice(0, 8)
          .map(activity => row(activity.label, ms(activity.ms, 2)))
          .join('')
      )
    );
  }

  const r = s.renderer;
  parts.push(
    section(
      'Renderer',
      r
        ? row('draw calls', num(r.calls)) +
            row('triangles', num(r.triangles)) +
            row('geometries / textures', `${num(r.geometries)} / ${num(r.textures)}`) +
            row(
              'programs',
              `${num(r.programs)}${s.programsLinked > 0 ? ` (+${s.programsLinked} linked)` : ''}`,
              s.programsLinked > 0 ? 'warn' : ''
            )
        : '<div class="muted">no frame rendered yet</div>'
    )
  );

  const lf = s.longFrames;
  parts.push(
    section(
      'Long frames (browser)',
      lf.supported
        ? row('count', num(lf.count), lf.count > 0 ? 'warn' : '') +
            lf.worst
              .map(frame =>
                row(
                  frame.script ?? 'no JS (GC, compositing, vsync)',
                  ms(frame.durationMs, 0),
                  frame.durationMs > 100 ? 'bad' : 'warn'
                )
              )
              .join('')
        : '<div class="muted">not reported by this browser</div>'
    )
  );

  parts.push(
    section(
      `Audio (${s.audio.active})`,
      s.audio.playbacks.length > 0
        ? s.audio.playbacks
            .map(playback =>
              row(
                playback.label,
                `${playback.bus}${playback.loop ? ' · loop' : ''} · ${(playback.elapsedMs / 1000).toFixed(1)} s`
              )
            )
            .join('')
        : '<div class="muted">nothing playing</div>'
    )
  );

  parts.push(
    section(
      `Errors (${s.errors.count})`,
      s.errors.recent.length > 0
        ? s.errors.recent
            .slice(-4)
            .reverse()
            .map(
              error =>
                `<div class="error">${escapeHtml(error.message)}${error.where ? `<small>${escapeHtml(error.where)}</small>` : ''}</div>`
            )
            .join('')
        : '<div class="muted">none</div>'
    )
  );

  if (s.game) {
    let text: string;
    try {
      text = JSON.stringify(s.game.snapshot, null, 1) ?? 'null';
    } catch {
      text = '(not JSON-serialisable)';
    }
    parts.push(section(`Game · ${s.game.name}`, `<pre>${escapeHtml(text.slice(0, 4000))}</pre>`));
  }

  const d = s.device;
  parts.push(
    section(
      'Device',
      row('scene', escapeHtml(s.scene ?? '–')) +
        row('status', escapeHtml(s.status), s.status === 'failed' ? 'bad' : '') +
        row('GPU', escapeHtml(d.gpu ?? '–')) +
        row('screen / viewport', `${d.screen} / ${d.viewport} @${d.devicePixelRatio}x`) +
        row(
          'memory / cores',
          `${d.memoryGb === null ? '–' : `${d.memoryGb} GB`} / ${num(d.cores)}`
        ) +
        row('JS heap', s.heapMb === null ? '–' : `${s.heapMb.toFixed(1)} MB`)
    )
  );

  return parts.join('');
};
