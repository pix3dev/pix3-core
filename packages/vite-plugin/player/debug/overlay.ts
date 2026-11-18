import { openEditor } from '../dev/editor-link';
import type { EditorRpc, PageInfo } from '../dev/editor-rpc';
import { LONG_FRAME_MS, type FrameRing } from './frame-stats';
import { escapeHtml, row, section } from './markup';
import { SceneTab } from './scene-tab';
import type { DebugSession, DebugSnapshot } from './session';

/**
 * The debug overlay's DOM: a panel over the game's top-right corner, in a shadow root so the
 * game's CSS cannot reach it (and its CSS cannot reach the game). Two tabs: **Profiler**, whose
 * chart repaints at 8 Hz and text at 2 Hz (each text refresh closes an averaging window), from
 * timers rather than the game's frame listener, so a slow page shows a slow overlay instead of a
 * slower game; and **Scene** (`scene-tab.ts`), the live object tree, read on demand.
 *
 * A page the editor opened (`rpc`, plan play-in-page S4) starts collapsed, names its role in the
 * header, and — the human's page — offers "Show agent" (pause + a message for the agent on the
 * clipboard) and an error banner with "Copy for agent", the same message.
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
/* Collapsed = a chip (D1): it sits over the game's top corner, where HUDs live. */
.panel.collapsed [data-action="step"], .panel.collapsed [data-action="editor"],
.panel.collapsed.has-role .title { display: none; }
.panel.wide { width: min(380px, calc(100vw - 16px)); }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
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
.tabs { display: flex; gap: 4px; margin-top: 6px; border-bottom: 1px solid rgba(255,255,255,0.12); }
.tabs button { border-radius: 4px 4px 0 0; border-bottom: none; }
.scene-bar { display: flex; gap: 6px; margin-top: 6px; }
.scene-bar input { flex: 1; min-width: 0; font: inherit; color: inherit; background: rgba(0,0,0,0.35);
  border: 1px solid rgba(255,255,255,0.16); border-radius: 4px; padding: 1px 6px; }
.scene-count { margin: 4px 0 2px; }
.tree { max-height: 40vh; overflow: auto; scrollbar-width: thin; border: 1px solid rgba(255,255,255,0.08);
  border-radius: 4px; padding: 2px 0; }
