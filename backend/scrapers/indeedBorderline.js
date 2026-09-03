'use strict';

const { ApifyClient } = require('apify-client');
const { mapFiltersForIndeedBorderline } = require('./filters');
const { normalizeIndeedItems } = require('./normalize');

const ACTOR_ID = 'borderline/indeed-scraper';
const ACTOR_NAME = 'Indeed scraper [Borderline]';
const RUN_TIMEOUT_SECS = 300;
const DATASET_PAGE_SIZE = 1000;

function getApifyClient() {
  const token = process.env.APIFY_API_TOKEN || process.env.APIFY_API_KEY;
  if (!token) {
    throw new Error('APIFY_API_TOKEN is required to run the Indeed scraper.');
  }

  return new ApifyClient({ token });
}

async function getAllDatasetItems(datasetClient) {
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

async function runIndeedBorderlineScraper(filters) {
  const client = getApifyClient();
  const requestedMaxResults = Number.isInteger(filters && filters.maxResults) && filters.maxResults > 0
    ? filters.maxResults
    : 100;
  const actorInput = mapFiltersForIndeedBorderline({
    ...(filters || {}),
    maxResults: requestedMaxResults,
  });
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
  return normalizeIndeedItems(items);
}

module.exports = {
  runIndeedBorderlineScraper,
};
