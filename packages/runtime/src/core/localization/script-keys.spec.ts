import { describe, expect, it } from 'vitest';

import { scanScriptLocalizationKeys } from './script-keys';

describe('scanScriptLocalizationKeys', () => {
  it('finds tr-family string-literal keys with line numbers', () => {
    const source = [
      `const a = this.tr('menu.play');`,
      `label.setTextKey("hud.gold", { amount });`,
      `const s = loc.trSprite('btn.skin');`,
      `banner.setText(this.trPlural('wave.failed', n));`,
      `const dyn = this.tr(someVariable); // not a literal — skipped`,
      'const tpl = this.tr(`shop.item.${id}.name`); // interpolated — skipped',
      'const str = toStr("not.a.key"); const t = tr(`plain.template`);',
    ].join('\n');
    expect(scanScriptLocalizationKeys(source)).toEqual([
      { fn: 'tr', key: 'menu.play', line: 1 },
      { fn: 'setTextKey', key: 'hud.gold', line: 2 },
      { fn: 'trSprite', key: 'btn.skin', line: 3 },
      { fn: 'trPlural', key: 'wave.failed', line: 4 },
      { fn: 'tr', key: 'plain.template', line: 7 },
    ]);
  });
});
