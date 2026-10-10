import { registerBuiltInScripts, ScriptRegistry } from '@pix3/runtime';

import { installDocumentTitleSync } from '@/core/document-title';
import { registerSpineModuleLoader } from '@/core/lazy-spine';
import { registerRuntimeServices } from '@/core/register-runtime-services';
import { ServiceContainer } from '@/fw/di';
import { AgentKeepaliveService } from '@/services/core/AgentKeepaliveService';
import { RuntimeErrorBridgeService } from '@/services/play/RuntimeErrorBridgeService';
import { ExternalChangeService } from '@/services/project/disk/ExternalChangeService';
import { ProjectService } from '@/services/project/ProjectService';
import { ProjectStorageService } from '@/services/project/ProjectStorageService';
import { FlushService } from '@/services/project/FlushService';
import { SceneBaselineService } from '@/services/project/SceneBaselineService';
import { SceneDraftService } from '@/services/project/SceneDraftService';
import { LocalizationEditorService } from '@/services/localization/LocalizationEditorService';
import { LiveComponentService } from '@/services/scripting/LiveComponentService';
import { ProjectScriptLoaderService } from '@/services/scripting/ProjectScriptLoaderService';
import { appState } from '@/state';

import { installDebugBridge } from './debug-bridge';
import type { EditorHost } from './EditorHost';
import { ExternalReloadService } from './ExternalReloadService';
import { HostService } from './HostService';
import { SyncApplyService } from './SyncApplyService';
import { WriterService } from './WriterService';

export interface EditorHandle {
  dispose(): Promise<void>;
}

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

/** Tag of the editor shell custom element (`ui/pix3-editor-shell.ts`). */
export const EDITOR_SHELL_TAG = 'pix3-editor';

/**
 * Boot the editor into `el` against `host` (`.plans/editor-core-port.md` §2.1): no router, no
 * welcome screen, no project picker — one host, one project. The order matters: the host first
 * (every storage call goes through it), then runtime services and scripts, then the project, then
 * the writer claim and the sync handlers, then the UI.
 */
export async function mountEditorWith(
  el: HTMLElement,
  host: EditorHost,
  options: { readonly shell?: boolean } = {}
): Promise<EditorHandle> {
  HostService.install(host);

  registerRuntimeServices();
  registerSpineModuleLoader();
  registerBuiltInScripts(service(ScriptRegistry));
  service(RuntimeErrorBridgeService).initialize();
  installDocumentTitleSync();
  service(AgentKeepaliveService).initialize();

  const scripts = service(ProjectScriptLoaderService);
  scripts.registerRoots(host.scripts.current());
  // A script edited during play applies when play stops (`queueRoots` defers it).
  const disposers: Array<() => void> = [host.scripts.onChange(roots => scripts.queueRoots(roots))];

  await service(ProjectService).openHostProject();

  const externalChanges = service(ExternalChangeService);
  externalChanges.initialize();
  service(ExternalReloadService).start();
  disposers.push(
    host.events.onFs(frame => {
      service(ProjectStorageService).applyFrame(frame);
      externalChanges.reportFrame(frame);
    }),
    host.events.onConnection(state => {
      appState.project.host.connection = state;
    })
  );
  appState.project.host.connection = 'open';

  const writer = service(WriterService);
  await writer.claimAtLoad();

  const sceneWrite = service(FlushService);
  sceneWrite.start();
  const drafts = service(SceneDraftService);
  drafts.start();
  const syncApply = service(SyncApplyService);
  host.sync.setHandlers({
    flush: async timeoutMs => {
      // Locale tables write through; one whose write failed without a conflict goes now.
      await service(LocalizationEditorService).flush();
      return sceneWrite.flushDirty(timeoutMs);
    },
    applySync: info => syncApply.apply(info),
  });

  installDebugBridge();

  if (options.shell !== false) {
    await import('@/ui/pix3-editor-shell');
    el.append(document.createElement(EDITOR_SHELL_TAG));
  }

  return {
    async dispose() {
      for (const dispose of disposers) dispose();
      host.sync.setHandlers({});
      sceneWrite.dispose();
      drafts.dispose();
      writer.dispose();
      service(ExternalReloadService).dispose();
      service(LiveComponentService).dispose();
      // Per-file memory of this mount (pending external versions, baselines) goes with it.
      externalChanges.reset();
      service(SceneBaselineService).reset();
      service(ProjectStorageService).reset();
      el.replaceChildren();
    },
  };
}
