const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLinkedInApifyActorInput,
  buildLinkedInJobSearchUrl,
  expandLinkedInSearchKeywords,
  hasLinkedInExternalApplyUrl,
  mapApifyLinkedInJobItem,
  normalizeLinkedInLimit,
  resolveLinkedInPostedSince,
} = require('../dist/services/linkedinJobs');

test('resolveLinkedInPostedSince accepts supported aliases', () => {
  assert.equal(resolveLinkedInPostedSince('past-24-hours'), 'past-24-hours');
  assert.equal(resolveLinkedInPostedSince('week'), 'past-week');
  assert.equal(resolveLinkedInPostedSince('1-month'), 'past-month');
  assert.equal(resolveLinkedInPostedSince('unexpected'), 'past-24-hours');
});

test('normalizeLinkedInLimit clamps invalid values into the supported range', () => {
  assert.equal(normalizeLinkedInLimit(undefined), 1000);
  assert.equal(normalizeLinkedInLimit('10'), 10);
  assert.equal(normalizeLinkedInLimit(0), 1);
  assert.equal(normalizeLinkedInLimit(1500), 1000);
});

test('expandLinkedInSearchKeywords broadens software engineering searches and deduplicates titles', () => {
  const expanded = expandLinkedInSearchKeywords('"software engineer"');

  assert.equal(expanded[0], 'software engineer');
  assert.ok(expanded.includes('java developer'));
  assert.ok(expanded.includes('devops engineer'));
  assert.ok(expanded.includes('site reliability engineer'));
  assert.equal(new Set(expanded).size, expanded.length);
});

test('expandLinkedInSearchKeywords leaves unknown searches unchanged', () => {
  assert.deepEqual(expandLinkedInSearchKeywords('marketing manager'), ['marketing manager']);
});

test('buildLinkedInApifyActorInput builds the required Apify actor payload', () => {
  assert.deepEqual(
    buildLinkedInApifyActorInput({
      keywords: 'python developer',
      postedSince: 'past-week',
      limit: 25,
    }),
    {
      urls: ['https://www.linkedin.com/jobs/search/?keywords=python+developer&location=United+States&f_WT=2&f_TPR=r604800&sortBy=DD'],
      count: 25,
      proxy: {
        useApifyProxy: true,
      },
    }
  );
});

test('buildLinkedInJobSearchUrl builds a LinkedIn public search url for the actor input', () => {
  assert.equal(
    buildLinkedInJobSearchUrl({
      keywords: 'software engineer',
      postedSince: 'past-24-hours',
    }),
    'https://www.linkedin.com/jobs/search/?keywords=software+engineer&location=United+States&f_WT=2&f_TPR=r86400&sortBy=DD'
  );
});

test('mapApifyLinkedInJobItem maps public actor fields and stores null external apply links', () => {
  const result = mapApifyLinkedInJobItem({
    id: '123',
    title: 'Software Engineer',
    companyName: 'Acme',
    companyLogo: 'https://cdn.example.com/logo.png',
    companyWebsite: 'https://acme.example.com',
    location: 'United States',
    link: 'https://www.linkedin.com/jobs/view/123',
    applyUrl: 'https://jobs.acme.example.com/apply/123',
    easyApply: false,
    descriptionText: 'Build systems.',
    postedAt: '2026-04-27',
    employmentType: 'Full-time',
    seniorityLevel: 'Entry level',
    workplaceTypes: ['Remote'],
    industries: 'Software Development',
  });

  assert.deepEqual(result, {
    id: '123',
    title: 'Software Engineer',
    company: 'Acme',
    jobId: '123',
    jobTitle: 'Software Engineer',
    companyName: 'Acme',
    companyLogo: 'https://cdn.example.com/logo.png',
    companyWebsite: 'https://acme.example.com/',
    location: 'United States',
    postedAtText: '2026-04-27',
    postedAtIso: '2026-04-27',
    link: 'https://www.linkedin.com/jobs/view/123',
    jobUrl: 'https://www.linkedin.com/jobs/view/123',
    applyUrl: 'https://jobs.acme.example.com/apply/123',
    easyApply: false,
    descriptionText: 'Build systems.',
    postedAt: '2026-04-27',
    externalApplyUrl: 'https://jobs.acme.example.com/apply/123',
    applyText: 'Apply',
    workplaceType: 'Remote',
    employmentType: 'Full-time',
    experienceLevel: 'Entry level',
    seniorityLevel: 'Entry level',
    workplaceTypes: ['Remote'],
    jobFunction: '',
    industries: 'Software Development',
    sector: 'Software Development',
    description: 'Build systems.',
    insights: [
      'Employment type: Full-time',
      'Seniority level: Entry level',
      'Industries: Software Development',
    ],
    criteria: [
      { label: 'Employment type', value: 'Full-time' },
      { label: 'Seniority level', value: 'Entry level' },
      { label: 'Industries', value: 'Software Development' },
    ],
  });
});

test('mapApifyLinkedInJobItem sets requested Apify fields to null when absent', () => {
  const result = mapApifyLinkedInJobItem({
    id: '456',
    title: 'Software Engineer Intern',
    companyName: 'Acme',
    jobUrl: 'https://www.linkedin.com/jobs/view/456',
    description: 'Learn fast.',
    postedTime: '2 days ago',
    publishedAt: '2026-04-26',
    contractType: 'Internship',
    experienceLevel: 'Internship',
    workType: 'Engineering',
    sector: 'Software Development',
  });

  assert.equal(result.jobId, '456');
  assert.equal(result.jobTitle, 'Software Engineer Intern');
  assert.equal(result.companyName, 'Acme');
  assert.equal(result.companyLogo, null);
  assert.equal(result.companyWebsite, null);
  assert.equal(result.location, null);
  assert.equal(result.link, null);
  assert.equal(result.applyUrl, null);
  assert.equal(result.easyApply, null);
  assert.equal(result.descriptionText, null);
  assert.equal(result.postedAt, null);
  assert.equal(result.employmentType, null);
  assert.equal(result.experienceLevel, null);
  assert.equal(result.workplaceTypes, null);
  assert.equal(result.sector, null);
});

test('hasLinkedInExternalApplyUrl only accepts jobs with external apply urls', () => {
  assert.equal(
    hasLinkedInExternalApplyUrl({
      externalApplyUrl: 'https://jobs.acme.example.com/apply/123',
    }),
    true
  );

  assert.equal(
    hasLinkedInExternalApplyUrl({
      externalApplyUrl: null,
    }),
    false
  );

  assert.equal(
    hasLinkedInExternalApplyUrl({
      externalApplyUrl: '   ',
    }),
    false
  );
});
