import { injectable, inject } from '@/fw/di';
import { OperationService } from '@/services/core/OperationService';
import { ModalRequests, type ModalRequest } from '@/services/editor/modal-requests';
import {
  UpdateEditorSettingsOperation,
  loadEditorSettings,
} from '@/features/editor/UpdateEditorSettingsOperation';

/** Sidebar section the Editor Settings dialog can open on. */
export type EditorSettingsTab = 'general' | 'images' | 'about';

export type EditorSettingsDialogInstance = ModalRequest<object, never>;

@injectable()
export class EditorSettingsService {
  @inject(OperationService)
  private readonly operationService!: OperationService;

  private readonly requests = new ModalRequests<object, never>('editor-settings', true);
  private initialized = false;
  private initialTab: EditorSettingsTab = 'general';

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const stored = loadEditorSettings();
    if (stored) {
      void this.operationService.invoke(new UpdateEditorSettingsOperation(stored));
    }
  }

  /** The tab the dialog should open on; read once by the dialog in connectedCallback. */
  public getInitialTab(): EditorSettingsTab {
    return this.initialTab;
  }

  public async showSettings(initialTab: EditorSettingsTab = 'general'): Promise<void> {
    if (this.requests.active()) {
      return;
    }
    this.initialTab = initialTab;
    await this.requests.request({});
  }

  public close(): void {
    const dialog = this.requests.active();
    if (dialog) this.requests.settle(dialog.id, null);
  }

  public subscribe(
    listener: (activeDialog: EditorSettingsDialogInstance | null) => void
  ): () => void {
    listener(this.requests.active());
    return this.requests.onChange(() => listener(this.requests.active()));
  }

  public dispose(): void {
    this.requests.dispose();
  }
}
