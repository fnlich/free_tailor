'use strict';

const { getApifyClient, getAllDatasetItems } = require('./apify');
const { requireSettings } = require('./settings');
const { mapFiltersForIndeed } = require('./filters');
const { normalizeIndeedItems } = require('./normalize');

const ACTOR_NAME = 'Indeed scraper';

/**
 * One run of the actor, and its results normalized.
 *
 * `settings` is the deployment's (see ./settings.js): the actor id from
 * APIFY_ACTOR_*, and APIFY_RUN_TIMEOUT_S, which bounds the run on Apify's side
 * and how long this call waits for it.
 */
async function runIndeedScraper(filters, settings) {
  const { actorId, runTimeoutS } = requireSettings(settings, ['actorId', 'runTimeoutS'], ACTOR_NAME);
  const client = getApifyClient(ACTOR_NAME);
  // The request's maxResults is not passed on: the pasted start URL decides the
  // search, and the mapper sends the actor's per-search cap (see filters.js).
  const actorInput = mapFiltersForIndeed(filters || {}, settings);
  const finishedRun = await client.actor(actorId).call(actorInput, { timeout: runTimeoutS });

  if (finishedRun.status !== 'SUCCEEDED') {
    const statusMessage = finishedRun.status === 'RUNNING' || finishedRun.status === 'READY'
      ? `timed out after ${runTimeoutS} seconds`
      : `failed with status ${finishedRun.status || 'UNKNOWN'}`;
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || 'UNKNOWN'} ${statusMessage}.`);
  }

  if (!finishedRun.defaultDatasetId) {
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || 'UNKNOWN'} finished without a result dataset.`);
  }

  const items = await getAllDatasetItems(client.dataset(finishedRun.defaultDatasetId));
  return normalizeIndeedItems(items);
}

module.exports = {
  runIndeedScraper,
};
