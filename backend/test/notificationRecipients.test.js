const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * Notices for one account, beside the announcements everybody reads.
 *
 * The notice board was broadcast-only; refund requests need to tell one
 * person - the requester, or each administrator - something nobody else may
 * read. The claims: a reader's feed and unread count hold the announcements
 * and their own notices and nothing of anybody else's; every row from before
 * the column existed still reads as an announcement; and a notice's link can
 * only ever be a path on this app.
 */

function load() {
  const storage = useTempStorage(`notification-recipients-${Math.random().toString(36).slice(2)}`);
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const notifications = loadFresh('../dist/database/notificationRepository');
  return { ...storage, users, notifications };
}

test('a notice for one account is in its feed and its unread count, and in nobody else\'s', () => {
  const { users, notifications } = load();
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });

  notifications.createNotification({ title: 'For everybody' });
  notifications.createNotification({ title: 'For Alice', recipientId: alice.id, link: '/credits?tab=refunds' });

  const aliceFeed = notifications.listNotificationsFor(alice.id);
  assert.deepEqual(aliceFeed.map((notice) => notice.title), ['For Alice', 'For everybody']);
  assert.equal(aliceFeed[0].recipientId, alice.id);
  assert.equal(aliceFeed[0].link, '/credits?tab=refunds');
  assert.equal(aliceFeed[1].recipientId, null);
  assert.equal(aliceFeed[1].link, null);
  assert.equal(notifications.countUnreadFor(alice.id, null), 2);

  assert.deepEqual(notifications.listNotificationsFor(bob.id).map((notice) => notice.title), ['For everybody']);
  assert.equal(notifications.countUnreadFor(bob.id, null), 1);

  // Seen is still one timestamp, and a later notice for Alice lights only her dot.
  const seenAt = notifications.markSeen(alice.id);
  const bobSeen = notifications.markSeen(bob.id);
  const later = new Date(Date.parse(seenAt) + 5).toISOString();
  const { getDb } = require('../dist/database/sqlite');
  notifications.createNotification({ title: 'Later, for Alice', recipientId: alice.id });
  getDb().prepare("UPDATE notifications SET created_at = ? WHERE title = 'Later, for Alice'").run(later);
  assert.equal(notifications.countUnreadFor(alice.id, seenAt), 1);
  assert.equal(notifications.countUnreadFor(bob.id, bobSeen), 0);

  // The announcement editor sees announcements only.
  assert.deepEqual(notifications.listAnnouncements().map((notice) => notice.title), ['For everybody']);

  // Deleting the account takes its own notices, and leaves the announcements.
  users.deleteUser(alice.id);
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ?').get(alice.id).n,
    0
  );
  assert.equal(notifications.listAnnouncements().length, 1);
});

test('a notice links only to a path on this app', () => {
  const { notifications } = load();
  for (const link of [
    'https://evil.example.com',
    '//evil.example.com/path',
    '/\\evil.example.com',
    'javascript:alert(1)',
    'credits',
    '/credits?tab=refunds\nX-Injected: 1',
    `/${'a'.repeat(400)}`,
  ]) {
    assert.equal(notifications.safeAppPath(link), '', JSON.stringify(link));
    assert.equal(notifications.createNotification({ title: 't', link }).link, null);
  }
  assert.equal(notifications.safeAppPath(' /admin/payments?tab=refunds '), '/admin/payments?tab=refunds');
});

test('the feed, the unread count and the refund-request lookups are index seeks, not scans', () => {
  load();
  const { getDb } = require('../dist/database/sqlite');
  const db = getDb();
  const plan = (sql, ...args) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...args)
      .map((row) => row.detail)
      .join(' | ');

  const unread = plan(
    'SELECT COUNT(*) AS n FROM notifications WHERE (recipient_id IS NULL OR recipient_id = ?) AND created_at > ?',
    'acct',
    '2026-01-01'
  );
  assert.match(unread, /idx_notifications_recipient/, unread);
  assert.doesNotMatch(unread, /SCAN notifications/, unread);

  const open = plan(
    "SELECT * FROM refund_requests WHERE item_key = ? AND state IN ('requested', 'approved')",
    'payment:pay_1'
  );
  assert.match(open, /USING INDEX idx_refund_requests_(item|open_item)/, open);
  const mine = plan('SELECT * FROM refund_requests WHERE account_id = ? ORDER BY created_at DESC', 'acct');
  assert.match(mine, /USING INDEX idx_refund_requests_account/, mine);
  const queue = plan("SELECT * FROM refund_requests WHERE state IN ('requested', 'approved') ORDER BY created_at");
  assert.match(queue, /USING INDEX idx_refund_requests_(state|open_item)/, queue);
});
