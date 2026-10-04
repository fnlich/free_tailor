'use strict';

/**
 * The deployment settings a scraper run is handed, and the check that they
 * were handed in.
 *
 * Apart from apify.js, which reads the token (APIFY_API_TOKEN, or the older
 * APIFY_API_KEY), nothing in this directory reads the environment.
 * services/scraperProviders.ts resolves APIFY_ACTOR_*, APIFY_RUN_TIMEOUT_S,
 * APIFY_PROXY_GROUPS, SCRAPER_COUNTRY, SCRAPER_DEFAULT_LOCATION and
 * SCRAPER_MAX_RESULTS through config/operational.ts - validated, defaulted,
 * warned about once - and passes the values in as one `settings` object:
 *
 *   actorId          the Apify actor to run ('owner/name')
 *   runTimeoutS      the run timeout, which is also how long we wait for it
 *   proxyGroups      Apify proxy groups; [] means leave the groups out (`auto`)
 *   country          ISO 3166-1 alpha-2, for the actors that take one
 *   defaultLocation  the deployment's job market, for the actors with a fixed one
 *   maxResults       the deployment's cap on one run, or null for none
 *
 * Keeping the reads on the TypeScript side means there is one reader per
 * variable and one place its default is written. The price is that a caller
 * can forget to pass them, and the actor would then be started with
 * `country: undefined` or no timeout and billed regardless - so each function
 * that needs a field checks for it and names the wiring that should have
 * supplied it.
 */

const CHECKS = {
  actorId: (value) => typeof value === 'string' && value.length > 0,
  runTimeoutS: (value) => Number.isInteger(value) && value > 0,
  proxyGroups: (value) => Array.isArray(value) && value.every((group) => typeof group === 'string' && group.length > 0),
  country: (value) => typeof value === 'string' && value.length > 0,
  defaultLocation: (value) => typeof value === 'string' && value.length > 0,
  maxResults: (value) => value === null || (Number.isInteger(value) && value > 0),
};

/**
 * `settings`, once every named field is present and well formed.
 *
 * `what` names the caller ("Indeed scraper"), so a wiring mistake says which
 * run it broke.
 */
function requireSettings(settings, fields, what) {
  for (const field of fields) {
    const value = settings ? settings[field] : undefined;
    if (!CHECKS[field](value)) {
      throw new TypeError(
        `The ${what} needs settings.${field} (got ${JSON.stringify(value)}); ` +
          'services/scraperProviders.ts resolves it from the environment and passes it in.'
      );
    }
  }

  return settings;
}

module.exports = { requireSettings };
