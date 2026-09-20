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

By default it runs on **a chat tab you are already signed in to** rather than metered API tokens: the backend drives claude.ai or chatgpt.com in a Chrome you started yourself, so generation costs nothing per request and needs no API key. Running on a **Claude subscription seat** through the local `claude` CLI is also offered, and needs only that the `claude` binary is installed and signed in on the machine running the server. OpenAI, the Anthropic API and DeepSeek remain available as API-key providers you can switch to per prompt or per request.

### ✨ Features

| Feature | Description |
|---------|-------------|
| **Accounts** | Sign in with Google or a code emailed to you. Your profiles belong to your account and nobody else on the installation can see them |
| **Plans** | Default (1 profile), Premium (5), Premium+ (25), Premium Max (unlimited). An administrator sets the plan |
| **Credits** | One credit per generated resume, whatever it writes. Charged before the first model call and given back for any resume that does not build, so credits spent always equals resumes delivered. Previews are free; administrators are exempt. Every movement has a ledger row explaining it |
| **Roles** | User and Administrator. Admins manage accounts, prompts, models, templates, the skill library and settings - everything shared by everybody |
| **Single or Batch** | Generate for one profile, a group, or all profiles at once |
| **Profile import** | Move a profile between installs, restore one from a backup, or write one by hand: upload the JSON under Admin → Profiles |
| **ATS Optimization** | AI extracts keywords and tailors content for applicant tracking systems |
| **Templates** | Built-in professional templates plus manual and uploaded templates |
| **Cover Letters** | Auto-generated PDF and DOCX cover letters with professional formatting |
| **Per-Profile Settings** | Each profile chooses its prompts, template, file naming, and skill ordering |
| **Admin Panel** | Manage accounts, groups, templates, prompts, skills, and AI model settings |
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
| `claude-cli` | The `claude` CLI's own sign-in — no key | Offered. Needs `claude` installed and signed in on the server's machine. Free at the margin, one subprocess per call. |
| `claude` | `ANTHROPIC_API_KEY` | Metered. The only provider that can still honour `temperature`. |
| `openai` | `OPENAI_API_KEY` | Metered. |
| `deepseek` | `DEEPSEEK_API_KEY` | Metered. |

**Locked providers.** A lock means this installation cannot run a provider —
distinct from the admin's enable switch, which records what an operator wants.
**Nothing is locked out of the box.** A locked provider's models stay in every
picker, greyed out behind a 🔒 with the reason next to them, rather than
vanishing: a model that disappears reads as a bug. Nothing dispatches to a
locked provider — naming one by model id, by provider id or as
`provider:modelName` is refused with a sentence saying so.

Lock one from `.env` when the machine cannot run it — a box with no `claude`
binary signed in, or a shared install whose operator does not want the
subscription seat spent:

```env
AI_LOCKED_PROVIDERS=claude-cli
```

`AI_UNLOCKED_PROVIDERS` is the mirror, and wins when a provider is in both, so
it stays an escape hatch.

There is deliberately no button for either in the admin UI. A lock is a fact
about the machine, and only whoever set the machine up can know it has changed.

The `openrouter` provider was **replaced** by `claude-cli`. An existing database
is migrated on the next boot (its settings row is backed up first, and
`npm run ai:rollback` restores it); records that still name `openrouter` are
read as `claude-cli` whether or not that migration has run.

A second migration gives an install upgrading from before the browser-chat
providers their `claude-web` and `chatgpt-web` model records. Model
records are stored per install, so the seed list a new install starts from
could never reach one that had already saved settings - which is why those two
providers were enabled and configurable while no model in any picker named
them. The same migration switches the two on if every provider the install had
enabled turns out to be locked, and repoints a stored default that named the
locked seat at a free model rather than at a metered one.

### Credits

One credit buys **one resume** - one profile against one job - however many files
that produces. A run asking for PDF and DOCX plus a cover letter writes four
files and costs one credit, because what was asked for is one tailored resume.

