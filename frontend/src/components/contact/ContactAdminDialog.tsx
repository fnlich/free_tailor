'use client';

import { useEffect, useState } from 'react';

import Dialog from '@/components/ui/Dialog';
import { opensInNewTab, safeContactHref } from '@/lib/appLinks';
import { contactApi, type ContactChannel } from '@/lib/contact';
import { CONTACT_TYPE_LABELS } from '@/lib/contactChannels';
import { userMessage } from '@/lib/userMessage';

/**
 * How to reach whoever runs this installation, as a dialog anybody can open:
 * from the account menu, the sign-in screen, the account-disabled screen, and
 * every notice that says "contact your administrator" (the kit's Notice,
 * Status and ErrorNotice add the link - see components/ui/kit.tsx).
 *
 * The channels come from `GET /api/contact`, which needs no session, and are
 * drawn exactly as the server sent them: its `href` as the link, or the value
 * as text with a Copy button - a Discord name, a phone line. Nothing here
 * turns a value into a link (lib/appLinks.ts checks the server's once more).
 *
 * Deliberately built from the kit's CLASSES rather than its components: the
 * kit's notices import this file to offer the link, and a notice inside this
 * dialog offering a link to this dialog is the loop that avoids.
 */

type Loaded = { channels: ContactChannel[] } | { error: string } | null;

/**
 * Mounted only while it is open, so every opening reads the list afresh - an
 * administrator who just fixed an address is not shown the old one - and the
 * loading state is simply the first render's.
 */
export default function ContactAdminDialog({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>(null);

  useEffect(() => {
    let alive = true;
    contactApi.get().then(
      (answer) => {
        if (alive) setLoaded({ channels: Array.isArray(answer.channels) ? answer.channels : [] });
      },
      (error: unknown) => {
        // Not a ContactAdminLink-bearing notice: see above.
        if (alive) setLoaded({ error: userMessage(error, 'Could not load the contact details.') });
      }
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Dialog
      open
      title="Contact admin"
      subtitle="How to reach the people who run this installation."
      onClose={onClose}
      footer={
        <button type="button" className="tl-button-quiet" onClick={onClose}>
          Close
        </button>
      }
    >
      {loaded === null ? (
        <div className="flex items-center gap-3 py-4 text-sm text-muted" role="status">
          <span className="tl-spinner" aria-hidden />
          <span>Loading…</span>
        </div>
      ) : 'error' in loaded ? (
        <p className="tl-notice break-words" data-tone="error" role="alert">
          {loaded.error}
        </p>
      ) : loaded.channels.length === 0 ? (
        <p className="text-sm text-muted">
          No contact details have been listed yet. If you can sign in, an announcement in the bell may say
          how to reach your administrator.
        </p>
      ) : (
        <ul className="space-y-3" aria-label="Ways to reach the administrator">
          {loaded.channels.map((channel, index) => (
            <ChannelRow key={`${channel.type}-${index}`} channel={channel} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function ChannelRow({ channel }: { channel: ContactChannel }) {
  const href = safeContactHref(channel.href);
  return (
    <li className="tl-card flex items-start justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{channel.label}</p>
        {href ? (
          <a
            href={href}
            className="tl-link mt-1 block break-all text-sm"
            {...(opensInNewTab(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {channel.value}
          </a>
        ) : (
          <p className="mt-1 break-all text-sm text-ink">{channel.value}</p>
        )}
        <p className="mt-1 text-xs text-subtle">{CONTACT_TYPE_LABELS[channel.type] ?? channel.type}</p>
      </div>
      {!href && <CopyButton value={channel.value} />}
    </li>
  );
}

/** Copies a value that is not a link. Says whether it worked, because a silent button reads as broken. */
function CopyButton({ value }: { value: string }) {
  const [said, setSaid] = useState('');

  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(''), 2000);
    return () => clearTimeout(timer);
  }, [said]);

  return (
    <button
      type="button"
      className="tl-button-quiet shrink-0"
      data-size="sm"
      onClick={() => {
        // The Clipboard API exists only on a secure page (https, or localhost);
        // opened by a LAN address over http, the value is still there to select.
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clipboard) {
          setSaid('Select it to copy');
          return;
        }
        clipboard.writeText(value).then(
          () => setSaid('Copied'),
          () => setSaid('Select it to copy')
        );
      }}
    >
      <span aria-live="polite">{said || 'Copy'}</span>
    </button>
  );
}

/**
 * A "Contact admin" button that opens the dialog - drawn as a link by default,
 * because it sits inside a sentence ("...contact your administrator.
 * Contact admin").
 */
export function ContactAdminLink({
  label = 'Contact admin',
  className = 'tl-link',
}: {
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && <ContactAdminDialog onClose={() => setOpen(false)} />}
    </>
  );
}
