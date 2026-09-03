const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');
const { normalizeHiringCafeItems, normalizeIndeedItems } = require('../scrapers/normalize');

test('scraper provider catalog keeps all categories and limits LinkedIn to Bebity', () => {
  const {
    listScraperProviderCatalog,
    resolveScraperProvider,
  } = loadFresh('../dist/services/scraperProviders');

  const catalog = listScraperProviderCatalog();
  const linkedin = catalog.find((entry) => entry.source === 'linkedin');
  const indeed = catalog.find((entry) => entry.source === 'indeed');
  const hiringCafe = catalog.find((entry) => entry.source === 'hiringcafe');
  const jobboard = catalog.find((entry) => entry.source === 'jobboard');

  assert.ok(linkedin);
  assert.equal(linkedin.defaultProviderId, 'apify-bebity');
  assert.deepEqual(
    linkedin.providers.map((provider) => provider.id),
    ['apify-bebity']
  );

  assert.ok(indeed);
  assert.equal(indeed.defaultProviderId, 'apify-misceres');
  assert.deepEqual(
    indeed.providers.map((provider) => provider.id),
    ['apify-misceres']
  );

  assert.ok(hiringCafe);
  assert.equal(hiringCafe.defaultProviderId, 'apify-manojachari');
  assert.deepEqual(
    hiringCafe.providers.map((provider) => provider.id),
    ['apify-manojachari', 'apify-crawlerbros', 'apify-memo23']
  );

  assert.ok(jobboard);
  assert.deepEqual(
    jobboard.providers.map((provider) => provider.id),
    ['apify-jobboard']
  );

  assert.equal(resolveScraperProvider('linkedin').id, 'apify-bebity');
  assert.equal(resolveScraperProvider('indeed').id, 'apify-misceres');
  assert.equal(resolveScraperProvider('lever').id, 'apify-lever');
  assert.throws(() => resolveScraperProvider('linkedin', 'missing-provider'), /Unknown scraper provider/);
});

test('hiring cafe normalization supports alternative provider fields', () => {
  const [job] = normalizeHiringCafeItems([
    {
      id: 'job-1',
      title: 'Backend Engineer',
      company_name: 'Acme',
      formatted_workplace_location: 'Remote, United States',
      commitment_type: 'Full Time',
      posted_at: '2026-05-01T10:00:00.000Z',
      description: 'Build APIs',
      apply_url: 'https://jobs.acme.example/apply/1',
    },
  ]);

  assert.deepEqual(job, {
    id: 'job-1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote, United States',
    job_type: 'full-time',
    salary_min: null,
    salary_max: null,
    equity: null,
    posted_at: '2026-05-01T10:00:00.000Z',
    description: 'Build APIs',
    apply_url: 'https://jobs.acme.example/apply/1',
    source: 'hiringcafe',
    raw: {
      id: 'job-1',
      title: 'Backend Engineer',
      company_name: 'Acme',
      formatted_workplace_location: 'Remote, United States',
      commitment_type: 'Full Time',
      posted_at: '2026-05-01T10:00:00.000Z',
      description: 'Build APIs',
      apply_url: 'https://jobs.acme.example/apply/1',
    },
  });
});

test('hiring cafe normalization supports crawlerbros flat output fields', () => {
  const [job] = normalizeHiringCafeItems([
    {
      id: 'crawlerbros-job-1',
      title: 'Senior Software Engineer',
      companyName: 'Remote Labs',
      workplaceType: 'Remote',
      workplaceCities: ['San Francisco'],
      workplaceStates: ['California'],
      workplaceCountries: ['US'],
      commitment: 'Full Time',
      salaryMin: 180000,
      salaryMax: 220000,
      scrapedAt: '2026-05-02T08:30:00.000Z',
      description: 'Build distributed systems',
      applyUrl: 'https://jobs.example.com/apply/crawlerbros-job-1',
      source: 'greenhouse',
    },
  ]);

  assert.deepEqual(job, {
    id: 'crawlerbros-job-1',
    title: 'Senior Software Engineer',
    company: 'Remote Labs',
    location: 'Remote, San Francisco, California, US',
    job_type: 'full-time',
    salary_min: 180000,
    salary_max: 220000,
    equity: null,
    posted_at: '2026-05-02T08:30:00.000Z',
    description: 'Build distributed systems',
    apply_url: 'https://jobs.example.com/apply/crawlerbros-job-1',
    source: 'hiringcafe',
    raw: {
      id: 'crawlerbros-job-1',
      title: 'Senior Software Engineer',
      companyName: 'Remote Labs',
      workplaceType: 'Remote',
      workplaceCities: ['San Francisco'],
      workplaceStates: ['California'],
      workplaceCountries: ['US'],
      commitment: 'Full Time',
      salaryMin: 180000,
      salaryMax: 220000,
      scrapedAt: '2026-05-02T08:30:00.000Z',
      description: 'Build distributed systems',
      applyUrl: 'https://jobs.example.com/apply/crawlerbros-job-1',
      source: 'greenhouse',
    },
  });
});

