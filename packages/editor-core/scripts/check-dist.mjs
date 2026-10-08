// Gate on the prebuilt editor (`.plans/editor-core-port.md` D12, plan §B.2 contract B): the editor
// page carries no `/@vite/client`, so nothing in `dist/` may make Vite inject it — no
// `import.meta.hot`, no CSS import, no non-literal `import()`. Also prints the sizes (S7: ≤ 8 MB).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
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

for (const required of ['index.js', 'editor.css', 'optimize-deps.json', 'THIRD_PARTY_NOTICES']) {
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

const bytes = files
  .filter(path => !path.endsWith('.map'))
  .reduce((sum, path) => sum + statSync(path).size, 0);
console.log(`dist: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB without source maps`);
if (problems.length > 0) {
  console.error(`check-dist failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('check-dist: ok');
