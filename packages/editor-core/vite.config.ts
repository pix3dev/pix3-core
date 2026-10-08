import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { defineConfig, type Plugin } from 'vite';

/**
 * Prebuilt `@pix3/editor-core` (`.plans/editor-core-port.md` §4): one ESM entry with literal lazy
 * chunks, one `editor.css` (the plugin links it from the raw editor page — no CSS import may
 * reach the editor chain, plan §B.2 contract B), the editor's images, the bare subpaths the
 * plugin must pre-bundle, and the notices of what is inlined.
 */

const EXTERNAL = [
  /^@pix3\/runtime(\/|$)/,
  /^three(\/|$)/,
  /^postprocessing$/,
  /^lit(\/|$)/,
  /^@lit\//,
  /^yaml$/,
  /^virtual:pix3\//,
];

const isExternal = (id: string): boolean => EXTERNAL.some(pattern => pattern.test(id));

/**
 * `dist/optimize-deps.json`: every bare external the bundle imports (plan §B.2). The plugin puts
 * all of them in `optimizeDeps.include`: one discovered at runtime makes Vite re-optimize, and the
 * editor page (no Vite client, so no reload) would then mix two copies of `@pix3/runtime` — its DI
 * tokens stop matching (`Service not registered for token: Symbol(SceneManager)`).
 */
const optimizeDepsManifest = (): Plugin => {
  const subpaths = new Set<string>();
  return {
    name: 'pix3-optimize-deps-manifest',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.imports) {
          if (!isExternal(id) || id.startsWith('virtual:')) continue;
          subpaths.add(id);
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: 'optimize-deps.json',
        source: `${JSON.stringify([...subpaths].sort(), null, 2)}\n`,
      });
    },
  };
};

/** `dist/THIRD_PARTY_NOTICES`: the licences of the packages inlined into the bundle. */
const thirdPartyNotices = (): Plugin => {
  const packages = new Map<string, string>();
  return {
    name: 'pix3-third-party-notices',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const moduleId of Object.keys(chunk.modules)) {
          const match = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(moduleId);
          if (!match) continue;
          const name = match[1].replace(/\\/g, '/');
          if (packages.has(name)) continue;
          const dir = moduleId.slice(0, moduleId.indexOf(match[1]) + match[1].length);
          packages.set(name, dir);
        }
      }
      const sections: string[] = [];
      for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          version?: string;
          license?: string;
        };
        let text = '';
        for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
          try {
            text = readFileSync(join(dir, file), 'utf8');
            break;
          } catch {
            // try the next spelling
          }
        }
        sections.push(
          `${name}@${pkg.version ?? '?'} (${pkg.license ?? 'unknown licence'})\n\n${text.trim()}\n`
        );
      }
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES',
        source: `Third-party software inlined into @pix3/editor-core\n\n${sections.join('\n---\n\n')}`,
      });
    },
  };
};

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
    dedupe: ['three'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
      cssFileName: 'editor',
    },
    rollupOptions: {
      external: isExternal,
      output: {
        chunkFileNames: 'chunks/[name]-[hash].js',
        // A stable name: the plugin serves it as `/__pix3/editor.css`.
        assetFileNames: info =>
          info.names.some(name => name.endsWith('.css'))
            ? 'editor.css'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [optimizeDepsManifest(), thirdPartyNotices()],
});