The charge happens **at submit, before the first model call**, and every resume
that does not build gives its credit back. So the invariant is: *credits spent
equals resumes delivered*. A run that is cancelled refunds everything that had
not started; one that fails half way refunds the half that failed.

Charging up front rather than on delivery is what makes a refusal mean
something. The batch endpoint returns a job id before any work runs, and by the
time a task reaches a browser there is no request and no user attached to it - so
the only moment a charge can be both truthful and attributable is when the work
is asked for. It also means a run of thirty is refused as thirty, rather than
being refused on the thirtieth after twenty-nine resumes already exist.

- **Previews are free.** `/preview` and `/preview-all` write no file, and the
  tailored output they return is reused by the real run - charging both would
  bill the ordinary preview-then-generate flow twice for one piece of model work.
  A new account on zero credits can still paste a job description and see the
  result; what it cannot do is take the file away.
- **Administrators are exempt.** They can already set any balance, so metering
  them is a formality. The first account to sign in is an administrator, which is
  why a fresh install works on day one with nobody holding a credit.
- **Every movement is explainable.** The ledger is append-only and records the
  reserve, each refund, each grant and who made it. `users.credits` is a cache of
  its sum, and a disagreement is reported at startup rather than quietly fixed -
  it would mean something wrote the balance outside the credit service.
- **A balance dips while a run is in flight.** The account page shows that as
  *held*, rather than hiding it and having the number appear to come back from
  nowhere.

A brand-new account starts at **0** and needs an administrator to grant it some.
Set `CREDIT_SIGNUP_GRANT` to give an open installation a self-serve trial instead.

### What each account can reach

Not everything is for everybody, and the rule differs by section because the
reasons differ. A **role** says who may change things the whole installation
shares; a **plan** says what an individual account includes. They are separate
checks and one is not a substitute for the other.

| Section | Who | Why |
|---|---|---|
| Builder, Calendar, Jobs, Job Filter, Bid Assistant, Profiles | anybody signed in | their own work |
| **Find the job** | anybody signed in | opens today's tab of their own job sheet in a new tab |
| **Groups** | **Premium and above** | an entitlement, checked on the plan alone |
| **Templates** (managing them) | **administrators** | a template is shared - editing one changes how everybody's resumes look. Everybody still *picks* a template when building |
| **Test** | **administrators** | runs prompts directly and shows raw model output; a tool for whoever maintains the prompts |
| **Settings** (all of it) | **administrators** | every page under it changes something shared |

An entry nobody may use is not shown in the navigation, and the page behind it
explains itself if the URL is typed - a blank screen reads as a broken link.
**Hiding is not the protection**: every one of these is enforced by middleware on
the routes, so an old tab or a hand-made request is refused just the same.

One consequence worth knowing: because the group gate is on the plan alone, **an
administrator on the default plan is refused Groups too**. Every account starts
on the default plan, so the first administrator has to be moved up before they
can use them.

### The job sheet

Every account gets **one Google spreadsheet of its own**, and inside it **one tab
per day**, named `MM/DD/YYYY`. The tab is created on the first sign-in of that
date and skipped on every sign-in after, so a day's rows stay together and a
quiet day costs nothing. A new tab opens with the job columns - `NO(DATE)`,
`Company`, `Job Title`, `Job Link`, `Job Description`, `Rate`, `note`,
`Job Finder`, `Filter Result`, `Filter Reason` - frozen, filtered and formatted.
The first eight are yours to fill in; the last two belong to the job filter.

Allocation is **fire-and-forget at sign-in**: a spreadsheet is a convenience and
being able to log in is not, so a Google outage must not become an outage of
logging in. The account page ensures the same thing when it loads, which is what
covers an account whose sign-in ran while Google was down, and accounts created
before this feature existed - a paced backfill at startup takes care of the rest.

**Who owns them, and who can open them.** Every sheet is created in the Drive of
whichever Google account signed in with `npm run sheets:login` - the operator's,
normally - and each account is invited to its own sheet as an **editor**, by
email, without a notification mail.

