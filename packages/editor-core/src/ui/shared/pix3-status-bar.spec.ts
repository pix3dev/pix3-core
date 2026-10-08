import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { LoggingService } from '@/services/core/LoggingService';
import { LayoutManagerService } from '@/core/LayoutManager';
import { HostService } from '@/host/HostService';
import { FakeHost } from '@/host/testing/fake-host';
import { appState, resetAppState } from '@/state';

vi.mock('golden-layout', () => ({ GoldenLayout: class {} }));

type TestStatusBarElement = HTMLElement & { updateComplete: Promise<unknown> };

class LayoutManagerStub {
  showPanel = vi.fn();
}

const settle = async (element: TestStatusBarElement): Promise<void> => {
  // Valtio notifies in a microtask; Lit renders in the next one.
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  await element.updateComplete;
};

const mount = async (): Promise<TestStatusBarElement> => {
  const statusBar = document.createElement('pix3-status-bar') as TestStatusBarElement;
  document.body.appendChild(statusBar);
  await statusBar.updateComplete;
  return statusBar;
};

const hostPill = (element: HTMLElement): HTMLElement | null =>
  element.querySelector<HTMLElement>('.status-host');

beforeAll(async () => {
  await import('./pix3-status-bar');
});

beforeEach(() => {
  const container = ServiceContainer.getInstance();
  container.addService(container.getOrCreateToken(LoggingService), LoggingService, 'singleton');
  container.addService(
    container.getOrCreateToken(LayoutManagerService),
    LayoutManagerStub,
    'singleton'
  );
  HostService.install(new FakeHost({ projectName: 'demo' }));
  appState.project.projectName = 'demo';
});

afterEach(() => {
  document.body.innerHTML = '';
  HostService.reset();
  resetAppState();
  vi.restoreAllMocks();
});

describe('Pix3StatusBar', () => {
  it('shows the editor-core version the dev server reports, and every version in its tooltip', async () => {
    const statusBar = await mount();
    const version = statusBar.querySelector<HTMLElement>('.status-version');
    expect(version?.textContent).toBe('v0.0.0');
    expect(version?.title).toContain('@pix3/vite-plugin 0.0.0');
    expect(version?.title).toContain('Vite 0.0.0');
  });

  it('reports a closed dev-server connection before anything else', async () => {
    appState.project.host.connection = 'closed';
    appState.project.host.writer = 'other';
    const statusBar = await mount();
    expect(hostPill(statusBar)?.classList.contains('is-error')).toBe(true);
    expect(hostPill(statusBar)?.textContent).toContain('Disconnected');
  });

  it('marks a tab without the writer claim read-only', async () => {
    appState.project.host.connection = 'open';
    appState.project.host.writer = 'other';
    const statusBar = await mount();
    expect(hostPill(statusBar)?.textContent).toContain('Read-only');
    expect(hostPill(statusBar)?.title).toContain('another tab');
  });

  it('counts unsaved scenes, then reads Saved once they are written', async () => {
    appState.project.host.connection = 'open';
    appState.project.host.writer = 'self';
    appState.scenes.descriptors['main'] = {
      id: 'main',
      filePath: 'res://scenes/main.pix3scene',
      name: 'main',
      version: '1',
      isDirty: true,
      lastSavedAt: null,
    };
    const statusBar = await mount();
    expect(hostPill(statusBar)?.textContent).toContain('1 unsaved');

    appState.scenes.descriptors['main'].isDirty = false;
    await settle(statusBar);
    expect(hostPill(statusBar)?.textContent).toContain('Saved');
    expect(hostPill(statusBar)?.classList.contains('is-ok')).toBe(true);
  });

  it('lists scenes that changed on disk while edited here', async () => {
    appState.project.host.connection = 'open';
    appState.project.host.writer = 'self';
    appState.project.host.staleScenes = ['scenes/main.pix3scene'];
    const statusBar = await mount();
    expect(hostPill(statusBar)?.textContent).toContain('1 changed on disk');
    expect(hostPill(statusBar)?.title).toContain('scenes/main.pix3scene');
  });

  it('counts new errors and opens the Logs panel when clicked, resetting the count', async () => {
    const statusBar = await mount();
    const container = ServiceContainer.getInstance();
    const logger = container.getService<LoggingService>(container.getOrCreateToken(LoggingService));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.error('boom');
    await settle(statusBar);
    const button = statusBar.querySelector<HTMLButtonElement>('.status-diagnostics');
    expect(button?.classList.contains('error')).toBe(true);
    expect(button?.textContent).toContain('1');

    button?.click();
    await settle(statusBar);
    const layout = container.getService<LayoutManagerStub>(
      container.getOrCreateToken(LayoutManagerService)
    );
    expect(layout.showPanel).toHaveBeenCalledWith('logs');
    expect(statusBar.querySelector('.status-diagnostics')).toBeNull();
  });

  it('shows the play indicator while playing', async () => {
    appState.ui.isPlaying = true;
    const statusBar = await mount();
    expect(statusBar.querySelector('.status-indicator.playing')?.textContent).toContain('Playing');
  });
});
