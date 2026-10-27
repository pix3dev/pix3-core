import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/**
 * A private headless Chrome for `pix3 play`: its own temp profile, CDP over
 * `--remote-debugging-pipe` (fds 3/4 — no TCP port anyone else could reach), one page target
 * attached in flat mode. Separate from the editor's Chrome on purpose: a play run must not touch
 * the human's or the agent's editor tab, and it is gone when the run is.
 */

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

export class PipeChrome {
  readonly #child: ChildProcess;
  readonly #toChrome: Writable;
  readonly #profile: string;
  #nextId = 1;
  #buffer = '';
  readonly #pending = new Map<number, PendingCall>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();

  private constructor(child: ChildProcess, profile: string) {
    this.#child = child;
    this.#profile = profile;
    this.#toChrome = child.stdio[3] as Writable;
    const fromChrome = child.stdio[4] as Readable;
    fromChrome.setEncoding('utf8');
    fromChrome.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let end = this.#buffer.indexOf('\0');
      while (end >= 0) {
        const raw = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        this.#receive(raw);
        end = this.#buffer.indexOf('\0');
      }
    });
    child.once('exit', () => {
      for (const pending of this.#pending.values()) pending.reject(new Error('Chrome exited'));
      this.#pending.clear();
    });
  }

  static launch(chromePath: string, options: { readonly noSandbox?: boolean } = {}): PipeChrome {
    const profile = mkdtempSync(join(tmpdir(), 'pix3-play-chrome-'));
    const child = spawn(
      chromePath,
      [
        '--headless=new',
        `--user-data-dir=${profile}`,
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        // Headless has no GPU: WebGL through SwiftShader, as on a CI box.
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        // A built game is opened from file://; its single file loads nothing else.
        '--allow-file-access-from-files',
        '--autoplay-policy=no-user-gesture-required',
        ...(options.noSandbox ? ['--no-sandbox'] : []),
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
    );
    return new PipeChrome(child, profile);
  }

  #receive(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) {
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      };
      for (const listener of this.#listeners) listener(event);
    }
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#toChrome.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`
      );
    });
  }

  onEvent(listener: (event: CdpEvent) => void): void {
    this.#listeners.add(listener);
  }

  /** A fresh page, attached in flat mode: its commands carry the returned session id. */
  async openPage(): Promise<string> {
    const { targetId } = (await this.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const { sessionId } = (await this.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    return sessionId;
  }

  /** Evaluate in the page and return the JSON value (a thrown error becomes a rejection). */
  async evaluate(sessionId: string, expression: string, timeoutMs = 30_000): Promise<unknown> {
    const answer = (await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (answer.exceptionDetails) {
      throw new Error(
        answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? 'threw'
      );
    }
    return answer.result?.value;
  }

  async close(): Promise<void> {
    if (this.#child.exitCode === null) {
      const exited = new Promise(resolve => this.#child.once('exit', resolve));
      this.#child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3_000))]);
      if (this.#child.exitCode === null) this.#child.kill('SIGKILL');
    }
    rmSync(this.#profile, { recursive: true, force: true });
  }
}
