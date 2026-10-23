import type { ReactNode, SVGProps } from 'react';

/**
 * The app's icons, drawn here rather than installed.
 *
 * Forty icons is under the size where a dependency pays for itself, and this
 * project has five runtime packages and no UI library at all - adding one costs
 * every contributor an install step on a checkout that already needs a native
 * rebuild and a Chrome download. Eighteen hand-written inline <svg> remain
 * across six other files; those can move here over time.
 *
 * All of them share one grid and one stroke weight, which is the whole reason a
 * set reads as a set: 24x24, 1.75 stroke, round caps and joins, no fills.
 * `currentColor` throughout, so a row's colour is decided by the row.
 *
 * Those four rules are also the boundary of this file. A brand mark - a card
 * network, a coin - cannot obey them: it is filled, it is multi-colour, and its
 * colours are not the row's to choose. Bitcoin is orange wherever it appears,
 * and Tether's green is the only thing that says which coin it is. Pushing
 * them through the wrapper above would either break the
 * single-colour promise for all twenty icons here or produce outlines nobody
 * recognises, so they live in `./marks.tsx` instead. Anything new that needs a
 * fill belongs there and not here.
 */

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  /** Overridable, but the default is the size every nav row uses. */
  className?: string;
};

function Icon({ children, className = 'h-[18px] w-[18px]', ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------ navigation */

/** A person - the signed-in account, where there is no picture to show. */
export const IconUser = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  </Icon>
);

/** A document with a person on it: the stored resume, the career data a built resume starts from. */
export const IconResume = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <circle cx="12" cy="12.5" r="1.8" />
    <path d="M8.8 18a3.4 3.4 0 0 1 6.4 0" />
  </Icon>
);

/** Two people: interpersonal skills (the Soft Skills card). */
export const IconPeople = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.5a3 3 0 0 1 0 5.8" />
    <path d="M17.5 14.4A5.5 5.5 0 0 1 20.5 19" />
  </Icon>
);

/** Build resumes - the generator. */
export const IconBuild = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4.5 19.5 9-9" />
    <path d="m12.5 5.5 1.4 1.4" />
    <path d="M16 3.2 16.8 5l1.8.8-1.8.8L16 8.4 15.2 6.6 13.4 5.8l1.8-.8z" />
    <path d="M19.4 11.2l.55 1.25 1.25.55-1.25.55-.55 1.25-.55-1.25L17.6 13l1.25-.55z" />
    <path d="m16.5 9.5 3 3-6 6" />
  </Icon>
);

export const IconOrders = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z" />
    <path d="M3.5 7.5 12 11.6l8.5-4.1" />
    <path d="M12 11.6v8.9" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const IconFilter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 5.5h17l-6.5 7.5v6l-4 2v-8z" />
  </Icon>
);

/** Bid assistant. */
export const IconBid = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.5 12.5a7.5 7.5 0 0 1-10.9 6.7L4 20.5l1.3-5.4A7.5 7.5 0 1 1 20.5 12.5z" />
    <path d="M9 11.5h6" />
    <path d="M9 14.5h3.5" />
  </Icon>
);

export const IconCalendar = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 9.5h17" />
    <path d="M8 3.5V6M16 3.5V6" />
  </Icon>
);

/** Find jobs - it leaves the app for the account's own spreadsheet. */
export const IconExternal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.5 4.5h6v6" />
    <path d="m19.5 4.5-8 8" />
    <path d="M18 14v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2h4.5" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.3 14.3a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47v.17a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 0 1 0-4h.09A1.6 1.6 0 0 0 4.56 8.7a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 0 1 0 4h-.09a1.6 1.6 0 0 0-1.47 1z" />
  </Icon>
);

/**
 * Report Jobs - a reporter's postings going up into the shared job lake: an
 * arrow rising out of a tray.
 */
export const IconReport = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 13.5v4a2.5 2.5 0 0 0 2.5 2.5h11a2.5 2.5 0 0 0 2.5-2.5v-4" />
    <path d="M12 15.5V4" />
    <path d="m7.5 8.5 4.5-4.5 4.5 4.5" />
  </Icon>
);

/** Manage accounts - people, not resumes. */
export const IconAccounts = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="8" r="3.2" />
    <path d="M4 19.5a6 6 0 0 1 12 0" />
    <circle cx="18.5" cy="6.5" r="2" />
    <path d="M16.2 10.6a4 4 0 0 1 4.3 2.4" />
  </Icon>
);

/* ------------------------------------------------------------- top bar */

export const IconCredits = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M14.2 9.3a2.6 2.6 0 0 0-2.2-1.1c-1.3 0-2.2.7-2.2 1.8 0 2.4 4.6 1.2 4.6 3.7 0 1.2-1 2-2.4 2a2.7 2.7 0 0 1-2.3-1.2" />
    <path d="M12 6.6v10.8" />
  </Icon>
);

export const IconTemplates = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
    <path d="M3.5 9h17" />
    <path d="M9.5 9v11" />
  </Icon>
);

