/**
 * `pix3 play --profile`: the shape of the page's profile (`FrameProfile.report()` in
 * `packages/vite-plugin/player/debug/profile.ts`, which the CLI cannot import — it is browser code
 * against the runtime's types) and its human lines. Only what the lines read is typed here; the
 * JSON report carries the page's object whole.
 */

interface Stats {
  readonly count: number;
  readonly mean: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export interface PlayProfile {
  readonly window: {
    readonly warmup: { readonly seconds: number; readonly frames: number; readonly ticks: number };
    readonly seconds: number;
    readonly frames: number;
    readonly painted: number;
    readonly ticks: number;
    readonly ticksPerFrame: number | null;
    readonly fps: number | null;
    readonly timeMode: {
      readonly mode: string;
      readonly fixedDeltaSec: number;
      readonly ticksPerFrame: number;
      readonly renderEveryNTicks: number;
    };
    readonly gaps: number;
  };
  readonly frame: Stats & { readonly long: number; readonly longPercent: number | null };
  readonly work: Stats;
  readonly logicPerTick: Stats;
  readonly logicPerFrame: Stats;
  readonly render: Stats;
  readonly activities: readonly {
    readonly label: string;
    readonly perTick: { readonly mean: number; readonly max: number };
    readonly perFrameMean: number;
    readonly ticks: number;
  }[];
  readonly renderer: {
    readonly sampled: number;
    readonly calls: { readonly mean: number; readonly max: number };
    readonly triangles: { readonly mean: number; readonly max: number };
    readonly last: {
      readonly calls: number;
      readonly triangles: number;
      readonly geometries: number;
      readonly textures: number;
      readonly programs: number;
    };
    readonly programsLinked: number;
  } | null;
  readonly heapMb: { readonly start: number; readonly end: number; readonly peak: number } | null;
  readonly longAnimationFrames: {
    readonly supported: boolean;
    readonly count: number;
    readonly worst: readonly {
      readonly durationMs: number;
      readonly blockingMs: number;
      readonly script: string | null;
    }[];
  };
  readonly device: {
    readonly gpu: string | null;
    readonly devicePixelRatio: number;
    readonly viewport: string;
    readonly cores: number | null;
  };
  readonly softwareGpu: boolean;
}

const ms = (value: number | null): string =>
  value === null ? '-' : value < 10 ? value.toFixed(2) : value.toFixed(1);

const statsLine = (label: string, stats: Stats): string =>
  `  ${label.padEnd(24)} mean ${ms(stats.mean).padStart(6)}  p50 ${ms(stats.p50).padStart(6)}  p95 ${ms(stats.p95).padStart(6)}  p99 ${ms(stats.p99).padStart(6)}  max ${ms(stats.max).padStart(6)} ms`;

const count = (value: number): string =>
  value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));

const describeTimeMode = (mode: PlayProfile['window']['timeMode']): string =>
  mode.mode === 'realtime'
    ? 'realtime'
    : `${mode.mode}, ${mode.ticksPerFrame} tick(s) of ${(mode.fixedDeltaSec * 1000).toFixed(1)} ms per frame, paint every ${mode.renderEveryNTicks}`;

