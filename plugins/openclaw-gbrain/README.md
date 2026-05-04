# OpenClaw GBrain Plugin

This package installs the Eva Brain/GBrain OpenClaw native plugin.

It provides:

- `gbrain_status`, `gbrain_search`, and `gbrain_query` agent tools
- `openclaw gbrain status`
- authenticated `/plugins/gbrain/extract`

The extraction route calls OpenClaw's gateway model runner with
`openai-codex/gpt-5.4-mini` by default, so media/text extraction can use the
logged-in OpenClaw/Codex runtime instead of asking users for a model API key.

## Install

From an Eva Brain checkout:

```bash
openclaw plugins install --dangerously-force-unsafe-install ./plugins/openclaw-gbrain
openclaw plugins enable gbrain
openclaw gateway restart
openclaw plugins inspect gbrain --runtime --json
```

This first bridge intentionally shells out to the reviewed local `gbrain` and
`openclaw` CLIs. OpenClaw's install scanner therefore requires the explicit
unsafe-install override. The plugin does not accept arbitrary command strings;
the command paths are configurable and arguments are built internally.

For local development, `plugins.load.paths` may point at this package directory,
or you can link it:

```bash
openclaw plugins install --link --dangerously-force-unsafe-install ./plugins/openclaw-gbrain
```

## Configure

The defaults expect `gbrain` and `openclaw` to be on PATH. Override only when
needed:

```json
{
  "plugins": {
    "entries": {
      "gbrain": {
        "enabled": true,
        "config": {
          "gbrainBin": "/absolute/path/to/gbrain",
          "openclawBin": "/absolute/path/to/openclaw",
          "extractionModel": "openai-codex/gpt-5.4-mini",
          "timeoutMs": 120000
        }
      }
    }
  }
}
```

## Smoke

```bash
gbrain --version
openclaw infer model run --gateway --model openai-codex/gpt-5.4-mini --prompt 'Return only JSON: {"ok":true}' --json
```

Then call `gbrain ingest-media --extract openclaw` with
`GBRAIN_OPENCLAW_GATEWAY_URL` and an authenticated gateway token available to
the caller.

The route accepts `timeoutMs` per request, clamped to 1s-300s. It defaults to
120s.
