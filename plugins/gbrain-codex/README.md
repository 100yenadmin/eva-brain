# Eva Brain for Codex Desktop

This package makes Eva Brain/GBrain available to Codex Desktop as a local
plugin.

It is intentionally thin:

- Codex launches `node ./scripts/launch-gbrain-serve.mjs`
- that launcher resolves a local `gbrain` executable
- then it runs the canonical server via `gbrain serve`

There is no second MCP server here, and no forked search or write logic inside
the plugin package. Codex sees the same GBrain MCP surface that other stdio
hosts see.

## What You Get

- the current GBrain MCP tool surface
- the current repo skill tree, linked into the installed plugin by
  `scripts/install-codex-plugin.mjs`
- the same remote/untrusted MCP behavior GBrain already applies to stdio calls

Useful current commands for Codex agents to prefer before deeper retrieval:

- `gbrain status --json` for runtime/source/cycle/worker posture
- `gbrain doctor --scope=brain --json` for brain health without skill noise
- `gbrain sources list --json` before declaring a brain empty
- `gbrain search <query> --source workspace-docs` for local workspace/runbook docs
- `gbrain search <query> --source openclaw-support-kb` for support protocol docs
- `gbrain extract status --json` and `gbrain extract --explain <kind> --json`
  when debugging extraction receipts or schema-pack extractor routing

## Resolution Order

The launcher resolves `gbrain` in this order:

1. `GBRAIN_CODEX_BIN`
2. repo-local `bin/gbrain`
3. `gbrain` on `PATH` with `$HOME/.bun/bin` prepended

If none resolve, the launcher fails with an install hint. This plugin is an
adapter over a local GBrain install, not a standalone runtime bundle.

## Install In Codex Desktop

From the Eva Brain repo root:

```bash
bun install
bun link
node scripts/install-codex-plugin.mjs
```

Then restart Codex Desktop.

The installer creates `~/plugins/gbrain-codex`, links this package plus the
repo's current `skills/` tree, updates the local Codex marketplace/config, and
clears stale cached `gbrain-codex` plugin entries so Codex reloads the current
version after restart.

For the full public install path, including the CLI and optional host plugins:

```bash
git clone https://github.com/electricsheephq/eva-brain.git ~/eva-brain
cd ~/eva-brain
scripts/update-local-install.sh --with-codex-plugin
```

By default the updater installs the newest `eva-v*` GitHub release tag. For
development against moving `master`, pass `--ref master`. To pin or roll back,
pass an exact release tag such as `--ref eva-v0.40.2.0`.

Add `--with-openclaw --with-support-kb` when this Codex install should share the
same machine with OpenClaw and the OpenClaw support knowledge base.

## Local Repo Smoke

From the Eva Brain repo root:

```bash
bun install
test -x "$HOME/.bun/bin/gbrain" || bun link
node plugins/gbrain-codex/scripts/rehearsal.mjs
```

The rehearsal script creates a temp `GBRAIN_HOME`, initializes PGLite with
deferred embeddings so no provider API key is required, connects to the plugin
over stdio MCP, checks `tools/list`, and exercises `put_page`, `get_page`,
`search`, `query`, `sync_brain`, and the `whoami` fail-closed path.

After installing into Codex Desktop, run the configured-machine smoke:

```bash
node scripts/codex-gbrain-smoke.mjs
```

If stale `gbrain serve` processes are present, refresh with:

```bash
scripts/update-local-install.sh --with-codex-plugin --stop-stale-serve
```

## Safety Boundary

This plugin does not add or loosen GBrain permissions.

- Codex calls arrive through MCP stdio
- GBrain treats those calls as `remote: true`
- operation-level guards stay inside GBrain core

That means Codex gets the full tool surface, but the same stdio-MCP trust
boundary and restrictions still apply.
