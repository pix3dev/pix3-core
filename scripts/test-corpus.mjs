// The write-model corpus specs over another project's scenes as well as the templates
// (`.plans/write-model.md`): saver fixed point + `ScenePatchWriter`/merge on every scene. Local only,
// not CI — the default project is the sibling checkout `../DeepCore` (plan §A.4); pass another
// directory as the first argument or in `PIX3_EXTRA_CORPUS`. Fails when the project is missing, so
// a run never passes on the templates alone by accident.
//
//   npm run test:corpus                 # ../DeepCore
//   npm run test:corpus -- ../OtherGame
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(root, process.argv[2] ?? process.env.PIX3_EXTRA_CORPUS ?? '../DeepCore');
if (!existsSync(join(project, 'pix3project.yaml'))) {
  console.error(`test:corpus: no Pix3 project at ${project} (pix3project.yaml missing)`);
  process.exit(1);
}
console.log(`test:corpus: templates + ${project}`);
const result = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    'packages/runtime/src/core/scene-saver-stability.spec.ts',
    'packages/editor-core/src/core/scene-patch/scene-patch.spec.ts',
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, PIX3_EXTRA_CORPUS: project } }
);
process.exit(result.status ?? 1);
