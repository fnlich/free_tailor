/**
 * Where resumes are filed, as the two boxes that decide it see it (owner
 * decisions O1-O5): the administrator's PREFIX on Admin -> Settings ->
 * General and each account's own folder path - the SUFFIX - on Settings ->
 * Profile -> Resume files. `<output folder>/<prefix>/<suffix>/<file name>`.
 *
 * The rules and the rendering are the server's alone
 * (utils/outputStorage.ts): a page never renders a path, it asks the preview
 * routes, and it never judges one, it shows the server's sentences. What is
 * here is what a box does as it is typed into: which tokens it offers as
 * chips, where a chip lands, and which preview answer is still the one to
 * show.
 *
 * No runtime import: backend/test/frontendSettings.test.js holds the token
 * lists to the server's and runs the rest.
 */

/** One token a box offers, as a chip: what it inserts, and what it stands for. */
export type OutputPathTokenChip = { token: string; text: string; means: string };

const chip = (token: string, means: string): OutputPathTokenChip => ({ token, text: `{{${token}}}`, means });

/** The prefix's tokens, in the server's order (`OUTPUT_PREFIX_TOKENS`). */
export const OUTPUT_PREFIX_TOKEN_CHIPS: readonly OutputPathTokenChip[] = [
  chip('user_email', "the account's email, as a folder name"),
  chip('order_number', 'the run\'s order number - required, alone in its folder'),
  chip('date', 'the day the run was placed'),
];

/** An account's folder path's tokens, in the server's order (`OUTPUT_SUFFIX_TOKENS`). */
export const OUTPUT_SUFFIX_TOKEN_CHIPS: readonly OutputPathTokenChip[] = [
  chip('date', 'the day the run was placed'),
  chip('profile_name', "the profile's name"),
  chip('company_name', 'the company'),
  chip('role', 'the role, else the posting\'s job title'),
  chip('row_number', 'the sheet row the job came from'),
];

/**
 * A token clicked into a box: put where the caret is, over whatever is
 * selected, and the caret after it - so a second click lands after the
 * first rather than at the end of the box.
 */
export function insertToken(
  text: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  token: string
): { text: string; caret: number } {
  const clamp = (at: number | null, fallback: number) =>
    at === null || !Number.isInteger(at) ? fallback : Math.max(0, Math.min(text.length, at));
  const start = clamp(selectionStart, text.length);
  const end = Math.max(start, clamp(selectionEnd, start));
  return { text: text.slice(0, start) + token + text.slice(end), caret: start + token.length };
}

/**
 * What the Resume files section says the folder path in effect is: the
 * account's own, or the default. Never which `.env` line: an ordinary account
 * is not told how the server is configured.
 */
export function suffixSourceLabel(source: 'account' | 'env' | 'default' | undefined): string {
  return source === 'account' ? 'Your own' : 'Default';
}

/**
 * The save of an account's folder path: as typed, or `null` - Reset to
 * default - for an empty box. The server checks it and stores its canonical
 * spelling.
 */
export function suffixSaveValue(draft: string): string | null {
  return draft.trim() === '' ? null : draft;
}

/**
 * Which preview answer may still be shown. Each request takes a ticket; an
 * answer is shown only while its ticket is the newest, so a slow answer for
 * what the box held two keystrokes ago never replaces the one for what it
 * holds now.
 */
export function createLatestGate(): { begin: () => number; isLatest: (ticket: number) => boolean } {
  let newest = 0;
  return {
    begin: () => {
      newest += 1;
      return newest;
    },
    isLatest: (ticket) => ticket === newest,
  };
}

/** How long a box waits for the typing to stop before it asks for a preview. */
export const OUTPUT_PATH_PREVIEW_DELAY_MS = 300;
