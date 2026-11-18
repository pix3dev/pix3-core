import type {
  Operation,
  OperationContext,
  OperationInvokeResult,
  OperationMetadata,
} from '@/core/Operation';
import type { Navigation2DSettings } from '@/state/AppState';

export interface UpdateEditorSettingsParams {
  pauseRenderingOnUnfocus?: boolean;
  keepEditorRunningForAgent?: boolean;
  navigation2D?: Partial<Navigation2DSettings>;
}

export interface EditorSettingsSnapshot {
  pauseRenderingOnUnfocus: boolean;
  keepEditorRunningForAgent: boolean;
  navigation2D: Navigation2DSettings;
}

export const EDITOR_SETTINGS_STORAGE_KEY = 'pix3.editorSettings:v1';

export const loadEditorSettings = (): Partial<EditorSettingsSnapshot> | null => {
  try {
    const raw = localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EditorSettingsSnapshot> | null;
    if (parsed) {
      const result: Partial<EditorSettingsSnapshot> = {};
      if (typeof parsed.pauseRenderingOnUnfocus === 'boolean') {
        result.pauseRenderingOnUnfocus = parsed.pauseRenderingOnUnfocus;
      }
      if (typeof parsed.keepEditorRunningForAgent === 'boolean') {
        result.keepEditorRunningForAgent = parsed.keepEditorRunningForAgent;
      }
      if (parsed.navigation2D && typeof parsed.navigation2D === 'object') {
        const nav2D: Partial<Navigation2DSettings> = {};
        if (typeof parsed.navigation2D.panSensitivity === 'number') {
          nav2D.panSensitivity = parsed.navigation2D.panSensitivity;
        }
        if (typeof parsed.navigation2D.zoomSensitivity === 'number') {
          nav2D.zoomSensitivity = parsed.navigation2D.zoomSensitivity;
        }
        if (Object.keys(nav2D).length > 0) {
          result.navigation2D = nav2D as Navigation2DSettings;
        }
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
};

const persistEditorSettings = (settings: EditorSettingsSnapshot): void => {
  try {
    localStorage.setItem(EDITOR_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore persistence errors
  }
};

export class UpdateEditorSettingsOperation implements Operation<OperationInvokeResult> {
  readonly metadata: OperationMetadata = {
    id: 'editor.update-settings',
    title: 'Update Editor Settings',
    description: 'Update editor-level preferences',
    tags: ['editor', 'settings'],
  };

  constructor(private readonly params: UpdateEditorSettingsParams) {}

  async perform(context: OperationContext): Promise<OperationInvokeResult> {
    const { state, snapshot } = context;
    const prev: EditorSettingsSnapshot = {
      pauseRenderingOnUnfocus: snapshot.ui.pauseRenderingOnUnfocus,
      keepEditorRunningForAgent: snapshot.ui.keepEditorRunningForAgent,
      navigation2D: { ...snapshot.ui.navigation2D },
    };
    const next: EditorSettingsSnapshot = {
      pauseRenderingOnUnfocus: this.params.pauseRenderingOnUnfocus ?? prev.pauseRenderingOnUnfocus,
      keepEditorRunningForAgent:
        this.params.keepEditorRunningForAgent ?? prev.keepEditorRunningForAgent,
      navigation2D: {
        panSensitivity:
          this.params.navigation2D?.panSensitivity ?? prev.navigation2D.panSensitivity,
        zoomSensitivity:
          this.params.navigation2D?.zoomSensitivity ?? prev.navigation2D.zoomSensitivity,
      },
    };

    if (JSON.stringify(next) === JSON.stringify(prev)) {
      return { didMutate: false };
    }

    const apply = (settings: EditorSettingsSnapshot): void => {
      state.ui.pauseRenderingOnUnfocus = settings.pauseRenderingOnUnfocus;
      state.ui.keepEditorRunningForAgent = settings.keepEditorRunningForAgent;
      state.ui.navigation2D = { ...settings.navigation2D };
      persistEditorSettings(settings);
    };
    apply(next);

    return {
      didMutate: true,
      commit: {
        label: 'Update Editor Settings',
        undo: async () => apply(prev),
        redo: async () => apply(next),
      },
    };
  }
}
