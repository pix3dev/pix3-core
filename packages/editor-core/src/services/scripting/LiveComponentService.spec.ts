import { SceneManager, Script, type PropertySchema } from '@pix3/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RemoveComponentCommand } from '@/features/scripts/RemoveComponentCommand';
import { UpdateComponentPropertyCommand } from '@/features/scripts/UpdateComponentPropertyCommand';
import { LoadSceneCommand } from '@/features/scene/LoadSceneCommand';
import { ServiceContainer } from '@/fw/di';
import { callBridgeTool } from '@/host/debug-bridge';
import type { ScriptRoots } from '@/host/EditorHost';
import { HostService } from '@/host/HostService';
import { mountEditorWith, type EditorHandle } from '@/host/mount';
import { FakeHost } from '@/host/testing/fake-host';
import { CommandDispatcher } from '@/services/core/CommandDispatcher';
import { OperationService } from '@/services/core/OperationService';
import { appState, resetAppState } from '@/state';

/**
 * A synced script edit replaces the live components built from the old class
 * (`.plans/scripts-vite.md` S7): same id and slot, the file's config, unsaved edits kept, no
 * history entry, no dirty mark.
 */

const SCENE = `version: 1.0.0
root:
  - id: hero
    type: Group2D
    name: Hero
    components:
      - id: mover
        type: user:Mover
        enabled: true
        config:
          speed: 3
`;

/** One version of `scripts/Mover.ts` as Vite would evaluate it: a new class per edit. */
const moverVersion = (fields: readonly string[], defaults: Record<string, unknown> = {}) => {
  class Mover extends Script {
    constructor(id: string, type: string) {
      super(id, type);
      this.config = { ...defaults };
    }

    static getPropertySchema(): PropertySchema {
      return {
        nodeType: 'Mover',
        properties: fields.map(name => ({
          name,
          type: 'number' as const,
          getValue: (s: unknown) => (s as Mover).config[name] ?? 0,
          setValue: (s: unknown, v: unknown) => {
            (s as Mover).config[name] = Number(v);
          },
        })),
        groups: {},
      };
    }
  }
  return Mover;
};

const rootsOf = (Mover: typeof Script, revision: number): ScriptRoots => ({
  editorScripts: { __pix3Revision: revision, modules: { '/scripts/Mover.ts': { Mover } } },
  botPolicies: { __pix3Revision: revision, modules: {} },
});

const service = <T>(ctor: new (...args: never[]) => T): T => {
  const container = ServiceContainer.getInstance();
  return container.getService<T>(container.getOrCreateToken(ctor));
};

