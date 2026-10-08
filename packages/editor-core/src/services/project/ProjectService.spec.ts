import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { HostService } from '@/host/HostService';
import { FakeHost } from '@/host/testing/fake-host';
import { appState, resetAppState } from '@/state';

import { ProjectService } from './ProjectService';

const MANIFEST_WITH_ID = [
  'version: 1.0.0',
  'defaultExportScenePath: scenes/level.pix3scene',
  'metadata:',
  '  projectId: proj-123',
  '',
].join('\n');

const open = async (files: Record<string, string>) => {
  resetAppState();
  const host = new FakeHost({ files, projectName: 'tapper' });
  await host.whenReady();
  HostService.install(host);
  const projects = new ProjectService();
  await projects.openHostProject();
  return { host, projects };
};

afterEach(() => {
  HostService.reset();
});

describe('ProjectService.openHostProject', () => {
  it('opens the dev server project from its manifest', async () => {
    const { projects } = await open({ 'pix3project.yaml': MANIFEST_WITH_ID });
    expect(appState.project).toMatchObject({
      status: 'ready',
      backend: 'host',
      id: 'proj-123',
      projectName: 'tapper',
    });
    expect(appState.project.manifest?.defaultExportScenePath).toBe('scenes/level.pix3scene');
    expect(projects.entryScenePath()).toBe('res://scenes/level.pix3scene');
    expect(appState.project.lastOpenedScenePath).toBe('res://scenes/level.pix3scene');
  });

  it('backfills metadata.projectId once, keeping the rest of the manifest', async () => {
    const { host } = await open({
      'pix3project.yaml': 'version: 1.0.0\nmetadata:\n  owner: igor\n',
    });
    const written = parse(host.text('pix3project.yaml') ?? '') as {
      metadata: { projectId?: string; owner?: string };
    };
    expect(written.metadata.owner).toBe('igor');
    expect(written.metadata.projectId).toMatch(/.+/);
    expect(appState.project.id).toBe(written.metadata.projectId);
  });

  it('opens a folder without a manifest on defaults and does not create one', async () => {
    const { host, projects } = await open({ 'scenes/main.pix3scene': 'root: []\n' });
    expect(appState.project.status).toBe('ready');
    expect(host.text('pix3project.yaml')).toBeNull();
    expect(appState.project.id).toMatch(/^[0-9a-f]{64}$/);
    expect(projects.entryScenePath()).toBe('res://scenes/main.pix3scene');
  });
});