.node { display: flex; align-items: center; gap: 5px; padding-right: 4px; white-space: nowrap; cursor: pointer; }
.node:hover { background: rgba(255,255,255,0.08); }
.node.selected { background: rgba(255,207,51,0.22); }
.node.match .name, .node.match .type { color: #ffcf33; }
.node.hidden > .type, .node.hidden > .name { opacity: 0.5; }
.node .type { color: #a0a0a0; }
.node .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.twisty { flex: none; width: 12px; height: 12px; position: relative; }
.twisty.open::before, .twisty.closed::before { content: ''; position: absolute; left: 3px; top: 3px;
  border: 4px solid transparent; }
.twisty.closed::before { border-left: 5px solid #a0a0a0; border-right: none; top: 2px; }
.twisty.open::before { border-top: 5px solid #a0a0a0; border-bottom: none; left: 2px; top: 4px; }
.chip { flex: none; padding: 0 4px; border-radius: 3px; font-size: 10px; background: rgba(78,161,255,0.25); color: #cfe3ff; }
.chip.off { background: rgba(255,255,255,0.12); color: #a0a0a0; }
.detail { margin-top: 6px; }
.detail-head { display: flex; align-items: center; gap: 6px; }
.detail-head .type { color: #ffcf33; font-weight: 600; }
.detail-head .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: auto; }
.role { color: #4ea1ff; white-space: nowrap; }
.alert { margin-top: 6px; color: #ff6b6b; display: flex; gap: 6px; align-items: baseline; }
.alert span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.alert[hidden], .handoff[hidden] { display: none; }
.handoff { margin-top: 6px; }
.handoff pre { user-select: all; border: 1px solid rgba(255,255,255,0.16); border-radius: 4px; padding: 4px; }
.swatch { display: inline-block; width: 8px; height: 8px; margin-right: 4px; vertical-align: -1px; border: 1px solid rgba(255,255,255,0.3); }
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

/** The stored choice, else `fallback` (collapsed on a page the editor opened, D1). */
const readCollapsed = (fallback: boolean): boolean => {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    return stored === null ? fallback : stored === '1';
  } catch {
    return fallback;
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
  private readonly sceneTab: SceneTab;
  private readonly alert: HTMLElement;
  private readonly handoff: HTMLElement;
  private tab: 'profiler' | 'scene' = 'profiler';
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;

  constructor(
    private readonly session: DebugSession,
    private readonly editorUrl: string | null = null,
    private readonly rpc: EditorRpc | null = null
  ) {
    const designer = rpc?.role === 'designer';
    this.host.className = 'pix3-debug-overlay';
    const root = this.host.attachShadow({ mode: 'open' });
    this.root = root;
    root.innerHTML = `<style>${STYLE}</style>
<div class="panel${rpc ? ' has-role' : ''}" part="panel">
  <header>
    <span class="title">Pix3 debug</span>
    ${rpc ? `<span class="role" title="Opened by the Pix3 editor">${rpc.role === 'agent' ? "agent's page" : 'from editor'}</span>` : ''}
    <span class="fps">– fps</span>
    <button type="button" data-action="pause" aria-pressed="false" title="Freeze the game (manual time mode)">Pause</button>
    <button type="button" data-action="step" title="Advance one frame while paused" disabled>Step</button>
    ${designer ? '<button type="button" data-action="show-agent" title="Pause here and copy a message that lets the agent read this page">Show agent</button>' : ''}
    ${editorUrl ? '<button type="button" data-action="editor" title="Open this project in the Pix3 editor">Editor</button>' : ''}
    <button type="button" data-action="collapse" title="Collapse">Hide</button>
  </header>
  <div class="alert" hidden><span></span><button type="button" data-action="show-agent" title="Pause here and copy a message for the agent">Copy for agent</button></div>
  <div class="handoff" hidden></div>
  <div class="body">
    <nav class="tabs"><button type="button" data-action="tab" data-tab="profiler" aria-pressed="true">Profiler</button><button type="button" data-action="tab" data-tab="scene" aria-pressed="false">Scene</button></nav>
    <div data-pane="profiler">
      <canvas></canvas>
      <div class="legend"><span><i style="background:${COLORS.logic}"></i>logic</span><span><i style="background:${COLORS.render}"></i>render</span><span><i style="background:${COLORS.other}"></i>other</span><span class="muted">lines: 16.7 / 33.3 ms</span></div>
      <div class="sections"></div>
      <section><button type="button" data-action="reset" title="Reset percentiles, long frames and the program count">Reset stats</button></section>
    </div>
    <div data-pane="scene" hidden></div>
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
    this.alert = pick('.alert');
    this.handoff = pick('.handoff');
    this.sceneTab = new SceneTab(
      session,
      pick('[data-pane="scene"]'),
      rpc ? nodeId => this.showInEditor(nodeId) : null
    );
    root.addEventListener('click', this.onClick);
    // Keep the game's own listeners (a tap-to-jump on `window`, a key) out of the panel's input.
    for (const type of [
      'pointerdown',
      'pointerup',
      'touchstart',
      'touchend',
      'wheel',
      'keydown',
      'keyup',
    ]) {
      this.panel.addEventListener(type, event => event.stopPropagation());
    }
    this.setCollapsed(readCollapsed(rpc !== null));
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
    if (this.profilerShown()) drawChart(this.canvas, this.session.ring);
    if (withText) this.render();
  }

  private profilerShown(): boolean {
    return this.tab === 'profiler' && !this.panel.classList.contains('collapsed');
  }

  private render(): void {
    const snapshot = this.session.snapshot();
    this.renderHeader(snapshot);
    if (!this.profilerShown()) return;
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
    // The human's page: the newest error, and the way to hand it to the agent.
    const latest = this.rpc?.role === 'designer' ? snapshot.errors.recent.at(-1) : undefined;
    this.alert.hidden = !latest;
    if (latest) {
      (this.alert.firstElementChild as HTMLElement).textContent =
        `${snapshot.errors.count} error${snapshot.errors.count === 1 ? '' : 's'}: ${latest.message}`;
    }
  }

  /** Pause, and put a message on the clipboard that tells the agent how to read this page. */
  private showAgent(): void {
    if (!this.rpc) return;
    this.session.pause();
    const text = agentMessage(this.rpc.info(), this.session.snapshot());
    const shown = (copied: boolean): void => {
      this.handoff.hidden = false;
      this.handoff.innerHTML = copied
        ? '<div class="muted">Paused. The message for the agent is on the clipboard.</div>'
        : `<div class="muted">Paused. Copy this for the agent:</div><pre>${escapeHtml(text)}</pre>`;
      if (copied) setTimeout(() => (this.handoff.hidden = true), 4000);
    };
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) return shown(false);
    clipboard.writeText(text).then(
      () => shown(true),
      () => shown(false)
    );
  }

  /** The Scene tab's "Show in editor": the editor selects the node, and its window comes forward. */
  private showInEditor(nodeId: string): void {
    this.rpc?.select(nodeId);
    try {
      window.opener?.focus();
    } catch {
      // A severed opener: the editor still selects the node.
    }
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
      case 'show-agent':
        this.showAgent();
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
      case 'tab':
        this.showTab(
          (event.target as Element).closest('[data-tab]')?.getAttribute('data-tab') === 'scene'
            ? 'scene'
            : 'profiler'
        );
        break;
      default:
        return;
    }
    this.render();
  };

  /** Opening Scene reads the live tree (it is never read on a timer). */
  private showTab(tab: 'profiler' | 'scene'): void {
    this.tab = tab;
    for (const button of this.root.querySelectorAll('[data-tab]')) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-tab') === tab));
    }
    for (const pane of this.root.querySelectorAll<HTMLElement>('[data-pane]')) {
      pane.hidden = pane.getAttribute('data-pane') !== tab;
    }
    this.panel.classList.toggle('wide', tab === 'scene');
    if (tab === 'scene') this.sceneTab.refresh();
  }

  private setCollapsed(collapsed: boolean): void {
    this.panel.classList.toggle('collapsed', collapsed);
    this.collapseButton.textContent = collapsed ? 'Show' : 'Hide';
    this.collapseButton.title = collapsed ? 'Expand' : 'Collapse';
    writeCollapsed(collapsed);
  }
}

/**
 * What "Show agent" copies: which page, where the game stopped, the tools that read it without
 * touching it, and the latest errors.
 */
const agentMessage = (page: PageInfo, snapshot: DebugSnapshot): string => {
  const lines = [
    `I paused the game in my Pix3 play window to show you something: page "designer", ` +
      `loadId ${page.loadId}, scene ${page.scene ?? '?'}, frame ${snapshot.frameNumber}.`,
    'Read it as it is — do not start, restart or tap it (it is my page: not_your_page):',
    '- pix3_scene {"page":"designer","nodeId":"…"} or {"page":"designer","find":"…"} — live node state',
    '- pix3_screenshot {"target":"game","page":"designer"}, then take_screenshot of that page',
    '- pix3_errors',
    'Reproduce it on your own page (pix3_play start) before you change anything.',
  ];
  const errors = snapshot.errors.recent.slice(-5);
  if (errors.length > 0) {
    lines.push('Latest errors:');
    for (const error of errors) {
      lines.push(`- ${error.message}${error.where ? ` (${error.where})` : ''}`);
    }
  }
  return lines.join('\n');
};

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
