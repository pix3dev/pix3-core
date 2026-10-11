/** One open modal request: what its UI renders (`TParams`), and how the UI settles it. */
export type ModalRequest<TParams, TResult> = TParams & {
  readonly id: string;
  /** Settles the request (`null` = cancelled) and closes it. */
  readonly resolve: (result: TResult | null) => void;
};

/**
 * The open requests of one kind of modal (a picker, the import dialog, the settings dialog):
 * `request` returns a promise the modal's host settles through {@link settle}; the shell renders
 * {@link list}. A `single` kind refuses a second request while one is open (it resolves to null).
 */
export class ModalRequests<TParams extends object, TResult> {
  private readonly requests = new Map<string, ModalRequest<TParams, TResult>>();
  private readonly listeners = new Set<() => void>();
  private nextId = 0;

  constructor(
    private readonly idPrefix: string,
    private readonly single = false
  ) {}

  request(params: TParams): Promise<TResult | null> {
    if (this.single && this.requests.size > 0) return Promise.resolve(null);
    return new Promise(resolve => {
      const id = `${this.idPrefix}-${this.nextId++}`;
      this.requests.set(id, {
        ...params,
        id,
        resolve: (result: TResult | null) => {
          this.requests.delete(id);
          this.notify();
          resolve(result);
        },
      });
      this.notify();
    });
  }

  list(): ModalRequest<TParams, TResult>[] {
    return [...this.requests.values()];
  }

  /** The open request of a `single` kind, or null. */
  active(): ModalRequest<TParams, TResult> | null {
    return this.requests.values().next().value ?? null;
  }

  settle(id: string, result: TResult | null): void {
    this.requests.get(id)?.resolve(result);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.requests.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
