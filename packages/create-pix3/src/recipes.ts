/**
 * The recipe catalog `create-pix3` offers: the `recipe-*` templates, each with the one-line pitch an
 * agent (or a person reading `--help`) picks from.
 *
 * Seeded from the editor's Flow catalog (`pix3` repo, `src/services/flow/PrototypeBootstrapService.ts`,
 * `RECIPE_CATALOG`). Flow is gone in pix3-core, and with it the catalog-id → template aliases: here an
 * entry IS its template id. `recipes.spec.ts` holds this list and the shipped `templates/recipe-*`
 * folders to the same set, both ways.
 */
export interface RecipeEntry {
  readonly id: string;
  readonly blurb: string;
}

export const RECIPE_CATALOG: readonly RecipeEntry[] = [
  {
    id: 'recipe-blank-2d',
    blurb:
      "NO mechanics — an empty 2D field with score/lives/timer bookkeeping, a HUD, bloom post-fx, a shape-sprite library and a win/lose overlay already wired; the first increment builds the core mechanic itself, CONTROLS INCLUDED. Pick it when the idea's core loop is not what any recipe below ships: grid or turn-based movement (snake, sokoban, match-3), word/card/board games, builders, clickers and idle games WITHOUT a ball. Deleting a wrong mechanic costs more than building on this blank.",
  },
  {
    id: 'recipe-tapper-2d',
    blurb:
      'objects appear and tapping them is the whole game; timer or lives. Tappers, whack-a-mole, catch-the-falling, clickers.',
  },
  {
    id: 'recipe-arena-2d',
    blurb:
      'an avatar moves in a bounded field while a spawner sends pickups/hazards at it; touching them scores or hurts. Dodgers, collectors, top-down survival, runners. NOT grid or turn-based movement — its steering is continuous.',
  },
  {
    id: 'recipe-bouncer-2d',
    blurb:
      'a ball under gravity bounces off walls, bumpers and an optional paddle, with neon bloom, swept collision and hit juice already wired; the drain can cost a life OR relaunch the ball. Breakout, pong, plinko, pinball, peggle, and idle/builder pinball where the player places bumpers — the falling bouncing ball is the mechanic that survives, even when the paddle goes.',
  },
  {
    id: 'recipe-grid-3d',
    blurb:
      'a solid block of cubes in 3D that you carve by tapping; some cubes are core and cost a life. Voxel carving, 3D minesweeper, layer puzzles, tap-to-mine, "chip away to reveal the shape".',
  },
];

/**
 * Size cap for a recipe's `design/recipe.md`. The agent reads the file whole and its tail is where
 * `## Do not touch` and `## Verify` live, so a recipe that keeps growing pushes its own guardrails
 * out of the part anyone reads. In the editor this was the point where the in-editor agent's prompt
 * cut the file off; pix3-core keeps the number as a budget.
 */
export const MAX_RECIPE_MD_CHARS = 10_000;

/**
 * Headroom the spec insists on under {@link MAX_RECIPE_MD_CHARS}: passing at 9 996 of 10 000 is not
 * passing, because the next sentence anyone adds breaks it.
 */
export const RECIPE_MD_HEADROOM_CHARS = 1_500;
