/**
 * The tabs of the account's own job sheet, as every page that picks one shows
 * them: the builder's sheet panel, the Job Filter and Report Jobs.
 *
 * Imports nothing at runtime, so backend/test/frontendJobSheet.test.js runs
 * it against the server's own listing (services/sheets/accountSheet.ts
 * `listAddressableSheetTabs`) and its two tab names.
 */

/**
 * What a tab's row 1 says it is, in the server's words
 * (integrations/googleSheets.ts `jobTabLayoutOf`): `job` - it starts with the
 * six user headers, Date to Job Description; `blank` - row 1 is empty (the
 * server lays such a tab out the first time it is used, if the WHOLE tab is
 * empty); `other` - anything else, which is a tab of the person's own
 * whatever its name. No job route reads or writes an `other` tab.
 */
export type SheetTabLayout = 'job' | 'blank' | 'other';

/** A tab as GET /api/import/tabs and GET /api/report/tabs list it. */
export type ListedSheetTab = {
  title: string;
  gid?: number;
  layout: SheetTabLayout;
};

export type SheetTabListing = {
  tabs: ListedSheetTab[];
  /** The tab a picker starts on, the server's choice: All while it is a job tab. Null for none. */
  defaultTab: string | null;
};

/** The tab every job route uses when none is named (accountSheet.ts `DEFAULT_TAB`). */
export const DEFAULT_TAB = 'All';
/** The second tab every account sheet has (accountSheet.ts `TEMP_TAB`). */
export const TEMP_TAB = 'Temp For AI';

/** Whether a job route reads (and writes) the tab: anything but `other`. */
export function isJobTab(tab: Pick<ListedSheetTab, 'layout'>): boolean {
  return tab.layout !== 'other';
}

export type SheetTabOption = {
  title: string;
  /** What the option says: the title, and why it cannot be chosen when it cannot. */
  label: string;
  /** False for a tab no job route reads: listed, so it is not a mystery, but not chosen. */
  usable: boolean;
};

/** Why a tab is not read, as its option says it. */
const UNREAD_TAB_LABEL = 'not a job tab';

/** Every tab, in the spreadsheet's order, each with whether it may be chosen. */
export function sheetTabOptions(tabs: readonly ListedSheetTab[]): SheetTabOption[] {
  return tabs
    .filter((tab) => typeof tab.title === 'string' && tab.title !== '')
    .map((tab) =>
      isJobTab(tab)
        ? { title: tab.title, label: tab.title, usable: true }
        : { title: tab.title, label: `${tab.title} (${UNREAD_TAB_LABEL})`, usable: false }
    );
}

/**
 * The tab a picker shows: the one picked by hand while it is still listed and
 * readable, else the server's default (All), else the first tab a job route
 * reads - never one it does not. '' when there is none.
 */
export function chosenTab(listing: SheetTabListing | null, picked = ''): string {
  if (!listing) return '';
  const usable = sheetTabOptions(listing.tabs).filter((option) => option.usable);
  const has = (title: string | null | undefined) => Boolean(title) && usable.some((option) => option.title === title);
  if (has(picked)) return picked;
  if (has(listing.defaultTab)) return listing.defaultTab as string;
  return usable[0]?.title ?? '';
}

/** Whether any tab is listed that no job route reads - what the pages explain under the select. */
export function hasUnreadTabs(tabs: readonly ListedSheetTab[]): boolean {
  return tabs.some((tab) => !isJobTab(tab));
}

/**
 * The sentence under a tab select that lists a tab it will not read. Its rows
 * are not lost - they are where they were - but no job route reads its
 * columns, so a job in one is copied into All by hand, into the four columns
 * a job tab keeps it in.
 *
 * Plain string literals, not template literals with `${DEFAULT_TAB}`: Next
 * 16.1's Turbopack folds an exported constant made of template literals
 * joined with `+` at build time, and dropped the middle one of three. The tab
 * name is spelled out; backend/test/frontendJobSheet.test.js holds it to the
 * constant above.
 */
export const UNREAD_TABS_NOTE =
  'Tabs that are not laid out as job tabs are listed but not read. To use a job from one, copy its Company, ' +
  'Job Title, Job Link and Job Description into columns C to F of All.';

/**
 * The same note when the tab named All is the person's own (a name clash the
 * server left alone): pasting into it would be pasting into a tab every job
 * route refuses, so the note says to clear the name first. Only the Job Sheet
 * page looks at a clash again (GET /api/sheet?recheck=1), so that is where it
 * sends them. Plain literals, for the reason above.
 */
export const UNREAD_TABS_NOTE_ALL_CLASH =
  'Tabs that are not laid out as job tabs are listed but not read. Your own tab named All is one of them: rename ' +
  'or delete it in Google Sheets, then open Settings > Job Sheet to have the job tab All added. To use a job from ' +
  'a tab that is not read, copy its Company, Job Title, Job Link and Job Description into columns C to F of that ' +
  'new All.';

/** The note under a tab select, for the tabs it lists. */
export function unreadTabsNoteFor(tabs: readonly ListedSheetTab[]): string {
  return tabs.some((tab) => tab.title === DEFAULT_TAB && !isJobTab(tab)) ? UNREAD_TABS_NOTE_ALL_CLASH : UNREAD_TABS_NOTE;
}
