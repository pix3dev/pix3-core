import { injectable } from '@/fw/di';
import type { ShaderEffectTarget } from '@pix3/runtime';
import { ModalRequests, type ModalRequest } from '@/services/editor/modal-requests';

interface EffectPickerParams {
  /** Effect type ids already attached — hidden from the picker (one-per-type). */
  readonly excludeTypes: string[];
  /**
   * Material family of the host stack — the picker lists only effects that
   * support it. Omitted keeps the legacy (unfiltered) behavior.
   */
  readonly target?: ShaderEffectTarget;
}

export type EffectPickerInstance = ModalRequest<EffectPickerParams, string>;

/**
 * Modal picker for attaching a shader effect to a mesh — mirrors
 * {@link BehaviorPickerService}. `showPicker` resolves to the chosen effect id
 * (e.g. `core:dissolve`) or null if cancelled.
 */
@injectable()
export class EffectPickerService {
  private readonly requests = new ModalRequests<EffectPickerParams, string>('effect-picker');

  showPicker(excludeTypes: string[] = [], target?: ShaderEffectTarget): Promise<string | null> {
    return this.requests.request({ excludeTypes, target });
  }

  getPickers(): EffectPickerInstance[] {
    return this.requests.list();
  }

  subscribe(listener: (pickers: EffectPickerInstance[]) => void): () => void {
    return this.requests.onChange(() => listener(this.requests.list()));
  }

  select(pickerId: string, effectType: string): void {
    this.requests.settle(pickerId, effectType);
  }

  cancel(pickerId: string): void {
    this.requests.settle(pickerId, null);
  }

  dispose(): void {
    this.requests.dispose();
  }
}
