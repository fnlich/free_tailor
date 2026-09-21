# CLAUDE.md

Build and orientation notes for this repository. Verified by running every
command below on a clean checkout (Node 22, Linux).

## What this is

Tailor: a Next.js 16 frontend and an Express + SQLite backend that generate
tailored resumes and cover letters. Two npm workspaces that are
not npm workspaces — `backend/` and `frontend/` each have their own
`package.json` and lockfile, and the root `package.json` only orchestrates
them. A single `.env` at the repository root feeds both sides.

## Build and test

```bash
npm run install:all            # root + backend + frontend (run after every pull)
npm run build --prefix backend # tsc -> backend/dist   (~8s)
npm run build --prefix frontend# next build            (~16s)
npm test                       # backend node:test suite (~1m50s, 715 tests)
npm run dev                    # backend watch + frontend dev server
```

Facts worth knowing before you build:

- **`npm run install:all` after every pull.** A pull brings `package.json`
  entries but not packages; the symptom is `TS2307` / `Cannot find module`
  naming a dependency that is plainly listed.
- **The backend postinstall downloads Chrome** (`scripts/installBrowser.js
  --if-missing`) for PDF rendering. It is idempotent and skips an existing
  download. If the download is blocked, `npm run setup:browser` retries, or set
  `CHROME_PATH` to an installed Chrome/Edge/Chromium/Brave.
- **`npm test` builds first.** It is `tsc && node --test "test/*.test.js"`, so
  the suite runs the compiled output in `backend/dist`, never the sources.
  Editing a `.ts` and rerunning a single test file directly will run stale
  JavaScript.
- **`npm run lint --prefix frontend` exits 1 on a clean checkout** — 3
  pre-existing `react-hooks/set-state-in-effect` errors in
  `src/app/page.tsx` and `src/bid-assistant/App.jsx`, plus 2 warnings. Not a
  build gate: `next build` does not run ESLint. Do not treat a red lint as
  something your change caused without checking `git stash` first.
- **Dark mode does not work the way it looks.** `globals.css` ends with a block
  that remaps light utilities under `html.dark` (`html.dark .bg-white { ... }`).
  That block is **unlayered** while every Tailwind utility sits in
  `@layer utilities`, so it beats `dark:` variants outright — on
  `class="bg-white dark:bg-slate-900"` the shim wins and the variant is
  ignored. Eighteen pages carry no `dark:` at all and theme entirely through
  it, so it stays. New chrome uses the `@theme inline` tokens instead
  (`bg-surface`, `border-line`, `text-muted`), which the shim never names, and
  needs no `dark:` variant. Three of its rules are catch-alls rather than
  dark-mode fixes — the bare `border` width class, every `shadow*`, and bare
  `input`/`select`/`textarea` — so avoid those on anything new.
- **`frontend`'s npm scripts go through `scripts/next.mjs`**, never `next`
  directly. That wrapper loads the root `.env` (Next only reads `.env` inside
  its own directory) and passes the port without POSIX shell syntax, which
  `cmd.exe` cannot expand. Keep using it. Note `dev` is a production-style
  build+start; `dev:live` is the webpack dev server.
- **`better-sqlite3` is native.** Install and run with the same Node major, or
  `npm rebuild better-sqlite3 --prefix backend`. A
  `NODE_MODULE_VERSION 127 ... requires 137` error is this and nothing else.

## Running it

The backend needs a writable `DB_DIR` and nothing else to boot:

```bash
DB_DIR=/tmp/ft-db PORT=3001 node backend/dist/index.js
curl http://127.0.0.1:3001/api/health
```

Unset, `DB_DIR` defaults to `/data/db` on Linux/macOS (often not writable — the
most common first-run failure) and `%LOCALAPPDATA%\free_tailor\db` on Windows.
The backend prints the resolved path, the Chrome it will print with, and a
readiness line per AI provider at startup; missing API keys and unreachable
debug browsers are reported, not fatal.

To sign in, `.env` needs Google OAuth (`GOOGLE_CLIENT_ID`) or SMTP. The first
account to sign in becomes the administrator unless `ADMIN_EMAILS` decides in
advance.

## Layout

```
backend/src/
  index.ts            # Express app: mounts ~19 routers under /api
  config/             # env loading (.env, UTF-16 aware), browser resolution
  database/           # better-sqlite3, one repository per table
  database/migrations # numbered, run on first DB use
  routes/             # one file per /api/* area
  services/ai/        # provider-agnostic transport; one directory per provider
  services/queue/     # on-disk generation queue (survives a restart)
  generators/         # PDF (puppeteer), DOCX (html-to-docx), Handlebars
  static/             # seed prompts, skills, templates — defaults only
  test/               # node:test, ~70 files; fixtures/cli replays real streams
frontend/src/
  app/                # App Router pages: /, /admin/*, /jobs, /orders, /credits
  components/shell/   # The app shell - top bar, sidebar, settings sub-nav.
                      #   Mounted once in the root layout inside AuthGate;
                      #   pages render no navigation of their own.
  components/icons/   # Hand-rolled inline SVG set (there is no icon library)
  components/, lib/   # UI and the API client
```

All dynamic data lives in SQLite. `backend/static` holds seeds only — a running
install reads its prompts, skills and templates from the database.

## The AI layer

Every model call goes through `backend/src/services/ai`. A provider is one
directory implementing `AIProviderAdapter`; the registry is keyed on the
provider catalog, so a missing entry is a compile error. Providers:
`claude-web` and `chatgpt-web` (drive a chat tab in a debug Chrome you start
yourself — the default, free, no key), `claude-cli` (a Claude subscription seat
via the local `claude` binary), and `claude` / `openai` / `deepseek` (metered
API keys). `AI_LOCKED_PROVIDERS` in `.env` marks a provider this machine cannot
run; nothing is locked out of the box.

Tests never spawn a browser, a subprocess or a network call: the CLI provider
replays recorded event streams from `test/fixtures/cli` through an injected
runner, and storage tests point `DB_DIR` and `TAILOR_STATIC_DIR` at temp dirs.

## Conventions from the history

122 commits, no tags; releases are `vN.0` merge PRs (v2.0, v3.0, v4.0 so far).
The pattern in nearly every feature arc is a feature commit followed by one or
more "fix what the adversarial review found" commits, so expect review passes
to be part of the work rather than an afterthought.

Commit subjects are written as sentences saying what changed and why it
matters — "Pass over a browser that cannot take the prompt, and use the next
one", not "fix(browser): retry". Match that voice.

The README's Troubleshooting table is long and genuinely load-bearing: most
failures you can hit here already have a row explaining the cause. Read it
before debugging a browser, Chrome, database-directory or provider problem, and
add a row when you fix a new class of failure.

## Platform notes

Windows support is deliberate and tested from Linux: the platform-dependent
decisions (default DB directory, Windows binary resolution, command-line
budget, reserved path characters) take the platform as an argument rather than
reading `process.platform`, so both branches are covered from either host.
`backend/src/config/env.ts` and `frontend/scripts/next.mjs` both decode a
UTF-16 `.env` (PowerShell writes those) — change the two together.
