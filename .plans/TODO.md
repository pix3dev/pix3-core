# TODO

Open items with no active plan. A finished plan's follow-ups land here; an item that grows a plan
moves to its own file.

- **C1 dogfood** (gate P1, `../pix3/.plans/pix3-core.md` §G.2): the remaining scenarios in Codex,
  plus the "Not yet" list in `CLAUDE.md` → Status.
- **Safe-area insets in the runtime**: the starter's page is `viewport-fit=cover`, but the layout
  does not read `env(safe-area-inset-*)` / the visual viewport, so a phone's notch and home bar
  cover anchored UI. Today only a kit workaround (`pix3-nodes` → "Known gaps").
  From `.plans/done/agent-kit-gamedev-pack.md`.
- **Codex skill discovery**: `pix3 kit` installs skills only under `.claude/skills/`; Codex reads
  `.agents/skills/`. Change `packages/cli/src/kit/generate.ts` + `kit --migrate`.
- **Upstream**: a `pix3project.yaml` fingerprint ahead of the three.js row in
  gamedev-skills/awesome-gamedev-agent-skills' router (owner's call — external PR).
- **itch.io note**: `build: 'zip'` → `butler push`, five lines in the kit, if anyone ships there.
