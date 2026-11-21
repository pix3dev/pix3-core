---
name: pix3-mobile
description: How a Pix3 game lives on a phone — in a mobile browser or inside a native shell (Capacitor, WKWebView, Android WebView) — what the engine already does about background / foreground, the back button, safe-area insets, haptics and the save, and what the game and the shell still wire themselves: `scene.app`, `window.__pix3Back` / `window.__pix3SetInsets`, the haptics adapter (Capacitor Haptics), the storage adapter (Capacitor Preferences) with a cloud-save merge, the portal / ads adapter, the iOS audio trap, texture memory budgets and a shell checklist. Use when the game targets phones, when you wrap it in a native shell, or when a device bug reads as "blank / frozen / silent after returning", "the back button quits", "the HUD is under the notch".
---

<!-- Pix3 agent kit {{version}} -->
# The game on a phone

Every item here cost a real game a device bug report. Most of it the engine already does — your
job is to **not** do it a second time, and to wire the few things only the game or its shell can.

## What the engine already does (never re-implement it)

- **Background / foreground.** The page going hidden (`visibilitychange`, `pagehide` / `pageshow`
  incl. bfcache, `freeze` / `resume`) pauses the runner: time, tweens, scripts and audio stand
  still, held pointers are dropped, `scene.storage` and `scene.analytics` flush. The first tick
  back plays 0 s and no realtime tick is longer than 0.1 s, so a long hitch never lands at once.
  Never listen to `visibilitychange` / `blur` / `popstate`, never run your own
  `requestAnimationFrame` loop, never mute audio yourself.
- **A throw does not kill the loop.** A component that throws in `onStart` / `onUpdate` is disabled
  and the game keeps running (`pix3-scripts` → "Traps"); read `pix3 smoke`'s `E_SMOKE_SCRIPT`.
- **Safe area.** `layout.safeArea` on the HUD's anchored nodes keeps them off the notch and the
  home indicator; the player reads `env(safe-area-inset-*)` on every resize and rotation.
- **Haptics** throttled by weight, **reduced motion**, **the save** read before the first
  `onStart` and written a moment after each change — all on `this.scene` (`pix3-scripts` →
  "`this.scene`").

## What the game does (`this.scene.app`)

```ts
onStart(): void {
  const app = this.scene.app;
  app.onBackground(this, () => this.showPauseOverlay()); // the save flushes by itself
  app.onForeground(this, ({ awayMs }) => {
    if (awayMs > 30_000) this.showPauseOverlay(); // back after a while: let the player re-enter
  });
}

openSettings(): void {
  this.settings.visible = true;
  this.closeBack = this.scene.app.pushBack(this, () => {
    this.closeSettings();
    return true; // handled: the back press does not leave the game
  });
}

closeSettings(): void {
  this.settings.visible = false;
  this.closeBack?.(); // pop the handler with the popup
  this.closeBack = null;
}
```

Subscriptions die with their owner (the first argument) — no `onDetach` cleanup. A back press with
no handler left answers `false`, and the shell decides (minimise, a quit dialog). Test it headless:
`bot.background(ms)` in a bot policy is the round trip; `pix3 play --safe-area 47,0,34,0
--size 390x844@3` puts an iPhone notch over the HUD; `pix3 play --reduced-motion`.

## The native shell (Capacitor)

The shell reaches the game through **one file**, `src/shell.ts`, imported by `src/main.ts`; no
other game file imports `@capacitor/*`. Adapters go in **before** `startGame` (the save is read
during it); the `window` hooks exist only **after** it.

```ts
// src/main.ts
import { startGame } from '@pix3/vite-plugin/player';
import { installShellAdapters, wireShell } from './shell';

installShellAdapters();
void startGame('#app').then(wireShell);
```