New sheets are **public by default**, meaning anyone with the link can edit them.
The toggle on the account page withdraws exactly that one grant and nothing else:
the owner's personal invitation stays, which is what still lets them open it. The
order matters and is enforced - the invitation is confirmed *before* the link is
taken away, and the request is refused outright if it cannot be, because
withdrawing the link from somebody who never got an invitation locks them out of
their own spreadsheet with no way back through the UI.

Either way the server keeps its own access, since the file belongs to the account
whose credentials it holds - so job links, company names and descriptions still
load after somebody goes private.

Nothing ties the credential to the app's administrator: sheets land in whichever
Drive consented, which may not be the address `ADMIN_EMAILS` or `SMTP_USER`
names. `npm run sheets:doctor` reports the owning account and says so when the
two differ.

**Who administers the installation.** Not whoever signs in first - on a server
anybody can reach, that handed the keys to the quickest stranger. It is
`ADMIN_EMAILS` when that is set, otherwise the `SMTP_USER` address: the mailbox
sign-in codes are sent *from* is a credential the operator had to configure, so
it identifies them. With neither set there is **no administrator at all**, and
startup says so loudly. An account named by either is promoted the moment it
exists - at boot or on its next sign-in - and nothing is ever demoted, so a typo
in `.env` cannot lock you out.

**When it will not work: `npm run sheets:doctor`.** Allocation fails with a 403
whose message is often only "The caller does not have permission" - true of a
disabled API, a narrow scope, a full Drive and a revoked key alike. The doctor
walks the same chain allocation walks, with the real API calls, and stops at the
first step that breaks with the remedy for that step. It creates one throwaway
spreadsheet and deletes it again.

```
cd backend
npm run sheets:doctor
npm run sheets:doctor -- --email you@example.com   # also tests sharing
npm run sheets:doctor -- --keep                    # leave the throwaway behind
```

**Which credential, and why it probably is not a service account.** The tidy
arrangement is a service account key, and on a Google Workspace domain with a
shared drive it works. On a **consumer Google project it cannot**: the service
account is given a Drive quota of **zero bytes**, so it authenticates perfectly
and can never own a file - and creating a spreadsheet means owning one. The
failure is a 403 that blames permissions and means storage.

So the app accepts either credential, and prefers the one that works:

```
cd backend
npm run sheets:login     # sign in as yourself, once
```

That saves `google-oauth-credentials.json`, and every account's sheet is then
created in **your** Drive and shared with its owner as an editor. It needs an
OAuth client from the Cloud console (Desktop app type) - the script says exactly
where to click if it cannot find one. `GOOGLE_CREDENTIALS_PATH` overrides where
credentials are looked for; a service account key at
`backend/service-account-key.json` still works if you have a shared drive for it.

Two things this needs from Google, and both are easy to miss:

- The **Drive API** enabled for the same Cloud project as the key, not just the
  Sheets API. Sharing is a Drive concept, and a missing Drive API produces a 403
  that blames the file rather than the setting.
- Room in the service account's own Drive. Files it creates count against *its*
  quota, not against any person's, so a large installation should point the key
  at a shared drive.

**Moving to another server.** Nothing is registered with Google a second time.
The Cloud project, the enabled Sheets and Drive APIs, the consent screen and the
OAuth client all belong to the Google account that consented - not to a machine -
so a new host inherits them by holding the same credential file. Copy
`backend/google-oauth-credentials.json` across and give it mode `0600`: the
refresh token inside is tied to an account, not to a host or an IP. Running
`npm run sheets:login` on the new machine is equivalent and mints a second
refresh token for the same account, both valid - but its redirect goes to
`127.0.0.1`, so it needs a browser on that machine, which a headless server has
not got.

**Copy the database too, with the backend stopped**, and this is the part that
does damage if it is missed. An account's row is the *only* record of which
spreadsheet is its own. Start a new server on an empty database and every
account looks like an account from before the feature existed, so the startup
backfill allocates each one a **brand-new spreadsheet** and the real ones are
left orphaned in the Drive that owns them - with a log line that reads like a
success. The file is `free_tailor.db` in `DB_DIR`, and the default differs by
platform, so a Windows-to-Linux move will never find the old one by accident:

```
Linux/macOS   /data/db/free_tailor.db
Windows       %LOCALAPPDATA%\free_tailor\db\free_tailor.db
```

`SHEET_BACKFILL=off` is how to bring the new host up *before* the database is in
place without it allocating anything.

`.env` does not travel with the repository and has to be written again -
`ADMIN_EMAILS`, the `SMTP_*` block, `DB_DIR`, `SHEET_TIMEZONE`,
`SHEET_BACKFILL`. Do not carry a relative `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`
across: it resolves from whatever directory the backend was started in on the
new machine, and it names a credential this setup no longer wants. Then
`cd backend && npm run sheets:doctor` on the new host, which walks the same
chain allocation walks and says which step is missing.

One thing to check that is neither the old server's nor the new one's: an OAuth
consent screen still in **Testing** expires its refresh tokens after seven days,
on every machine equally. Publish it.

**The job pages write into it.** Scraping jobs and filtering them used to make
you supply a spreadsheet id, a tab name and four column letters. They now default
to your own sheet, today's tab, and the layout above - `Company`, `Job Title`,
`Job Link` and `Job Description` for an export; the job link read back, with the
filter's verdict in `Filter Result` and its reason in `Filter Reason` - two
columns the filter owns, so `Rate`, `note` and `Job Finder` stay yours. Rows are appended after
what is already there, and jobs already in the tab are skipped.

**And the builder reads back out of it.** *Import from Sheets* on the builder
offers your own sheet first and by default, on today's tab, with `Company`,
`Job Title` and `Job Description` already mapped - because the layout is one
this app wrote. A saved source is somebody else's spreadsheet and keeps the
older column guesses. Only an administrator is offered the saved sources at all:
they are not a user-addressable sheet, so listing them for everyone did nothing
but offer a 404.

**Who may point them where.** A spreadsheet id supplied by a request is checked
rather than trusted: an ordinary account may address only its own sheet, and an
administrator may also address the shared sources they configured on the admin
page. Anything else is a 404. This matters more than it looks - the service
account *owns* every account's spreadsheet, so a route that took an id on trust
would read and overwrite anybody's for anyone who knew it, and a link-shared
sheet hands that id out in its URL.

`SHEET_TIMEZONE` decides which day a tab belongs to. A server running in UTC
rolls the day over at midnight UTC, which for a user in New York is seven in the
evening - so an evening's work would land on the next day's tab. Set it to the
zone the users actually live in.

### Where data lives

| Data | Storage |
|------|---------|
| Profiles, groups, custom templates, custom prompts, edited built-in prompts, app settings, skill library, bid-assistant jobs and answers | SQLite database in `DB_DIR` (default `/data/db/free_tailor.db`) |
| Accounts, live sessions, unused sign-in codes | The same database. Session tokens and codes are stored **hashed**, so a copy of the database yields no usable session |
| Which spreadsheet belongs to an account, and the last day tab prepared in it | The same database, on the account's row - along with `sheet_shared_at`, the moment the owner's invitation to their own sheet was confirmed. Recorded once, so sign-in retries the invitation until it works and then stops asking Drive at all; going private still asks live, because that is the one moment a grant revoked in Google's own UI would lock somebody out |
| Credit ledger and open reservations | The same database. The ledger is append-only and `users.credits` is a cache of its sum; a disagreement between the two is reported at startup rather than silently repaired |
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
- **Claude Code**, only if you want to run on a subscription seat. Install it
  and sign it in; the free browser-chat route needs none of this.

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

  There are **two queues** - one shared by every browser whichever site it
  shows, and one for the Claude CLI seat, so a slow seat never stalls the
  browsers - and **neither has a length limit**. Whenever a browser frees, the
  task that has waited longest takes it. A request only ever gives up on its own timeout, never for being
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

