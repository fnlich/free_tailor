'use strict';

const { getApifyClient, getAllDatasetItems } = require('./apify');
const { mapFiltersForHiringCafe } = require('./filters');
const { normalizeHiringCafeItems } = require('./normalize');

const ACTOR_ID = 'manojachari/hiring-cafe-scraper';
const ACTOR_NAME = 'Hiring Cafe scraper';
const RUN_TIMEOUT_SECS = 300;

async function runHiringCafeScraper(filters) {
  const client = getApifyClient(ACTOR_NAME);
  const actorInput = mapFiltersForHiringCafe(filters || {});
  const startedRun = await client.actor(ACTOR_ID).start(actorInput, { timeout: RUN_TIMEOUT_SECS });
  const finishedRun = await client.run(startedRun.id).waitForFinish({ waitSecs: RUN_TIMEOUT_SECS });

  if (finishedRun.status !== 'SUCCEEDED') {
    const statusMessage = finishedRun.status === 'RUNNING' || finishedRun.status === 'READY'
      ? `timed out after ${RUN_TIMEOUT_SECS} seconds`
      : `failed with status ${finishedRun.status || 'UNKNOWN'}`;
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || startedRun.id} ${statusMessage}.`);
  }

  const items = await getAllDatasetItems(client.run(finishedRun.id).dataset());
  return normalizeHiringCafeItems(items);
}

module.exports = {
  runHiringCafeScraper,
};
