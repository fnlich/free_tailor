'use strict';

const { getApifyClient, getAllDatasetItems } = require('./apify');
const { mapFiltersForWellfound } = require('./filters');
const { normalizeWellfoundItems } = require('./normalize');

const ACTOR_ID = 'blackfalcondata/wellfound-scraper';
const ACTOR_NAME = 'Wellfound scraper';
const RUN_TIMEOUT_SECS = 300;

async function runWellfoundScraper(filters) {
  const client = getApifyClient(ACTOR_NAME);
  const actorInput = mapFiltersForWellfound(filters || {});
  const startedRun = await client.actor(ACTOR_ID).start(actorInput, { timeout: RUN_TIMEOUT_SECS });
  const finishedRun = await client.run(startedRun.id).waitForFinish({ waitSecs: RUN_TIMEOUT_SECS });

  if (finishedRun.status !== 'SUCCEEDED') {
    const statusMessage = finishedRun.status === 'RUNNING' || finishedRun.status === 'READY'
      ? `timed out after ${RUN_TIMEOUT_SECS} seconds`
      : `failed with status ${finishedRun.status || 'UNKNOWN'}`;
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || startedRun.id} ${statusMessage}.`);
  }

  const items = await getAllDatasetItems(client.run(finishedRun.id).dataset());
  return normalizeWellfoundItems(items);
}

module.exports = {
  runWellfoundScraper,
};
