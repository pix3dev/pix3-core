import { injectable } from '@/fw/di';
import { ModalRequests, type ModalRequest } from '@/services/editor/modal-requests';

export interface AssetImportDialogParams {
  /** Project-relative directory the imported files will be copied into (`.` = project root). */
  targetDirectory: string;
}

export interface AssetImportDialogResult {
  /** Project-relative paths of the files that were imported. */
  importedPaths: string[];
}

export type AssetImportDialogInstance = ModalRequest<
  { readonly params: AssetImportDialogParams },
  AssetImportDialogResult
>;

/**
 * Tracks the single active "Import assets" dialog and exposes a Promise-based API.
 * The dialog component performs the actual file copy and reports the imported paths back via {@link confirm}.
 */
@injectable()
export class AssetImportDialogService {
  private readonly requests = new ModalRequests<
    { readonly params: AssetImportDialogParams },
    AssetImportDialogResult
  >('asset-import', true);

  showDialog(params: AssetImportDialogParams): Promise<AssetImportDialogResult | null> {
    return this.requests.request({ params });
  }

  confirm(dialogId: string, result: AssetImportDialogResult): void {
    this.requests.settle(dialogId, result);
  }

  cancel(dialogId: string): void {
    this.requests.settle(dialogId, null);
  }

  subscribe(listener: (activeDialog: AssetImportDialogInstance | null) => void): () => void {
    listener(this.requests.active());
    return this.requests.onChange(() => listener(this.requests.active()));
  }

  dispose(): void {
    this.requests.dispose();
  }
}