```ts
// src/shell.ts — the only file that knows about Capacitor
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Preferences } from '@capacitor/preferences';
import { setHapticsAdapter, setStorageAdapter } from '@pix3/runtime';

const native = Capacitor.isNativePlatform(); // a browser keeps the engine's defaults

export function installShellAdapters(): void {
  if (!native) return;
  // WKWebView may evict localStorage under storage pressure; Preferences is UserDefaults /
  // SharedPreferences. The key is the engine's (`pix3:<namespace>:save`, `…:editor` in Play).
  setStorageAdapter({
    read: async key => (await Preferences.get({ key })).value,
    write: async (key, snapshot) => Preferences.set({ key, value: snapshot }),
  });
  // iOS Safari has no navigator.vibrate: without this adapter an iPhone never buzzes.
  void Haptics.selectionStart();
  setHapticsAdapter({
    play(kind) {
      if (kind === 'selection') void Haptics.selectionChanged();
      else if (kind === 'success') void Haptics.notification({ type: NotificationType.Success });
      else if (kind === 'warning') void Haptics.notification({ type: NotificationType.Warning });
      else if (kind === 'error') void Haptics.notification({ type: NotificationType.Error });
      else {
        const style = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy }[kind];
        void Haptics.impact({ style });
      }
    },
    vibrate: pattern =>
      void Haptics.vibrate({ duration: typeof pattern === 'number' ? pattern : (pattern[0] ?? 0) }),
  });
}

export function wireShell(): void {
  if (!native) return;
  // Android's back button: the game's pushBack stack first, then leave like any app.
  void App.addListener('backButton', () => {
    if (!window.__pix3Back?.()) void App.minimizeApp();
  });
  // Insets from native when the WebView reads env() as 0. Any plugin that reports CSS px works;
  // with capacitor-plugin-safe-area:
  //   const push = ({ insets: i }) => window.__pix3SetInsets?.(i.top, i.right, i.bottom, i.left);
  //   void SafeArea.getSafeAreaInsets().then(push);
  //   void SafeArea.addListener('safeAreaChanged', push);
  // `window.__pix3SetInsets()` with no numbers goes back to the env() probe.
}

declare global {
  interface Window {
    __pix3Back?: () => boolean;
    __pix3SetInsets?: (top?: number, right?: number, bottom?: number, left?: number) => void;
  }
}
```

With a shell that calls `__pix3Back`, set `app: { backButton: false }` in `pix3project.yaml`: the
page then arms no history entry of its own, and the back press has one path. Ads, rewarded video
and level events go through `setPlatformAdapter` — the 30-line adapter in `pix3-scripts` → "Ads
and level events"; AdMob or a portal SDK is mapped there the same way.

## A cloud save: merge two snapshots

A save that follows the player across devices is the storage adapter's job, in `read`: load both
sides, merge, return one snapshot. The merge is a **pure function** of the game's — no storage,
no network — so it can be checked with plain inputs. A snapshot is what `scene.storage.export()`
gives, `{"version":n,"data":{…}}`; when each side was saved is the adapter's own record.

```ts
// src/save-merge.ts — which key merges how is this game's table.
interface Side { json: string | null; savedAt: number }
interface Save { version: number; data: Record<string, unknown> }

const parse = (json: string | null): Save | null => {
  try {
    const save = json ? (JSON.parse(json) as Save) : null;
    return save && typeof save.data === 'object' && save.data ? save : null;
  } catch {
    return null;
  }
};
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const max = (a: unknown, b: unknown) => Math.max(num(a), num(b));
const union = (a: unknown, b: unknown) => [...new Set([...[a, b].flatMap(v => (Array.isArray(v) ? v : []))])];
const maxEach = (a: unknown, b: unknown) => {
  const out: Record<string, number> = { ...(a as Record<string, number>) };
  for (const [k, v] of Object.entries((b ?? {}) as Record<string, number>)) out[k] = max(out[k], v);
  return out;
};

const RULES: Record<string, (a: unknown, b: unknown) => unknown> = {
  best: max, // progress only grows: a reinstall must never lose it
  level: max,
  stars: maxEach, // { "1": 3, "2": 1 } per level
  unlocked: union, // owned skins, seen tutorials — never taken back
  // coins, settings and every key not listed: the side saved last
};

export function mergeSaves(local: Side, cloud: Side | null): string | null {
  const l = parse(local.json);
  const c = cloud ? parse(cloud.json) : null;
  if (!c) return local.json;
  if (!l) return cloud!.json; // a fresh install: the cloud's
  if (l.version !== c.version) return l.version > c.version ? local.json : cloud!.json;
  const localNewer = local.savedAt >= cloud!.savedAt;
  // An empty local save newer than the cloud is a reset the player asked for — keep it empty.
  if (localNewer && Object.keys(l.data).length === 0) return local.json;
  const [newer, older] = localNewer ? [l, c] : [c, l];
  const data = { ...older.data, ...newer.data };
  for (const [key, rule] of Object.entries(RULES)) {
    if (key in l.data && key in c.data) data[key] = rule(l.data[key], c.data[key]);
  }
  return JSON.stringify({ version: l.version, data });
}
```