describe('LiveComponentService', () => {
  let handle: EditorHandle | null = null;
  let host: FakeHost;
  const V1 = moverVersion(['speed']);
  const V2 = moverVersion(['speed', 'jump'], { jump: 5 });

  const hero = () => service(SceneManager).getActiveSceneGraph()?.nodeMap.get('hero');
  const sync = (revision: number, Mover: typeof Script) =>
    host.handlers.applySync?.({
      rev: revision,
      changed: { 'scripts/Mover.ts': `sha-${revision}` },
      roots: rootsOf(Mover, revision),
    });
  const sceneText = () => new TextDecoder().decode(host.store.get('scenes/main.pix3scene')?.bytes);
  const descriptor = () => Object.values(appState.scenes.descriptors)[0];

  beforeEach(async () => {
    resetAppState();
    host = new FakeHost({
      files: {
        'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  projectId: p-live\n',
        'scenes/main.pix3scene': SCENE,
      },
      roots: rootsOf(V1, 1),
    });
    await host.whenReady();
    handle = await mountEditorWith(document.createElement('div'), host, { shell: false });
    await service(CommandDispatcher).execute(
      new LoadSceneCommand({ filePath: 'res://scenes/main.pix3scene' })
    );
  });

  afterEach(async () => {
    await handle?.dispose();
    handle = null;
    HostService.reset();
    resetAppState();
  });

  it('a clean scene: the instance follows the new class, stays clean, writes nothing new', async () => {
    const old = hero()?.components[0];
    expect(old).toBeInstanceOf(V1);
    const history = service(OperationService).history.snapshot();

    expect(await sync(2, V2)).toMatchObject({ ok: true });

    const fresh = hero()?.components[0];
    expect(fresh).toBeInstanceOf(V2);
    expect(fresh).not.toBe(old);
    expect(fresh).toMatchObject({ id: 'mover', enabled: true, config: { speed: 3, jump: 5 } });
    expect(fresh?.node).toBe(hero());
    expect(old?.node).toBeNull();
    // No history entry, no dirty mark, nothing a flush would write (the new default is not an edit).
    expect(service(OperationService).history.snapshot()).toEqual(history);
    expect(descriptor().isDirty).toBe(false);
    expect(await callBridgeTool('pix3_status')).toMatchObject({ dirty: [], pending: {} });
    // The same script synced again (unchanged module, same class): nothing is replaced.
    expect(await sync(3, V2)).toMatchObject({ ok: true });
    expect(hero()?.components[0]).toBe(fresh);
  });

  it('a script deleted: the component is parked as a load would park it, the scene stays clean, and it comes back', async () => {
    const old = hero()?.components[0];
    const noScripts: ScriptRoots = {
      editorScripts: { __pix3Revision: 2, modules: {} },
      botPolicies: { __pix3Revision: 2, modules: {} },
    };
    const before = sceneText();
    expect(
      await host.handlers.applySync?.({
        rev: 2,
        changed: { 'scripts/Mover.ts': null },
        roots: noScripts,
      })
    ).toMatchObject({ ok: true });
    expect(hero()?.components).toEqual([]);
    expect(old?.node).toBeNull();
    expect(hero()?.pendingComponents).toEqual([
      { id: 'mover', type: 'user:Mover', enabled: true, config: { speed: 3 } },
    ]);
    // Nothing to write: the file keeps the component, exactly as a fresh load would keep it.
    expect(descriptor().isDirty).toBe(false);
    expect(await callBridgeTool('pix3_status')).toMatchObject({ dirty: [], pending: {} });
    expect(sceneText()).toBe(before);

    // The file comes back: the parked definition attaches as an instance of the new class.
    expect(await sync(3, V2)).toMatchObject({ ok: true });
    expect(hero()?.components[0]).toBeInstanceOf(V2);
    expect(hero()?.components[0]).toMatchObject({ id: 'mover', config: { speed: 3, jump: 5 } });
    expect(hero()?.pendingComponents).toEqual([]);
  });

  it('a dirty scene keeps its unsaved edit through the swap, and undo reaches the new instance', async () => {
    await service(CommandDispatcher).execute(
      new UpdateComponentPropertyCommand({
        nodeId: 'hero',
        componentId: 'mover',
        propertyName: 'speed',
        value: 7,
      })
    );
    expect(descriptor().isDirty).toBe(true);

    expect(await sync(2, V2)).toMatchObject({ ok: true });

    const fresh = hero()?.components[0];
    expect(fresh).toBeInstanceOf(V2);
    expect(fresh?.config).toEqual({ speed: 7, jump: 5 });
    expect(descriptor().isDirty).toBe(true);
    const status = await callBridgeTool('pix3_status');
    expect(Object.values(status.pending as Record<string, string[]>).flat()).toEqual([
      expect.stringContaining('speed'),
    ]);

    // Undo of the edit made on the old instance lands on the live one.
    expect(await service(OperationService).undo()).toBe(true);
    expect(hero()?.components[0]).toBe(fresh);
    expect(fresh?.config.speed).toBe(3);
    expect(await service(OperationService).redo()).toBe(true);
    expect(fresh?.config.speed).toBe(7);

    // The flush writes the edit, not the new default.
    expect(await host.handlers.flush?.(1000)).toMatchObject({ ok: true });
    expect(sceneText()).toContain('speed: 7');
    expect(sceneText()).not.toContain('jump');
  });

  it('an old instance an undo brings back is replaced too', async () => {
    await service(CommandDispatcher).execute(
      new RemoveComponentCommand({ nodeId: 'hero', componentId: 'mover' })
    );
    expect(hero()?.components).toHaveLength(0);
    expect(await sync(2, V2)).toMatchObject({ ok: true });

    expect(await service(OperationService).undo()).toBe(true);
    expect(hero()?.components).toHaveLength(1);
    expect(hero()?.components[0]).toBeInstanceOf(V2);
    expect(hero()?.components[0]).toMatchObject({ id: 'mover', config: { speed: 3, jump: 5 } });
  });
});
