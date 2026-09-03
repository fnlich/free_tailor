'use strict';

const { runLinkedInScraper } = require('./linkedin');
const { runIndeedScraper } = require('./indeed');
const { runIndeedBorderlineScraper } = require('./indeedBorderline');
const { runJobBoardScraper } = require('./jobboard');
const { runWellfoundScraper } = require('./wellfound');
const { runLeverScraper } = require('./lever');
const { runHiringCafeScraper } = require('./hiringcafe');
const { runHiringCafeCrawlerbrosScraper } = require('./hiringcafeCrawlerbros');
const { runHiringCafeMemo23Scraper } = require('./hiringcafeMemo23');
const { deduplicate } = require('./deduplicate');

module.exports = {
  runLinkedInScraper,
  runIndeedScraper,
  runIndeedBorderlineScraper,
  runJobBoardScraper,
  runWellfoundScraper,
  runLeverScraper,
  runHiringCafeScraper,
  runHiringCafeCrawlerbrosScraper,
  runHiringCafeMemo23Scraper,
  deduplicate,
};