test('hiring cafe normalization supports memo23 nested output fields', () => {
  const [job] = normalizeHiringCafeItems([
    {
      id: 'memo23-job-1',
      apply_url: 'https://jobs.example.com/apply/1',
      job_information: {
        title: 'Senior Backend Engineer',
        description: 'Build distributed systems',
      },
      v5_processed_job_data: {
        commitment: ['Full Time'],
        formatted_workplace_location: 'Remote, United States',
        estimated_publish_date: '2026-05-03T09:00:00.000Z',
        yearly_min_compensation: 180000,
        yearly_max_compensation: 220000,
        company_name: 'Example Corp',
      },
      v5_processed_company_data: {
        name: 'Example Corp',
      },
    },
  ]);

  assert.deepEqual(job, {
    id: 'memo23-job-1',
    title: 'Senior Backend Engineer',
    company: 'Example Corp',
    location: 'Remote, United States',
    job_type: 'full-time',
    salary_min: 180000,
    salary_max: 220000,
    equity: null,
    posted_at: '2026-05-03T09:00:00.000Z',
    description: 'Build distributed systems',
    apply_url: 'https://jobs.example.com/apply/1',
    source: 'hiringcafe',
    raw: {
      id: 'memo23-job-1',
      apply_url: 'https://jobs.example.com/apply/1',
      job_information: {
        title: 'Senior Backend Engineer',
        description: 'Build distributed systems',
      },
      v5_processed_job_data: {
        commitment: ['Full Time'],
        formatted_workplace_location: 'Remote, United States',
        estimated_publish_date: '2026-05-03T09:00:00.000Z',
        yearly_min_compensation: 180000,
        yearly_max_compensation: 220000,
        company_name: 'Example Corp',
      },
      v5_processed_company_data: {
        name: 'Example Corp',
      },
    },
  });
});

test('indeed normalization supports misceres output fields', () => {
  const [job] = normalizeIndeedItems([
    {
      positionName: 'Data Analyst',
      salary: null,
      jobType: ['Fulltime'],
      company: 'Purple Drive Technologies',
      location: '500 Almanor Avenue, Sunnyvale, CA 94085',
      url: 'https://www.indeed.com/company/Purple/jobs/data-analyst',
      id: 'cd84b0a277f6128d',
      postedAt: 'Today',
      postingDateParsed: '2026-05-04T12:00:00.000Z',
      description: 'Analyze data',
      externalApplyLink: 'https://jobs.example.com/apply/123',
    },
  ]);

  assert.equal(job.id, 'cd84b0a277f6128d');
  assert.equal(job.title, 'Data Analyst');
  assert.equal(job.company, 'Purple Drive Technologies');
  assert.equal(job.location, '500 Almanor Avenue, Sunnyvale, CA 94085');
  assert.equal(job.job_type, 'full-time');
  assert.equal(job.apply_url, 'https://jobs.example.com/apply/123');
  assert.equal(job.source, 'indeed');
  assert.equal(job.description, 'Analyze data');
  assert.equal(job.posted_at, '2026-05-04T12:00:00.000Z');
});

test('indeed normalization supports borderline output fields', () => {
  const [job] = normalizeIndeedItems([
    {
      title: 'Remote Software Engineer',
      isRemote: true,
      jobType: ['Full-time', 'Remote'],
      companyName: 'Borderline Labs',
      location: {
        city: 'San Francisco',
        country: 'United States',
        formattedAddressShort: 'San Francisco, CA',
      },
      jobUrl: 'https://www.indeed.com/viewjob?jk=borderline-job-1',
      applyUrl: 'https://jobs.example.com/apply/borderline-job-1',
      jobKey: 'borderline-job-1',
      datePublished: '2026-05-02',
      descriptionText: 'Build remote-first products.',
      salary: {
        salaryMin: 180000,
        salaryMax: 210000,
      },
    },
  ]);

  assert.equal(job.id, 'borderline-job-1');
  assert.equal(job.title, 'Remote Software Engineer');
  assert.equal(job.company, 'Borderline Labs');
  assert.equal(job.location, 'San Francisco, United States');
  assert.equal(job.job_type, 'full-time');
  assert.equal(job.salary_min, 180000);
  assert.equal(job.salary_max, 210000);
  assert.equal(job.apply_url, 'https://jobs.example.com/apply/borderline-job-1');
  assert.equal(job.source, 'indeed');
  assert.equal(job.description, 'Build remote-first products.');
  assert.equal(job.posted_at, '2026-05-02T00:00:00.000Z');
});

test('indeed normalization drops invalid or error rows', () => {
  const jobs = normalizeIndeedItems([
    {
      error: "Scraper didn't find any jobs",
    },
    {
      positionName: 'Software Engineer',
      company: 'Acme',
      id: 'valid-job',
      url: 'https://www.indeed.com/viewjob?jk=valid-job',
      externalApplyLink: 'https://jobs.acme.example/apply/valid-job',
      description: 'Build software',
    },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'valid-job');
});
