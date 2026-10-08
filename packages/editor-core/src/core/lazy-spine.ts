import { setSpineModuleLoader, type SpineModule } from '@pix3/runtime';
import { loadSpine } from 'virtual:pix3/spine-loader';

/**
 * Registers the lazy loader for `@esotericsoftware/spine-threejs` with the runtime.
 *
 * The runtime never imports Spine itself — it declares the module contract and lets the host
 * provide it (`setSpineModuleLoader`). The editor is a prebuilt package, so the literal `import()`
 * lives in the plugin's `virtual:pix3/spine-loader`, which resolves to `null` when the project does
 * not install Spine (a literal import of a missing optional peer kills the importing module — plan
 * §B.2, S1 finding 6).
 */
export function registerSpineModuleLoader(): void {
  setSpineModuleLoader(async () => {
    const spine = await loadSpine();
    if (!spine) {
      throw new Error(
        'This scene uses Spine, but @esotericsoftware/spine-threejs is not installed in the project.'
      );
    }
    return spine as SpineModule;
  });
}
