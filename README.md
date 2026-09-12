<div align="center">

# ✨ Tailored Resume Builder

**AI-powered resume and cover letter generation with ATS optimization**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Express](https://img.shields.io/badge/Express-4-green?logo=express)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite)](https://sqlite.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)

</div>

---

## 📖 Overview

Tailored Resume Builder is a full-stack application that generates tailored resumes and cover letters for job applications. Paste a job description, and the AI analyzes it to optimize your resume with relevant keywords, rewrite experience sections, and craft a professional cover letter.

By default it runs on **a chat tab you are already signed in to** rather than metered API tokens: the backend drives claude.ai or chatgpt.com in a Chrome you started yourself, so generation costs nothing per request and needs no API key. Running on a **Claude subscription seat** through the local `claude` CLI is also supported, but locked until you sign that seat in - see Locked providers below. OpenAI, the Anthropic API and DeepSeek remain available as API-key providers you can switch to per prompt or per request.

### ✨ Features

| Feature | Description |
|---------|-------------|
| **Single or Batch** | Generate for one profile, a group, or all profiles at once |
| **Profile import** | Move a profile between installs, restore one from a backup, or write one by hand: upload the JSON under Admin → Profiles |
| **ATS Optimization** | AI extracts keywords and tailors content for applicant tracking systems |
| **Templates** | Built-in professional templates plus manual and uploaded templates |
| **Cover Letters** | Auto-generated PDF and DOCX cover letters with professional formatting |
| **Per-Profile Settings** | Each profile chooses its prompts, template, file naming, and skill ordering |
| **Admin Panel** | Manage profiles, groups, templates, prompts, skills, and AI model settings |
| **PDF & DOCX** | Export resumes in both formats |

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌──────────────────────────┐
│   Next.js 16    │────▶│  Express API    │────▶│  services/ai             │
│   Frontend      │     │  Backend        │     │  ├── claude-web  (tab)   │
│   (React 19)    │     │  (Port 3001)    │     │  ├── chatgpt-web (tab)   │
└─────────────────┘     └─────────────────┘     │  ├── claude-cli  (seat)🔒│
                                 │              │  ├── claude      (key)   │
                                 │              │  ├── openai      (key)   │
                                 │              │  └── deepseek    (key)   │
                                 │              └──────────────────────────┘
                                 │                           │
                                 │                           ▼
                                 │              a chat tab in a Chrome you
                                 │              started and signed in to
                                 │
                                 ├── SQLite database  (/data/db) — all dynamic data
                                 ├── Static assets    (backend/static) — defaults only
                                 └── Generated files  (PDF/DOCX)
```

### The AI layer

Every model call in the app goes through `backend/src/services/ai`. A provider
is one directory implementing `AIProviderAdapter`; call sites never name a
transport, and the registry is keyed on the provider catalog so a missing entry
is a compile error rather than a silent fall-through.

| Provider id | How it authenticates | Notes |
|---|---|---|
| `claude-web` (default) | A claude.ai tab you signed in to yourself | Free. Slow, and one conversation per browser. |
| `chatgpt-web` | A chatgpt.com tab you signed in to yourself | Free, same terms. |
| `claude-cli` | The `claude` CLI's own sign-in — no key | **Locked** by default; see below. Free at the margin, one subprocess per call. |
| `claude` | `ANTHROPIC_API_KEY` | Metered. The only provider that can still honour `temperature`. |
| `openai` | `OPENAI_API_KEY` | Metered. |
| `deepseek` | `DEEPSEEK_API_KEY` | Metered. |

**Locked providers.** A lock means this installation cannot run a provider —
distinct from the admin's enable switch, which records what an operator wants.
`claude-cli` is locked out of the box, because it needs a Claude subscription
seat signed in to the CLI on the machine running the server and most do not
have one. Its models stay in every picker, greyed out behind a 🔒 with the
reason next to them, rather than vanishing: a model that disappears reads as a
bug. Nothing dispatches to a locked provider — naming one by model id, by
provider id or as `provider:modelName` is refused with a sentence saying so.

Unlock it once the seat is signed in by listing it in `.env`:

```env
AI_UNLOCKED_PROVIDERS=claude-cli
```

There is deliberately no button for that in the admin UI. A lock is a fact
about the machine, and only whoever set the machine up can know it has changed.

The `openrouter` provider was **replaced** by `claude-cli`. An existing database
is migrated on the next boot (its settings row is backed up first, and
`npm run ai:rollback` restores it); records that still name `openrouter` are
read as `claude-cli` whether or not that migration has run.

A second migration gives an install upgrading from before the browser-chat
providers their `Claude (free)` and `ChatGPT (free)` model records. Model
records are stored per install, so the seed list a new install starts from
could never reach one that had already saved settings - which is why those two
providers were enabled and configurable while no model in any picker named
them. The same migration switches the two on if every provider the install had
enabled turns out to be locked, and repoints a stored default that named the
locked seat at a free model rather than at a metered one.

### Where data lives

| Data | Storage |
|------|---------|
| Profiles, groups, custom templates, custom prompts, edited built-in prompts, app settings, skill library, bid-assistant jobs and answers | SQLite database in `DB_DIR` (default `/data/db/free_tailor.db`) |
| API keys for the metered providers | `.env` only. The app keeps no keys of its own: a settings row upgraded from an older release has its stored keys deleted on first read, and says so in the log |
| Default prompts (one per feature) | `backend/static/prompts/*.json` |
| Skill library seed (loaded into the database on first run) | `backend/static/skills/skills.json` |
| Built-in resume templates | `backend/static/templates/*.json` |

Nothing under `backend/static` is written to at runtime. Edits made in the admin panel always go to the database.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ (the same major version for installing and running - see the
  `NODE_MODULE_VERSION` row under Troubleshooting)
- **Windows 10/11, Ubuntu, or macOS.** Every command in this guide is the same
  on all three; where a default differs it is called out below.
- A writable database directory. Left unset, `DB_DIR` defaults to `/data/db` on
  Linux and macOS and to `%LOCALAPPDATA%\free_tailor\db` on Windows. The
  backend prints the resolved path at startup.
- **Claude Code**, only if you want to run on a subscription seat. That
  provider is locked until you install it, sign it in, and name it in
  `AI_UNLOCKED_PROVIDERS`; the free browser-chat providers need none of this.

  ```bash
  npm i -g @anthropic-ai/claude-code
  claude auth login
  claude auth status     # must print "loggedIn": true and "authMethod": "oauth_token"
  ```

  On Windows npm installs this as `claude.cmd`, which Node cannot spawn
  directly. The backend reads the shim and runs what it wraps - the package's
  `bin/claude.exe` today, a `cli.js` under an older release - so no extra
  configuration is needed. If that ever fails it says so and asks for
  `AI_CLI_BIN`.

  `oauth_token` is what a subscription looks like. Any other `authMethod` means
  the CLI found an API key and every request will be billed per token; the
  backend says so loudly at startup and on the admin Settings page.

- **A Chrome to print with.** Resumes and cover letters are rendered by
  headless Chrome, and `npm install --prefix backend` downloads one
  automatically. Nothing further is needed unless that download is blocked -
  see `Could not find Chrome` under Troubleshooting. The backend prints which
  browser it resolved at startup, on a `[pdf]` line, and reports it from
  `GET /api/health`.

- Optionally an **OpenAI**, **Anthropic** or **DeepSeek** API key in `.env`, if
  you want those providers available as alternatives. They are the only
  credentials this app reads and it stores none of its own

- A **debug Chrome** for the two browser-chat providers, one of which is the
  default. They need no key at all.

  **Register** each browser first, under **Admin → Settings → Browser Chat
  (free)**: pick a site and a port, press **Register**, and it is saved
  immediately. That list is the address book the providers send requests to, so
  a browser that is not on it is a browser nothing will use.

  Then **start** them yourself:

  ```bash
  npm run browser:debug                                   # every registered browser
  npm run browser:debug -- --list                         # what is registered, and what is up
  npm run browser:debug -- --port 9333 --site claude-web  # one, and register it
  ```

  `--port=9333` works too, and an unrecognised flag is an error rather than a
  quiet fallback to starting everything.


  **The backend never starts a browser.** There used to be a Start button that
  made it spawn Chrome on an HTTP request; that is gone, along with the endpoint
  behind it. The server only ever attaches to what it finds, which means these
  windows belong to you, outlive a backend restart, and cannot be started by
  anyone who can reach the admin API.

  Sign in to `claude.ai` and/or `chatgpt.com` **in the window each one opens**
  and leave it open. Each gets a profile directory of its own
  (`~/.free-tailor-chrome-<port>`) because Chrome ignores
  `--remote-debugging-port` when the same profile is already running, and the
  launcher picks an installed Chrome/Edge/Brave rather than puppeteer's Chrome
  for Testing - sign-in flows reject a browser in automation mode.

  Running it again is safe: a port that already has a browser on it is left
  alone rather than started twice.

  **If a turn fails, ask the page what it offers** rather than guessing:

  ```bash
  npm run browser:doctor            # per role: which selector matched, and how many nodes
  npm run browser:doctor -- --send  # also drive one real round trip, step by step
  ```

  Neither site publishes a markup contract and both rename these attributes, so
  this is the fastest way to find which of the five roles went stale. Overrides
  go in `.env` (`AI_WEB_CLAUDE_*`, `AI_WEB_CHATGPT_*`, candidates separated by
  `|`) and take effect on a backend restart - no rebuild.

  **One browser shows one chat tab**, on its own port and its own profile. That
  is not a preference: a second tab in the same window is a background tab, and
  Chrome freezes those - a DOM read against a frozen renderer never returns.
  So parallelism comes from more browsers. Two browsers for claude.ai means two
  free Claude requests run at once; measured against a fixture answering in
  about three seconds, four requests took 25.5s on one browser and 12.9s on two.

  Each provider has its **own queue** - Claude (free), ChatGPT (free) and the
  Claude CLI never wait for one another - and **no queue has a length limit**.
  Whenever one of that site's tabs frees, the request that has waited longest
  takes it. A request only ever gives up on its own timeout, never for being
  late in the line. If a configured browser turns out not to be running, the
  request is retried on another of that site's browsers and the dead one is set
  aside for a short while.

  Back on **Admin → Settings → Browser Chat (free)**, each platform shows
  **Active** or **Not active**. Active means the provider's own check found a
  signed-in chat tab - not merely that a window is running, which a port probe
  alone cannot tell apart from a window that is signed out. Under it are the
  ports registered, how many are reachable, and how many are showing the site.
  Press **Check status** to re-read it after a launcher run.

  The debug port listens on loopback only, and the launcher deliberately does
  **not** pass `--remote-allow-origins=*`. That flag turns off Chrome's DevTools
  origin check, which is the only thing stopping an ordinary web page you visit
  from opening a socket to `127.0.0.1` and driving this browser - including
  reading the accounts signed in to it. Nothing here needs it: the backend
  connects from Node, which sends no `Origin` header, so the check never applies
  to it. If you start the browser by hand, leave that flag off too.

  Two things to know before enabling these: the prompt (your resume and the job
  description) is typed into a third-party chat window and lands in that
  account's history, and driving these sites this way may not be permitted by
  their terms of service. They are also slow and strictly one call at a time, so
  they suit a single tailoring run rather than a batch

### 1. Clone & Install

```bash
git clone <repo-url>
cd free_tailor

npm install
npm install --prefix backend
npm install --prefix frontend
```

### 2. Environment Setup

Copy `.env.example` to `.env` in the project root and fill in the values you need. The important ones:

```env
HOST=0.0.0.0             # backend listens on every interface
PORT=3001
#DB_DIR=                 # SQLite database directory; see the note below
NEXT_PUBLIC_API_URL=http://localhost:3001/api
ADMIN_PASSWORD=change-me
```

`DB_DIR` is commented out in `.env.example` on purpose, so a fresh checkout
picks the writable default for the platform it is on. Set it when you want the
data somewhere specific - `DB_DIR=./data/db` works on both Windows and Ubuntu
and is resolved from the directory the backend was started in.

Nothing else is required for AI generation: the default provider drives a
claude.ai tab in the debug Chrome described above, which costs nothing and
needs no key. The `AI_CLI_*` variables in `.env.example` tune the model,
effort, concurrency and timeouts of the subscription-seat provider, which is
locked until `AI_UNLOCKED_PROVIDERS` names it.

The frontend swaps the hostname in `NEXT_PUBLIC_API_URL` for the hostname the page was loaded from, and the backend accepts requests from any origin on the same host as the API. That means you can open the app through `localhost`, a LAN IP, or a hostname without changing configuration.

### 3. Run

```bash
npm run dev
```

This starts the backend in watch mode and the frontend dev server. For a production-style frontend build use `npm run dev:poll` or run each side separately:

```bash
cd backend && npm run dev        # http://<server-ip>:3001
cd frontend && npm run dev:live  # http://<server-ip>:3000
```

The backend prints every address it is reachable on when it starts, followed by
a readiness line for each AI provider. A locked one is reported as locked
rather than probed:

```
[ai] claude-cli: Locked in this installation. Needs a Claude subscription seat ...
[ai] claude-web: 1 browser configured, 1 reachable.
```

Both sides read the single `.env` at the repository root, on Windows as well as
macOS and Linux, and every npm script here runs under `cmd.exe` and PowerShell
as well as `bash`. If you set `DB_DIR=/data/db` on Ubuntu, create it and make it
writable first (`sudo mkdir -p /data/db && sudo chown "$USER" /data/db`); on
Windows that path means `C:\data\db` and needs an administrator, so leave
`DB_DIR` unset or point it at something local. A directory the backend cannot
create is the most common first-run failure, and it says exactly that.

### 4. Import data from the old JSON layout (optional)

If you are upgrading from a version that stored data as JSON files under `backend/data`, import it once:

```bash
cd backend
npm run migrate:legacy -- /path/to/old/backend/data
```

Existing database records are never overwritten.

---

## 📁 Project Structure

```
free_tailor/
├── backend/                 # Express API
│   ├── src/
│   │   ├── config/         # App settings + static asset paths
│   │   ├── database/       # SQLite connection, schema, repositories
│   │   ├── database/
│   │   │   └── migrations/ # One-time data migrations, run on first DB use
│   │   ├── routes/         # API routes
│   │   ├── services/
│   │   │   ├── ai/         # Provider-agnostic AI transport
│   │   │   │   ├── providers/claudeCli/  # The `claude` CLI provider
│   │   │   │   └── providers/            # openai, deepseek, anthropicHttp
│   │   │   └── resumeService.ts          # Resume/cover-letter domain logic
│   │   ├── generators/     # PDF, DOCX, cover letter generation
│   │   ├── scripts/        # Legacy data import, provider-migration rollback
│   │   └── types/          # TypeScript types
│   ├── static/
│   │   ├── prompts/        # Default prompt per feature
│   │   ├── skills/         # Skill library seed
│   │   └── templates/      # Built-in templates
│   └── test/               # node:test suite
│       └── fixtures/cli/   # Recorded `claude` CLI event streams
├── frontend/               # Next.js app
│   └── src/
│       ├── app/            # Pages (/, /admin/*, /jobs, /bid-assistant, /calendar)
│       ├── components/     # Reusable UI components
│       └── lib/            # API client
└── generated/              # Default output location for resumes and cover letters
```

---

## 📤 Output Structure

Generated files are saved under the configured output directory using the output path template from the admin settings, for example:

```
{profile}/{date}/{company}/{role}/
├── {profile}.pdf
├── {profile}.docx
├── {profile}_cover_letter.pdf
└── {profile}_cover_letter.docx
```

File and folder names are templated per profile.

---

## ⚙️ Admin Panel

| Section | Purpose |
|---------|---------|
| **Profiles** | Create/edit candidate profiles, prompts, template, file naming, and hard-skill ordering. Three ways in: **Add Manually**, **Upload Resume PDF** (an AI call reads the PDF), and **Import JSON** (no AI call - the file already is a profile) |
| **Profile JSON import** | Takes one profile, a list of them, or `{ "profiles": [ ... ] }` - the shapes `GET /api/profiles/:id` hands out. An import never overwrites a profile you already have: an id that is free is kept, so a backup restored into an empty install keeps the ids its groups reference, and one that is taken gets a new profile instead. A file with one bad entry imports nothing rather than half |
| **Groups** | Group profiles for batch generation |
| **Browser chat providers** | `Claude (browser)` and `ChatGPT (browser)` drive claude.ai and chatgpt.com in a Chrome you started and signed in to yourself, over the DevTools protocol. No API key, nothing metered - your existing chat plan is the quota. Slow, one conversation at a time, and the prompt goes into that account's chat history |
| **Browser Chat (free)** | Register a debug port per browser here; registering saves immediately, because this list is what the providers and the launcher both read. It shows each platform as **Active** or **Not active** (active = the provider found a signed-in chat tab, which a port probe alone cannot tell from a signed-out one) and the ports registered, reachable, and showing the site. It does **not** start browsers - `npm run browser:debug` does. Unregistering forgets a browser here; it does not close a window |
| **Credentials** | Claude Code runs on your subscription seat, with no key at all. The metered providers - Anthropic API, OpenAI, DeepSeek - read their key from `.env`; there is no key management in the app, so a key exists in exactly one place |
| **AI defaults per profile** | Each profile picks its own model, effort (`low`..`max`) and thinking mode; the builder shows those defaults and can override any of them for a single run. Both menus list every model, with the locked ones greyed out behind a 🔒 rather than hidden. Effort is the CLI's `--effort` flag. Thinking is on by default and adaptive - the models decide per answer - so the choice is whether to allow it, not how much; depth is what effort controls |
| **Templates** | Nineteen built-in templates - Professional Two-Column, Classic Serif, Developer Mono, Structured Slate, Editorial Italic, Contrast Cards, Charcoal Sidebar, Timeline Bars, Indigo Band, Forest Chips, Slate Italic, Burgundy Rule, Navy Rule, Navy Gold, Amber Gradient, Ink Ledger, Dossier Panel, Framed Serif and Azure Stack - plus manual and uploaded ones. **View** renders any of them with a full sample resume in that template's own page box, read from its `@page` rule, so the preview and the printed PDF agree |
| **Prompts** | Edit default prompts or add custom variants per feature |
| **Skills** | Maintain the hard/soft skill library |
| **Settings** | AI providers, models, output location, and live Claude subscription status (sign-in, usage window, in-flight calls). Each provider row shows what it reports right now; a metered provider's key comes from `.env`. A provider this installation cannot run is marked 🔒 with the reason, and its checkbox is fixed at whatever the operator last chose |

---

## 🔧 Configuration

| Variable | Description |
|----------|-------------|
| `HOST` / `PORT` | Backend bind address and port (default `0.0.0.0:3001`) |
| `DB_DIR` | SQLite database directory. Default `/data/db` on Linux and macOS, `%LOCALAPPDATA%\free_tailor\db` on Windows |
| `FRONTEND_URL` | Extra allowed CORS origins, comma separated (same-host origins are always allowed) |
| `FRONTEND_HOST` / `FRONTEND_PORT` | Frontend bind address and port (default `0.0.0.0:3000`) |
| `NEXT_PUBLIC_API_URL` | Frontend API base; the hostname is replaced at runtime. Leave unset to derive it from `PORT` - set it only to reach a different machine |
| `NEXT_PUBLIC_ALLOWED_DEV_ORIGINS` | Extra origins allowed by the Next.js dev server |
| | *(the frontend is launched through `frontend/scripts/next.mjs`, which loads this root `.env` and passes the host and port to Next - Next itself only reads `.env` files inside its own directory. A `frontend/.env*` file still wins for any key it sets, and an exported shell variable wins over both.)* |
| `NEXT_PUBLIC_CALENDAR_SHARE_URL` | Optional default calendar share link |
| `ADMIN_PASSWORD` | Admin login password |
| `AI_CLI_BIN` | Path to the `claude` binary when it is not on PATH |
| `AI_CLI_MODEL` / `AI_CLI_EFFORT` | Default model alias (`sonnet`) and reasoning effort (`low`) |
| `AI_CLI_CONCURRENCY` | Simultaneous `claude` processes, process-wide (default `4`) |
| `AI_CLI_TIMEOUT_MS` / `AI_CLI_TIMEOUT_MS_TAILOR` | Per-call wall-clock budgets |
| `AI_CLI_ALLOW_API_KEY` / `AI_CLI_ALLOW_OVERAGE` | Opt in to metered billing; both off by default |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | Keys for the metered providers (can also be stored from the admin panel) |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | Service account JSON for Google Sheets import |

See `.env.example` for the full `AI_CLI_*` list.

---

## 🩺 Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| The page cannot reach the API but the backend is clearly running | Look for `[cors] Refused origin ...` in the backend output. A browser reports a refused origin as an unreachable server, so the page cannot tell the two apart - the backend log is the only place the reason appears. It names the origin and the `FRONTEND_URL` value that allows it. |
| `Cannot reach the backend at ...` naming a port you did not expect | `NEXT_PUBLIC_API_URL` and `PORT` disagree. They must name the same port when both point at this machine. Delete `NEXT_PUBLIC_API_URL` from `.env` to derive it from `PORT`, or set the two to match. The backend and the frontend build both print an `[env]` line when they disagree. |
| `Cannot reach the backend at http://localhost:3001/api ...` in the UI | The frontend is running but nothing answered on the API port. The backend prints its own reason where it was started - the `backend` half of `npm run dev`, or its own terminal. Most often it exited at boot over the database directory or a native-module mismatch, both rows below. The two halves are independent: a crashed backend no longer takes the frontend down with it, so the page stays up to tell you. |
| `Could not find a declaration file for module 'better-sqlite3'` | Backend dev dependencies are not installed. Run `npm install --prefix backend` (not `--omit=dev`). |
| `Cannot create the database directory`, `SQLITE_CANTOPEN`, or a permission error on startup | `DB_DIR` points somewhere this user cannot write. On Ubuntu the usual cause is `/data/db` not existing; create it, or set `DB_DIR=./data/db`. On Windows a `DB_DIR=/data/db` copied from an older `.env` means `C:\data\db` and needs an administrator - unset it to get `%LOCALAPPDATA%\free_tailor\db`, or point it at a folder you own. |
| `NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 137` | `better-sqlite3` is a native module compiled for a different Node version than the one now running (127 is Node 22, 137 is Node 24). Run `npm rebuild better-sqlite3 --prefix backend`, or switch back to the Node version you installed with. |
| A browser provider says `Could not reach a debug browser` | Nothing is listening on the debug port. Run `npm run browser:debug` and leave the windows it opens open. The app never starts one for you. If you started Chrome yourself, check it used a `--user-data-dir` of its own: Chrome ignores `--remote-debugging-port` when that profile is already running, so the flag looks accepted and no port ever opens. |
| The first call of a run works and the next one fails with `The chat page did not finish accepting the prompt` | That tab is too busy to take the prompt. The two calls are not the same size: analysing a job posting sends only the posting, while tailoring sends your whole profile, the analysis and the keyword lists - some 27,000 characters - and the site re-renders its editor over all of it. Close the other conversations in that window, reload the tab, and leave the window visible rather than minimised. (Earlier versions reported this as `Input.insertText timed out. Increase the 'protocolTimeout' setting`, which was this app's own limit being too small and is now sized for a real prompt.) |
| A generation you cancelled by reloading the page keeps driving the browser | Fixed. The reload now stops the call: nothing further is typed into your chat history and the tab is handed back at once, so the request you make after reloading starts straight away instead of queueing behind the one you abandoned. A prompt already in flight when you reloaded finishes typing - nothing can recall a keystroke the browser has begun - but the turn ends there. |
| A browser provider types the prompt but nothing is ever sent | The site's send button is disabled until its own framework notices the composer has content, and a click on a disabled button dispatches no event at all - so this used to look like "no reply". The driver now waits for the control to become clickable and falls back to Enter, and says `nothing sent it` when neither works. Run `npm run browser:doctor -- --send` to see which control it found. |
| Not sure whether the selectors still match the live site | `npm run browser:doctor` attaches to your signed-in tab and reports, per role, which candidate matched and how many nodes it found; `--send` drives one real round trip and says which step failed. It reads the page and sends nothing unless you pass `--send`. Every BROKEN line names the `AI_WEB_*` override that fixes it. |
| A browser provider says `found no message box` or `showed no reply` | Either that tab is not signed in - open it in the debug browser and sign in - or the site changed its markup. The backend names the role that failed; set the matching `AI_WEB_*` override in `.env` (candidates separated by `\|`). A deadline message distinguishes the two: `none of its assistant selectors matched anything at all` is a markup change, while `rendered no new message ... though "<selector>" does match` means the send did not land or the tab is signed out. |
| How a batch is spread over the browsers | Ten resumes and five browsers means five run at once and five queue; the moment any browser finishes it takes the next queued resume, on that same browser, rather than waiting for the rest of its wave. If one of the five is out of messages it is passed over and the other four carry the batch - all ten are still generated. Add browsers under Admin → Settings → Browser Chat to widen it. |
| How a run of many resumes is actually scheduled | The backend owns a queue. One request carries every resume - thirty sheet rows and three profiles is ninety tasks - and the request returns a batch id straight away, before any of them has run. Browsers take tasks off the head of the queue as they come free, so with three browsers three resumes are built at once and the moment one finishes the next task starts on that browser. A second request appends behind the first. There are two queues, because there are two resources: one shared by every debug browser, one for the Claude CLI seat, so a stalled seat cannot hold up the browsers. |
| A run survives the server restarting | The queue is on disk, in the same SQLite database as everything else, so `npm run dev` reloading on a file save no longer costs you an hour of browser time. On boot the server picks up any unfinished batch: resumes already built come back built and are not rebuilt, and whatever was in a browser at the moment the process died is built again - nothing completed it, so its file does not exist. Repeating one is safe because the output path is derived from the profile, company and row, so it overwrites rather than adding a second copy. A batch is kept for an hour after it finishes and then pruned. |
| A run keeps going after the page is closed | It does now, and that is deliberate. The work belongs to the queue rather than to the request that submitted it, so closing or reloading the page does not stop it and files keep landing. Reopening the builder picks the run back up and shows live progress - it remembers the batch in this browser, and failing that asks the server what is still running. To actually stop a run, cancel it: queued resumes are dropped and the ones in a browser are aborted. |
| A profile's platform choice inside a batch | Still honoured. A profile set to `Claude (free)` waits for a Claude browser even if a ChatGPT one is idle; a profile on `Hybrid (free)` goes to whichever frees up first. A pinned task at the head does not block a browser it cannot use - the browser reaches past it for the next task it can run. A task no registered browser can serve fails with that reason rather than waiting for ever. |
| A batch of profiles or a sheet import runs one at a time | Fixed. Every batch endpoint now runs its items in parallel, as wide as the chosen provider can actually take: the browsers registered for that site, both sites' added together under Hybrid, or `AI_CLI_CONCURRENCY` slots for the subscription seat. The queues were already there - a free browser is handed to the head of its line the moment it is released - the batch just was not offering them enough work. `AI_BATCH_CONCURRENCY` still overrides the whole thing. The backend logs the width and the reason at the start of each batch. |
| Generation feels like it sends more than it needs to | It used to. The profile is now projected before it goes to the model: contact details, this database's ids and timestamps, and the whole of `profileSettings` (your prompt choices, file-name templates and which model you pay for) are left out, and the JSON is compact rather than pretty-printed. Measured on a five-role profile: 9,365 characters down to 6,942. Nothing the prompt reads was removed. |
| The same job posting is analysed over and over | It is not any more. An analysis is deterministic, so the answer is kept for six hours keyed on the posting, the model, and the prompt's own text - a preview followed by a generate, or a sheet re-run after fixing one row, now costs one call instead of two. Editing the prompt invalidates it, so an admin never sees a stale answer from the version they just changed. |
| One browser is out of messages and the whole request fails | Fixed. A browser that is reachable but cannot take the prompt - out of messages, signed out, wedged, or a previous turn that never let go - is passed over for the next browser of that site, and left out for a few minutes so later calls skip it too. That is the reason to run more than one: each window is a separate session, so an account's wall is not the site's. The retry only happens when the prompt never reached the site; once it has landed, another browser would be asking the same question twice. When every browser refuses, the error is still that browser's own (a usage wall is a 429, a signed-out tab a 503) with each browser and its reason named in the log. |
| A free account runs out of messages halfway through a batch | Set the profile's model to **Hybrid (free)**. It spreads calls across both free accounts - a tailoring run is three calls and a batch of ten profiles is thirty, which one account will not carry - and moves to the other one when either is out of messages, signed out, or has no browser running. Hybrid only appears when both free providers are enabled, since with one there is nothing to be hybrid between. |
| Effort and Thinking are greyed out | The chosen model is a chat window, and a chat window has no effort flag and no thinking budget - there is nowhere to put either. The two selects go inactive rather than accept a setting that would change nothing. Pick the Claude CLI seat to get them back. |
| Technical Skills shows headings you do not want | Set **Technical Skills Layout** to `One plain list` under the profile's settings. The headings are kept, not deleted, so switching back restores them. |
| A skill is filed under the wrong heading | The shared skill library guesses a heading per skill, and it cannot know that your Vault is infrastructure rather than a library. Press **Assign headings** on the profile's Hard Skills and set that one; the rest keep being worked out. A profile's own headings are used exactly as written and are never padded out to a count. |
| An exported set of templates will not import | Fixed. The JSON upload now takes one template, a list of them, or `{ "templates": [ ... ] }`, works `sections` out from the markup when the file names none, and says which entry is wrong rather than failing the file. It saves all of them or none, and never overwrites a template already here. |
| An uploaded profile lost its skills | It should not now: a flat list, a `{ "Languages": [ ... ] }` map, a list of `{ category, skills }` groups, and a mix of names and groups all import to the same profile. Every grouped skill also lands in the flat list the tailoring prompt reads. |
| A model is greyed out with a 🔒 and cannot be picked | Its provider is locked in this installation - the row says why. `claude-cli` needs a Claude subscription seat signed in to the CLI on this machine; sign it in and add `AI_UNLOCKED_PROVIDERS=claude-cli` to `.env`, then restart. Use `Claude (free)` or `ChatGPT (free)` otherwise. |
| The free Claude and ChatGPT models are missing from the model menus | An install that saved settings before those providers existed stores its own model list, which the newer seed list cannot reach. The migration on the next boot adds them; if it did not run, the backend log says why on a `[db]` line. Adding them by hand under Admin → Models works too: provider `Claude (browser)` or `ChatGPT (browser)`, model name `chat`. |
| A free provider says it `has no browser set up yet` | No debug port is registered for that site. Register one under Admin → Settings → Browser Chat (free), start it with `npm run browser:debug`, and sign in to the tab it opens. |
| A platform shows **Not active** though its window is plainly open | Active means the provider found a signed-in chat tab, not merely a running browser. Open that window, check the tab is signed in and showing the chat site, then press **Check status**. The line under each platform says how many registered ports are reachable and how many are showing the site, which separates "not started" from "started but signed out". |
| `npm run browser:debug` starts every browser when you asked for one | Flags have to reach through two npm hops. From the repo root the form is `npm run browser:debug -- --port 9333 --site claude-web`; without the `--`, npm eats `--port` as its own option and the script never sees it. The script itself accepts either `--port 9333` or `--port=9333`, and refuses any flag it does not recognise rather than quietly falling back to starting everything - so if it *did* start the whole list, the flags did not reach it. |
| `npm run browser:debug` says `No database at ...` | It could not find the settings database, so nothing is registered from its point of view and it used the `.env` defaults. Usually `DB_DIR` differs between your shell and the backend - or the backend runs in a container and its database is in there. Name the browser you want instead: `npm run browser:debug -- --port 9222 --site claude-web`. |
| A free provider says a request `waited its whole time budget for a free tab` | Its browsers were all busy for the whole call. Nothing was refused for queue length - there is no limit - the request simply ran out of its own time. Add another browser for that site: each one runs one more request at a time. |
| `npm run browser:debug` says `nothing is listening on port ...` | Usually another window of that browser is already running with the same profile: Chrome then opens a tab in the existing window and never opens the port. Close every window of it and run it again - a port that already has a browser on it is reused, not started twice. On a server with no display, Chrome exits at once - set `AI_WEB_BROWSER_ARGS=--headless=new --no-sandbox`, noting that a headless browser cannot be signed in to by hand and so only works against a profile that already is. |
| `npm run browser:debug` says no installed browser was found | The resolver looks in the standard install locations and deliberately ignores `CHROME_PATH`, because that often points at puppeteer's Chrome for Testing and sign-in flows reject a browser in automation mode. Set `AI_WEB_BROWSER_PATH` to the browser you want used. |
| A browser provider says the site `did not answer because ...` | The site refused rather than the driver failing. A usage limit or a rate limit is reported as such and resets on its own; a signed-out tab or a human-verification check needs you at the browser. Either way the backend stops at once instead of polling until the deadline. |
| A browser provider warns `produced N assistant messages, and the first is being read as the reply` | The send produced more than one assistant message. The driver takes the first one that was not there before, which is right when a site streams two candidate answers side by side and wrong if one of those nodes is a reasoning trace or a preamble. If answers come back looking like reasoning, narrow `AI_WEB_CLAUDE_ASSISTANT` / `AI_WEB_CHATGPT_ASSISTANT` so it matches only the finished reply. |
| A browser provider warns `no usable "still generating" selector` | Every stop-button candidate also matched an idle page, so nothing can report that a reply is in flight. Answers are still read correctly - the driver falls back to waiting until the text has stopped changing for several seconds - but each call is slower. Set `AI_WEB_CLAUDE_BUSY` or `AI_WEB_CHATGPT_BUSY` to something present only while the site is generating. |
| A browser provider says the tab `was navigated to ...` | Something moved that tab off the chat site mid-answer - usually a link clicked in it. Give the app a tab of its own in the debug browser, or leave that window alone while a run is in flight. |
| A browser provider returns the prompt instead of an answer | The site's assistant selector is also matching your own message. The backend refuses the answer rather than tailoring a resume to the instructions, and says so. Set `AI_WEB_CLAUDE_ASSISTANT` or `AI_WEB_CHATGPT_ASSISTANT` to something that can only match an assistant turn. |
| A metered provider says `No API key is configured` | Set its key in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`) and restart the backend. Keys used to be enterable on the Settings page and stored in the database; that is gone, and any keys an older install had stored are deleted the first time the new build reads its settings. The Settings page shows each provider's live status instead. |
| An effort or thinking choice appears to do nothing | Look for `[ai] ... has no effort control` in the backend output. Only the Claude CLI provider honours them; the metered OpenAI, Anthropic and DeepSeek transports report them as dropped rather than pretending they applied. Switch the model, on the profile or under Admin → Models, to a Claude CLI one. |
| `Could not find Chrome (ver. ...)`, or `PDF rendering needs a Chrome to print with` | Puppeteer's Chrome was never downloaded - an `npm install --ignore-scripts`, a proxy blocking the download, or a cleaned cache. Run `npm run setup:browser`, which fetches exactly the build puppeteer expects. If that download cannot get through, point the server at a browser you already have instead: `CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe` in `.env` (Chrome, Edge, Chromium and Brave all work - same engine). The server also finds an installed browser on its own when the download is missing, so this only comes up when there is neither. |
| `Could not start ... - but there is no file there` at startup | `CHROME_PATH` or `PUPPETEER_EXECUTABLE_PATH` names a path that does not exist. An explicit setting is never silently overridden, so fix the path or unset it to fall back to the downloaded browser. |
| `The Claude CLI is not installed or is not on the server PATH` | Either it genuinely is not installed, or the server process has a different PATH than your shell - common under systemd and Docker, which get a minimal one. Set `AI_CLI_BIN` to the full path from `which claude` (`where claude` on Windows). On Windows npm installs the CLI as `claude.cmd`, a shim wrapping `node_modules\@anthropic-ai\claude-code\bin\claude.exe`; the server follows the shim to that binary on its own, so `AI_CLI_BIN` is only needed if that fails, and then it should name the `.exe`, not the `.cmd`. |
| Startup warns the sign-in is not a subscription | `claude auth status` reports something other than `authMethod: "oauth_token"`, so the CLI found an API key and every request is billed. Run `claude auth login`, and remove `ANTHROPIC_API_KEY` from the server environment if you did not mean to use it. |
| Generation returns 429 with a `Retry-After` | The subscription usage window is spent. The Settings page shows the window and its reset time; generation resumes on its own. |

## 🧪 Tests

```bash
npm test
```

Runs the backend `node:test` suite against temporary SQLite databases and static directories.

The Claude CLI provider is covered by `backend/test/claudeCli.test.js`, which
replays event streams recorded from the real CLI (`backend/test/fixtures/cli`)
through an injected runner — so the suite needs no network, no `claude` binary
and spawns no subprocess.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 |
| **Backend** | Express, TypeScript, better-sqlite3 |
| **AI** | Browser-driven Claude and ChatGPT (default, free), Claude Code CLI (subscription seat, locked by default), OpenAI, Anthropic API, DeepSeek |
| **PDF** | Puppeteer |
| **DOCX** | html-to-docx |
| **Templates** | Handlebars |

---

## 📄 License

ISC
