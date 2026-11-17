import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelJob, ModelPass } from '@/core/model-jobs-format';
import { SAMPLE_JOB } from '@/core/model-jobs-format.test-helpers';
import { HostService } from '@/host/HostService';
import { FakeHost } from '@/host/testing/fake-host';
import { ModelJobsService } from '@/services/assets/ModelJobsService';
import { appState, resetAppState } from '@/state';

import { ModelJobsPanel } from './model-jobs-panel';
import type { SheetAnnotator } from './sheet-annotator';

/** Window → 3D Asset Generator over `FakeHost` and the real `ModelJobsService`. */

const DIR = '.pix3/model-jobs';
const base = SAMPLE_JOB as ModelJob;
const pass3 = base.passes[0];
const pass2: ModelPass = {
  ...pass3,
  seq: 2,
  stage: 'structure',
  note: null,
  sheet: { ...pass3.sheet, file: 'passes/02-structure/sheet.png' },
  report: 'passes/02-structure/report.json',
  metrics: { ...pass3.metrics, silhouetteIoU: 0.61, triangles: 1200 },
};
const future = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

const makeJob = (patch: Partial<ModelJob> = {}): ModelJob => ({
  ...base,
  wait: { pid: 4242, since: future(-1), expiresAt: future(5) },
  passes: [pass2, pass3],
  ...patch,
});

const seed = (...jobs: ModelJob[]): Record<string, string> => ({
  [`${DIR}/index.json`]: JSON.stringify({
    v: 1,
    jobs: jobs.map(j => ({
      id: j.id,
      title: j.title,
      status: j.status,
      target: j.target,
      passes: j.passes.length,
      stage: j.passes.at(-1)?.stage ?? null,
      updatedAt: j.updatedAt,
      wait: j.wait,
    })),
  }),
  ...Object.fromEntries(
    jobs.flatMap(j => [
      [`${DIR}/${j.id}/job.json`, JSON.stringify(j)],
      ...j.passes.map(p => [`${DIR}/${j.id}/${p.sheet.file}`, `png ${p.seq}`]),
    ])
  ),
});

let host: FakeHost;
let service: ModelJobsService;
let panel: ModelJobsPanel;
const openTab = vi.fn();

const mount = async (files: Record<string, string>, writer: 'self' | 'other' = 'self') => {
  host = new FakeHost({ files });
  await host.whenReady();
  HostService.install(host);
  service = new ModelJobsService();
  appState.project.host.writer = writer;
  panel = new ModelJobsPanel();
  Object.defineProperty(panel, 'jobsService', { value: service, configurable: true });
  Object.defineProperty(panel, 'editorTabs', {
    value: { openResourceTab: openTab },
    configurable: true,
  });
  Object.defineProperty(panel, 'renderMarkedSheet', {
    value: vi.fn().mockResolvedValue(new Uint8Array([137, 80, 78, 71])),
    configurable: true,
  });
  document.body.appendChild(panel);
  await vi.waitFor(() => expect(panel.querySelector('pix3-sheet-annotator')).not.toBeNull());
  await panel.updateComplete;
};

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const el = panel.querySelector<T>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
};
const text = (selector: string): string =>
  $(selector).textContent?.replace(/\s+/g, ' ').trim() ?? '';
const click = async (selector: string): Promise<void> => {
  $<HTMLButtonElement>(selector).click();
  await panel.updateComplete;
};
const annotator = (): SheetAnnotator => $<SheetAnnotator>('pix3-sheet-annotator');

beforeEach(() => {
  resetAppState();
  vi.stubGlobal('IntersectionObserver', undefined);
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:url-${++n}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  panel?.remove();
  service?.dispose();
  HostService.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  openTab.mockReset();
});

