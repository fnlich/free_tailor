# Backend Tests

Run from the repository root:

```sh
npm test
```

Or run only the backend test suite:

```sh
npm run test --prefix backend
```

The backend tests use Node's built-in `node:test` runner and require no extra test dependencies. The test script builds TypeScript first, then runs the compiled JavaScript from `backend/dist`.

Storage tests set `TAILOR_DATA_DIR` to temporary folders under the system temp directory. This keeps tests from reading or mutating the real JSON database in `backend/data`.

Coverage currently focuses on:

- JSON-backed skills CRUD
- prompt JSON CRUD, rendering, and validation
- app settings JSON persistence
- generated output paths
- JSON extraction utilities
- array utilities
- output path safety helpers
- current auth middleware behavior
