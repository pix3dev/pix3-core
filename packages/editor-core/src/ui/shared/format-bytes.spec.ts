import { describe, expect, it } from 'vitest';
import { formatBytes } from '@/ui/shared/format-bytes';

describe('formatBytes', () => {
  it('formats byte values consistently', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});
