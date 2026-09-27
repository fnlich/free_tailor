'use strict';

const { getApifyClient, getAllDatasetItems } = require('./apify');
const { mapFiltersForLever } = require('./filters');
const { normalizeLeverItems } = require('./normalize');

const ACTOR_ID = 'deadlyaccurate/lever-jobs-scraper';
const ACTOR_NAME = 'Lever scraper';
const RUN_TIMEOUT_SECS = 300;

async function runLeverScraper(filters) {
  const client = getApifyClient(ACTOR_NAME);
  const actorInput = mapFiltersForLever(filters || {});
  const startedRun = await client.actor(ACTOR_ID).start(actorInput, { timeout: RUN_TIMEOUT_SECS });
  const finishedRun = await client.run(startedRun.id).waitForFinish({ waitSecs: RUN_TIMEOUT_SECS });

  if (finishedRun.status !== 'SUCCEEDED') {
    const statusMessage = finishedRun.status === 'RUNNING' || finishedRun.status === 'READY'
      ? `timed out after ${RUN_TIMEOUT_SECS} seconds`
      : `failed with status ${finishedRun.status || 'UNKNOWN'}`;
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || startedRun.id} ${statusMessage}.`);
  }

  const items = await getAllDatasetItems(client.run(finishedRun.id).dataset());
  return normalizeLeverItems(items);
}

module.exports = {
  runLeverScraper,
};
