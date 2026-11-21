import { setPlatformFallbackAdapter, type AdShow } from '@pix3/runtime';

/**
 * The dev server's stand-in for a portal's ads (`virtual:pix3/dev`; never in a build, where a game
 * without an adapter gets `'unavailable'`). A dark sheet with a play triangle and a ring that runs
 * out: a rewarded show rewards and closes when it does, an interstitial just closes; the cross in
 * the corner closes early (a rewarded show is then `'skipped'`). Pictograms only, no prose. A game
 * that installs its own adapter (`setPlatformAdapter`) never sees it.
 */

const REWARDED_MS = 3000;
const INTERSTITIAL_MS = 1500;
const RING = 2 * Math.PI * 26;

const play = (show: AdShow): void => {
  const sheet = document.createElement('div');
  sheet.dataset.pix3AdPlaceholder = show.id;
  sheet.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(10,10,14,.88)';
  sheet.innerHTML = `
    <svg width="96" height="96" viewBox="0 0 60 60" aria-hidden="true">
      <circle cx="30" cy="30" r="26" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="4"/>
      <circle data-ring cx="30" cy="30" r="26" fill="none" stroke="#ffcf33" stroke-width="4"
        stroke-linecap="round" transform="rotate(-90 30 30)" stroke-dasharray="${RING}" stroke-dashoffset="0"/>
      <path d="M24 19 L42 30 L24 41 Z" fill="#fff"/>
    </svg>
    <button type="button" aria-label="close" style="position:absolute;top:16px;right:16px;width:44px;height:44px;border:0;border-radius:22px;background:rgba(255,255,255,.14);cursor:pointer;display:flex;align-items:center;justify-content:center">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 3 L15 15 M15 3 L3 15" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>
    </button>`;
  const ring = sheet.querySelector<SVGCircleElement>('[data-ring]');
  const durationMs = show.kind === 'rewarded' ? REWARDED_MS : INTERSTITIAL_MS;
  const startedAt = performance.now();
  let frame = 0;
  const finish = (watched: boolean): void => {
    cancelAnimationFrame(frame);
    sheet.remove();
    if (watched) show.rewarded();
    show.closed();
  };
  const step = (): void => {
    const left = Math.max(0, 1 - (performance.now() - startedAt) / durationMs);
    ring?.setAttribute('stroke-dashoffset', String(RING * (1 - left)));
    if (left === 0) finish(true);
    else frame = requestAnimationFrame(step);
  };
  sheet.querySelector('button')?.addEventListener('click', () => finish(false));
  // A hidden tab runs no animation frame: the timer must not stall there.
  setTimeout(() => {
    if (sheet.isConnected) finish(true);
  }, durationMs + 50);
  (document.body ?? document.documentElement).appendChild(sheet);
  show.started();
  frame = requestAnimationFrame(step);
};

/** Install the placeholder as `platform`'s fallback (the dev page, once). */
export const installAdPlaceholder = (): void => {
  setPlatformFallbackAdapter({ showRewarded: play, showInterstitial: play });
};
