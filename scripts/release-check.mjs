// `npm run release:check [-- --keep] [-- --pack-only]`: exactly what `npm publish` would ship, and
// whether a user can live on it. Publishes nothing and never talks to npm as anyone.
//
// 1. `npm pack` every workspace package into a temp dir outside the repo (its `prepack` builds
//    included, as `npm publish` runs it), prints name / size / file count of each tarball.
// 2. Checks each tarball: the manifest (no `private`, `publishConfig.tag` = `next` for a prerelease, lockstep version,
//    internal dependencies pinned to exactly that version, licence, every `main` / `bin` / `exports`
//    target present, LICENSE and README present) and the contents — no specs, fixtures, plans,
//    test harnesses, stray source maps, the Spine runtime (plan §A.3: its licence forbids
//    redistributing it), secret-looking files or values, or this machine's absolute paths.
// 3. (Unless `--pack-only`) a scratch project outside the repo, created the way a user creates one:
//    the packed `create-pix3` installed with the packed `@pix3/cli`, its bin run for a 2D project;
//    the project's `@pix3/*` versions asserted equal to the lockstep version, then pointed at the
//    local tarballs (third-party dependencies come from the registry), `npm install`,
//    `npm run check`, `npm run smoke`, `npm run build`, and `dist/index.html` must exist.
//    `--keep` leaves the project for a manual look and prints what to run in it; a failure keeps it too.
//
// Exit 0 when everything passed, 1 otherwise. CI runs `--pack-only` (no install).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--keep', '--pack-only'].includes(arg)) {
    console.error(`release:check: unknown argument "${arg}" (--keep, --pack-only)`);
    process.exit(2);
  }
}
const keep = args.has('--keep');
const packOnly = args.has('--pack-only');

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const { version } = readJson(join(root, 'package.json'));

/** Publish order: each package's internal dependencies come before it. */
const PACKAGES = ['runtime', 'editor-core', 'vite-plugin', 'cli', 'create-pix3'];
const manifests = new Map(
  PACKAGES.map(dir => [dir, readJson(join(root, 'packages', dir, 'package.json'))])
);
const internalNames = new Set([...manifests.values()].map(pkg => pkg.name));