describe('3D Asset Generator panel', () => {
  it('lists jobs with their status and shows the selected one', async () => {
    await mount(
      seed(
        makeJob(),
        makeJob({
          id: 'crate',
          title: 'Crate',
          status: 'running',
          updatedAt: '2026-11-16T09:00:00.000Z',
          wait: { pid: 1, since: future(-20), expiresAt: future(-10) },
        })
      )
    );
    const rows = [...panel.querySelectorAll<HTMLElement>('.mj-job')].map(row =>
      row.textContent?.replace(/\s+/g, ' ').trim()
    );
    expect(rows[0]).toContain('Tower');
    expect(rows[0]).toContain('Waiting for you');
    expect(rows[0]).toContain('2 passes · form');
    expect(rows[1]).toContain('Wait expired');
    expect(text('.mj-job-head')).toContain('res://scenes/prefabs/tower.prefab');

    await click('.mj-job-head .mj-btn');
    expect(openTab).toHaveBeenCalledWith('scene', 'res://scenes/prefabs/tower.prefab');
  });

  it('renders the pass strip, the latest pass large, its metrics and the change since the last', async () => {
    await mount(seed(makeJob()));
    const passes = [...panel.querySelectorAll('.mj-pass')];
    expect(passes.map(p => p.getAttribute('data-seq'))).toEqual(['2', '3']);
    expect(passes[1].getAttribute('aria-pressed')).toBe('true');
    expect(text('.mj-pass-details__head')).toContain('Pass 3 · form');
    expect(text('[data-metric="silhouetteIoU"]')).toBe('Silhouette IoU 0.71 +0.10');
    expect(text('[data-metric="triangles"]')).toBe('Triangles 1840 +640');
    expect(annotator().src).toBe(service.snapshot().images[pass3.sheet.file]);
  });

  it('shows no change against a pass rendered under other params, and why a pass was not compared', async () => {
    const other: ModelPass = {
      ...pass3,
      params: { ...pass3.params, size: 256 },
      metrics: { ...pass3.metrics, notCompared: 'mask failed: the corners are not uniform' },
    };
    await mount(seed(makeJob({ passes: [pass2, other] })));
    expect(text('[data-metric="silhouetteIoU"]')).toBe('Silhouette IoU 0.71');
    expect(text('.mj-not-compared')).toBe('Not compared: mask failed: the corners are not uniform');
    expect(text('.mj-no-delta')).toContain('pass 2 was rendered under other conditions');
    expect(text('.mj-pass[data-seq="3"] .mj-pass__metric')).toBe('not compared');
  });

  it('flips A/B to the previous pass and draws nothing there', async () => {
    await mount(seed(makeJob()));
    const images = service.snapshot().images;
    await click('.mj-segment__btn:nth-child(2)');
    expect(annotator().src).toBe(images[pass2.sheet.file]);
    expect(annotator().tool).toBeNull();
    await click('.mj-segment__btn:nth-child(1)');
    expect(annotator().src).toBe(images[pass3.sheet.file]);
    expect(annotator().tool).toBe('rect');
  });

  it('undoes and redoes marks with Ctrl+Z / Ctrl+Y and keeps them from the scene undo', async () => {
    await mount(seed(makeJob()));
    const add = (detail: object) =>
      annotator().dispatchEvent(new CustomEvent('mark-add', { detail, bubbles: true }));
    // An arrow takes the view of its head: from `front` (bottom left) at `iso` (top right).
    add({ view: '', shape: 'arrow', from: [0.2, 0.7], to: [0.7, 0.3] });
    add({ view: '', shape: 'point', point: [0.7, 0.2] });
    await panel.updateComplete;
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    const key = (init: KeyboardEventInit, target: Element = $('.model-jobs')) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    try {
      expect(key({ key: 'z', ctrlKey: true }).defaultPrevented).toBe(true);
      await panel.updateComplete;
      expect(annotator().marks).toEqual([
        { view: 'iso', shape: 'arrow', from: [0.2, 0.7], to: [0.7, 0.3] },
      ]);
      key({ key: 'y', ctrlKey: true });
      await panel.updateComplete;
      expect(annotator().marks.map(m => m.shape)).toEqual(['arrow', 'point']);
      key({ key: 'z', ctrlKey: true });
      key({ key: 'Z', ctrlKey: true, shiftKey: true });
      await panel.updateComplete;
      expect(annotator().marks).toHaveLength(2);
      expect(seen).not.toHaveBeenCalled();
      // The comment field keeps its own text undo.
      const typed = key({ key: 'z', ctrlKey: true }, $('.mj-text'));
      expect(typed.defaultPrevented).toBe(false);
      expect(seen).toHaveBeenCalledTimes(1);
      expect(annotator().marks).toHaveLength(2);
    } finally {
      window.removeEventListener('keydown', seen);
    }
  });

  it('sends a comment with a mark: the PNG, then one feedback line naming the mark’s view', async () => {
    await mount(seed(makeJob()));
    // reference | iso / front, two columns: a rect centred in the bottom-left tile is on `front`.
    annotator().dispatchEvent(
      new CustomEvent('mark-add', {
        detail: { view: '', shape: 'rect', rect: [0.1, 0.6, 0.2, 0.2] },
        bubbles: true,
      })
    );
    await panel.updateComplete;
    const textarea = $<HTMLTextAreaElement>('.mj-text');
    textarea.value = 'roof too flat';
    textarea.dispatchEvent(new Event('input'));
    await panel.updateComplete;
    await click('[data-action="send"]');
    await vi.waitFor(() => expect(host.text(`${DIR}/tower/feedback.jsonl`)).not.toBeNull());

    const line = JSON.parse(host.text(`${DIR}/tower/feedback.jsonl`)!.trim());
    expect(line).toMatchObject({
      v: 1,
      pass: 3,
      text: 'roof too flat',
      verdict: null,
      marks: [{ view: 'front', shape: 'rect', rect: [0.1, 0.6, 0.2, 0.2] }],
      image: `feedback/${line.id}.png`,
    });
    expect(line.id).toMatch(/^f-\d+-[a-z0-9]+$/);
    expect(host.store.has(`${DIR}/tower/feedback/${line.id}.png`)).toBe(true);
    await vi.waitFor(() =>
      expect(text(`[data-feedback-id="${line.id}"]`)).toContain('Not delivered yet')
    );
    expect($<HTMLTextAreaElement>('.mj-text').value).toBe('');
  });

  it('shows what became of each entry: delivered, or addressed in a pass', async () => {
    const files = seed(
      makeJob({
        feedback: {
          'f-1-aaaa': { deliveredAt: '2026-11-16T10:06:00.000Z', addressedBy: 3 },
          'f-2-bbbb': { deliveredAt: '2026-11-16T10:07:00.000Z', addressedBy: null },
        },
      })
    );
    const entry = (id: string, verdict: string | null) =>
      JSON.stringify({
        v: 1,
        id,
        at: '2026-11-16T10:05:00.000Z',
        pass: 2,
        text: id,
        verdict,
        marks: [],
      });
    files[`${DIR}/tower/feedback.jsonl`] =
      `${entry('f-1-aaaa', 'changes')}\n${entry('f-2-bbbb', 'accept')}\n`;
    await mount(files);
    await vi.waitFor(() => expect(panel.querySelectorAll('.mj-feedback__item')).toHaveLength(2));
    expect(text('[data-feedback-id="f-1-aaaa"]')).toContain('Addressed in pass 3');
    expect(text('[data-feedback-id="f-1-aaaa"]')).toContain('Needs changes');
    expect(text('[data-feedback-id="f-2-bbbb"]')).toContain('Delivered');
    expect(text('[data-feedback-id="f-2-bbbb"]')).toContain('Accepted');
  });

  it('disables sending and drawing in a tab that is not the writer, and says why', async () => {
    await mount(seed(makeJob()), 'other');
    expect(text('.mj-readonly')).toContain('Another editor tab holds writing');
    for (const action of ['send', 'accept', 'changes'])
      expect($<HTMLButtonElement>(`[data-action="${action}"]`).disabled).toBe(true);
    expect($<HTMLTextAreaElement>('.mj-text').disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-tool="rect"]').disabled).toBe(true);
    expect(annotator().tool).toBeNull();

    appState.project.host.writer = 'self';
    await vi.waitFor(() =>
      expect($<HTMLButtonElement>('[data-action="accept"]').disabled).toBe(false)
    );
    expect(panel.querySelector('.mj-readonly')).toBeNull();
  });

  it('keeps drawn marks on their pass when a newer pass lands', async () => {
    await mount(seed(makeJob()));
    annotator().dispatchEvent(
      new CustomEvent('mark-add', {
        detail: { view: '', shape: 'point', point: [0.7, 0.2] },
        bubbles: true,
      })
    );
    await panel.updateComplete;
    const pass4: ModelPass = {
      ...pass3,
      seq: 4,
      sheet: { ...pass3.sheet, file: 'passes/04-form/sheet.png' },
    };
    await host.externalWrite(`${DIR}/tower/passes/04-form/sheet.png`, 'png 4');
    await host.externalWrite(
      `${DIR}/tower/job.json`,
      JSON.stringify(makeJob({ passes: [pass2, pass3, pass4] }))
    );
    service.refresh();
    await vi.waitFor(() => expect(panel.querySelectorAll('.mj-pass')).toHaveLength(3));
    expect(text('.mj-pass-details__head')).toContain('Pass 3 · form');
    expect(annotator().marks).toHaveLength(1);
  });
});
