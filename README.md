<div align="center">

# ✨ Tailored Resume Builder

**AI-powered resume and cover letter generation with ATS optimization**

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![Express](https://img.shields.io/badge/Express-4-green?logo=express)](https://expressjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--5.1-412991?logo=openai)](https://openai.com/)
[![Anthropic](https://img.shields.io/badge/Anthropic-Claude-orange)](https://anthropic.com/)

</div>

---

## 📖 Overview

Tailored Resume Builder is a full-stack application that generates tailored resumes and cover letters for job applications. Paste a job description, and the AI analyzes it to optimize your resume with relevant keywords, rewrite experience sections, and craft a professional cover letter.

### ✨ Features

| Feature | Description |
|---------|-------------|
| **Single or Batch** | Generate for one profile or all profiles at once |
| **ATS Optimization** | AI extracts keywords and tailors content for applicant tracking systems |
| **Multiple Templates** | Choose from various resume styles (one-column, two-column, etc.) |
| **Cover Letters** | Auto-generated PDF and DOCX cover letters with professional formatting |
| **Profile Templates** | Each profile can have its own preferred template style |
| **Admin Panel** | Manage profiles, templates, and AI model settings |
| **PDF & DOCX** | Export resumes in both formats |

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Next.js 16    │────▶│  Express API    │────▶│  OpenAI/Claude   │
│   Frontend      │     │  Backend        │     │  AI Services     │
│   (React 19)    │     │  (Port 9001)    │     │                  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                        │
        │                        ├── Profiles (JSON)
        │                        ├── Templates (HTML/Handlebars)
        │                        └── Generated (PDF/DOCX)
        └── Admin Panel (Profiles, Templates, Settings)
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+
- **OpenAI API Key** (for GPT-5.1)
- **Anthropic API Key** (optional, for Claude)
- **OpenRouter API Key** (optional, for OpenRouter)

### 1. Clone & Install

```bash
git clone <repo-url>
cd ResumeBuilder

# Install backend dependencies
cd backend && npm install && cd ..

# Install frontend dependencies
cd frontend && npm install && cd ..
```

### 2. Environment Setup

Create a `.env` file in the project root:

```env
# Required for OpenAI
OPENAI_API_KEY=sk-your-openai-key

# Optional for Claude
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key

# Optional for OpenRouter
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-key
OPENROUTER_MODEL=openai/gpt-4o-mini

# Admin panel password
ADMIN_PASSWORD=your-secure-password

# Server config
PORT=9001
FRONTEND_URL=http://localhost:3000
```

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:9001/api
```

### 3. Run

```bash
# Stable multi-tab mode
npm run dev
```

This starts:

- backend in watch mode
- frontend with `next build && next start` to avoid Next.js dev websocket reloads across tabs

If you want live frontend hot reload while developing UI code, use:

```bash
# Terminal 1: Start backend
cd backend && npm run dev

# Terminal 2: Start frontend with live reload
cd frontend && npm run dev:live
```

- **Frontend:** http://localhost:3000  
- **Backend API:** http://localhost:9001  
- **Admin Panel:** http://localhost:3000/admin  

---

## 📁 Project Structure

```
ResumeBuilder/
├── backend/                 # Express API
│   ├── src/
│   │   ├── routes/         # API routes (profiles, templates, resume, admin)
│   │   ├── services/       # AI, PDF, DOCX, cover letter generation
│   │   ├── config/         # Storage paths
│   │   └── types/          # TypeScript types
│   └── data/
│       ├── profiles/       # Profile JSON files
│       ├── templates/      # Resume templates (JSON with HTML)
│       │   └── m/          # Custom templates (e.g. one-column-clean)
│       └── config/         # AI model config
├── frontend/               # Next.js app
│   └── src/
│       ├── app/            # Pages (/, /admin/*)
│       ├── components/     # Reusable UI components
│       └── lib/            # API client
└── generated/              # Output: resumes, cover letters (PDF/DOCX)
```

---

## 📤 Output Structure

Generated files are saved in:

```
{profile}/{date}/{company}/{role}/
├── {profile}.pdf
├── {profile}.docx
├── {profile}_cover_letter.pdf
└── {profile}_cover_letter.docx
```

- **Date** uses CST (America/Chicago) timezone  
- **Example:** `john_doe/2025-02-21/acme_corp/software_engineer/`

---

## ⚙️ Admin Panel

| Section | Purpose |
|---------|---------|
| **Profiles** | Create/edit candidate profiles (experience, skills, education, preferred template) |
| **Templates** | Upload PDF templates, preview styles, enable/disable |
| **Settings** | Configure AI model providers (OpenAI, Claude, OpenRouter) |

---

## 🔧 Configuration

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Required for OpenAI (GPT) |
| `ANTHROPIC_API_KEY` | Optional for Claude |
| `OPENROUTER_API_KEY` | Optional for OpenRouter |
| `OPENROUTER_MODEL` | Optional OpenRouter model slug (default: `openai/gpt-4o-mini`) |
| `ADMIN_PASSWORD` | Admin login password |
| `PORT` | Backend port (default: 9001) |
| `FRONTEND_URL` | Allowed CORS origin |
| `OPENAI_MODEL` | Override default model (default: `gpt-5.1`) |

---

## 🛠️ Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 |
| **Backend** | Express, TypeScript |
| **AI** | OpenAI SDK (GPT-5.1), Anthropic API (Claude), OpenRouter API |
| **PDF** | Puppeteer |
| **DOCX** | html-to-docx |
| **Templates** | Handlebars |

---

## 📄 License

ISC

---

<div align="center">

**Built with ❤️ for job seekers**

</div>