/** The human report's profile block. */
export const formatProfileHuman = (profile: PlayProfile | { error: string }): string[] => {
  if ('error' in profile) return [`profile: not measured — ${profile.error}`];
  const w = profile.window;
  const lines = [
    `profile: ${w.frames} frame(s), ${w.ticks} logic tick(s) over ${w.seconds.toFixed(1)} s, ${w.fps === null ? '-' : w.fps.toFixed(1)} fps (${describeTimeMode(w.timeMode)}; first ${w.warmup.seconds.toFixed(1)} s / ${w.warmup.frames} frame(s) of warm-up excluded${w.gaps > 0 ? `; ${w.gaps} interval(s) across a pause dropped` : ''})`,
  ];
  if (w.frames === 0) {
    lines.push(
      '  nothing measured after the warm-up: the run (or the bot) ended within it — give it more --seconds / frames'
    );
    return lines;
  }
  lines.push(
    `${statsLine('frame interval (wall)', profile.frame)}  long (>33.4 ms) ${profile.frame.long}${profile.frame.longPercent === null ? '' : ` (${profile.frame.longPercent.toFixed(1)}%)`}`,
    statsLine('work / frame', profile.work),
    statsLine('logic / tick', profile.logicPerTick)
  );
  if (w.ticksPerFrame !== null && Math.abs(w.ticksPerFrame - 1) > 0.01) {
    lines.push(
      statsLine(`logic / frame (${w.ticksPerFrame.toFixed(1)} ticks)`, profile.logicPerFrame)
    );
  }
  lines.push(statsLine(`render / painted frame`, profile.render));
  if (profile.frame.mean !== null && profile.work.mean !== null) {
    const outside = profile.frame.mean - profile.work.mean;
    if (outside > 2) {
      lines.push(
        `  outside the runner: ${ms(outside)} ms of each frame interval is not the game's logic or paint submission (GPU rasterising, compositing, GC, idle waiting for vsync)`
      );
    }
  }
  if (profile.activities.length === 0) {
    lines.push(
      '  activities: none reported (sections come from scene.reportFrameProfilerActivities; the engine reports none of its own)'
    );
  } else {
    lines.push('  activities (self ms per tick: mean / max, per frame mean):');
    for (const activity of profile.activities.slice(0, 12)) {
      lines.push(
        `    ${activity.label.padEnd(28)} ${ms(activity.perTick.mean).padStart(6)} / ${ms(activity.perTick.max).padStart(6)}   ${ms(activity.perFrameMean).padStart(6)} per frame  (${activity.ticks} tick(s))`
      );
    }
    if (profile.activities.length > 12) {
      lines.push(`    … ${profile.activities.length - 12} more in --json`);
    }
  }
  const r = profile.renderer;
  lines.push(
    r
      ? `  renderer (${r.sampled} painted frame(s)): draw calls ${r.calls.mean.toFixed(1)} mean / ${r.calls.max} max, triangles ${count(r.triangles.mean)} / ${count(r.triangles.max)}, geometries ${r.last.geometries}, textures ${r.last.textures}, programs ${r.last.programs} (${r.programsLinked} linked while measured)`
      : '  renderer: no counters (no painted frame, or the page has no renderer to read)'
  );
  if (profile.heapMb) {
    lines.push(
      `  JS heap: ${profile.heapMb.start.toFixed(1)} → ${profile.heapMb.end.toFixed(1)} MB (peak ${profile.heapMb.peak.toFixed(1)})`
    );
  }
  const loaf = profile.longAnimationFrames;
  if (loaf.supported) {
    const worst = loaf.worst[0];
    lines.push(
      `  long animation frames: ${loaf.count}${worst ? ` (worst ${worst.durationMs.toFixed(0)} ms, ${worst.script ?? 'no script attributed'})` : ''}`
    );
  }
  lines.push(
    `  device: ${profile.device.gpu ?? 'unknown GPU'}, DPR ${profile.device.devicePixelRatio}, viewport ${profile.device.viewport}${profile.device.cores ? `, ${profile.device.cores} cores` : ''}`
  );
  if (profile.softwareGpu) {
    lines.push(
      '  note: SOFTWARE GPU (SwiftShader/llvmpipe) — render ms, frame interval and fps are CPU rasterising, not a device; logic ms, activities and renderer counters are representative.'
    );
  }
  if (w.timeMode.mode !== 'realtime') {
    lines.push(
      "  note: fixed ticks — compare logic per tick across runs; a frame carries several ticks, so frame interval and fps are the headless page's throughput, not a game frame rate."
    );
  }
  return lines;
};
