# Backend Source Layout

- `config/`: application settings orchestration and static asset path resolution.
- `database/`: SQLite connection, schema, and repository helpers for profiles, groups, templates, prompts, skills, and settings.
- `extractors/`: modules that extract structured data from external inputs.
- `generators/`: modules that generate output artifacts such as PDF, DOCX, and cover letters.
- `integrations/`: external service clients and API adapters.
- `middleware/`: Express middleware.
- `routes/`: HTTP route handlers.
- `scripts/`: one-off maintenance commands (legacy JSON data import).
- `services/`: core domain services and AI orchestration.
- `types/`: shared TypeScript types.
- `utils/`: focused utility helpers with no route-level responsibilities.

Static, read-only assets (default prompts, the skill library seed, and built-in templates) live in `backend/static/`.
All dynamic data is stored in the SQLite database under `DB_DIR` (default `/data/db`).
