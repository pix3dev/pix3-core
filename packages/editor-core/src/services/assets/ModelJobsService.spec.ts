import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelFeedback, ModelJob } from '@/core/model-jobs-format';
import { SAMPLE_FEEDBACK, SAMPLE_JOB } from '@/core/model-jobs-format.test-helpers';
import { HostService } from '@/host/HostService';
import { FakeHost, FakeHostError } from '@/host/testing/fake-host';

import { FeedbackWriterLostError, ModelJobsService } from './ModelJobsService';

/**
 * Reading and polling `.pix3/model-jobs/` and appending feedback (plan `.plans/model-jobs.md`
 * Stage 2, "Запись панели") over `FakeHost`, whose conditional writes fail like the plugin's.
 */

const DIR = '.pix3/model-jobs';
const job = (id: string, title = id): ModelJob => ({ ...(SAMPLE_JOB as ModelJob), id, title });
const indexOf = (...jobs: ModelJob[]): string =>
  JSON.stringify({
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
  });
const files = (...jobs: ModelJob[]): Record<string, string> => ({
  [`${DIR}/index.json`]: indexOf(...jobs),
  ...Object.fromEntries(jobs.map(j => [`${DIR}/${j.id}/job.json`, JSON.stringify(j)])),
});
const ENTRY = JSON.parse(SAMPLE_FEEDBACK.split('\n')[0]) as ModelFeedback;

let host: FakeHost;
let service: ModelJobsService;

const boot = async (initial: Record<string, string>): Promise<void> => {
  host = new FakeHost({ files: initial });
  await host.whenReady();
  HostService.install(host);
  service = new ModelJobsService();
};

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  service?.dispose();
  HostService.reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ModelJobsService reading', () => {
  it('lists the jobs, follows the newest, and reads its job, feedback and images', async () => {
    await boot({
      ...files(job('tower', 'Tower')),
      [`${DIR}/tower/feedback.jsonl`]: SAMPLE_FEEDBACK,
      [`${DIR}/tower/reference.png`]: 'ref',
      [`${DIR}/tower/passes/03-form/sheet.png`]: 'sheet',
    });
    service.setPanelVisible(true);
    await vi.waitFor(() =>
      expect(Object.keys(service.snapshot().images)).toEqual(['passes/03-form/sheet.png'])
    );
    const snap = service.snapshot();
    expect(snap.jobs.map(j => j.id)).toEqual(['tower']);
    expect(snap.selectedId).toBe('tower');
    expect(snap.job?.title).toBe('Tower');
    expect(snap.feedback.map(f => f.id)).toEqual(['f-1763287800000-k3x9', 'f-1763287900000-p2q1']);
    expect(snap.pollError).toBeNull();
  });

  it('polls only while a panel is visible and the document is not hidden', async () => {
    await boot(files(job('tower')));
    const head = vi.spyOn(host.files, 'head');
    service.refresh();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(head).not.toHaveBeenCalled();

    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    service.setPanelVisible(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(head).not.toHaveBeenCalled();

    hidden.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(head).toHaveBeenCalled());
  });

  it('drops a late answer for the job that is no longer selected', async () => {
    await boot(files(job('alpha', 'Alpha'), job('beta', 'Beta')));
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const read = host.files.read.bind(host.files);
    host.files.read = async path => {
      if (path === `${DIR}/alpha/job.json`) await gate;
      return read(path);
    };
    service.select('alpha');
    service.setPanelVisible(true);
    await new Promise(resolve => setTimeout(resolve, 20)); // alpha's read is held at the gate

    service.select('beta');
    release();
    await vi.waitFor(() => expect(service.snapshot().job?.id).toBe('beta'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(service.snapshot().selectedId).toBe('beta');
    expect(service.snapshot().job?.title).toBe('Beta');
  });

  it('treats a job the index lists but whose job.json is gone as missing, not an error', async () => {
    await boot({ [`${DIR}/index.json`]: indexOf(job('ghost')) });
    service.setPanelVisible(true);
    await vi.waitFor(() => expect(service.snapshot().jobMissing).toBe(true));
    expect(service.snapshot()).toMatchObject({ selectedId: 'ghost', job: null, pollError: null });
  });

  it('backs off after a failed poll and recovers', async () => {
    await boot(files(job('tower')));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const head = host.files.head.bind(host.files);
    let failing = true;
    const calls: number[] = [];
    host.files.head = async path => {
      calls.push(Date.now());
      if (failing) throw new Error('dev server gone');
      return head(path);
    };
    service.setPanelVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot().pollError).toBe('dev server gone');
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(1); // the next try waits 3 s, not 1.5 s
    failing = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls.length).toBeGreaterThan(1);
    await vi.waitFor(() => expect(service.snapshot().pollError).toBeNull());
  });
});

describe('ModelJobsService.sendFeedback', () => {
  const FEEDBACK = `${DIR}/tower/feedback.jsonl`;
  const IMAGE = `${DIR}/tower/${ENTRY.image}`;
  const lines = (): string[] => (host.text(FEEDBACK) ?? '').trim().split('\n');

  it('writes the PNG, then creates feedback.jsonl with the line', async () => {
    await boot(files(job('tower')));
    const write = vi.spyOn(host.files, 'write');
    await service.sendFeedback('tower', ENTRY, new Uint8Array([1, 2, 3]));
    expect(write.mock.calls.map(([path, , options]) => [path, options])).toEqual([
      [IMAGE, { createOnly: true }],
      [FEEDBACK, { createOnly: true }],
    ]);
    expect(lines().map(line => JSON.parse(line).id)).toEqual([ENTRY.id]);
  });

  it('retries after an If-Match conflict without duplicating anyone’s line', async () => {
    const other = SAMPLE_FEEDBACK.split('\n')[1];
    await boot({ ...files(job('tower')), [FEEDBACK]: '' });
    const write = host.files.write.bind(host.files);
    let raced = false;
    host.files.write = async (path, data, options) => {
      if (path === FEEDBACK && !raced) {
        raced = true; // someone appends between our read and our write
        await host.externalWrite(FEEDBACK, `${other}\n`);
      }
      return write(path, data, options);
    };
    const spy = vi.spyOn(host.files, 'write');
    await service.sendFeedback('tower', ENTRY, null);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][2]).toMatchObject({ ifMatch: expect.any(String) });
    expect(lines().map(line => JSON.parse(line).id)).toEqual(['f-1763287900000-p2q1', ENTRY.id]);

    await service.sendFeedback('tower', ENTRY, null); // a retry of a send that did land
    expect(lines()).toHaveLength(2);
  });

  it('takes `exists` on the PNG of a retried send as done and still appends the line once', async () => {
    await boot({ ...files(job('tower')), [IMAGE]: 'written by the first try' });
    await service.sendFeedback('tower', ENTRY, new Uint8Array([9]));
    expect(host.text(IMAGE)).toBe('written by the first try');
    expect(lines().map(line => JSON.parse(line).id)).toEqual([ENTRY.id]);
  });

  it('stops on a lost writer and says so', async () => {
    await boot(files(job('tower')));
    host.files.write = async () => {
      throw new FakeHostError('writer_superseded', 409, 'another tab writes');
    };
    await expect(service.sendFeedback('tower', ENTRY, null)).rejects.toBeInstanceOf(
      FeedbackWriterLostError
    );
  });
});
