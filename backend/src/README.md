# Backend Source Layout

- `config/`: application settings orchestration, the AI provider catalog, and static asset path resolution.
- `database/`: SQLite connection, schema, and repository helpers for profiles, groups, templates, prompts, skills, and settings. `database/migrations/` holds one-time data migrations, applied on first database use.
- `extractors/`: modules that extract structured data from external inputs.
- `generators/`: modules that generate output artifacts such as PDF, DOCX, and cover letters.
- `integrations/`: external service clients and API adapters.
- `middleware/`: Express middleware.
- `routes/`: HTTP route handlers.
- `scripts/`: one-off maintenance commands (legacy JSON data import, provider-migration rollback).
- `services/`: core domain services. `services/ai/` is the AI transport layer and the only place that knows how a model is reached; `services/resumeService.ts` is the resume and cover-letter domain logic that uses it.
- `types/`: shared TypeScript types.
- `utils/`: focused utility helpers with no route-level responsibilities.

Static, read-only assets (default prompts, the skill library seed, and built-in templates) live in `backend/static/`.
All dynamic data is stored in the SQLite database under `DB_DIR` (default `/data/db`).

## The AI layer (`services/ai/`)

Everything outside this directory imports from `services/ai` and nowhere
deeper. That boundary is what makes adding a provider a new file rather than an
edit to every call site.

```
ai/
  types.ts           Request/result contracts, capabilities, the adapter interface.
                     No runtime imports, no side effects at load - a test asserts it.
  errors.ts          AIProviderError and the kind -> HTTP status / user message maps.
  registry.ts        Provider lookup, built lazily and cached. Boot preflight.
  promptAssembly.ts  Resolves a stored prompt ONCE and renders it ONCE, splitting
                     the literal preamble (system) from the rendered body (user).
  promptExecution.ts createPromptCompletion / createRawCompletion. The only entry point.
  concurrency.ts     AsyncSemaphore, mapWithConcurrency.
  telemetry.ts       Per-call-site token, cost and latency accounting; warnOnce.
  providers/
    claudeCli/       The `claude` CLI. See below.
    anthropicHttp.ts Anthropic Messages API (metered).
    openaiCompatible.ts OpenAI and DeepSeek (metered), which share a wire format.
```

### `providers/claudeCli/`

| File | Responsibility |
|---|---|
| `index.ts` | The adapter: outage checks, the slot, error mapping. The only file that imports `runner.ts`. |
| `options.ts` | `AI_CLI_*` configuration. The prefix is deliberate - see `env.ts`. |
| `argv.ts` | Flag construction, the `--bare` prohibition, and stale-model-name resolution. |
| `env.ts` | Child environment scrubbing (the API key, the parent session). |
| `runner.ts` | **The injectable seam.** The only module importing `child_process`. |
| `events.ts` | NDJSON reduction. Unknown event types are ignored by construction. |
| `classify.ts` | What a failure means: auth, limit, model, server. |
| `limits.ts` | Rate-limit interpretation and the outage table. |
| `health.ts` | `claude --version` and `claude auth status`. |

Tests hand the adapter a fake `CliRunner` that replays streams recorded from the
real CLI (`test/fixtures/cli/*.ndjson`), so the suite needs no network, no
`claude` binary, and spawns no subprocess. When adding a case, record a real
stream rather than inventing one - several of the rules in this directory exist
because the real event shapes are surprising (a hard model 404 arrives with
`subtype: "success"`).
