# Pix3 plugin for Claude Code

One skill, `new-project`: creates a Pix3 game project (`npm create pix3@next`, `npm install`,
`pix3 agent-setup claude`) and hands over to a Claude Code session in the new folder.

```text
/plugin marketplace add pix3dev/pix3
/plugin install pix3@pix3
```

The marketplace is the [`pix3dev/pix3`](https://github.com/pix3dev/pix3) repository
(`.claude-plugin/marketplace.json`); it installs this folder from `main` of pix3-core.

## What belongs here

Only what does not depend on the engine version a project is pinned to: creating a project, and
later account-level things (publishing). Skills about nodes, scripts, scenes and the editor stay in
the project kit (`packages/cli/kit-src/`), which `create-pix3` installs at the project's own
version — a copy here would be a second, differently versioned `pix3-nodes` in the same session.

## Keep in sync

The skill quotes the `create-pix3` arguments (`packages/create-pix3/src/create.js`) and
`pix3 agent-setup` (`packages/cli/src/agent-setup/`). Change it in the same commit as either, and
re-run the commands from step 3 of `skills/new-project/SKILL.md` in an empty folder. The same
steps, shorter, are in the `pix3dev/pix3` repository's `AGENTS.md` and README.
