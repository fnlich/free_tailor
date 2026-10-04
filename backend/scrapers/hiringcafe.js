'use strict';

const { getApifyClient, getAllDatasetItems } = require('./apify');
const { requireSettings } = require('./settings');
const { mapFiltersForHiringCafe } = require('./filters');
const { normalizeHiringCafeItems } = require('./normalize');

const ACTOR_NAME = 'Hiring Cafe scraper';

/**
 * One run of the actor, and its results normalized.
 *
 * `settings` is the deployment's (see ./settings.js): the actor id from
 * APIFY_ACTOR_*, and APIFY_RUN_TIMEOUT_S, which bounds the run on Apify's side
 * and how long this call waits for it.
 */
async function runHiringCafeScraper(filters, settings) {
  const { actorId, runTimeoutS } = requireSettings(settings, ['actorId', 'runTimeoutS'], ACTOR_NAME);
  const client = getApifyClient(ACTOR_NAME);
  const actorInput = mapFiltersForHiringCafe(filters || {}, settings);
  const startedRun = await client.actor(actorId).start(actorInput, { timeout: runTimeoutS });
  const finishedRun = await client.run(startedRun.id).waitForFinish({ waitSecs: runTimeoutS });

  if (finishedRun.status !== 'SUCCEEDED') {
    const statusMessage = finishedRun.status === 'RUNNING' || finishedRun.status === 'READY'
      ? `timed out after ${runTimeoutS} seconds`
      : `failed with status ${finishedRun.status || 'UNKNOWN'}`;
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || startedRun.id} ${statusMessage}.`);
  }

  const items = await getAllDatasetItems(client.run(finishedRun.id).dataset());
  return normalizeHiringCafeItems(items);
}

module.exports = {
  runHiringCafeScraper,
};
