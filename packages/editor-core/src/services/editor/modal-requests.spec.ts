import { describe, expect, it } from 'vitest';
import { ModalRequests } from '@/services/editor/modal-requests';

describe('ModalRequests', () => {
  it('settles a request with the result its host gives, and closes it', async () => {
    const requests = new ModalRequests<{ readonly target: string }, string>('picker');
    const seen: number[] = [];
    requests.onChange(() => seen.push(requests.list().length));
    const first = requests.request({ target: 'a' });
    const second = requests.request({ target: 'b' });
    expect(requests.list().map(r => [r.id, r.target])).toEqual([
      ['picker-0', 'a'],
      ['picker-1', 'b'],
    ]);
    requests.settle('picker-1', 'chosen');
    requests.settle('picker-0', null);
    expect(await first).toBeNull();
    expect(await second).toBe('chosen');
    expect(seen).toEqual([1, 2, 1, 0]);
  });

  it('a single kind refuses a second request while one is open', async () => {
    const requests = new ModalRequests<object, string>('dialog', true);
    const open = requests.request({});
    expect(await requests.request({})).toBeNull();
    expect(requests.active()?.id).toBe('dialog-0');
    requests.settle('dialog-0', 'ok');
    expect(await open).toBe('ok');
    expect(requests.active()).toBeNull();
  });
});
