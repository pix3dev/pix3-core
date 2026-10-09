import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { findPackageDir } from '../dev-info.ts';
import { HttpError } from '../server/http.ts';
import { FLUSH_TIMEOUT_MS } from './editor-flush.ts';
import { buildRecordPath, readBuildRecord, type BuildRecord } from './record.ts';

/**
 * `POST /__pix3/api/build` (plan §B.6 «Из UI»): flush the editor, then run the project's own
 * `vite build` in a child process — `process.execPath node_modules/vite/bin/vite.js build`, never
 * `vite.cmd` (EINVAL on Windows) — and stream its output to every tab as `pix3:build` frames.
 * The child is the same plugin in build mode; it leaves `.pix3/build.json`, which is the answer.
 * One build at a time: a second request while one runs is `409 build_in_progress`.
 */

export interface BuildRequest {
  readonly format?: 'html' | 'zip';
  readonly compress?: boolean;
  readonly entryScene?: string;
}

export interface BuildProgressFrame extends Record<string, unknown> {
  readonly type: 'pix3:build';
  readonly phase: 'flush' | 'start' | 'output' | 'done' | 'failed';
  readonly line?: string;
  readonly record?: BuildRecord;
  readonly error?: string;
}

export interface BuildRunnerDeps {
  readonly root: string;
  readonly flush: (timeoutMs: number) => Promise<{ ok: boolean; reason?: string }>;
  readonly broadcast: (frame: BuildProgressFrame) => void;
  readonly log: (line: string) => void;
}

export const parseBuildRequest = (body: Record<string, unknown>): BuildRequest => {
  const format = body.format;
  if (format !== undefined && format !== 'html' && format !== 'zip') {
    throw new HttpError(400, 'bad_request', '`format` must be "html" or "zip".');
  }
  if (body.entryScene !== undefined && typeof body.entryScene !== 'string') {
    throw new HttpError(400, 'bad_request', '`entryScene` must be a string.');
  }
  return {
    ...(format ? { format } : {}),
    ...(typeof body.compress === 'boolean' ? { compress: body.compress } : {}),
    ...(typeof body.entryScene === 'string' ? { entryScene: body.entryScene } : {}),
  };
};

export class BuildRunner {
  private readonly deps: BuildRunnerDeps;
  private running: Promise<BuildRecord> | null = null;

  constructor(deps: BuildRunnerDeps) {
    this.deps = deps;
  }

  get inProgress(): boolean {
    return this.running !== null;
  }

  async run(request: BuildRequest): Promise<BuildRecord> {
    if (this.running) throw new HttpError(409, 'build_in_progress', 'A build is already running.');
    const promise = this.execute(request);
    this.running = promise;
    try {
      return await promise;
    } finally {
      this.running = null;
    }
  }

  private async execute(request: BuildRequest): Promise<BuildRecord> {
    const { root, broadcast, log } = this.deps;
    broadcast({ type: 'pix3:build', phase: 'flush' });
    const flushed = await this.deps.flush(FLUSH_TIMEOUT_MS);
    if (!flushed.ok) {
      const error = `The editor did not flush its unsaved scenes (${flushed.reason ?? 'unknown'}).`;
      broadcast({ type: 'pix3:build', phase: 'failed', error });
      throw new HttpError(409, 'E_EDITOR_UNSYNCED', error);
    }

    const viteDir = findPackageDir(root, 'vite');
    const viteBin = viteDir ? join(viteDir, 'bin', 'vite.js') : null;
    if (!viteBin || !existsSync(viteBin)) {
      const error = 'vite is not installed in this project (node_modules/vite/bin/vite.js).';
      broadcast({ type: 'pix3:build', phase: 'failed', error });
      throw new HttpError(500, 'vite_missing', error);
    }
    rmSync(buildRecordPath(root), { force: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // The parent flushed already; the child must not ask the editor again.
      PIX3_NO_SYNC: '1',
      ...(request.format ? { PIX3_BUILD_FORMAT: request.format } : {}),
      ...(request.compress !== undefined
        ? { PIX3_BUILD_COMPRESS: request.compress ? '1' : '0' }
        : {}),
      ...(request.entryScene ? { PIX3_ENTRY_SCENE: request.entryScene } : {}),
    };
    broadcast({
      type: 'pix3:build',
      phase: 'start',
      line: `vite build (${request.format ?? 'default'})`,
    });
    log(`build: ${process.execPath} ${viteBin} build`);

    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [viteBin, 'build'], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onData = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          if (line.trim()) broadcast({ type: 'pix3:build', phase: 'output', line });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', exitCode => resolve(exitCode ?? 1));
    });

    const record = code === 0 ? readBuildRecord(root) : null;
    if (!record) {
      const error =
        code === 0
          ? 'vite build finished but left no .pix3/build.json — is pix3() in vite.config with build enabled?'
          : `vite build exited with code ${code}.`;
      broadcast({ type: 'pix3:build', phase: 'failed', error });
      throw new HttpError(500, 'build_failed', error);
    }
    broadcast({ type: 'pix3:build', phase: 'done', record });
    log(`build: ${record.path} (${record.bytes} bytes)`);
    return record;
  }
}
