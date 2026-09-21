import type { ComponentType, SVGProps } from 'react';

/**
 * Brand and asset marks: card networks, and the coins.
 *
 * A SECOND family, deliberately, and not a few more entries in `./index.tsx`.
 * That file fixes one grid, one stroke weight, no fills and a single
 * `currentColor` for everything in it, and its header says why: those shared
 * rules are the whole reason a set of icons reads as a set.
 *
 * A brand mark cannot obey any of them. A Visa wordmark is filled, a Bitcoin
 * disc is orange whatever colour the row it sits in happens to be, and USDT and
 * USDC are told apart by their green and their blue and by nothing else. Push
 * them through the shared wrapper and either the twenty icons that promise a
 * single stroke colour stop keeping that promise, or the marks come out as
 * outlines nobody recognises.
 *
 * So the boundary is explicit, and both files say so:
 *   ./index.tsx - UI icons. One grid, one stroke, one colour, and the ROW
 *                 decides the colour.
 *   ./marks.tsx - brand and asset marks. Their own viewBox, their own fills,
 *                 their own colours, never recoloured by a parent.
 *
 * On trademarks, plainly: these are simplified recognition marks drawn in each
 * brand's own colours, used to say which cards and coins this installation
 * accepts. They imply no endorsement and no affiliation. An operator running
 * this commercially should drop the networks' official assets in here - this is
 * the one file to change, which is part of why it is its own file.
 */

export type MarkProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { className?: string };

/* ------------------------------------------------------------ card networks */

/** Visa, as a wordmark. Fixed aspect, so it is given a width not a square. */
export const MarkVisa = ({ className = 'h-5 w-auto', ...rest }: MarkProps) => (
  <svg viewBox="0 0 48 16" role="img" aria-label="Visa" className={className} {...rest}>
    <path
      fill="#1434CB"
      d="M20.4 15.3h-3.9L18.9.7h3.9zM13.6.7 9.9 10.7l-.4-2.2L8.3 2.2S8.2.7 6.3.7H.1L0 1.1s2.1.4 4.6 1.9l3.5 12.3h4.1L18.5.7zM44.6 15.3H48L45.1.7h-3c-1.4 0-1.7 1.1-1.7 1.1l-5.5 13.5h3.9l.8-2.1h4.7zM40.5 10.3l1.9-5.3 1.1 5.3zM35 4.2l.5-3.1S33.9.5 32.2.5c-1.8 0-6.2.8-6.2 4.7 0 3.6 5.1 3.7 5.1 5.6s-4.6 1.5-6.1.3l-.6 3.2s1.7.8 4.2.8c2.5 0 6.4-1.3 6.4-4.9 0-3.7-5.2-4.1-5.2-5.6 0-1.6 3.6-1.4 5.2-.4z"
    />
  </svg>
);

/** Mastercard's two discs. The overlap is the mark; there is no wordmark here. */
export const MarkMastercard = ({ className = 'h-5 w-auto', ...rest }: MarkProps) => (
  <svg viewBox="0 0 36 24" role="img" aria-label="Mastercard" className={className} {...rest}>
    <circle cx="12" cy="12" r="10.5" fill="#EB001B" />
    <circle cx="24" cy="12" r="10.5" fill="#F79E1B" />
    <path
      fill="#FF5F00"
      d="M18 3.7a10.5 10.5 0 0 0 0 16.6 10.5 10.5 0 0 0 0-16.6z"
    />
  </svg>
);

/** American Express: the blue box is the recognisable part. */
export const MarkAmex = ({ className = 'h-5 w-auto', ...rest }: MarkProps) => (
  <svg viewBox="0 0 36 24" role="img" aria-label="American Express" className={className} {...rest}>
    <rect width="36" height="24" rx="3" fill="#1F72CD" />
    <path
      fill="#fff"
      d="M7.6 8.2h3l.7 1.6V8.2h3.7l.6 1.7.6-1.7h3v7.6h-2.2v-5.5l-2 5.5h-1.9l-2-5.5v5.5H8.5l-.4-1h-2l-.4 1H3.3zm.9 1.8-.6 1.6h1.2zM20.6 8.2h6v1.9h-3.8v1h3.7v1.8h-3.7v1h3.9v1.9h-6.1zM27.4 8.2h2.6l1.3 1.6 1.4-1.6H35l-2.5 3.8L35 15.8h-2.4L31.3 14l-1.4 1.8h-2.5l2.5-3.8z"
    />
  </svg>
);

