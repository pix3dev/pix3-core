// Gate on the prebuilt editor (`.plans/done/editor-core-port.md` D12, plan §B.2 contract B): the editor
// page carries no `/@vite/client`, so nothing in `dist/` may make Vite inject it — no
// `import.meta.hot`, no CSS import, no non-literal `import()`. Also prints the sizes (S7: ≤ 8 MB).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const problems = [];
const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(dist);

for (const required of [
  'index.js',
  'editor.css',
  'optimize-deps.json',
  'THIRD_PARTY_NOTICES',
  'page-test-host.js',
  'page-test-host.js.map',
]) {
  if (!existsSync(join(dist, required))) problems.push(`missing dist/${required}`);
}
for (const file of files.filter(path => path.endsWith('.js'))) {
  const code = readFileSync(file, 'utf8');
  const name = relative(dist, file);
  if (code.includes('import.meta.hot')) problems.push(`${name}: import.meta.hot`);
  if (code.includes('/@vite/client')) problems.push(`${name}: /@vite/client`);
  if (/\bimport\s*(?:[\w{},*\s]+from\s*)?["'][^"']+\.css["']/.test(code)) {
    problems.push(`${name}: CSS import`);
  }
  for (const match of code.matchAll(/\bimport\(\s*([^)]{0,60})/g)) {
    if (!/^["'`][^"'`$]*["'`]\s*$/.test(match[1].trim())) {
      problems.push(`${name}: non-literal import(${match[1].slice(0, 40)}…)`);
    }
  }
}

// The game page's test host (plan play-in-page S3, D10) is imported by the game's dev page, not the
// editor's: it may import nothing but the page's own `@pix3/runtime` and `three`, and its graph
// (read from its source map) must stay out of the editor — no service outside `game-test` and the
// two dependency-free `core` timers, nothing of `host` but its tool table, no state, DI, UI, `lit`
// or `yaml`.
const PAGE_HOST = join(dist, 'page-test-host.js');
if (existsSync(PAGE_HOST) && existsSync(`${PAGE_HOST}.map`)) {
  const code = readFileSync(PAGE_HOST, 'utf8');
  for (const match of code.matchAll(
    /\b(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g
  )) {
    const specifier = match[1] ?? match[2];
    if (!/^(@pix3\/runtime|three)(\/|$)/.test(specifier)) {
      problems.push(
        `page-test-host.js imports ${specifier} (only @pix3/runtime and three may stay external)`
      );
    }
  }
  const allowed = [
    /^\.\.\/src\/services\/game-test\/[^/]+\.ts$/,
    /^\.\.\/src\/services\/core\/(background-ticker|page-activity)\.ts$/,
    /^\.\.\/src\/core\/agent-introspection\.ts$/,
    // the bridge's tool table: data only, no imports
    /^\.\.\/src\/host\/bridge-tools\.ts$/,
  ];
  const { sources } = JSON.parse(readFileSync(`${PAGE_HOST}.map`, 'utf8'));
  for (const source of sources) {
    if (!allowed.some(pattern => pattern.test(source))) {
      problems.push(
        `page-test-host.js reaches ${source} (the editor: only game-test and its timers may)`
      );
    }
  }
}

const bytes = files
  .filter(path => !path.endsWith('.map'))
  .reduce((sum, path) => sum + statSync(path).size, 0);
console.log(
  `dist: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB without source maps`
);
if (problems.length > 0) {
  console.error(`check-dist failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('check-dist: ok');
