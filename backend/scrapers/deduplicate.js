'use strict';

function normalizeKeyPart(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/\s+/g, ' ').trim()
    : '';
}

function extractCity(location) {
  if (typeof location !== 'string') {
    return '';
  }

  return normalizeKeyPart(location.split(',')[0] || '');
}

function toFlatResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }

  if (results.every((entry) => Array.isArray(entry))) {
    return results.flat();
  }

  return results.slice();
}

function deduplicate(results) {
  const flattened = toFlatResults(results);
  const seen = new Set();
  const deduplicated = [];

  for (const item of flattened) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const companyKey = normalizeKeyPart(item.company);
    const titleKey = normalizeKeyPart(item.title);
    const cityKey = extractCity(item.location);
    const fallbackKey = normalizeKeyPart(item.id || item.apply_url || item.source || '');
    const key = [companyKey, titleKey, cityKey].some(Boolean)
      ? [companyKey, titleKey, cityKey].join('::')
      : `fallback::${fallbackKey}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduplicated.push(item);
  }

  return deduplicated;
}

module.exports = {
  deduplicate,
};