In the adapter: `read` loads the local snapshot and its time (a sidecar key, `${key}:at`), loads
the cloud's **with a timeout** (2–3 s — the game does not start until `read` answers; offline is
"no cloud"), returns `mergeSaves(…)`, and writes the merged one back to both sides when it differs.
`write` saves locally with `Date.now()` and sends the cloud copy without awaiting it. Versions that
differ are not merged (the engine migrates after `read`): the newer schema wins whole. Test runs
(`pix3 play --storage …`, `pix3 smoke`) bypass the adapter, so the merge is checked as a function.

## iOS audio

The engine starts audio on the first touch, mutes it in the background and resumes it on return.
iOS can hand back, after a lock / unlock or a phone call, a context that says `running` while
nothing sounds (its clock does not advance); the engine does not detect that yet. On a device:
lock and unlock mid-game, take a call, switch apps with music playing — and if the game comes back
silent, record it with `pix3 gap "iOS audio silent after <what>" --kind capability`.

## Texture memory

A texture costs **width × height × 4 bytes** in GPU memory whatever its PNG weighs (3D textures
⅓ more for mipmaps; 2D ones have none): 2048 × 2048 = 16 MiB, 4096 × 4096 = 64 MiB. A 2 GB
phone kills a WebView that grows past roughly 200 MB, the page included.

- Keep the sum of what one scene shows under **~100 MiB**, every texture ≤ **2048 px** a side.
- Art at about twice its largest on-screen size in design units — not four times.
- Read the totals, do not guess: `dist/<name>.report.json` lists every shipped asset;
  `pix3 play dist --profile` reports textures, draw calls and the JS heap of a real run.
- A device that reloads the page after a while in the background ran out of memory — not a bug
  in the lifecycle.

## Shell checklist

- [ ] `src/shell.ts` is the only file importing `@capacitor/*`; adapters before `startGame`,
      `window` hooks after it; a browser build runs without the shell.
- [ ] Back: Android's button → `window.__pix3Back()`, `false` → minimise; `app.backButton: false`.
- [ ] Insets: on a notched iPhone the HUD clears the notch and the home indicator — from `env()`
      or `window.__pix3SetInsets`.
- [ ] Haptics: `setHapticsAdapter` with Capacitor Haptics; an iPhone buzzes on `play('light')`.
- [ ] Save: `setStorageAdapter` with Preferences; kill the app right after a change, reopen — the
      change is there. A cloud merge, if any, checked as a pure function.
- [ ] Lifecycle on the device: home button and back — the game pauses, the music stops, the save
      survives; back in — no burst of missed sounds, the first frame does not jump.
- [ ] Audio after a lock / unlock and a phone call (above).
- [ ] Portrait / landscape locked as the design viewport is; `viewport-fit=cover` in
      `index.html`'s viewport meta.
- [ ] Android: hardware acceleration on; assets from the app bundle over `https://`
      (Capacitor's default scheme).
- [ ] Texture totals under the budget on the cheapest phone you name; measured on it, not in
      desktop Chrome's device emulation (it says nothing about GPU fill rate).
