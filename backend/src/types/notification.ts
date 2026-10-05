/**
 * A notice: posted by an administrator for everybody on the installation, or
 * written by the app for one account (a refund request decided, or - to each
 * administrator - a new one asked for).
 */
export interface Notification {
  id: string;
  title: string;
  body: string;
  /** The administrator who posted it. Empty on a row whose author is gone, and on one the app wrote. */
  authorId: string;
  /**
   * Their name AS IT WAS when they posted.
   *
   * Copied rather than joined, because a notice is a published thing: it should
   * still say who wrote it after that account is renamed or deleted, and a join
   * would either lose the attribution or quietly rewrite history.
   */
  authorName: string;
  /**
   * Who it is for: null for an announcement every account reads, an account id
   * for a notice only that account reads. A feed only ever holds the
   * announcements and the reader's own.
   */
  recipientId: string | null;
  /** An app path the notice is about (`/credits?tab=refunds`), or null. Never an outside address. */
  link: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNotificationDTO {
  title: string;
  body?: string;
  authorId?: string;
  authorName?: string;
  /** For one account only. Absent: an announcement to everybody. */
  recipientId?: string;
  /** An app path, starting with a single `/`. Anything else is dropped. */
  link?: string;
}
