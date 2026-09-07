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

By default it runs on **your Claude subscription** rather than metered API tokens: the backend drives the locally installed `claude` CLI on the seat you are already signed in to, so generation costs nothing per request. OpenAI, the Anthropic API and DeepSeek remain available as API-key providers you can switch to per prompt or per request.

### ✨ Features

| Feature | Description |
|---------|-------------|
| **Single or Batch** | Generate for one profile, a group, or all profiles at once |
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
│   Frontend      │     │  Backend        │     │  ├── claude-cli  (seat)  │
│   (React 19)    │     │  (Port 3001)    │     │  ├── claude      (key)   │
└─────────────────┘     └─────────────────┘     │  ├── openai      (key)   │
                                 │              │  └── deepseek    (key)   │
                                 │              └──────────────────────────┘
                                 │                           │
                                 │                           ▼
                                 │              `claude -p` subprocess on the
                                 │              signed-in subscription seat
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
| `claude-cli` (default) | The `claude` CLI's own sign-in — no key | Free at the margin. One subprocess per call, bounded by a process-wide semaphore. |
| `claude` | `ANTHROPIC_API_KEY` | Metered. The only provider that can still honour `temperature`. |
| `openai` | `OPENAI_API_KEY` | Metered. |
| `deepseek` | `DEEPSEEK_API_KEY` | Metered. |

The `openrouter` provider was **replaced** by `claude-cli`. An existing database
is migrated on the next boot (its settings row is backed up first, and
`npm run ai:rollback` restores it); records that still name `openrouter` are
read as `claude-cli` whether or not that migration has run.

### Where data lives

| Data | Storage |
|------|---------|
| Profiles, groups, custom templates, custom prompts, edited built-in prompts, app settings, skill library, bid-assistant jobs and answers | SQLite database in `DB_DIR` (default `/data/db/free_tailor.db`) |
| Default prompts (one per feature) | `backend/static/prompts/*.json` |
| Skill library seed (loaded into the database on first run) | `backend/static/skills/skills.json` |
| Built-in resume templates | `backend/static/templates/*.json` |

Nothing under `backend/static` is written to at runtime. Edits made in the admin panel always go to the database.

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+
- A writable database directory (default `/data/db`; override with `DB_DIR`)
- **Claude Code** installed and signed in on the machine running the backend:

  ```bash
  npm i -g @anthropic-ai/claude-code
  claude auth login
  claude auth status     # must print "loggedIn": true and "authMethod": "oauth_token"
  ```

  `oauth_token` is what a subscription looks like. Any other `authMethod` means
  the CLI found an API key and every request will be billed per token; the
  backend says so loudly at startup and on the admin Settings page.

- Optionally an **OpenAI**, **Anthropic** or **DeepSeek** API key, if you want
  those providers available as alternatives

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
DB_DIR=/data/db          # SQLite database directory
NEXT_PUBLIC_API_URL=http://localhost:3001/api
ADMIN_PASSWORD=change-me
```

Nothing else is required for AI generation: the default provider uses the
subscription seat you signed in to above. The `AI_CLI_*` variables in
`.env.example` tune the model, effort, concurrency and timeouts.

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

The backend prints every address it is reachable on when it starts.

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
| **Profiles** | Create/edit candidate profiles, prompts, template, file naming, and hard-skill ordering |
| **Groups** | Group profiles for batch generation |
| **Templates** | Built-in, manual, and uploaded resume templates |
| **Prompts** | Edit default prompts or add custom variants per feature |
| **Skills** | Maintain the hard/soft skill library |
| **Settings** | AI providers, models, API keys, output location, and live Claude subscription status (sign-in, usage window, in-flight calls) |

---

## 🔧 Configuration

| Variable | Description |
|----------|-------------|
| `HOST` / `PORT` | Backend bind address and port (default `0.0.0.0:3001`) |
| `DB_DIR` | SQLite database directory (default `/data/db`) |
| `FRONTEND_URL` | Extra allowed CORS origins, comma separated (same-host origins are always allowed) |
| `FRONTEND_HOST` / `FRONTEND_PORT` | Frontend bind address and port (default `0.0.0.0:3000`) |
| `NEXT_PUBLIC_API_URL` | Frontend API base; the hostname is replaced at runtime |
| `NEXT_PUBLIC_ALLOWED_DEV_ORIGINS` | Extra origins allowed by the Next.js dev server |
| `NEXT_PUBLIC_CALENDAR_SHARE_URL` | Optional default calendar share link |
| `ADMIN_PASSWORD` | Admin login password |
| `AI_CLI_BIN` | Path to the `claude` binary when it is not on PATH |
| `AI_CLI_MODEL` / `AI_CLI_EFFORT` | Default model alias (`sonnet`) and reasoning effort (`low`) |
| `AI_CLI_CONCURRENCY` | Simultaneous `claude` processes, process-wide (default `4`) |
| `AI_CLI_TIMEOUT_MS` / `AI_CLI_TIMEOUT_MS_TAILOR` | Per-call wall-clock budgets |
| `AI_CLI_ALLOW_API_KEY` / `AI_CLI_ALLOW_OVERAGE` | Opt in to metered billing; both off by default |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | Keys for the metered providers (can also be stored from the admin panel) |

See `.env.example` for the full `AI_CLI_*` list.
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | Service account JSON for Google Sheets import |

---

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
| **AI** | Claude Code CLI (subscription seat, default), OpenAI, Anthropic API, DeepSeek |
| **PDF** | Puppeteer |
| **DOCX** | html-to-docx |
| **Templates** | Handlebars |

---

## 📄 License

ISC
