'use strict';

const { getApifyClient, getAllDatasetItems } = require('./apify');
const { mapFiltersForJobBoard } = require('./filters');
const { normalizeJobBoardItems } = require('./normalize');

const ACTOR_ID = 'openclawai/job-board-scraper';
const ACTOR_NAME = 'Job Board scraper';
const RUN_TIMEOUT_SECS = 300;

async function runJobBoardScraper(filters) {
  const client = getApifyClient(ACTOR_NAME);
  const actorInput = mapFiltersForJobBoard(filters || {});
  const startedRun = await client.actor(ACTOR_ID).start(actorInput, { timeout: RUN_TIMEOUT_SECS });
  const finishedRun = await client.run(startedRun.id).waitForFinish({ waitSecs: RUN_TIMEOUT_SECS });

  if (finishedRun.status !== 'SUCCEEDED') {
    const statusMessage = finishedRun.status === 'RUNNING' || finishedRun.status === 'READY'
      ? `timed out after ${RUN_TIMEOUT_SECS} seconds`
      : `failed with status ${finishedRun.status || 'UNKNOWN'}`;
    throw new Error(`${ACTOR_NAME} run ${finishedRun.id || startedRun.id} ${statusMessage}.`);
  }

  const items = await getAllDatasetItems(client.run(finishedRun.id).dataset());
  return normalizeJobBoardItems(items);
}

module.exports = {
  runJobBoardScraper,
};
