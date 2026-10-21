/*
 * Keeps an e2e backend away from any real Google credential. Loaded with
 * `node --require` FIRST - at the top of every stub and fake preload here, and
 * on its own for a backend that needs none of them - before anything loads
 * the backend.
 *
 * The credential search also looks beside the compiled code, so on a checkout
 * holding a real credential (backend/google-oauth-credentials.json once
 * `sheets:login` has run, or backend/service-account-key.json) an e2e backend
 * whose sheets were not stubbed signed its test accounts in and allocated a
 * REAL spreadsheet for each, in that Google account. These are the three
 * settings scripts/runTests.js gives the unit tests: the search off, and both
 * path variables empty - an exported empty value counts as set, so the root
 * `.env` cannot fill them in. A backend started with no preload at all still
 * finds a real credential.
 */

process.env.TAILOR_GOOGLE_CREDENTIAL_SEARCH = 'off';
process.env.GOOGLE_CREDENTIALS_PATH = '';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH = '';
