import type { ReactNode, SVGProps } from 'react';

/**
 * The app's icons, drawn here rather than installed.
 *
 * Twenty icons is under the size where a dependency pays for itself, and this
 * project has five runtime packages and no UI library at all - adding one costs
 * every contributor an install step on a checkout that already needs a native
 * rebuild and a Chrome download. There were also nineteen hand-written inline
 * <svg> across seven files before this existed; those can move here over time.
 *
 * All of them share one grid and one stroke weight, which is the whole reason a
 * set reads as a set: 24x24, 1.75 stroke, round caps and joins, no fills.
 * `currentColor` throughout, so a row's colour is decided by the row.
 *
 * Those four rules are also the boundary of this file. A brand mark - a card
 * network, a coin - cannot obey them: it is filled, it is multi-colour, and its
 * colours are not the row's to choose. Bitcoin is orange wherever it appears,
 * and USDT and USDC are told apart by their green and their blue and by nothing
 * else. Pushing them through the wrapper above would either break the
 * single-colour promise for all twenty icons here or produce outlines nobody
 * recognises, so they live in `./marks.tsx` instead. Anything new that needs a
 * fill belongs there and not here.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
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

/** Resume profiles - the career data a resume is built from. */
export const IconProfile = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <circle cx="12" cy="12.5" r="1.8" />
    <path d="M8.8 18a3.4 3.4 0 0 1 6.4 0" />
  </Icon>
);

export const IconGroups = (p: IconProps) => (
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

/** Manage accounts - people, not profiles. */
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

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
    <path d="M15 9V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H9" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
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

/**
 * Keyed by name so the navigation model can stay a plain `.ts` file holding
 * `icon: 'orders'` strings instead of JSX. That list is the one place to read
 * when asking "who can see what", and it is easier to read without markup in it.
 */
export const ICONS = {
  profile: IconProfile,
  groups: IconGroups,
  build: IconBuild,
  orders: IconOrders,
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
  copy: IconCopy,
  trash: IconTrash,
} as const;

export type IconName = keyof typeof ICONS;
