// Lockstep versions (plan §A.3): the root package.json version is the one source of truth. Stamps
// it into every workspace package and into each internal `@pix3/*` dependency range, so
// `@pix3/runtime@X` and `@pix3/editor-core@X` are by definition the pair that shipped together.
// Run `npm run version:sync` after bumping the root; never hand-edit a package's `version`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const { version, workspaces } = readJson(join(root, 'package.json'));
const internal = new Set(workspaces.map(dir => readJson(join(root, dir, 'package.json')).name));

for (const dir of workspaces) {
  const path = join(root, dir, 'package.json');
  const pkg = readJson(path);
  const before = JSON.stringify(pkg);
  pkg.version = version;
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (internal.has(name)) pkg[field][name] = version;
    }
  }
  if (JSON.stringify(pkg) !== before) {
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`version:sync: ${pkg.name} -> ${version}`);
  }
}