export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M18 8.8a6 6 0 1 0-12 0c0 5-2 6.4-2 6.4h16s-2-1.4-2-6.4" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </Icon>
);

export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
  </Icon>
);

export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2z" />
  </Icon>
);

/* ------------------------------------------------------------ furniture */

export const IconMenu = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
);

export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

/**
 * A feature the account's subscription does not include
 * (components/subscription/LockedFeature.tsx): pressed, it says which
 * subscription does, and leads to the Subscription page.
 */
export const IconLock = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="11" width="14" height="9.5" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16" />
    <path d="M9.5 7V4.8h5V7" />
    <path d="M6 7l.9 12.2a2 2 0 0 0 2 1.8h6.2a2 2 0 0 0 2-1.8L18 7" />
    <path d="M10.2 11v6M13.8 11v6" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

/* ------------------------------------------------------ the resume editor */

/*
 * The section cards of the resume editor: a grip to drag a card by, a pencil
 * for the header card, a sparkle for Write with AI, and one glyph per section
 * kind (lib/sectionCatalogue.ts names them). Six dots drawn as zero-length
 * strokes - round caps make them dots at this stroke weight.
 */

export const IconGrip = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 6.5h.01M9 12h.01M9 17.5h.01M15 6.5h.01M15 12h.01M15 17.5h.01" />
  </Icon>
);

export const IconPencil = (p: IconProps) => (
  <Icon {...p}>
    <path d="m4 20 .9-3.6L15.4 5.9a2.1 2.1 0 0 1 3 3L7.9 19.4z" />
    <path d="m13.9 7.4 3 3" />
  </Icon>
);

export const IconSparkle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 3.5 12.9 9.1 18.5 11l-5.6 1.9L11 18.5l-1.9-5.6L3.5 11l5.6-1.9z" />
    <path d="m18.5 15.5.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Icon>
);

/** Summary - lines of text. */
export const IconText = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.5h16M4 11h16M4 15.5h10" />
  </Icon>
);

/** Experience. */
export const IconBriefcase = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
    <path d="M9 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5v2" />
    <path d="M3.5 12.5h17" />
  </Icon>
);

/** Education. */
export const IconGraduation = (p: IconProps) => (
  <Icon {...p}>
    <path d="m2.5 9.5 9.5-4.5 9.5 4.5-9.5 4.5z" />
    <path d="M6.5 11.5v4.3c0 1.3 2.5 2.7 5.5 2.7s5.5-1.4 5.5-2.7v-4.3" />
    <path d="M21.5 9.5v5" />
  </Icon>
);

/** Technical skills. */
export const IconWrench = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.3 7.7a5 5 0 0 1-6.6 5.9l-7.9 7.9a2 2 0 0 1-2.8-2.8l7.9-7.9a5 5 0 0 1 5.9-6.6l-3.1 3.1 1 3.5 3.5 1z" />
  </Icon>
);

/** Strengths. */
export const IconShield = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 5 6.2v5.3c0 4.3 3 7.6 7 9 4-1.4 7-4.7 7-9V6.2z" />
    <path d="m9.3 12 1.9 1.9 3.6-3.8" />
  </Icon>
);

/** Certifications - a rosette with its ribbons. */
export const IconCertificate = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="9.5" r="5.5" />
    <path d="M8.6 14 7 21l5-2.5 5 2.5-1.6-7" />
    <path d="m10 9.5 1.4 1.4 2.8-2.8" />
  </Icon>
);

/** Projects. */
export const IconFolder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Icon>
);

/** Languages - a globe. */
export const IconLanguage = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.5 2.5 3.7 5.3 3.7 8.5s-1.2 6-3.7 8.5c-2.5-2.5-3.7-5.3-3.7-8.5s1.2-6 3.7-8.5z" />
  </Icon>
);

/** Awards. */
export const IconTrophy = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 4.5h8v4.5a4 4 0 0 1-8 0z" />
    <path d="M8 6.5H5.5a2.5 2.5 0 0 0 2.5 3M16 6.5h2.5a2.5 2.5 0 0 1-2.5 3" />
    <path d="M12 13v6.5M9 19.5h6" />
  </Icon>
);

/** Publications. */
export const IconBookOpen = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 6.5c-1.6-1.3-3.8-2-6-2H3.5v14H6c2.2 0 4.4.7 6 2 1.6-1.3 3.8-2 6-2h2.5v-14H18c-2.2 0-4.4.7-6 2z" />
    <path d="M12 6.5v14" />
  </Icon>
);

/** Volunteering. */
export const IconHeart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 20.5s-7.5-4.6-7.5-10A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 7.5 2.5c0 5.4-7.5 10-7.5 10z" />
  </Icon>
);

/** Courses. */
export const IconBook = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 4.5h12a1 1 0 0 1 1 1v14H7a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M5.5 18A1.5 1.5 0 0 1 7 16.5h11.5" />
    <path d="M9 8.5h6" />
  </Icon>
);

