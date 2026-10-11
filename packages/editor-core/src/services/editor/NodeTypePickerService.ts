import { injectable } from '@/fw/di';
import { ModalRequests, type ModalRequest } from '@/services/editor/modal-requests';

export type NodeTypePickerInstance = ModalRequest<object, string>;

/** The node type browser: one at a time; resolves to the chosen node type id, or null. */
@injectable()
export class NodeTypePickerService {
  private readonly requests = new ModalRequests<object, string>('node-type-picker', true);

  showPicker(): Promise<string | null> {
    return this.requests.request({});
  }

  select(pickerId: string, nodeTypeId: string): void {
    this.requests.settle(pickerId, nodeTypeId);
  }

  cancel(pickerId: string): void {
    this.requests.settle(pickerId, null);
  }

  subscribe(listener: (activePicker: NodeTypePickerInstance | null) => void): () => void {
    listener(this.requests.active());
    return this.requests.onChange(() => listener(this.requests.active()));
  }

  dispose(): void {
    this.requests.dispose();
  }
}
