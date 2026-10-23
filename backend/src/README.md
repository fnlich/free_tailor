# Backend Source Layout

- `config/`: application settings orchestration, the AI provider catalog, the three build modes and their prices (`buildModes.ts`), the catalogue of a resume's sections (`sectionCatalogue.ts`), and static asset path resolution.
- `database/`: SQLite connection, schema, and repository helpers for resumes (`resumeRepository.ts`, the `resumes` table), profiles - the people who hold the resumes (`profileRepository.ts`, the `profiles` table; `profileTree.ts` is the tree itself: the one transaction every write to the two runs in, where a new resume is placed, and the default-resume rules; `profileLimit.ts` counts people against a subscription's cap) - templates, prompts, skills, and settings. `upgradeGuard.ts` refuses, at startup, a database an older build never finished upgrading (start build ac3df79 on it once first); `openAtStartup.ts` opens the database before any route loads, so that refusal is one line and exit code 1. `glossaryRename.ts` runs right after that check, once and in place, and renames what a v4.1 database called a profile (now a resume) and a group (now a profile) - see Upgrading in the top-level README. `database/migrations/` holds the runner for numbered one-time data migrations - two today, 9 (`settings-defaults`) and 10 (`orders-output-root`) - applied on first database use.
- `extractors/`: modules that extract structured data from external inputs.
- `generators/`: modules that generate output artifacts such as PDF, DOCX, and cover letters.
- `integrations/`: external service clients and API adapters.
- `middleware/`: Express middleware.
- `routes/`: HTTP route handlers. `profiles.ts` (`/api/profiles`) is the people, `resumes.ts` (`/api/resumes`) the stored resume, and `resume.ts` (`/api/resume`, singular) the builder's models, analysis and preview.
- `scripts/`: operator tools, each behind an npm script: the mail and sheets doctors (`mail:doctor`, `sheets:doctor`) and the Google sign-in for job sheets (`sheets:login`).
- `services/`: core domain services. `services/ai/` is the AI transport layer and the only place that knows how a model is reached; `services/resumeService.ts` is the resume and cover-letter domain logic that uses it, and `services/resumeDocument.ts` builds, normalises and reads the stored resume. A run's choice of resume is `services/resumeChoice.ts` (which resume each job builds, and what that costs), `services/resumeMatch.ts` (the suitable resume of a profile for a posting) and `services/resumeKeywords.ts` (the keywords it is matched on, computed and never stored); `services/profileRules.ts` holds the rules of profiles that need no database.
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
  errors.ts          AIProviderError, the kind -> HTTP status / admin message maps, and the
                     four PUBLIC_AI_MESSAGE sentences anybody else is told.
  registry.ts        Provider lookup, built lazily and cached. Boot preflight.
  promptAssembly.ts  Resolves a stored prompt ONCE and renders it ONCE, splitting
                     the literal preamble (system) from the rendered body (user).
  promptExecution.ts createPromptCompletion / createRawCompletion. The only entry point.
  concurrency.ts     AsyncSemaphore, mapWithConcurrency.
  telemetry.ts       Per-call-site token, cost and latency accounting; warnOnce.
  providers/
    claudeCli/       The `claude` CLI on the Claude subscription. See below.
    codexCli/        The `codex` CLI on the ChatGPT subscription.
    geminiCli/       The `gemini` CLI on a Google account: a locked-down workspace
                     (workspace.ts), stream-json reduction (events.ts), holds (classify.ts).
    cli/             The spawn seam all three share: runner.ts and resolveBinary.ts.
```

Every provider is a subscription seat signed in on the server; none holds an
API key. `config/providerCatalog.ts` names exactly the three seat types, and
`coerceProviderId` answers null for any other id - the OpenRouter, browser-chat
and metered-API providers of older builds are not mapped onto a seat.

### `providers/claudeCli/`

| File | Responsibility |
|---|---|
| `index.ts` | The adapter: outage checks, the slot, error mapping. The only file that imports `../cli/runner.ts`. |
| `options.ts` | `AI_CLI_*` configuration. The prefix is deliberate - see `env.ts`. |
| `argv.ts` | Flag construction, the `--bare` prohibition, and stale-model-name resolution. |
| `env.ts` | Child environment scrubbing (the API key, the parent session). |
| `modelNames.ts` | The aliases the CLI runs as written - shared with the model-name lists in `config/providerModels.ts`. |
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
