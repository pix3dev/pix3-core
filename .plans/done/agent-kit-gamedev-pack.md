# Agent kit: what to take from awesome-gamedev-agent-skills

Date: 2026-10-24. Source reviewed: [gamedev-skills/awesome-gamedev-agent-skills](https://github.com/gamedev-skills/awesome-gamedev-agent-skills)
(76 Agent Skills + a router, Apache-2.0). Second opinion: an independent review pass on the same
recommendations (verdicts folded in below).

## 0. Decisions

| # | Decision | Why |
|---|---|---|
| G1 | **Do not install or vendor the pack.** | Its router fingerprints three.js by a `three` dependency (`router/SKILL.md`, row 8, first match wins); our starter pins `three` (`packages/create-pix3/templates/base/files/package.json`), so a globally installed router loads `threejs-scene-setup` (hand-rolled `WebGLRenderer` + `setAnimationLoop`, r186 vs our 0.183) — the opposite of the kit's `startGame` + `.pix3scene` rule. No engine match falls back to Godot. |
| G2 | **Paraphrase, never copy.** | Apache-2.0: verbatim text in the kit tarball (which ships into user projects) would need LICENSE + NOTICE carried along. Methodology in our own words needs nothing. |
| G3 | **No Python validator.** Three assertions in `packages/cli/src/kit.spec.ts` instead. | `kit.spec.ts` already checks front matter and name == folder; the pack's script would reject our layout (loose `reference.md`) and add a Python toolchain to a Node CI. |
| G4 | **No genre / prototype / jam / engine skills.** | Engine-foreign code (Godot/Unity/pygame); rule 1 "playable change first" already covers prototyping. |
| G5 | **No trauma accumulator for shake.** | `scene.juice.shake` has no accumulate semantic; teaching one invites a parallel shake system. Take only the tiers and the "returns to rest / never blocks input" rules. |
| G6 | **No asset brief / JSON manifest files.** | Conflicts with "read the one file you change"; take only "approve one, then the family" and "record source and licence". |

## 1. Work

| # | Change | Where |
|---|---|---|
| K1 | Precedence: generic three.js / gamedev-router skills do not apply to a Pix3 project; `pix3-*` skills win on engine facts. | `kit-src/AGENTS.md` §"New-game architecture"; engine checkout `CLAUDE.md` (agents building games in this repo). |
| K2 | Juice proportion: small/medium/large tiers by event importance; juice is transient (returns to rest), never blocks input, hitstop/shake only on impacts. | `kit-src/skills/pix3-scripts/SKILL.md`, Juice bullet. |
| K3 | Numeric UI floors in the done-criteria: touch target ≥ 44 CSS px, text ≥ 16 CSS px on the smallest target screen. | `kit-src/AGENTS.md` §"New-game architecture" (completion paragraph). |
| K4 | No safe-area API: listed as a known gap with the workaround (anchor margins keep critical controls off the edges). | `kit-src/skills/pix3-nodes/SKILL.md` §"Known gaps". |
| K5 | Art rule 5: approve one asset at game scale before producing its family; record the source and licence of every imported/generated asset. | `kit-src/AGENTS.md` rule 5. |
| K6 | `kit.spec.ts`: every SKILL.md description ≤ 1024 chars, SKILL.md ≤ 500 lines, every relative Markdown link in the kit resolves; the same shape checks over the engine checkout's `.claude/skills/*/SKILL.md`. | `packages/cli/src/kit.spec.ts`. |

## 2. Not now

- **Safe area in the runtime** (read `env(safe-area-inset-*)` / visual viewport into layout): an engine feature, own plan.
- **Codex skill discovery**: the kit installs skills only under `.claude/skills/`; Codex looks in `.agents/skills/`. Separate change to `kit/generate.ts` + migrate.
- **Upstream PR** to the pack: a `pix3project.yaml` fingerprint ahead of the three.js row. External; owner's call.
- **itch.io**: `build: 'zip'` → `butler push` is a five-line note if anyone ships there.

## Progress

- 2026-10-25: complete — committed in `6766100`, released in `2.0.0-alpha.2`; the "Not now"
  items moved to `.plans/TODO.md`.
- 2026-10-24: plan written; K1–K6 done in the working tree (not committed). K4 found the gap is
  sharper than "no API": the starter's `index.html` is `viewport-fit=cover`, so the canvas runs
  under the notch. K6's new spec fails on a broken link in `pix3-game-dev` (checked by mutation)
  and passes on the tree; `kit.spec.ts` + `new-project.spec.ts` 43/43, eslint and `tsc` clean.
