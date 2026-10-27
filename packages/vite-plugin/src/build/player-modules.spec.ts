// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { devSource } from './player-modules.ts';

/** `virtual:pix3/dev`: a test run's `?run=` exists on the dev server only (core-tests/game10). */
describe('devSource', () => {
  const evaluate = (source: string, search: string) => {
    const module: Record<string, () => unknown> = {};
    const body = source.replace(/export function (\w+)/g, 'module.$1 = function $1');
    new Function('module', 'location', 'URLSearchParams', 'console', body)(
      module,
      { search },
      URLSearchParams,
      { error: () => {} }
    );
    return module;
  };

  it('reads ?run=<json> on the dev server', () => {
    const dev = devSource('dev', { overlayPath: '/o', editorLinkPath: '/l', editorUrl: null });
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

  it('a build has none of it: no ?run= reader, always null', () => {
    const build = devSource('none');
    expect(build).not.toContain("params.get('run')");
    expect(evaluate(build, '?run=%7B%22seed%22%3A1%7D').devRunOverrides()).toBeNull();
  });
});