/**
 * The network a saved card is actually on.
 *
 * Not the trio: a card whose brand we KNOW must not be drawn as all three,
 * which says "we take these" where the row means "this is yours". The brand
 * string is Stripe's own lowercase name ('visa', 'mastercard', 'amex' - and
 * 'american_express' from some older shapes), and anything else falls back to
 * a plain card outline rather than to a network it might not be.
 */
export const MarkCardBrand = ({ brand = '', className = 'h-5 w-auto', ...rest }: MarkProps & { brand?: string }) => {
  const key = brand.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'visa') return <MarkVisa className={className} {...rest} />;
  if (key === 'mastercard') return <MarkMastercard className={className} {...rest} />;
  if (key === 'amex' || key === 'americanexpress') return <MarkAmex className={className} {...rest} />;
  return (
    <svg viewBox="0 0 36 24" role="img" aria-label={brand || 'Card'} className={className} {...rest}>
      <rect x="0.75" y="0.75" width="34.5" height="22.5" rx="2.75" fill="none" stroke="#94A3B8" strokeWidth="1.5" />
      <rect x="0.75" y="6" width="34.5" height="3.5" fill="#94A3B8" />
    </svg>
  );
};

/* -------------------------------------------------------------------- coins */

/** A coin disc with a glyph on it. Every coin mark is drawn this way. */
function Coin({
  className = 'h-5 w-5',
  fill,
  children,
  label,
  ...rest
}: MarkProps & { fill: string; children: React.ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label={label} className={className} {...rest}>
      <circle cx="12" cy="12" r="12" fill={fill} />
      {children}
    </svg>
  );
}

export const CoinBitcoin = (p: MarkProps) => (
  <Coin {...p} fill="#F7931A" label="Bitcoin">
    <path
      fill="#fff"
      d="M16.7 10.6c.2-1.5-.9-2.3-2.5-2.8l.5-2-1.2-.3-.5 2-1-.2.5-2-1.2-.3-.5 2-2.4-.6-.3 1.3s.9.2.9.2c.5.1.6.5.6.7l-1.4 5.7c-.1.2-.2.4-.6.3l-.9-.2-.5 1.4 2.4.6-.5 2 1.2.3.5-2 1 .2-.5 2 1.2.3.5-2c2 .4 3.6.2 4.2-1.6.5-1.5 0-2.3-1.1-2.9.8-.2 1.4-.7 1.6-1.9zm-2.8 4c-.4 1.5-2.9.7-3.7.5l.7-2.8c.8.2 3.4.6 3 2.3zm.4-4c-.3 1.4-2.4.7-3.2.5l.6-2.5c.8.2 2.9.5 2.6 2z"
    />
  </Coin>
);

export const CoinEthereum = (p: MarkProps) => (
  <Coin {...p} fill="#627EEA" label="Ethereum">
    <path fill="#fff" fillOpacity=".7" d="M12 3v6.7l5.7 2.5z" />
    <path fill="#fff" d="M12 3 6.3 12.2 12 9.7z" />
    <path fill="#fff" fillOpacity=".7" d="M12 16.4V21l5.7-7.9z" />
    <path fill="#fff" d="M12 21v-4.6l-5.7-3.3z" />
    <path fill="#fff" fillOpacity=".4" d="m12 15.3 5.7-3.1-5.7-2.5z" />
    <path fill="#fff" fillOpacity=".55" d="m6.3 12.2 5.7 3.1V9.7z" />
  </Coin>
);

export const CoinUsdc = (p: MarkProps) => (
  <Coin {...p} fill="#2775CA" label="USD Coin">
    <path
      fill="#fff"
      d="M12 4.6a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 0 0 0-14.8zm0 13.3a5.9 5.9 0 1 1 0-11.8 5.9 5.9 0 0 1 0 11.8z"
    />
    <path
      fill="#fff"
      d="M12.7 11.4c-1.1-.3-1.4-.5-1.4-1 0-.4.4-.7 1-.7.6 0 1 .2 1.1.7h1.2c-.1-.9-.7-1.5-1.6-1.6V8h-1v.8c-1 .1-1.7.8-1.7 1.7 0 1.1.7 1.5 1.9 1.8 1 .2 1.3.5 1.3 1s-.4.8-1.1.8c-.8 0-1.1-.3-1.2-.8H9.9c.1 1 .8 1.6 1.9 1.7v.8h1v-.8c1.1-.1 1.8-.8 1.8-1.8 0-1.1-.7-1.5-1.9-1.8z"
    />
  </Coin>
);

