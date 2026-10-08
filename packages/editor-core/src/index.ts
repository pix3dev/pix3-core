import 'reflect-metadata';
import 'golden-layout/dist/css/goldenlayout-base.css';
import 'golden-layout/dist/css/themes/goldenlayout-dark-theme.css';
import './index.css';

import type { EditorHost } from './host/EditorHost';
import { mountEditorWith, type EditorHandle } from './host/mount';

export type * from './host/EditorHost';
export { hostFailureOf } from './host/EditorHost';
export type { EditorHandle } from './host/mount';

/**
 * Mount the Pix3 editor into `el`, talking to the dev server through `host` (plan §A.1).
 * `@pix3/vite-plugin`'s `virtual:pix3/editor-host` calls this once the host is connected.
 */
export function mountEditor(el: HTMLElement, host: EditorHost): Promise<EditorHandle> {
  return mountEditorWith(el, host);
}
