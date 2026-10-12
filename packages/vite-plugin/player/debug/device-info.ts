/** What the debug overlay shows about the device (the 1.x remote preview's `device-info`). */
export interface DeviceInfo {
  readonly userAgent: string;
  /** `UNMASKED_RENDERER_WEBGL` when the browser exposes it, else `RENDERER`. */
  readonly gpu: string | null;
  readonly devicePixelRatio: number;
  readonly screen: string;
  readonly viewport: string;
  /** `navigator.deviceMemory` (Chromium, coarse and capped at 8). */
  readonly memoryGb: number | null;
  readonly cores: number | null;
}

/** A throwaway GL context: the game's own context is not touched. */
const readGpu = (): string | null => {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return null;
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer: unknown = gl.getParameter(
      debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER
    );
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof renderer === 'string' && renderer.length > 0 ? renderer : null;
  } catch {
    return null;
  }
};

let gpu: string | null | undefined;

export const readDeviceInfo = (): DeviceInfo => {
  if (gpu === undefined) gpu = readGpu();
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    gpu,
    devicePixelRatio: window.devicePixelRatio || 1,
    screen: `${window.screen?.width ?? 0}×${window.screen?.height ?? 0}`,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
  };
};

interface MemoryPerformance extends Performance {
  readonly memory?: { readonly usedJSHeapSize: number };
}

/** Used JS heap in MiB (`performance.memory`, Chromium only). */
export const readHeapMb = (): number | null => {
  const used = (performance as MemoryPerformance).memory?.usedJSHeapSize;
  return typeof used === 'number' && Number.isFinite(used) ? used / (1024 * 1024) : null;
};
