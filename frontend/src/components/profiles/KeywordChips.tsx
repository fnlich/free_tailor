import type { ResumeKeywords } from '@/lib/api';
import { keywordPreview } from '@/lib/profileDashboard';
import css from './profiles.module.css';

/** Case-insensitive repeats out, first spelling kept, blanks dropped. */
function distinct(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
  }
  return kept;
}

/**
 * A resume's keywords as read-only chips, in two rows: the kinds of role it
 * names ("Job titles", its headline and the titles it holds) and the "Skills
 * and technologies" it claims. They are computed by the server from the
 * resume and drive which resume Choose Suitable Resume and Partial Tailor pick
 * for a posting; nothing here edits them. `limit` shows only the first skills
 * and counts the rest.
 */
export function KeywordChips({ keywords, limit }: { keywords: ResumeKeywords | undefined; limit?: number }) {
  if (!keywords) {
    return <p className={css.keywordNote}>Keywords appear once the resume is saved.</p>;
  }
  const titles = distinct([...(keywords.headline ?? []), ...(keywords.roleTitles ?? [])]);
  const preview = limit === undefined ? { shown: keywords.terms ?? [], more: 0 } : keywordPreview(keywords, limit);
  const terms = distinct(preview.shown);
  if (titles.length === 0 && terms.length === 0) {
    return <p className={css.keywordNote}>No keywords yet. Add skills or experience to the resume and save it.</p>;
  }
  return (
    <div className={css.keywordSections}>
      {titles.length > 0 && (
        <section aria-label="Job titles">
          <h3 className={css.keywordHeading}>Job titles</h3>
          <ul className={css.chips}>
            {titles.map((title) => (
              <li key={title} className={`${css.chip} ${css.chipTitle}`}>
                {title}
              </li>
            ))}
          </ul>
        </section>
      )}
      {terms.length > 0 && (
        <section aria-label="Skills and technologies">
          <h3 className={css.keywordHeading}>Skills and technologies</h3>
          <ul className={css.chips}>
            {terms.map((term) => (
              <li key={term} className={css.chip}>
                {term}
              </li>
            ))}
            {preview.more > 0 && <li className={`${css.chip} ${css.chipMore}`}>+{preview.more} more</li>}
          </ul>
        </section>
      )}
    </div>
  );
}
