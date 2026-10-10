import { describe, expect, it } from 'vitest';

import { pendingDuringPlay } from './SyncApplyService';

describe('pendingDuringPlay', () => {
  it('holds game files for play to stop, but not bot policies (the next run reads them)', () => {
    expect(
      pendingDuringPlay(
        ['scripts/Player.ts', 'design/tests/bots/dodge.ts', 'design/tests/bots/lib/aim.ts'],
        ['scenes/main.pix3scene', 'scripts/Player.ts']
      )
    ).toEqual(['scripts/Player.ts', 'scenes/main.pix3scene']);
    expect(pendingDuringPlay(['design/tests/bots/dodge.ts'], [])).toEqual([]);
    // A helper outside the policy folder may be the game's too: it waits.
    expect(pendingDuringPlay(['design/tests/lib/aim.ts'], [])).toEqual(['design/tests/lib/aim.ts']);
  });
});
