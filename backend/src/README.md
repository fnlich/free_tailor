# Backend Source Layout

- `config/`: application configuration and settings orchestration.
- `database/`: local database setup and repository-style persistence helpers.
- `extractors/`: modules that extract structured data from external inputs.
- `generators/`: modules that generate output artifacts such as PDF, DOCX, and cover letters.
- `integrations/`: external service clients and API adapters.
- `middleware/`: Express middleware.
- `routes/`: HTTP route handlers.
- `services/`: core domain services and AI orchestration.
- `types/`: shared TypeScript types.
- `utils/`: focused utility helpers with no route-level responsibilities.
- `examples/` and `experiments/`: non-runtime reference code and exploratory snippets.
