/**
 * The industries a posting is filed under: ONE per posting, from this closed
 * list, or `not_specified` when the posting gives nothing to tell it by.
 *
 * The ID is the identity and never changes once shipped: it is what an
 * analysis stores (`JobAnalysis.industry`), what a Job Data Lake row stores
 * (`job_lake.industry`) and what the lake's Industry filter compares - so a
 * label may be reworded freely, while an id that is retired stays out of use
 * for ever, as a job field's does (config/jobFields.ts).
 *
 * The list reaches the model as the analysis prompt's `[[industryList]]`
 * (`renderIndustryListForPrompt`), stable text the shipped prompt carries
 * BEFORE the posting, beside the job fields, so a CLI's prompt cache reuses
 * it. The answer is checked in code (services/jobAnalysis/facts.ts
 * `normalizeIndustry`): a word the list does not have becomes `other`, never
 * itself.
 *
 * An analysis stored before this list existed has no `industry` at all, and
 * is NEVER sent back to a model for one: its industry is derived when it is
 * read (`industryOf`), from the company category its filter facts carry, else
 * from the free-text `jobMeta.industry` by the keywords below.
 */

export type Industry = {
  /** Stable for ever. Lower-case words joined by `_`, like the filter facts' words. */
  id: string;
  label: string;
};

/** What a posting that says nothing about its industry is stored as. Its label is empty. */
export const NOT_SPECIFIED_INDUSTRY_ID = 'not_specified';
/** The last resort for an industry the list does not name. */
export const OTHER_INDUSTRY_ID = 'other';

/** The owner's list, in the owner's order, `other` last. */
export const INDUSTRIES: readonly Industry[] = [
  { id: 'healthcare', label: 'Healthcare' },
  { id: 'finance', label: 'Finance' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'military', label: 'Military' },
  { id: 'government', label: 'Government' },
  { id: 'education', label: 'Education' },
  { id: 'retail_ecommerce', label: 'Retail & E-commerce' },
  { id: 'technology', label: 'Technology' },
  { id: 'consulting', label: 'Consulting' },
  { id: 'media_entertainment', label: 'Media & Entertainment' },
  { id: 'logistics_transportation', label: 'Logistics & Transportation' },
  { id: 'energy_utilities', label: 'Energy & Utilities' },
  { id: 'manufacturing', label: 'Manufacturing' },
  { id: 'telecommunications', label: 'Telecommunications' },
  { id: 'legal', label: 'Legal' },
  { id: 'real_estate', label: 'Real Estate' },
  { id: 'hospitality_travel', label: 'Hospitality & Travel' },
  { id: 'nonprofit', label: 'Nonprofit' },
  { id: OTHER_INDUSTRY_ID, label: 'Other' },
];

const BY_ID = new Map(INDUSTRIES.map((entry) => [entry.id, entry]));

/** True for an id in the list or `not_specified` - every value an industry may be stored as. */
export function isIndustryId(value: unknown): value is string {
  return typeof value === 'string' && (value === NOT_SPECIFIED_INDUSTRY_ID || BY_ID.has(value));
}

/** An industry's display label; '' for `not_specified` and for anything not in the list. */
export function industryLabel(id: unknown): string {
  return (typeof id === 'string' && BY_ID.get(id)?.label) || '';
}

/**
 * A word or label folded for comparison: lower case, `&` as "and", every run
 * of anything but letters and digits one `_` - so "Retail & E-commerce",
 * "retail and e commerce" and `retail_and_e_commerce` are one spelling.
 */
export function foldIndustryWord(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

const BY_FOLDED_LABEL = new Map(INDUSTRIES.map((entry) => [foldIndustryWord(entry.label), entry.id]));

/**
 * Other spellings of an industry a model or an older analysis may use, folded:
 * the company categories the filter facts offer (services/jobAnalysis/facts.ts
 * FILTER_FACT_VALUES) and the common short forms. Checked after the ids and
 * labels, before the keywords.
 */
export const INDUSTRY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  fintech: 'finance',
  financial_services: 'finance',
  banking: 'finance',
  insurtech: 'insurance',
  defense: 'military',
  defence: 'military',
  defense_military: 'military',
  military_defense: 'military',
  govtech: 'government',
  public_sector: 'government',
  edtech: 'education',
  ecommerce: 'retail_ecommerce',
  e_commerce: 'retail_ecommerce',
  retail: 'retail_ecommerce',
  retail_and_ecommerce: 'retail_ecommerce',
  saas: 'technology',
  tech: 'technology',
  software: 'technology',
  cybersecurity: 'technology',
  ai_ml: 'technology',
  enterprise_software: 'technology',
  legaltech: 'legal',
  media: 'media_entertainment',
  entertainment: 'media_entertainment',
  logistics: 'logistics_transportation',
  transportation: 'logistics_transportation',
  energy: 'energy_utilities',
  utilities: 'energy_utilities',
  telecom: 'telecommunications',
  proptech: 'real_estate',
  hospitality: 'hospitality_travel',
  travel: 'hospitality_travel',
  non_profit: 'nonprofit',
  not_for_profit: 'nonprofit',
});

