'use strict';

const { getApifyClient, getAllDatasetItems } = require('./apify');
const { mapFiltersForHiringCafeMemo23 } = require('./filters');
const { normalizeHiringCafeItems } = require('./normalize');

const ACTOR_ID = 'memo23/apify-hiring-cafe-scraper';
const ACTOR_NAME = 'Hiring Cafe scraper (memo23)';
const RUN_TIMEOUT_SECS = 300;

async function runHiringCafeMemo23Scraper(filters) {
  const client = getApifyClient(ACTOR_NAME);
  const actorInput = mapFiltersForHiringCafeMemo23(filters || {});
  const finishedRun = await client.actor(ACTOR_ID).call(actorInput, { timeout: RUN_TIMEOUT_SECS });

  if (finishedRun.status !== 'SUCCEEDED') {
    const statusMessage = finishedRun.status === 'RUNNING' || finishedRun.status === 'READY'
      ? `timed out after ${RUN_TIMEOUT_SECS} seconds`
      : `failed with status ${finishedRun.status || 'UNKNOWN'}`;
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || 'UNKNOWN'} ${statusMessage}.`);
  }

  if (!finishedRun.defaultDatasetId) {
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || 'UNKNOWN'} finished without a result dataset.`);
  }

  const items = await getAllDatasetItems(client.dataset(finishedRun.defaultDatasetId));
  return normalizeHiringCafeItems(items);
}

module.exports = {
  runHiringCafeMemo23Scraper,
};