npm run install:all     # root, backend and frontend
```

Or the three on their own, which is what `install:all` runs:

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

**Already have a checkout?** Run `npm run install:all` again after every pull.
A pull brings new `package.json` entries but not the packages themselves, and
the symptom is a compile error naming a module that "cannot be found" - most
recently `nodemailer`, which v2 added for the emailed sign-in codes.

### 2. Environment Setup

Copy `.env.example` to `.env` in the project root and fill in the values you need. The important ones:

```env
HOST=0.0.0.0             # backend listens on every interface
PORT=3001
#DB_DIR=                 # SQLite database directory; see the note below
NEXT_PUBLIC_API_URL=http://localhost:3001/api

# One of these two, or nobody can sign in:
GOOGLE_CLIENT_ID=        # OAuth 2.0 Web application client id
SMTP_HOST=               # ...or SMTP, for emailed six-digit codes
SMTP_USER=
SMTP_PASS=
```

**Somebody has to be able to sign in.** Set up Google sign-in or SMTP - the
login page names what is missing if neither is configured. The **first account
to sign in becomes the administrator**, because account management is
admin-only and an install whose first user was an ordinary one would have no
way to appoint one. Set `ADMIN_EMAILS` to decide in advance instead.

Upgrading an install that has profiles already? They have no owner, so they are
invisible to ordinary accounts and visible to administrators until the first
administrator signs in, at which point they are adopted automatically.

`DB_DIR` is commented out in `.env.example` on purpose, so a fresh checkout
picks the writable default for the platform it is on. Set it when you want the
data somewhere specific - `DB_DIR=./data/db` works on both Windows and Ubuntu
and is resolved from the directory the backend was started in.

Nothing else is required for AI generation: the default provider drives a
claude.ai tab in the debug Chrome described above, which costs nothing and
needs no key. The `AI_CLI_*` variables in `.env.example` tune the model,
effort, concurrency and timeouts of the subscription-seat provider, which
needs the `claude` CLI installed and signed in on this machine.

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
| **Accounts** | Every account on the installation, with its role, plan, credits and profile use. Set a balance outright or add a delta, and read any account's ledger to see where a balance came from. Change any of them, disable an account, end all its sessions, or delete it. The last enabled administrator cannot be demoted, disabled or deleted - account management is admin-only, so that would leave nobody who could undo it. Adding an account here sets somebody's plan before they arrive; it is not a way in, since they still prove the address through Google or a code |
| **Profiles** | Create/edit candidate profiles, prompts, template, file naming, and hard-skill ordering. Three ways in: **Add Manually**, **Upload Resume PDF** (an AI call reads the PDF), and **Import JSON** (no AI call - the file already is a profile) |
| **Profile JSON import** | Takes one profile, a list of them, or `{ "profiles": [ ... ] }` - the shapes `GET /api/profiles/:id` hands out. An import never overwrites a profile you already have: an id that is free is kept, so a backup restored into an empty install keeps the ids its groups reference, and one that is taken gets a new profile instead. A file with one bad entry imports nothing rather than half |
| **Groups** | Group profiles for batch generation |
| **Browser chat providers** | `Claude (browser)` and `ChatGPT (browser)` drive claude.ai and chatgpt.com in a Chrome you started and signed in to yourself, over the DevTools protocol. No API key, nothing metered - your existing chat plan is the quota. Slow, one conversation at a time, and the prompt goes into that account's chat history |
| **Browser Chat (free)** | Register a debug port per browser here; registering saves immediately, because this list is what the providers and the launcher both read. It shows each platform as **Active** or **Not active** (active = the provider found a signed-in chat tab, which a port probe alone cannot tell from a signed-out one) and the ports registered, reachable, and showing the site. It does **not** start browsers - `npm run browser:debug` does. Unregistering forgets a browser here; it does not close a window |
| **Credentials** | Claude Code runs on your subscription seat, with no key at all. The metered providers - Anthropic API, OpenAI, DeepSeek - read their key from `.env`; there is no key management in the app, so a key exists in exactly one place |
| **AI defaults per profile** | Each profile picks its own model and effort (`low`..`max`); the builder shows those defaults and can override either for a single run. Both menus list every model, with the locked ones greyed out behind a 🔒 rather than hidden. Effort is the CLI's `--effort` flag: how much reasoning the model spends before answering |
| **Templates** | Nineteen built-in templates - Professional Two-Column, Classic Serif, Developer Mono, Structured Slate, Editorial Italic, Contrast Cards, Charcoal Sidebar, Timeline Bars, Indigo Band, Forest Chips, Slate Italic, Burgundy Rule, Navy Rule, Navy Gold, Amber Gradient, Ink Ledger, Dossier Panel, Framed Serif and Azure Stack - plus manual and uploaded ones. **View** renders any of them with a full sample resume in that template's own page box, read from its `@page` rule, so the preview and the printed PDF agree |
| **Prompts** | Edit default prompts or add custom variants per feature, grouped into **Extracting Prompts** (a posting into keywords, a resume PDF into a profile, a scraped page into job attributes) and **Building Prompts** (the tailored resume content and the cover letter). The line is what a prompt produces, not what it reads. Admin-only to change, since one edit changes what every account gets |
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
| `ADMIN_EMAILS` | Who becomes an administrator, comma separated. Leave empty and the first account to sign in does. **When it is set it is the only rule** - if somebody not on the list signs in first, the install has no administrator until a listed address does, and the backend says so at startup |
| `CREDIT_SIGNUP_GRANT` | Credits a brand-new account starts with. `0` by default |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 Web application client id, for Google sign-in |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Sending the emailed sign-in codes. Port 465 is treated as implicit TLS and everything else as STARTTLS; `SMTP_SECURE` overrides that, and `SMTP_FROM` defaults to `SMTP_USER` |
| `AI_CLI_BIN` | Path to the `claude` binary when it is not on PATH |
| `AI_CLI_MODEL` / `AI_CLI_EFFORT` | Default model alias (`sonnet`) and reasoning effort (`low`) |
| `AI_CLI_CONCURRENCY` | Simultaneous `claude` processes, process-wide (default `4`) |
| `AI_CLI_TIMEOUT_MS` / `AI_CLI_TIMEOUT_MS_TAILOR` | Per-call wall-clock budgets |
| `AI_CLI_ALLOW_API_KEY` / `AI_CLI_ALLOW_OVERAGE` | Opt in to metered billing; both off by default |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | Keys for the metered providers (can also be stored from the admin panel) |
| `GOOGLE_CREDENTIALS_PATH` | Where to look for Google credentials, overriding the search. Either `google-oauth-credentials.json` (from `npm run sheets:login`) or a service account key. **One set serves everything** - per-account sheets, the scrapers, the sheet filter, the range import and the bid assistant |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | The older name for the same thing, still honoured. Whichever credential is used, **both** the Sheets API and the Drive API must be enabled for its Cloud project |
| `SHEET_TIMEZONE` | IANA zone deciding which day a sheet tab belongs to (e.g. `America/New_York`). Defaults to the server's own |
| `SHEET_BACKFILL` | Set to `off` to skip allocating spreadsheets for pre-existing accounts at startup |
| `ADMIN_EMAILS` | Who administers this installation. Wins over `SMTP_USER`; a comma-separated list may name several |
| `SMTP_USER` | Also the administrator's address when `ADMIN_EMAILS` is unset. Ignored for that purpose when it is a bare username rather than an email |

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
| A profile's platform choice inside a batch | Still honoured. A profile that had picked `claude-web` before the pickers were folded into one entry still waits for a Claude browser even if a ChatGPT one is idle; a profile on `Default (browser)` goes to whichever frees up first. A pinned task at the head does not block a browser it cannot use - the browser reaches past it for the next task it can run. A task no registered browser can serve fails with that reason rather than waiting for ever. |
| A batch of profiles or a sheet import runs one at a time | Fixed. Every batch endpoint now runs its items in parallel, as wide as the chosen provider can actually take: the browsers registered for that site, both sites' added together under Hybrid, or `AI_CLI_CONCURRENCY` slots for the subscription seat. The queues were already there - a free browser is handed to the head of its line the moment it is released - the batch just was not offering them enough work. `AI_BATCH_CONCURRENCY` still overrides the whole thing. The backend logs the width and the reason at the start of each batch. |
| Generation feels like it sends more than it needs to | It used to. The profile is now projected before it goes to the model: contact details, this database's ids and timestamps, and the whole of `profileSettings` (your prompt choices, file-name templates and which model you pay for) are left out, and the JSON is compact rather than pretty-printed. Measured on a five-role profile: 9,365 characters down to 6,942. Nothing the prompt reads was removed. |
| The same job posting is analysed over and over | It is not any more. An analysis is deterministic, so the answer is kept for six hours keyed on the posting, the model, and the prompt's own text - a preview followed by a generate, or a sheet re-run after fixing one row, now costs one call instead of two. Editing the prompt invalidates it, so an admin never sees a stale answer from the version they just changed. |
| One browser is out of messages and the whole request fails | Fixed. A browser that is reachable but cannot take the prompt - out of messages, signed out, wedged, or a previous turn that never let go - is passed over for the next browser of that site, and left out for a few minutes so later calls skip it too. That is the reason to run more than one: each window is a separate session, so an account's wall is not the site's. The retry only happens when the prompt never reached the site; once it has landed, another browser would be asking the same question twice. When every browser refuses, the error is still that browser's own (a usage wall is a 429, a signed-out tab a 503) with each browser and its reason named in the log. |
| A free account runs out of messages halfway through a batch | Nothing to set - **Default (browser)** already spreads calls across both free accounts. A tailoring run is three calls and a batch of ten profiles is thirty, which one account will not carry, so it moves to the other whenever one is out of messages, signed out, or has no browser running. It appears whenever at least one free provider is enabled, and covers whichever of the two are. |
| Effort is greyed out | The chosen model is a chat window, and a chat window has no effort flag - there is nowhere to put one. The select goes inactive rather than accept a setting that would change nothing. Pick the Claude CLI seat to get it back. |
| Technical Skills shows headings you do not want | Set **Technical Skills Layout** to `One plain list` under the profile's settings. The headings are kept, not deleted, so switching back restores them. |
| A skill is filed under the wrong heading | The shared skill library guesses a heading per skill, and it cannot know that your Vault is infrastructure rather than a library. Press **Assign headings** on the profile's Hard Skills and set that one; the rest keep being worked out. A profile's own headings are used exactly as written and are never padded out to a count. |
| An exported set of templates will not import | Fixed. The JSON upload now takes one template, a list of them, or `{ "templates": [ ... ] }`, works `sections` out from the markup when the file names none, and says which entry is wrong rather than failing the file. It saves all of them or none, and never overwrites a template already here. |
| An uploaded profile lost its skills | It should not now: a flat list, a `{ "Languages": [ ... ] }` map, a list of `{ category, skills }` groups, and a mix of names and groups all import to the same profile. Every grouped skill also lands in the flat list the tailoring prompt reads. |
| A model is greyed out with a 🔒 and cannot be picked | Its provider is locked in this installation - the row says why. Nothing is locked by default, so this means `AI_LOCKED_PROVIDERS` in `.env` names it; remove it there and restart, or use `Default (browser)`. |
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
| An effort choice appears to do nothing | Look for `[ai] ... has no effort control` in the backend output. Only the Claude CLI provider honours it; the metered OpenAI, Anthropic and DeepSeek transports report it as dropped rather than pretending it applied. Switch the model, on the profile or under Admin → Models, to a Claude CLI one. |
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
| **AI** | Browser-driven Claude and ChatGPT (default, free), Claude Code CLI (subscription seat), OpenAI, Anthropic API, DeepSeek |
| **PDF** | Puppeteer |
| **DOCX** | html-to-docx |
| **Templates** | Handlebars |

---

## 📄 License

ISC
