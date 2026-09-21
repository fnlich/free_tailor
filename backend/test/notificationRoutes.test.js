const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { useTempStorage, useAdminEmails, loadFresh } = require('./helpers');

/*
 * The notice board, and the two things it has to get right.
 *
 * One: only an administrator may post. Everything under /api/admin in this app
 * is guarded by an explicit middleware rather than by the path - /api/admin/ai
 * is mounted there with only `requireUser` - so "it is under /api/admin" proves
 * nothing and the guard is worth a test of its own.
 *
 * Two: unread has to mean something. It is one timestamp per account, so the
 * interesting case is not "does it go to zero" but "does it come back" - a
 * notice posted after somebody looked must read as new to them again.
 */

async function serve() {
  useTempStorage(`notifications-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('admin@example.com');

  const users = loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/notifications');

  const admin = users.createUser({ email: 'admin@example.com', name: 'The Admin' });
  const alice = users.createUser({ email: 'alice@example.com', name: 'Alice' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/notifications', routes.default);
  app.use('/api/admin/notifications', routes.adminNotificationsRouter);

  const server = app.listen(0);
  const port = server.address().port;

  const request = (token, path, init = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  return {
    users,
    admin,
    alice,
    adminToken: users.createSession(admin.id),
    aliceToken: users.createSession(alice.id),
    close: () => server.close(),
    request,
    post: (token, body) =>
      request(token, '/api/admin/notifications', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    feed: async (token) => {
      const response = await request(token, '/api/notifications');
      return response.json();
    },
  };
}

test('posting a notification is closed to strangers and to ordinary users', async () => {
  const server = await serve();
  try {
    assert.equal((await server.post(null, { title: 'Hello' })).status, 401);
    assert.equal((await server.post(server.aliceToken, { title: 'Hello' })).status, 403);
    assert.equal((await server.post(server.adminToken, { title: 'Hello' })).status, 201);

    // The admin listing is guarded too, not just the write.
    assert.equal((await server.request(null, '/api/admin/notifications')).status, 401);
    assert.equal((await server.request(server.aliceToken, '/api/admin/notifications')).status, 403);
    assert.equal((await server.request(server.adminToken, '/api/admin/notifications')).status, 200);
  } finally {
    server.close();
  }
});

test('reading the board needs an account, and any account will do', async () => {
  const server = await serve();
  try {
    assert.equal((await server.request(null, '/api/notifications')).status, 401);
    assert.equal((await server.request(server.aliceToken, '/api/notifications')).status, 200);
    assert.equal((await server.request(server.adminToken, '/api/notifications')).status, 200);
  } finally {
    server.close();
  }
});

test('what an admin posts is what every account reads', async () => {
  const server = await serve();
  try {
    const posted = await (
      await server.post(server.adminToken, { title: 'Scheduled outage', body: 'Sunday, 9am.' })
    ).json();

    assert.equal(posted.title, 'Scheduled outage');
    assert.equal(posted.body, 'Sunday, 9am.');
    // Attribution is copied onto the notice, so it survives the author being
    // renamed or deleted later.
    assert.equal(posted.authorId, server.admin.id);
    assert.equal(posted.authorName, 'The Admin');

    const feed = await server.feed(server.aliceToken);
    assert.equal(feed.notifications.length, 1);
    assert.equal(feed.notifications[0].id, posted.id);
  } finally {
    server.close();
  }
});

test('unread counts what this account has not seen, and comes back when more is posted', async () => {
  const server = await serve();
  try {
    await server.post(server.adminToken, { title: 'First' });
    await server.post(server.adminToken, { title: 'Second' });

    // Never looked: everything is unread, including what was posted before
    // this account had ever opened the panel.
    let feed = await server.feed(server.aliceToken);
    assert.equal(feed.unreadCount, 2);
    assert.equal(feed.seenAt, null);

    const seen = await (
      await server.request(server.aliceToken, '/api/notifications/seen', { method: 'POST' })
    ).json();
    assert.ok(seen.seenAt, 'marking seen answers with the moment it recorded');

    feed = await server.feed(server.aliceToken);
    assert.equal(feed.unreadCount, 0);

    // The timestamp is the server's own, and ISO strings tie at millisecond
    // resolution, so wait a tick before posting the one that must read as new.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await server.post(server.adminToken, { title: 'Third' });

    feed = await server.feed(server.aliceToken);
    assert.equal(feed.unreadCount, 1, 'a notice posted after they looked is new again');

    // And it is per account: the admin has never opened the panel.
    const adminFeed = await server.feed(server.adminToken);
    assert.equal(adminFeed.unreadCount, 3);
  } finally {
    server.close();
  }
});

test('an edit fixes the text without shoving the notice back to the top', async () => {
  const server = await serve();
  try {
    const posted = await (await server.post(server.adminToken, { title: 'Teh outage' })).json();

    await server.request(server.aliceToken, '/api/notifications/seen', { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const edited = await (
      await server.request(server.aliceToken, `/api/admin/notifications/${posted.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: 'The outage' }),
      })
    ).json();
    assert.equal(edited.error !== undefined, true, 'an ordinary user cannot edit');

    const fixed = await (
      await server.request(server.adminToken, `/api/admin/notifications/${posted.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: 'The outage' }),
      })
    ).json();
    assert.equal(fixed.title, 'The outage');
    assert.equal(fixed.createdAt, posted.createdAt, 'created_at is untouched by an edit');

    // Which is the point: correcting a typo must not light the dot again for
    // everybody who had already read it.
    const feed = await server.feed(server.aliceToken);
    assert.equal(feed.unreadCount, 0);
  } finally {
    server.close();
  }
});

test('a notification needs a title, and deleting one twice is a 404', async () => {
  const server = await serve();
  try {
    assert.equal((await server.post(server.adminToken, { title: '   ' })).status, 400);
    assert.equal((await server.post(server.adminToken, {})).status, 400);
    assert.equal((await server.post(server.adminToken, { title: 'x'.repeat(201) })).status, 400);

    const posted = await (await server.post(server.adminToken, { title: 'Temporary' })).json();

    const first = await server.request(
      server.adminToken,
      `/api/admin/notifications/${posted.id}`,
      { method: 'DELETE' }
    );
    assert.equal(first.status, 200);

    const second = await server.request(
      server.adminToken,
      `/api/admin/notifications/${posted.id}`,
      { method: 'DELETE' }
    );
    assert.equal(second.status, 404);
  } finally {
    server.close();
  }
});
