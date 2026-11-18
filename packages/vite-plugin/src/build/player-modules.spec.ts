// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { devSource } from './player-modules.ts';

/** `virtual:pix3/dev`: a test run's `?run=` exists on the dev server only (core-tests/game10). */
describe('devSource', () => {
  /** `meta` stands for the page's `<meta name="pix3-rev">` content. */
  const evaluate = (source: string, search: string, meta: string | null = null) => {
    const module: Record<string, (...args: unknown[]) => unknown> = {};
    const body = source.replace(/export function (\w+)/g, 'module.$1 = function $1');
    const document = {
      querySelector: (selector: string) =>
        meta !== null && selector === 'meta[name="pix3-rev"]' ? { getAttribute: () => meta } : null,
    };
    new Function('module', 'location', 'URLSearchParams', 'console', 'document', body)(
      module,
      { search },
      URLSearchParams,
      { error: () => {} },
      document
    );
    return module;
  };

  it('reads ?run=<json> on the dev server', () => {
    const dev = devSource('dev', {
      overlayPath: '/o',
      editorLinkPath: '/l',
      editorUrl: null,
      testHostPath: null,
    });
    const run = encodeURIComponent(
      JSON.stringify({ seed: 7, config: { game: { rules: { moves: 3 } } } })
    );
    expect(evaluate(dev, `?clean&run=${run}`).devRunOverrides()).toEqual({
      seed: 7,
      config: { game: { rules: { moves: 3 } } },
    });
    expect(evaluate(dev, '?clean').devRunOverrides()).toBeNull();
    expect(evaluate(dev, '?run=%7Bnope').devRunOverrides()).toBeNull();
  });

  it('a build reads no ?run=, only what pix3 play injected before the page loaded (core-tests/game13)', () => {
    const build = devSource('none');
    expect(build).not.toContain("params.get('run')");
    expect(evaluate(build, '?run=%7B%22seed%22%3A1%7D').devRunOverrides()).toBeNull();
    const injected = globalThis as { __PIX3_RUN__?: unknown };
    injected.__PIX3_RUN__ = { seed: 3 };
    try {
      expect(evaluate(build, '').devRunOverrides()).toEqual({ seed: 3 });
      const dev = devSource('dev', {
        overlayPath: '/o',
        editorLinkPath: '/l',
        editorUrl: null,
        testHostPath: null,
      });
      expect(evaluate(dev, '').devRunOverrides()).toEqual({ seed: 3 });
    } finally {
      delete injected.__PIX3_RUN__;
    }
  });

  it('reads the revision the plugin stamped into the page on the dev server, none in a build', () => {
    const dev = devSource('dev', {
      overlayPath: '/o',
      editorLinkPath: '/l',
      editorUrl: null,
      testHostPath: null,
    });
    expect(evaluate(dev, '').devPageRev()).toBeNull();
    expect(evaluate(dev, '', '42').devPageRev()).toBe(42);
    expect(evaluate(devSource('none'), '', '42').devPageRev()).toBeNull();
  });

  it('loads the test host and the bot policies only when asked, and never in a build', async () => {
    const options = { overlayPath: '/o', editorLinkPath: '/l', editorUrl: null };
    const dev = devSource('dev', { ...options, testHostPath: '/h/page-test-host.js' });
    expect(dev).toContain('import(testHostPath)');
    expect(dev).toContain("import('virtual:pix3/bot-policies')");
    expect(dev).toContain('const testHostPath = "/h/page-test-host.js"');
    expect(devSource('none')).not.toContain('bot-policies');

    // Without editor-core the page says why it has no tools, instead of a failed import.
    const state: { loadTools?: () => Promise<boolean> } = {};
    evaluate(devSource('dev', { ...options, testHostPath: null }), '?clean').installDevTools({
      state,
    });
    await expect(state.loadTools?.()).rejects.toThrow('@pix3/editor-core is not installed');
  });
});
