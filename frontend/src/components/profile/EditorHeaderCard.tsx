'use client';

import type { ComponentType, SVGProps } from 'react';
import { IconLink, IconMail, IconMapPin, IconPencil, IconPhone } from '@/components/icons';
import type { ProfileDraft } from '@/lib/profileDraft';
import css from './profileEditor.module.css';

type Glyph = ComponentType<Omit<SVGProps<SVGSVGElement>, 'children'> & { className?: string }>;

/** The contact details, in the order the header prints them, each with its icon. */
const CONTACT_LINES: Array<{ key: keyof ProfileDraft['contact']; icon: Glyph }> = [
  { key: 'email', icon: IconMail },
  { key: 'phone', icon: IconPhone },
  { key: 'location', icon: IconMapPin },
  { key: 'linkedin', icon: IconLink },
  { key: 'github', icon: IconLink },
  { key: 'portfolio', icon: IconLink },
];

/** Up to two initials from the name, for the circle FlowCV keeps a photo in; '' with no name. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * The top of the resume, as FlowCV's Personal Details card: the name, the
 * title, one line per contact detail with its icon, and the round pink pencil
 * that opens the Basics panel to change them. Fixed at the top of the Content
 * tab - the header is not a section and does not move - and never collapsed.
 * The circle on the right holds the person's initials: this app prints no
 * photo, so FlowCV's camera would promise something it cannot do.
 */
export function EditorHeaderCard({ draft, onEdit }: { draft: ProfileDraft; onEdit: () => void }) {
  const contact = CONTACT_LINES.map((line) => ({ ...line, value: draft.contact[line.key].trim() })).filter(
    (line) => line.value
  );
  const initials = initialsOf(draft.name);

  return (
    <section className={css.headerCard} aria-label="Name and contact details">
      <div className={css.headerMain}>
        <p className={css.headerName} data-empty={draft.name.trim() ? undefined : 'true'}>
          {draft.name.trim() || 'Your name'}
        </p>
        <p className={css.headerTitle} data-empty={draft.title.trim() ? undefined : 'true'}>
          {draft.title.trim() || 'Your professional title'}
        </p>
        <ul className={css.contactList}>
          {contact.length > 0 ? (
            contact.map(({ key, icon: Icon, value }) => (
              <li key={key} className={css.contactItem}>
                <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
                <span className={css.contactText}>{value}</span>
              </li>
            ))
          ) : (
            <li className={css.contactItem} data-empty="true">
              No contact details yet
            </li>
          )}
        </ul>
      </div>
      {initials && (
        <span className={css.avatar} aria-hidden="true">
          {initials}
        </span>
      )}
      <button type="button" className={css.headerEdit} onClick={onEdit} aria-label="Edit name and contact details">
        <IconPencil className="h-[17px] w-[17px]" strokeWidth={2.1} />
      </button>
    </section>
  );
}
