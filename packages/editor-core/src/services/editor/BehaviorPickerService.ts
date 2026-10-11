import { injectable } from '@/fw/di';
import type { ComponentTypeInfo } from '@pix3/runtime';
import { ModalRequests, type ModalRequest } from '@/services/editor/modal-requests';

export type ComponentPickerInstance = ModalRequest<object, ComponentTypeInfo>;

@injectable()
export class BehaviorPickerService {
  private readonly requests = new ModalRequests<object, ComponentTypeInfo>('picker');

  /** Show the component picker; resolves to the chosen component, or null if cancelled. */
  showPicker(): Promise<ComponentTypeInfo | null> {
    return this.requests.request({});
  }

  /** The open pickers, for rendering. */
  getPickers(): ComponentPickerInstance[] {
    return this.requests.list();
  }

  subscribe(listener: (pickers: ComponentPickerInstance[]) => void): () => void {
    return this.requests.onChange(() => listener(this.requests.list()));
  }

  select(pickerId: string, component: ComponentTypeInfo): void {
    this.requests.settle(pickerId, component);
  }

  cancel(pickerId: string): void {
    this.requests.settle(pickerId, null);
  }

  dispose(): void {
    this.requests.dispose();
  }
}
