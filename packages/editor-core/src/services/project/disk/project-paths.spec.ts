import { describe, expect, it } from 'vitest';
import { toFolderPath, toProjectPath, toResourcePath } from '@/services/project/disk/project-paths';

describe('project paths', () => {
  it('reduces every spelling of a project file to one key', () => {
    for (const spelling of [
      'res://scenes/a.pix3scene',
      './scenes/a.pix3scene',
      '/scenes\\a.pix3scene',
      'scenes/a.pix3scene/',
    ]) {
      expect(toProjectPath(spelling)).toBe('scenes/a.pix3scene');
    }
  });

  it('names the project root `.` in the folder form', () => {
    expect(toFolderPath('')).toBe('.');
    expect(toFolderPath('.')).toBe('.');
    expect(toFolderPath('./')).toBe('.');
    expect(toFolderPath('res://')).toBe('.');
    expect(toFolderPath('sprites/')).toBe('sprites');
  });

  it('builds a res:// path from any spelling, idempotently', () => {
    expect(toResourcePath('./assets/hero.png')).toBe('res://assets/hero.png');
    expect(toResourcePath('\\assets\\hero.png')).toBe('res://assets/hero.png');
    expect(toResourcePath('res://assets/hero.png')).toBe('res://assets/hero.png');
    expect(toResourcePath('.')).toBe('res://');
    expect(toResourcePath('')).toBe('res://');
  });
});
