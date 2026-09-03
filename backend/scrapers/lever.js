'use strict';

const { ApifyClient } = require('apify-client');
const { mapFiltersForLever } = require('./filters');
const { normalizeLeverItems } = require('./normalize');

const ACTOR_ID = 'deadlyaccurate/lever-jobs-scraper';
const ACTOR_NAME = 'Lever scraper';
const RUN_TIMEOUT_SECS = 300;
const DATASET_PAGE_SIZE = 1000;

function getApifyClient() {
  const token = process.env.APIFY_API_TOKEN || process.env.APIFY_API_KEY;
  if (!token) {
    throw new Error('APIFY_API_TOKEN is required to run the Lever scraper.');
  }

  return new ApifyClient({ token });
}

async function getAllDatasetItems(client, runId) {
  const datasetClient = client.run(runId).dataset();
  const items = [];

  for (let offset = 0; ; offset += DATASET_PAGE_SIZE) {
    const page = await datasetClient.listItems({ limit: DATASET_PAGE_SIZE, offset });
    items.push(...page.items);

    if (page.items.length < DATASET_PAGE_SIZE) {
      break;
    }
  }

  return items;
}

async function runLeverScraper(filters) {
  const client = getApifyClient();
  const actorInput = mapFiltersForLever(filters || {});
  const startedRun = await client.actor(ACTOR_ID).start(actorInput, { timeout: RUN_TIMEOUT_SECS });
  const finishedRun = await client.run(startedRun.id).waitForFinish({ waitSecs: RUN_TIMEOUT_SECS });

  if (finishedRun.status !== 'SUCCEEDED') {
    const statusMessage = finishedRun.status === 'RUNNING' || finishedRun.status === 'READY'
      ? `timed out after ${RUN_TIMEOUT_SECS} seconds`
      : `failed with status ${finishedRun.status || 'UNKNOWN'}`;
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || startedRun.id} ${statusMessage}.`);
  }

  const items = await getAllDatasetItems(client, finishedRun.id);
  return normalizeLeverItems(items);
}

module.exports = {
  runLeverScraper,
};
