// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { EditorHost } from '../../../editor-core/src/host/EditorHost.ts';
import { EditorHostConnection } from './index.ts';

/**
 * `EditorHostConnection` is the `EditorHost` `@pix3/editor-core` mounts against. The contract
 * lives in editor-core (`.plans/editor-core-port.md` D1); this type-level check is the only edge
 * between the packages, so the plugin's build carries no editor-core code.
 */
const conforms = (connection: EditorHostConnection): EditorHost => connection;

describe('EditorHostConnection', () => {
  it('is an EditorHost', () => {
    expect(typeof conforms).toBe('function');
  });
});
