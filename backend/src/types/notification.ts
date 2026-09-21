/**
 * A notice posted by an administrator, read by everybody on the installation.
 */
export interface Notification {
  id: string;
  title: string;
  body: string;
  /** The administrator who posted it. Empty on a row whose author is gone. */
  authorId: string;
  /**
   * Their name AS IT WAS when they posted.
   *
   * Copied rather than joined, because a notice is a published thing: it should
   * still say who wrote it after that account is renamed or deleted, and a join
   * would either lose the attribution or quietly rewrite history.
   */
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNotificationDTO {
  title: string;
  body?: string;
  authorId?: string;
  authorName?: string;
}
