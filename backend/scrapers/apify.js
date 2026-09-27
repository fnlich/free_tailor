'use strict';

const { ApifyClient } = require('apify-client');

/**
 * The two things every actor in this directory needs, written once.
 *
 * All seven scrapers do the same two things before they do anything of their
 * own: build a client from the token, and read a finished run's dataset a page
 * at a time. Both were copy-pasted into each file - the client seven times over,
 * differing only in the noun in its error message, and the paging loop seven
 * times in two shapes that disagreed about whether the caller or the callee
 * derives the dataset client.
 *
 * That last disagreement is why the signature here is the simpler of the two:
 * the CALLER passes a dataset client. An actor run reports its dataset in more
 * than one way (`defaultDatasetId` on the run, or `client.run(id).dataset()`),
 * and which one an actor gives is the actor's business, not this module's.
 */

/** How many dataset items to ask for per request. Apify's own page cap. */
const DATASET_PAGE_SIZE = 1000;

/**
 * A client, or a refusal that names the scraper asking.
 *
 * `what` is the scraper's own name, so an operator missing the token is told
 * which run failed rather than being handed the same sentence seven times.
 */
function getApifyClient(what) {
  const token = process.env.APIFY_API_TOKEN || process.env.APIFY_API_KEY;
  if (!token) {
    throw new Error(`APIFY_API_TOKEN is required to run the ${what}.`);
  }

  return new ApifyClient({ token });
}

/**
 * Every item in a dataset, paged until a short page says there are no more.
 *
 * A short page is the end condition rather than a total, because Apify does not
 * promise one and a dataset that grows between requests would make a total wrong
 * anyway.
 */
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

module.exports = { DATASET_PAGE_SIZE, getApifyClient, getAllDatasetItems };
