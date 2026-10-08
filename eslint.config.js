import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';

/**
 * Rules shared by every TypeScript block. Kept in one place so every package is held to the same
 * standard.
 */
const typescriptRules = {
  ...tseslint.configs.recommended.rules,
  'prettier/prettier': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/explicit-module-boundary-types': 'off',

  // Type-aware promise rules. Both blocks already set `parserOptions.project`, so the type
  // information these need was being computed on every lint run and then not used for anything.
  //
  // `no-floating-promises` is the one that earns its keep: a promise nobody holds is an error that
  // vanishes, and in this app it does not even vanish quietly — the editor and the player both
  // surface `unhandledrejection`, so a dropped rejection reports itself as a phantom runtime error
  // with no context. Marking a deliberate fire-and-forget with `void` is the whole cost.
  //
  // `checksVoidReturn: false` on `no-misused-promises`: an `async` handler passed to
  // `addEventListener` or a Lit `@click` is the normal idiom here, and flagging it would produce
  // hundreds of findings about a pattern that is fine.
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
  '@typescript-eslint/await-thenable': 'error',

  // A tree walk that seeds its cursor with `this` is the idiom throughout the node classes
  // (`getNodeByPath`, ancestor lookups), and a closure that captures the instance needs a name.
  // Neither is the bug this rule exists to catch, so name the ones we mean rather than
  // sprinkling disable comments.
  '@typescript-eslint/no-this-alias': [
    'error',
    {
      allowDestructuring: true,
      allowedNames: ['current', 'root', 'node', 'runner', 'lastContext'],
    },
  ],

  // An empty interface is a deliberate declaration-merging seam here: `SceneNodeNames` is
  // augmented by the editor with the current scene's node names and stays empty everywhere else.
  '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],

  // Base rules TypeScript supersedes. `no-undef` does not know browser or Node globals, and
  // `no-redeclare` reads a function's overload signatures as duplicate declarations.
  'no-undef': 'off',
  'no-redeclare': 'off',
};

export default [
  {
    // Global. A per-block `ignores` only narrows that block, so without this the recommended
    // config below still parses these with the default parser — and template payloads are
    // TypeScript that compiles against the runtime in a generated project, not against this repo.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/create-pix3/templates/*/files/**',
      // Player templates outside the runtime's tsconfig; they move into the plugin (plan §A.1).
      'packages/runtime/src/main.ts',
      'packages/runtime/src/register-project-scripts.ts',
      'packages/runtime/src/generated/**',
      // Not compiling until the port (plan §G.2); linted from then on.
      'packages/editor-core/**',
    ],
  },
  js.configs.recommended,
  ...[
    ['packages/runtime/src/**/*.ts', './packages/runtime/tsconfig.json'],
    // `@pix3/cli` is Node, with its own tsconfig (`.ts` import extensions).
    ['packages/cli/src/**/*.ts', './packages/cli/tsconfig.json'],
    ['packages/vite-plugin/src/**/*.ts', './packages/vite-plugin/tsconfig.json'],
  ].map(([files, project]) => ({
    files: [files],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', project },
    },
    plugins: { '@typescript-eslint': tseslint, prettier },
    rules: typescriptRules,
  })),
];