/** Words that mean "the posting does not say" rather than an industry of that name. */
export const NOT_SPECIFIED_WORDS: ReadonlySet<string> = new Set([
  'not_specified',
  'unspecified',
  'not_stated',
  'unknown',
  'none',
  'n_a',
  'na',
]);

/**
 * Keywords that name an industry inside free text - an older analysis's
 * `jobMeta.industry` ("SaaS", "fintech", "Healthcare IT") or a model's answer
 * that is not one of the ids. Tried in this order, on the text lower-cased
 * with every run of punctuation a space, so the specific comes before the
 * general: "insurtech" is insurance and "fintech" finance before anything
 * ending in "tech" is technology, which is last.
 */
export const INDUSTRY_KEYWORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['insurance', /insur/],
  ['nonprofit', /\bnon ?profit|\bnot for profit|\bngo\b|\bcharit|\bphilanthrop/],
  ['healthcare', /health|medic|hospital|pharma|biotech|life ?science|clinic|dental|patient/],
  ['military', /defen[cs]e|military|aerospace|\bdod\b|national security|armed forces/],
  ['government', /government|govtech|public sector|federal|municipal|civic/],
  ['education', /edtech|educat|school|universit|academ|e ?learning|\bk ?12\b|higher ed/],
  ['legal', /legal|\blaw\b|law firm/],
  ['real_estate', /real estate|proptech|property|construction/],
  ['finance', /fintech|financ|bank|payment|trading|invest(?:ment|ing|or)|wealth|asset management|capital market|lending|mortgage|accounting|crypto/],
  ['retail_ecommerce', /e ?commerce|retail|marketplace|consumer goods|\bcpg\b|fashion|grocer/],
  ['telecommunications', /telecom|telco|wireless|\b5g\b/],
  ['hospitality_travel', /hospitality|travel|hotel|touris|restaurant|airline|leisure/],
  ['logistics_transportation', /logistic|transport|shipping|freight|supply chain|mobility|trucking|delivery|automotive/],
  ['energy_utilities', /energy|utilit|\boil\b|\bgas\b|renewable|solar|cleantech|climate|electric/],
  ['media_entertainment', /media|entertain|gaming|\bgames?\b|music|film|streaming|publish|news|advertis|adtech|sports/],
  ['manufacturing', /manufactur|industrial|semiconductor|hardware|robotic|chemical/],
  ['consulting', /consult|professional services|outsourc|\bagency\b|staffing/],
  ['technology', /tech|software|saas|cloud|cyber|security|\bai\b|artificial intelligence|machine learning|\bdata\b|developer|devtools|internet|\bit\b|platform|digital/],
];

/** The industry free text names by keyword, or null when none of them is in it. */
export function industryFromText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const spaced = ` ${text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  if (!spaced.trim()) return null;
  for (const [id, pattern] of INDUSTRY_KEYWORDS) {
    if (pattern.test(spaced)) return id;
  }
  return null;
}

/**
 * The list as the analysis prompt shows it: one `id: Label` line per
 * industry, then `not_specified`.
 *
 * A pure function of this module, so it is byte-identical for every posting -
 * which is what lets it sit in the cached part of the prompt.
 */
export function renderIndustryListForPrompt(): string {
  return [
    ...INDUSTRIES.map((entry) => `- ${entry.id}: ${entry.label}`),
    `- ${NOT_SPECIFIED_INDUSTRY_ID}: the posting gives nothing to tell its industry by`,
  ].join('\n');
}

/** The list as a page offers it, for a filter: every industry, `not_specified` last with its own words. */
export function listIndustriesForClient(): Array<{ id: string; label: string }> {
  return [...INDUSTRIES.map((entry) => ({ ...entry })), { id: NOT_SPECIFIED_INDUSTRY_ID, label: 'Not specified' }];
}