/** Tether. Its network is named beside it in the UI, never inside the mark. */
export const CoinTether = (p: MarkProps) => (
  <Coin {...p} fill="#26A17B" label="Tether">
    <path
      fill="#fff"
      d="M13.2 11.9v-1.6h3.4V8H7.4v2.3h3.4v1.6c-2.8.1-4.9.7-4.9 1.4s2.1 1.3 4.9 1.4v4h2.4v-4c2.8-.1 4.9-.7 4.9-1.4s-2.1-1.3-4.9-1.4zm0 2.4v0c-.1 0-.5.1-1.2.1-.6 0-1 0-1.2-.1v0c-2.4-.1-4.2-.5-4.2-1s1.8-.9 4.2-1v1.7c.2 0 .6 0 1.2 0 .7 0 1.1 0 1.2 0v-1.7c2.4.1 4.2.5 4.2 1s-1.8.9-4.2 1z"
    />
  </Coin>
);

/** For an asset with no mark of its own: the symbol on a neutral disc. */
export const CoinGeneric = ({
  className = 'h-5 w-5',
  symbol = '?',
  ...rest
}: MarkProps & { symbol?: string }) => (
  <svg viewBox="0 0 24 24" role="img" aria-label={symbol} className={className} {...rest}>
    <circle cx="12" cy="12" r="12" fill="#64748B" />
    <text
      x="12"
      y="16"
      textAnchor="middle"
      fontSize="9"
      fontWeight="700"
      fill="#fff"
      fontFamily="system-ui, sans-serif"
    >
      {symbol.slice(0, 3)}
    </text>
  </svg>
);

/* ----------------------------------------------------------- family marks */

/**
 * The card networks together, for the one button that means "a card".
 *
 * Three marks rather than a generic card outline, because the question a buyer
 * is actually asking at that button is "will it take mine" - and a row of
 * logos answers it where a picture of a rectangle does not.
 */
export const MarkCardTrio = ({ className = 'h-5' }: { className?: string }) => (
  <span className={`inline-flex items-center gap-1.5 ${className}`}>
    <MarkVisa className="h-4 w-auto" />
    <MarkMastercard className="h-4 w-auto" />
    <MarkAmex className="h-4 w-auto" />
  </span>
);

/**
 * Several coins, for the one button that means "crypto".
 *
 * A FAMILY mark, and only for the method-level entry: it says "more than one
 * coin" and nothing about which. Once the server offers a row per asset, each
 * row carries its own coin from `CoinMark` and this is not used for it -
 * a per-asset button showing three coins would be a button lying about what it
 * does.
 */
export const MarkCoinTrio = ({ className = 'h-5' }: { className?: string }) => (
  <span className={`inline-flex items-center ${className}`}>
    <CoinBitcoin className="h-5 w-5" />
    <CoinEthereum className="-ml-1.5 h-5 w-5" />
    <CoinTether className="-ml-1.5 h-5 w-5" />
  </span>
);

/**
 * Which mark belongs to which asset.
 *
 * Keyed on the asset id the server sends, so the page never parses a symbol out
 * of a label. Both Tethers share one mark because they ARE one token - the
 * difference is the network, and the network is named in the row's text where
 * it can be read, rather than hidden in a glyph.
 */
export const COIN_MARKS: Record<string, ComponentType<MarkProps>> = {
  'bitcoin:BTC': CoinBitcoin,
  'ethereum:ETH': CoinEthereum,
  'ethereum:USDC': CoinUsdc,
  'ethereum:USDT': CoinTether,
  'tron:USDT': CoinTether,
  'bsc:USDT': CoinTether,
  'bsc:USDC': CoinUsdc,
};

/**
 * The mark for an asset, always something.
 *
 * A COMPONENT rather than a `markForAsset(id)` that hands one back, which is
 * what this was first written as. Returning a component means creating one
 * during the caller's render: React then sees a different component type on
 * every render, unmounts the old one and mounts the new, and any state it held
 * is lost. These marks hold none, so it did no visible harm - but the rule
 * catching it is right, and a lookup plus a fallback is simpler anyway.
 *
 * An operator may enable an asset this file has never heard of, and a hole
 * where a coin should be reads as a broken page. The fallback draws its symbol
 * on a neutral disc, which is legible and honest.
 */
export function CoinMark({
  assetId,
  symbol = '',
  className = 'h-5 w-5',
  ...rest
}: MarkProps & { assetId?: string; symbol?: string }) {
  const Known = assetId ? COIN_MARKS[assetId] : undefined;
  if (Known) return <Known className={className} {...rest} />;
  return (
    <CoinGeneric
      className={className}
      symbol={symbol || assetId?.split(':')[1] || '?'}
      {...rest}
    />
  );
}
