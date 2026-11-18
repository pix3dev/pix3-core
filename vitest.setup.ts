/**
 * Node 24 exposes a `localStorage` global that throws on every method unless the process was
 * started with a valid `--localstorage-file`, and it shadows the one happy-dom installs. Any spec
 * that touched storage therefore died on the first call — silently, as a whole-file failure — so
 * several suites (agent settings, the model catalog, library sources) were not running at all.
 *
 * Swap in a plain in-memory Storage whenever the ambient one cannot do the job. Deliberately not a
 * per-file stub: the trap is invisible from inside a spec, and the next spec to persist something
 * would fall into it again.
 */
const createMemoryStorage = (): Storage => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  } as Storage;
};

const isUsable = (storage: Storage | undefined): boolean => {
  try {
    storage?.setItem('__pix3_probe__', '1');
    storage?.removeItem('__pix3_probe__');
    return typeof storage?.clear === 'function';
  } catch {
    return false;
  }
};

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (!isUsable(globalThis[name] as Storage | undefined)) {
    Object.defineProperty(globalThis, name, {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}

/**
 * The specs run in worker threads of one process, and Node's `BroadcastChannel` reaches every
 * thread: the editor ↔ game page link (`pix3-play-pages`) of one spec file answered the fake pages
 * of another running beside it. Each spec file gets channels of its own.
 */
const NativeBroadcastChannel = globalThis.BroadcastChannel;
if (NativeBroadcastChannel) {
  const scope = `spec-${Math.random().toString(36).slice(2)}`;
  globalThis.BroadcastChannel = class extends NativeBroadcastChannel {
    constructor(name: string) {
      super(`${scope}/${name}`);
    }
  };
}