/** Interests. */
export const IconStar = (p: IconProps) => (
  <Icon {...p}>
    <path d="m12 3.8 2.5 5.3 5.8.7-4.3 4 1.2 5.7L12 16.7l-5.2 2.8 1.2-5.7-4.3-4 5.8-.7z" />
  </Icon>
);

/** A custom section - a list of the person's own. */
export const IconList = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12" />
    <path d="M4 6.5h.01M4 12h.01M4 17.5h.01" />
  </Icon>
);

/* -------------------------------------------------------- resume editor */

/** Every resume - nine dots, the editor's way back to the list. */
export const IconGrid = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01" />
  </Icon>
);

/** The editor's Content tab - a page with lines on it. */
export const IconDocument = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
    <path d="M14 3.5v5h5" />
    <path d="M8.5 13h7M8.5 16.5h4.5" />
  </Icon>
);

/** The editor's Customize tab - how the page looks. */
export const IconPalette = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2a1.7 1.7 0 0 1 1.2-2.9h2a4.1 4.1 0 0 0 4.1-4.1c0-4-3.8-7.1-8.5-7.1z" />
    <path d="M7.5 12h.01M9.5 8h.01M14.5 8h.01" />
  </Icon>
);

/** Contact lines on the editor's header card. */
export const IconMail = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <path d="m4 7 8 6 8-6" />
  </Icon>
);

export const IconPhone = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.6 3.5h2.3l1.4 4-2 1.3a10.5 10.5 0 0 0 6.9 6.9l1.3-2 4 1.4v2.3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" />
  </Icon>
);

export const IconMapPin = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
    <circle cx="12" cy="10" r="2.5" />
  </Icon>
);

export const IconLink = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Icon>
);

/** Move a section card up or down - arrows, so they never read as the card's own chevron. */
export const IconArrowUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
  </Icon>
);

export const IconArrowDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5.5 12.5 12 19l6.5-6.5" />
  </Icon>
);

/** A card's actions menu - three dots, upright. */
export const IconMoreVertical = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5.5h.01M12 12h.01M12 18.5h.01" />
  </Icon>
);

/** Duplicate. */
export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Icon>
);

/** A file saved to the computer. */
export const IconDownload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 16v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" />
  </Icon>
);

/** A file brought in from the computer. */
export const IconUpload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
    <path d="M4.5 16v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" />
  </Icon>
);

/** Shown again - a resume switched back on. */
export const IconEye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

/** Put aside - a resume switched off. */
export const IconEyeOff = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.9 5.7A9.9 9.9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.3 7.6C3.9 9.3 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.3-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3.5 3.5 17 17" />
  </Icon>
);

/** The template chooser's Modern filter - a cube. */
export const IconCube = (p: IconProps) => (
  <Icon {...p}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
  </Icon>
);

/** The preview at full size. */
export const IconExpand = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.5 4.5h5v5M9.5 19.5h-5v-5M19.5 4.5l-6 6M4.5 19.5l6-6" />
  </Icon>
);

/**
 * Keyed by name so the navigation model can stay a plain `.ts` file holding
 * `icon: 'orders'` strings instead of JSX. That list is the one place to read
 * when asking "who can see what", and it is easier to read without markup in it.
 */
export const ICONS = {
  resume: IconResume,
  user: IconUser,
  people: IconPeople,
  build: IconBuild,
  orders: IconOrders,
  report: IconReport,
  search: IconSearch,
  filter: IconFilter,
  bid: IconBid,
  calendar: IconCalendar,
  external: IconExternal,
  settings: IconSettings,
  accounts: IconAccounts,
  credits: IconCredits,
  templates: IconTemplates,
  bell: IconBell,
  sun: IconSun,
  moon: IconMoon,
  menu: IconMenu,
  close: IconClose,
  chevronRight: IconChevronRight,
  plus: IconPlus,
  check: IconCheck,
  lock: IconLock,
  trash: IconTrash,
  grip: IconGrip,
  pencil: IconPencil,
  sparkle: IconSparkle,
  text: IconText,
  briefcase: IconBriefcase,
  graduation: IconGraduation,
  wrench: IconWrench,
  shield: IconShield,
  certificate: IconCertificate,
  folder: IconFolder,
  language: IconLanguage,
  trophy: IconTrophy,
  bookOpen: IconBookOpen,
  heart: IconHeart,
  book: IconBook,
  star: IconStar,
  list: IconList,
  grid: IconGrid,
  document: IconDocument,
  palette: IconPalette,
  mail: IconMail,
  phone: IconPhone,
  mapPin: IconMapPin,
  link: IconLink,
  arrowUp: IconArrowUp,
  arrowDown: IconArrowDown,
  moreVertical: IconMoreVertical,
  copy: IconCopy,
  download: IconDownload,
  upload: IconUpload,
  eye: IconEye,
  eyeOff: IconEyeOff,
  cube: IconCube,
  expand: IconExpand,
} as const;

export type IconName = keyof typeof ICONS;
