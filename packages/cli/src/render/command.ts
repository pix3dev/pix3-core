import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import type { CliIo } from '../io.ts';
import { findProjectRoot } from '../manifest.ts';
import { resolveEsbuild, withCommandBundle } from '../package-root.ts';
import { COMMAND_USAGE } from '../usage.ts';
import { describeChromeNotFound, findChrome, needsNoSandbox } from '../editor/chrome.ts';
import { PipeChrome, type CdpEvent } from '../play/chrome-pipe.ts';
import { ProjectFiles } from '../validate/project.ts';
import { isScriptEntry } from '../script-rule.ts';
import type { RenderRequest, RenderResult } from './types.ts';
import { sha256Hex } from '../fs-util.ts';
import {
  allowedStages,
  checkTransition,
  jobDir,
  newFeedbackLine,
  passMetrics,
  readJob,
  recordPass,
  sheetColumns,
} from '../model/store.ts';
import { MODEL_JOBS_DIR } from '../model/types.ts';

/**
 * `pix3 render` — one scene or prefab (or one node of it) drawn from several sides into one PNG
 * sheet, in a private headless Chrome: the model's own feedback loop. The scene runs as in play
 * (its components start, so `core:MergeStatic` merges and bakes) for `--frames` frames, then a
 * framing camera takes each view. No dev server, no editor: the CLI serves the project's files
 * itself.
 */

interface RenderArgs {
  /** Optional with `--job` (the job's target). */
  readonly scene?: string;
  readonly node?: string;
  /** Unset = the job's, else the default; set ones win over the job and land in its `params`. */
  readonly views?: string;
  readonly size?: number;
  readonly frames: number;
  readonly lights: RenderRequest['lights'];
  readonly background: string;
  readonly reference?: string;
  readonly referenceBackground?: string;
  readonly out?: string;
  readonly json: boolean;
  readonly project?: string;
  /** `--job <id> --stage <name> [--note …] [--force "<reason>"]`: the render is a pass of a model job. */
  readonly job?: string;
  readonly stage?: string;
  readonly note?: string;
  readonly force?: string;
}

const parseRenderArgs = (argv: readonly string[]): RenderArgs | { error: string } | 'help' => {
  let scene: string | undefined;
  let node: string | undefined;
  let views: string | undefined;
  let size: number | undefined;
  let frames = 2;
  let lights: RenderRequest['lights'] = 'auto';
  let background = '#8f9aa6';
  let reference: string | undefined;
  let referenceBackground: string | undefined;
  let out: string | undefined;
  let json = false;
  let project: string | undefined;
  let job: string | undefined;
  let stage: string | undefined;
  let note: string | undefined;
  let force: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg];
    const value = (): string => inline ?? argv[++i] ?? '';
    if (flag === '--help' || flag === '-h') return 'help';
    if (flag === '--json') json = true;
    else if (flag === '--node') node = value();
    else if (flag === '--views') views = value();
    else if (flag === '--size') size = Number(value());
    else if (flag === '--frames') frames = Number(value());
    else if (flag === '--lights') {
      const v = value();
      if (v !== 'auto' && v !== 'studio' && v !== 'scene')
        return { error: '--lights takes auto, studio or scene' };
      lights = v;
    } else if (flag === '--background') background = value();
    else if (flag === '--reference') reference = value();
    else if (flag === '--reference-background') referenceBackground = value();
    else if (flag === '--out') out = value();
    else if (flag === '--project') project = value();
    else if (flag === '--job') job = value();
    else if (flag === '--stage') stage = value();
    else if (flag === '--note') note = value();
    else if (flag === '--force') force = value();
    else if (arg.startsWith('-')) return { error: `unknown argument ${arg}` };
    else if (scene === undefined) scene = arg;
    else return { error: `one scene at a time (got ${scene} and ${arg})` };
  }
  if (!scene && !job) return { error: 'name the scene or prefab to render' };
  if (job === undefined && (stage ?? note ?? force) !== undefined)
    return { error: '--stage, --note and --force belong to --job' };
  if (job !== undefined && !stage) return { error: '--job needs --stage <name>' };
  if (job !== undefined && out !== undefined)
    return { error: '--out and --job exclude each other (a pass goes into the job)' };
  if (force !== undefined && !force.trim()) return { error: '--force takes the reason' };
  if (size !== undefined && (!Number.isInteger(size) || size < 64 || size > 2048))
    return { error: '--size takes a tile size in px, 64–2048' };
  if (!Number.isInteger(frames) || frames < 1)
    return { error: '--frames takes a whole number ≥ 1' };
  if (
    referenceBackground !== undefined &&
    !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(referenceBackground)
  )
    return { error: '--reference-background takes a hex colour like #ffffff' };
  if (referenceBackground !== undefined && reference === undefined && job === undefined)
    return { error: '--reference-background needs --reference' };
  return {
    scene,
    node,
    views,
    size,
    frames,
    lights,
    background,
    reference,
    referenceBackground,
    out,
    json,
    project,
    job,
    stage,
    note,
    force,
  };
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/** The project folder over HTTP (read-only), plus the page, its two scripts and the reference. */
const serve = (root: string, page: Record<string, string | Buffer>): Promise<Server> =>
  new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
      if (page[path] !== undefined) {
        response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(path)] ?? 'text/plain' });
        response.end(page[path]);
        return;
      }
      const file = resolve(root, `.${path}`);
      if (!(file === root || file.startsWith(root + sep)) || !existsSync(file)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const body = readFileSync(file);
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });

export const runRenderCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseRenderArgs(argv);
  if (parsed === 'help') {
    io.stdout(COMMAND_USAGE.render);
    return 0;
  }
  if ('error' in parsed) {
    io.stderr(`pix3 render: ${parsed.error}\n\n${COMMAND_USAGE.render}`);
    return 2;
  }
  const args = parsed;
  const root = args.project ? resolve(io.cwd, args.project) : findProjectRoot(io.cwd);
  if (!root) {
    io.stderr('pix3 render: no pix3project.yaml here or above (or pass --project <dir>)\n');
    return 2;
  }
  // A pass of a model job: the job fills in what the flags leave out; the stage order is checked
  // before Chrome starts (and again when the pass is recorded).
  const job = args.job === undefined ? undefined : readJob(root, args.job);
  if (job && 'error' in job) {
    io.stderr(`pix3 render: ${job.error}\n`);
    return 2;
  }
  if (job) {
    const transition = checkTransition(job, args.stage!, args.force);
    if ('error' in transition) {
      io.stderr(
        `pix3 render: refused: ${transition.error}.\n  Allowed now: ${allowedStages(job).join(', ')}` +
          ` (pix3 model next ${job.id}); to bypass the order: --force "<reason>"\n`
      );
      return 2;
    }
  }
  const scene = args.scene ?? job!.target;
  const node = args.node ?? job?.node ?? undefined;
  const views = args.views ?? job?.views ?? 'iso,front,right,top';
  const size = args.size ?? job?.size ?? 512;
  const sceneFile = scene.startsWith('res://')
    ? join(root, scene.slice(6))
    : resolve(io.cwd, scene);
  if (!existsSync(sceneFile)) {
    io.stderr(`pix3 render: ${sceneFile} does not exist\n`);
    return 2;
  }
  const sceneRes = `res://${relative(root, sceneFile).split(sep).join('/')}`;
  const referenceFile = args.reference
    ? resolve(io.cwd, args.reference)
    : job?.reference
      ? join(jobDir(root, job.id), job.reference)
      : undefined;
  const referenceBackground =
    args.referenceBackground ??
    (args.reference ? undefined : (job?.referenceBackground ?? undefined));
  if (referenceFile && !existsSync(referenceFile)) {
    io.stderr(`pix3 render: the reference ${referenceFile} does not exist\n`);
    return 2;
  }
  const referenceUrl = referenceFile && `/__pix3_render__/reference${extname(referenceFile)}`;
  // Read once: the page draws these bytes and a job's pass records their sha256.
  const referenceBytes = referenceFile ? readFileSync(referenceFile) : undefined;
  const chromePath = findChrome(io.env ?? process.env);
  if (!chromePath) {
    io.stderr(`pix3 render: ${describeChromeNotFound()}\n`);
    return 2;
  }

  const bundle = await import('./bundle.ts');
  const project = new ProjectFiles(root);
  const entries = project.files.filter(file => isScriptEntry(file));
  let scripts = { code: '', stubbed: [] as string[] };
  const esbuild = resolveEsbuild();
  if (entries.length > 0) {
    if (!esbuild) {
      io.stderr('pix3 render: esbuild is not installed, so the project scripts cannot compile\n');
      return 2;
    }
    try {
      scripts = await bundle.compileRenderScripts(esbuild, project, entries);
    } catch (error) {
      io.stderr(`pix3 render: the project scripts do not compile: ${(error as Error).message}\n`);
      return 1;
    }
  }
  const host = await withCommandBundle(
    'render',
    bundle.RENDER_HOST_FILE,
    outdir => bundle.buildRenderBundle(outdir),
    async dir => bundle.readRenderHost(dir)
  );
  const server = await serve(root, {
    '/__pix3_render__/index.html':
      '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
      '<script src="/__pix3_render__/host.js"></script><script src="/__pix3_render__/scripts.js"></script></body></html>',
    '/__pix3_render__/host.js': host,
    '/__pix3_render__/scripts.js': scripts.code,
    ...(referenceBytes && referenceUrl ? { [referenceUrl]: referenceBytes } : {}),
  });
  const chrome = PipeChrome.launch(chromePath.path, {
    noSandbox: needsNoSandbox(chromePath.path, io.env ?? process.env),
  });
  const errors: string[] = [];
  try {
    const session = await chrome.openPage();
    chrome.onEvent((event: CdpEvent) => {
      if (event.sessionId !== session) return;
      if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params.exceptionDetails as {
          text?: string;
          exception?: { description?: string };
        };
        errors.push(details.exception?.description ?? details.text ?? 'an uncaught exception');
      } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
        const parts = (event.params.args as Array<{ value?: unknown; description?: string }>) ?? [];
        errors.push(parts.map(part => String(part.value ?? part.description ?? '')).join(' '));
      }
    });
    await chrome.send('Runtime.enable', {}, session);
    await chrome.send('Page.enable', {}, session);
    const { port } = server.address() as AddressInfo;
    await chrome.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${port}/__pix3_render__/index.html` },
      session
    );
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
      await new Promise(r => setTimeout(r, 100));
      const ready = await chrome
        .evaluate(session, 'document.readyState === "complete" && !!window.__PIX3_RENDER_HOST__')
        .catch(() => false);
      if (ready) break;
    }
    const request: RenderRequest = {
      scene: sceneRes,
      node,
      views,
      size,
      frames: args.frames,
      lights: args.lights,
      background: args.background,
      reference:
        referenceFile && referenceUrl
          ? {
              url: referenceUrl,
              label: `reference  ${basename(referenceFile)}`,
              background: referenceBackground,
            }
          : undefined,
    };
    const result = (await chrome.evaluate(
      session,
      `window.__PIX3_RENDER_HOST__.renderScene(${JSON.stringify(request)}).then(r => r, e => ({ error: String(e && e.stack || e) }))`,
      300_000
    )) as RenderResult | { error: string } | null;
    if (!result || 'error' in result) {
      io.stderr(`pix3 render: ${result ? result.error : 'the page returned nothing'}\n`);
      for (const error of errors) io.stderr(`  page error: ${error}\n`);
      return 1;
    }
    const png = Buffer.from(result.sheet.replace(/^data:image\/png;base64,/, ''), 'base64');
    const details = {
      views: result.views,
      ...result.info,
      look: result.look,
      ...(result.reference && { reference: { file: referenceFile, ...result.reference } }),
      stubbed: scripts.stubbed,
      errors,
    };
    let outFile: string;
    let jobLines = '';
    let jobInfo: { id: string; pass: number; stage: string; forced: string | null } | undefined;
    if (job) {
      // A failed render records no pass.
      if (errors.length > 0) {
        io.stderr('pix3 render: the page logged errors, so no pass was recorded\n');
        for (const error of errors) io.stderr(`  page error: ${error}\n`);
        return 1;
      }
      const sheetViews = [...(referenceFile ? ['reference'] : []), ...result.views];
      const recorded = await recordPass(root, job.id, {
        stage: args.stage!,
        note: args.note ?? null,
        force: args.force,
        params: {
          target: sceneRes,
          node: node ?? null,
          views,
          size,
          lights: args.lights,
          background: args.background,
          frames: args.frames,
          referenceSha256: referenceBytes ? sha256Hex(referenceBytes) : null,
          referenceBackground: referenceBackground ?? null,
        },
        sheetViews,
        cols: sheetColumns(sheetViews.length),
        metrics: passMetrics(result.info, result.look, result.reference),
        sheetPng: png,
        report: { scene: sceneRes, node: node ?? null, ...details },
        now: new Date(),
      });
      if ('error' in recorded) {
        io.stderr(`pix3 render: rendered, but the pass was refused: ${recorded.error}\n`);
        return 2;
      }
      const { pass } = recorded;
      outFile = join(jobDir(root, job.id), ...pass.sheet.file.split('/'));
      jobInfo = { id: job.id, pass: pass.seq, stage: pass.stage, forced: pass.forced };
      jobLines =
        `  pass ${pass.seq} (${pass.stage})${pass.forced ? `, forced: ${pass.forced}` : ''} recorded in ` +
        `${MODEL_JOBS_DIR}/${job.id}/job.json\n${newFeedbackLine(root, recorded.job)}`;
    } else {
      outFile = resolve(
        io.cwd,
        args.out ??
          join(
            root,
            '.pix3',
            'renders',
            `${sceneRes
              .split('/')
              .pop()!
              .replace(/\.pix3scene$/, '')}${node ? `-${node}` : ''}.png`
          )
      );
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, png);
    }
    const report = {
      scene: sceneRes,
      node: node ?? null,
      out: outFile,
      ...details,
      ...(jobInfo && { job: jobInfo }),
    };
    if (args.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else {
      io.stdout(
        `${outFile}\n  ${sceneRes}${node ? ` #${node}` : ''}: ${report.views.join(', ')}; ` +
          `${result.info.meshes} mesh(es), ${result.info.drawCalls} draw call(s), ${result.info.triangles} triangles; ` +
          `size ${result.info.size.join(' × ')}; lights: ${result.info.lights}\n` +
          `  look: ${result.summary.look}\n` +
          (result.summary.reference ? `  reference: ${result.summary.reference}\n` : '') +
          result.info.merges
            .map(
              m =>
                `  core:MergeStatic on ${m.node}: ${m.merged} part(s) → ${m.vertices} vertices, ${m.cached ? 'from the cache' : `${m.ms} ms`}\n`
            )
            .join('') +
          (scripts.stubbed.length ? `  stubbed imports: ${scripts.stubbed.join(', ')}\n` : '') +
          errors.map(e => `  page error: ${e}\n`).join('') +
          jobLines
      );
    }
    return errors.length > 0 ? 1 : 0;
  } catch (error) {
    io.stderr(`pix3 render: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await chrome.close();
    server.close();
  }
};