/** Files a package may ship that the generic rules below would refuse. */
const ALLOWED = {
  // The prebuilt editor ships its source maps on purpose (`vite.config.ts` `sourcemap: true`):
  // a stack trace in the user's editor tab points at editor sources.
  'editor-core': [/^dist\/.*\.js\.map$/],
  // `@pix3/runtime/testing` is a published entry (headless game for a project's own specs).
  runtime: [/^src\/testing\//],
};

/** Text a package's files may contain that the FORBIDDEN_TEXT rules below would refuse. */
const ALLOWED_TEXT = {
  // feather-icons ships a webpack bundle that names its own CI checkout; the editor's source maps
  // embed it, and on a GitHub runner (home /home/runner) it reads as our home directory.
  'editor-core': [/\/\*! \/home\/runner\/work\/feather\/feather\/[\w./-]* \*\//g],
};

/** Paths that must never be in a tarball. */
const FORBIDDEN_PATHS = [
  [/\.(spec|test)\.[cm]?[jt]sx?$/, 'a spec'],
  [/\.(spec|test)\.d\.[cm]?ts$/, 'a spec declaration'],
  [
    /(^|\/)(__tests__|__mocks__|__snapshots__|fixtures|test-support|testing)\//,
    'test fixtures / harness',
  ],
  [/\.test-helpers?\.|\.spec-helpers?\./, 'a spec helper'],
  [/(^|\/)\.plans\//, 'a plan'],
  [/(^|\/)\.github\//, 'CI config'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/\.map$/, 'a source map'],
  [/(^|\/)\.(env|npmrc|netrc|pypirc)(\.|$)/, 'a credentials / env file'],
  [/(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$|\.(pem|key|p12|pfx)$/, 'a key file'],
  [/(^|\/)(keys\.json|\.pix3\/)/, 'pix3 local keys / editor metadata'],
  [/\.(log|tgz)$|(^|\/)\.DS_Store$/, 'a log / tarball / OS junk'],
  [/(^|\/)@esotericsoftware\//, 'the Spine runtime'],
];

/** Text that must never be in a shipped file. */
const FORBIDDEN_TEXT = [
  // The Spine Runtimes header (every source file of the official runtimes carries it) and the
  // runtime's own install path, which a bundle or a source map would name.
  [/Spine Runtimes License Agreement/, 'the Spine runtime (its licence header)'],
  [/node_modules\/@esotericsoftware\/spine-/, 'the Spine runtime (bundled from node_modules)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'an npm token'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/, 'an OpenAI / Anthropic key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  // This machine's paths: a build that bakes in where it ran.
  ...[...new Set([root, dirname(root), homedir()])]
    .filter(path => path.length > 1)
    .map(path => [new RegExp(escapeRegExp(path)), `an absolute local path (${path})`]),
  [/(?<![\w.:/-])\/data\/[\w.-]+\//, 'an absolute local path (/data/…)'],
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

const run = (command, commandArgs, options = {}) => {
  const printable = [command, ...commandArgs].join(' ');
  console.log(`\n$ ${printable}${options.cwd ? `   (in ${options.cwd})` : ''}`);
  // npm.cmd cannot be spawned without a shell on Windows. Invoke its JS entry with Node
  // instead, keeping every argument separate (including temp directories with spaces).
  const npmCli = process.env.npm_execpath;
  if (command === 'npm' && process.platform === 'win32') {
    if (!npmCli) throw new Error('Run release:check through npm run release:check.');
    command = process.execPath;
    commandArgs = [npmCli, ...commandArgs];
  }
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${printable} exited with ${result.status ?? result.signal}`);
  }
};

const walk = dir => {
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(dir, path).split(sep).join('/'));
    }
  };
  visit(dir);
  return files.sort();
};

const formatBytes = bytes =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} kB`;

/** Every relative path a manifest promises: `main`, `types`, `bin`, `exports` leaves. */
const promisedPaths = pkg => {
  const paths = [];
  const add = value => {
    if (typeof value === 'string' && value.startsWith('.')) paths.push(value);
    else if (typeof value === 'string') paths.push(`./${value}`);
  };
  add(pkg.main);
  add(pkg.types);
  if (typeof pkg.bin === 'string') add(pkg.bin);
  else for (const value of Object.values(pkg.bin ?? {})) add(value);
  const visit = node => {
    if (typeof node === 'string') {
      if (!node.includes('*')) add(node);
    } else if (node && typeof node === 'object') {
      for (const value of Object.values(node)) visit(value);
    }
  };
  visit(pkg.exports);
  return [...new Set(paths.map(path => path.replace(/^\.\//, '')))];
};

const checkManifest = (dir, pkg, files) => {
  const where = pkg.name ?? dir;
  if (pkg.private) fail(where, '"private": true — npm publish refuses it');
  if (pkg.version !== version) fail(where, `version ${pkg.version}, root is ${version}`);
  if (version.includes('-') && pkg.publishConfig?.tag !== 'next') {
    fail(
      where,
      `publishConfig.tag is ${pkg.publishConfig?.tag ?? 'unset'}; prereleases go to "next"`
    );
  }
  if (pkg.name.startsWith('@') && pkg.publishConfig?.access !== 'public') {
    fail(where, 'publishConfig.access is not "public" (a scoped package publishes restricted)');
  }
  if (pkg.license !== 'Apache-2.0') fail(where, `license ${pkg.license ?? 'unset'}`);
  if (pkg.repository?.directory !== `packages/${dir}`) fail(where, 'repository.directory');
  if (!pkg.engines?.node) fail(where, 'no engines.node');
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (internalNames.has(name) && range !== version) {
        fail(where, `${field}.${name} is "${range}", not exactly ${version}`);
      }
    }
  }
  for (const required of ['package.json', 'LICENSE', 'README.md']) {
    if (!files.includes(required)) fail(where, `${required} missing from the tarball`);
  }
  for (const path of promisedPaths(pkg)) {
    if (!files.includes(path)) fail(where, `package.json names ${path}, not in the tarball`);
  }
  if (pkg.scripts?.prepack === undefined && dir !== 'runtime' && dir !== 'create-pix3') {
    fail(where, 'no prepack: the tarball would ship whatever dist/ happens to hold');
  }
};

const checkContents = (dir, pkg, extracted, files) => {
  const where = pkg.name;
  const allowed = ALLOWED[dir] ?? [];
  for (const path of files) {
    if (allowed.some(pattern => pattern.test(path))) continue;
    for (const [pattern, what] of FORBIDDEN_PATHS) {
      if (pattern.test(path)) fail(where, `${path} is ${what}`);
    }
  }
  for (const path of files) {
    const absolute = join(extracted, path);
    if (statSync(absolute).size > 32 * 1024 * 1024) continue;
    let text = readFileSync(absolute, 'latin1');
    // Blank allowed snippets out, same length, so line numbers stay right.
    for (const pattern of ALLOWED_TEXT[dir] ?? []) {
      text = text.replace(pattern, match => ' '.repeat(match.length));
    }
    for (const [pattern, what] of FORBIDDEN_TEXT) {
      const match = pattern.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split('\n').length;
        fail(where, `${path}:${line} contains ${what}`);
      }
    }
  }
};

const insideRepo = path => {
  const real = realpathSync(path);
  return real === root || real.startsWith(`${root}${sep}`);
};

const scratch = mkdtempSync(join(tmpdir(), 'pix3-release-check-'));
if (insideRepo(scratch)) {
  console.error(`release:check: the temp dir ${scratch} is inside the repo; set TMPDIR elsewhere`);
  process.exit(1);
}
const tarballDir = join(scratch, 'tarballs');
mkdirSync(tarballDir);

let ok = false;
try {
  // 1. Pack.
  const packed = [];
  for (const dir of PACKAGES) {
    const pkgDir = join(root, 'packages', dir);
    const before = new Set(readdirSync(tarballDir));
    run('npm', ['pack', '--pack-destination', tarballDir], { cwd: pkgDir });
    const created = readdirSync(tarballDir).filter(name => !before.has(name));
    if (created.length !== 1)
      throw new Error(`npm pack in ${pkgDir} made ${created.length} tarballs`);
    const tarball = join(tarballDir, created[0]);
    const extracted = join(scratch, 'extracted', dir);
    mkdirSync(extracted, { recursive: true });
    run('tar', ['-xzf', tarball, '-C', extracted, '--strip-components=1']);
    const files = walk(extracted);
    const pkg = readJson(join(extracted, 'package.json'));
    checkManifest(dir, pkg, files);
    checkContents(dir, pkg, extracted, files);
    packed.push({
      dir,
      name: pkg.name,
      tarball,
      bytes: statSync(tarball).size,
      files: files.length,
    });
  }

  console.log(`\nTarballs (${version}), in publish order:`);
  const width = Math.max(...packed.map(entry => entry.name.length));
  for (const entry of packed) {
    console.log(
      `  ${entry.name.padEnd(width)}  ${formatBytes(entry.bytes).padStart(9)}  ${String(entry.files).padStart(4)} files  ${entry.tarball}`
    );
  }
  if (failures.length > 0) throw new Error('the tarballs are not publishable');
  console.log('\nTarball scan: clean.');

  // 2. A user's project on those tarballs.
  if (!packOnly) {
    const tarballOf = new Map(packed.map(entry => [entry.name, entry.tarball]));
    const fileSpec = name => `file:${tarballOf.get(name)}`;

    // `npm create pix3` = install create-pix3 (and the @pix3/cli it depends on), run its bin.
    const creator = join(scratch, 'creator');
    mkdirSync(creator);
    const creatorOverrides = { '@pix3/cli': fileSpec('@pix3/cli') };
    writeFileSync(
      join(creator, 'package.json'),
      `${JSON.stringify(
        {
          name: 'pix3-release-check-creator',
          private: true,
          dependencies: { 'create-pix3': fileSpec('create-pix3'), ...creatorOverrides },
          overrides: creatorOverrides,
        },
        null,
        2
      )}\n`
    );
    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: creator });
    const createBin = join(creator, 'node_modules', 'create-pix3', 'index.js');
    run(process.execPath, [createBin, 'game', '--template', '2d', '--yes'], { cwd: scratch });

    const project = join(scratch, 'game');
    const projectPkgPath = join(project, 'package.json');
    const projectPkg = readJson(projectPkgPath);
    const overrides = {};
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name, range] of Object.entries(projectPkg[field] ?? {})) {
        if (!internalNames.has(name)) continue;
        if (range !== version) fail('starter', `${field}.${name} is "${range}", not ${version}`);
        projectPkg[field][name] = fileSpec(name);
        overrides[name] = fileSpec(name);
      }
    }
    for (const name of ['@pix3/runtime', '@pix3/cli', '@pix3/vite-plugin', '@pix3/editor-core']) {
      if (!(name in overrides)) fail('starter', `package.json does not depend on ${name}`);
    }
    if (failures.length > 0) throw new Error('the starter does not pin the lockstep version');
    // Peers (`@pix3/vite-plugin` and `@pix3/editor-core` → `@pix3/runtime`) resolve to the same
    // tarball; nothing @pix3/* may come from the registry, where this version does not exist yet.
    projectPkg.overrides = { ...projectPkg.overrides, ...overrides };
    writeFileSync(projectPkgPath, `${JSON.stringify(projectPkg, null, 2)}\n`);

    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: project });
    for (const name of Object.keys(overrides)) {
      const installed = readJson(join(project, 'node_modules', name, 'package.json')).version;
      if (installed !== version) fail('starter', `node_modules/${name} is ${installed}`);
    }
    run('npm', ['run', 'check'], { cwd: project });
    run('npm', ['run', 'smoke'], { cwd: project });
    run('npm', ['run', 'build'], { cwd: project });
    const html = join(project, 'dist', 'index.html');
    if (!existsSync(html)) fail('starter', 'npm run build left no dist/index.html');
    else {
      console.log(`\ndist/index.html: ${formatBytes(statSync(html).size)}`);
      // The page runs its bundle as a classic script: one `import.meta` left in it is a syntax
      // error and a black page (2.0.0-alpha.2 shipped that under vite-plugin-singlefile 2.3.4).
      // This project installed today's dependency versions, so this is where such a drift shows.
      const page = readFileSync(html, 'utf8');
      if (/<script\b[^>]*type=["']module["']/i.test(page) || /\bimport\.meta\b/.test(page))
        fail(
          'starter',
          'dist/index.html carries ES-module code in its classic script (black page)'
        );
    }
    if (failures.length > 0) throw new Error('the starter project failed');
    console.log('\nScratch project: install, check, smoke, build — passed.');
  }
  ok = true;
} catch (error) {
  console.error(`\nrelease:check: ${error instanceof Error ? error.message : error}`);
} finally {
  if (failures.length > 0) console.error(`\nProblems:\n  ${failures.join('\n  ')}`);
  if (ok && !keep) {
    rmSync(scratch, { recursive: true, force: true });
  } else {
    const project = existsSync(join(scratch, 'game')) ? ', the project in game/' : '';
    console.log(`\nKept: ${scratch} (tarballs in tarballs/${project}).`);
    if (ok && !packOnly) {
      console.log(
        [
          'Try it:',
          `  cd ${join(scratch, 'game')}`,
          '  npm run dev          # the game at /, the editor at /__pix3/',
          '  npm run editor       # the editor in Chrome for a coding agent',
          '  npx pix3 agent-setup # chrome-devtools-mcp for Claude Code / Codex',
        ].join('\n')
      );
    }
  }
}
console.log(ok ? `\nrelease:check: ${version} is ready to publish.` : '\nrelease:check: FAILED');
process.exit(ok ? 0 : 1);
