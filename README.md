# pi-omp-cc

Command Code provider for [pi](https://github.com/earendil-works/pi-coding-agent) and Oh My Pi, built for the GOAT subscription plan.

One TypeScript extension package works in both hosts. It uses Command Code's documented Provider API, so requests stream through the host's native OpenAI/Anthropic implementations. No custom wire protocol.

- Docs: https://commandcode.ai/docs
- API base: `https://api.commandcode.ai/provider/v1`
- Chat: `POST /provider/v1/chat/completions` (OpenAI shape)
- Claude models: `POST /provider/v1/messages` (Anthropic shape)
- Catalog: `GET /provider/v1/models` (plan-scoped when authenticated)

## Install

Two ways, one per host. From a local checkout:

```sh
# pi - registers the path in ~/.pi/agent/settings.json
pi install /path/to/pi-omp-cc

# Oh My Pi - links the package into ~/.omp/plugins
omp plugin install /path/to/pi-omp-cc
```

When published to npm, install by package name instead:

```sh
pi install npm:@kyomel/pi-omp-cc
omp plugin install @kyomel/pi-omp-cc
```

Remove:

```sh
pi remove @kyomel/pi-omp-cc        # or the installed path
omp plugin uninstall @kyomel/pi-omp-cc
```

## Authenticate (GOAT)

Every Command Code plan except Go has Provider API access. The same key authenticates the CLI subscription and the Provider API.

Three ways to provide a key:

1. `/login` inside pi or Oh My Pi. Press Enter for browser login (Command Code Studio posts the key to a local callback), type `key` to paste, or paste the key directly. The key is validated against `GET /alpha/whoami` before it is stored.
2. Environment: `COMMAND_CODE_API_KEY` or `COMMANDCODE_API_KEY`.
3. Auth file: `~/.commandcode/auth.json` (`{"apiKey": "..."}` or `{"commandcode": {"access": "..."}}`). The host auth files `~/.pi/agent/auth.json` and `~/.omp/agent/auth.json` are read as a fallback.

Keys do not expire. They are stored as OAuth credentials with a far-future expiry so both hosts treat them as subscription credentials.

## Models and the GOAT plan

The catalog comes from `GET /provider/v1/models`. When a key is configured, the request carries `Authorization: Bearer <key>` and the endpoint returns the account's catalog.

Command Code still gates individual models by plan at request time (`MODEL_NOT_IN_PLAN`). The extension marks gated models in the picker:

- `Name (CC)` - available on Go/GOAT and above
- `Name (CC · Pro+)` - requires Pro and above
- `Name (CC · Max)` - requires Max

A GOAT key runs GOAT-gated models and gets a clear `MODEL_NOT_IN_PLAN` error for Pro/Max models.

## Thinking levels

Command Code's Provider API does not expose per-model thinking metadata. The
`/provider/v1/models` response has no reasoning fields, and `reasoning_effort`
is validated against one global enum: `low|medium|high|xhigh|max` (`minimal` is
rejected with a 400). Per-model effort lists live in Command Code's own catalog:

- the CLI registry (`reasoningEfforts`) in the `command-code` npm package
- the "Efforts" column of the bundled models reference

`scripts/sync-catalog.mjs` merges both (they agree), keeps models that only the
docs list, and writes `src/catalog-meta.ts`. The extension then maps the result
onto each host:

- pi: `thinkingLevelMap` per model, so the picker offers exactly the documented
  levels and clamps unsupported picks.
- Oh My Pi: the native `thinking: { mode: "effort", efforts }` field on each
  registered model. This overrides OMP's own bundled commandcode catalog, so
  both hosts agree and OMP picks up new levels as soon as the catalog refreshes.

Adaptive models (reasoning on, no explicit levels, e.g. Kimi K2.7 Code) keep no
effort list; the upstream model decides its own depth.

### Refresh behavior

- Session start: the cached catalog registers immediately, then a background refresh updates it. Startup never blocks on the network. So after a plugin update, the next session in either host fetches the latest catalog.
- Both hosts: a successful refresh also mirrors the catalog into the other agent's cache when this plugin is installed there. One session therefore updates the model list of every host running the plugin (pi `<->` Oh My Pi).
- Host refresh: `refreshModels` is implemented, so pi/OMP model-list refreshes refetch the catalog with the effective credential.
- Manual: `/commandcode-refresh` inside a session. `/commandcode-status` shows redacted diagnostics.
- Manual trigger: `node scripts/refresh-models.mjs` refreshes the cache for every detected agent dir (`~/.pi/agent`, `~/.omp/agent`) without starting a session. It is deliberately not part of `update-all-agents`: the extension already self-refreshes on session start, so an update-loop step would duplicate work and add a network fetch to the update flow.

Cache file: `<agent-dir>/commandcode-models.json`, mode `0600`, atomic writes. A failed refresh keeps the last good catalog.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `COMMAND_CODE_API_KEY`, `COMMANDCODE_API_KEY` | API key (highest priority) |
| `COMMANDCODE_API_BASE` | Override `https://api.commandcode.ai/provider/v1` |
| `COMMANDCODE_MODELS_URL` | Override the models endpoint |
| `COMMANDCODE_MODELS_CACHE` | Override the cache file path |
| `COMMANDCODE_MODELS_TIMEOUT_MS` | Catalog fetch timeout (default 10000) |
| `COMMANDCODE_AUTH_TIMEOUT_MS` | Browser login timeout (default 120000) |
| `CMD_ZDR` or `COMMANDCODE_ZDR` | Send `x-cmd-zdr: 1` (zero data retention) on every request |

## Development

```sh
npm install
npm test                    # typecheck + model/auth/runtime tests
node scripts/refresh-models.mjs --help
node scripts/sync-catalog.mjs   # regenerate src/catalog-meta.ts from the command-code npm package
```

`src/catalog-meta.ts` is generated. Do not edit it by hand. Run `sync-catalog.mjs` when the official CLI registry changes.
