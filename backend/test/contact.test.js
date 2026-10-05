const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { loadFresh, useTempStorage, useAdminEmails, writeSettingRaw } = require('./helpers');

/**
 * How to reach the administrator (owner decision A2: shown to everybody,
 * signed in or not).
 *
 * The page that shows these is the sign-in page, read by people nobody has
 * vetted, and it renders links. So the claims are about what can become a
 * link: every type has its own rule, every `href` is built by the server from
 * a value that passed it, `javascript:` and `data:` never get through - not on
 * save, and not from a row edited by hand in the database either - and the
 * public answer carries the channels and nothing else.
 */

function load() {
  useTempStorage(`contact-${Math.random().toString(36).slice(2)}`);
  loadFresh('../dist/database/sqlite');
  loadFresh('../dist/database/settingsRepository');
  return loadFresh('../dist/services/contact');
}

test('each type is held to its own rule, and its link is built by the server', () => {
  const contact = load();
  const check = (type, value) => contact.checkContactValue(type, value);

  assert.deepEqual(check('email', '  help@example.com '), {
    ok: true,
    value: 'help@example.com',
    href: 'mailto:help@example.com',
  });
  assert.deepEqual(check('email', 'mailto:help+tailor@mail.example.co.uk'), {
    ok: true,
    value: 'help+tailor@mail.example.co.uk',
    href: 'mailto:help+tailor@mail.example.co.uk',
  });

  for (const telegram of ['@tailor_support', 'tailor_support', 'https://t.me/tailor_support', 't.me/tailor_support']) {
    assert.deepEqual(check('telegram', telegram), {
      ok: true,
      value: '@tailor_support',
      href: 'https://t.me/tailor_support',
    });
  }

  // Discord is a name to copy: there is no address that opens a person.
  assert.deepEqual(check('discord', 'Tailor.Admin'), { ok: true, value: 'tailor.admin', href: null });
  assert.deepEqual(check('discord', 'oldname#1234'), { ok: true, value: 'oldname#1234', href: null });
  assert.deepEqual(check('discord', '123456789012345678'), { ok: true, value: '123456789012345678', href: null });

  assert.deepEqual(check('whatsapp', '+1 (555) 123-4567'), {
    ok: true,
    value: '+15551234567',
    href: 'https://wa.me/15551234567',
  });
  assert.deepEqual(check('whatsapp', 'https://wa.me/447700900123'), {
    ok: true,
    value: '+447700900123',
    href: 'https://wa.me/447700900123',
  });

  // `other` is text, or an http(s) link.
  assert.deepEqual(check('other', 'Phone: +1 555 0100, weekdays'), {
    ok: true,
    value: 'Phone: +1 555 0100, weekdays',
    href: null,
  });
  assert.deepEqual(check('other', 'https://help.example.com/tickets'), {
    ok: true,
    value: 'https://help.example.com/tickets',
    href: 'https://help.example.com/tickets',
  });
  assert.equal(check('other', 'www.example.com').href, 'https://www.example.com/');
  // A word and a colon is a label, not a link: shown as text, never refused
  // with a sentence about links.
  for (const value of ['Hours:9-5', 'Phone:+1-555-0100', 'Skype:live:tailor', 'Matrix:@admin:example.org']) {
    assert.deepEqual(check('other', value), { ok: true, value, href: null }, value);
  }
});

test('nothing that is not an http(s) link, or a value of its own type, gets through', () => {
  const contact = load();
  const refused = (type, value, pattern) => {
    const result = contact.checkContactValue(type, value);
    assert.equal(result.ok, false, `${type} "${value}" should be refused`);
    if (pattern) assert.match(result.message, pattern);
  };

  for (const value of [
    'javascript:alert(1)',
    'JavaScript:alert(document.cookie)',
    '  javascript :alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'mailto:someone@example.com',
    'ftp://example.com/file',
    'tel:+15550100',
    'ssh://admin@example.com',
    'custom-app://open',
  ]) {
    refused('other', value, /http:\/\/ or https:\/\//);
  }
  refused('other', 'https://user:pass@example.com/', /user name or password/);
  refused('other', 'https://exa mple.com');
  refused('other', 'x'.repeat(201), /under 200/);
  refused('other', 'line one\nline two', /control characters/);
  refused('other', '   ', /Enter how/);

  refused('email', 'not-an-address', /email address/);
  refused('email', 'a?subject=hi@example.com', /email address/);
  refused('email', 'javascript:alert(1)@example.com', /email address/);
  refused('email', `${'a'.repeat(250)}@example.com`, /under 254/);

  refused('telegram', '@ab', /Telegram username/);
  refused('telegram', '@1startswithdigit', /Telegram username/);
  refused('telegram', 'name-with-dash', /Telegram username/);
  refused('telegram', 'https://t.me/joinchat/abc?x=1', /Telegram username/);
  refused('telegram', 'javascript:alert(1)', /Telegram username/);

  refused('discord', 'has space', /Discord username/);
  refused('discord', 'two..dots', /Discord username/);
  refused('discord', '<script>', /Discord username/);
  refused('discord', 'https://discord.gg/invite', /Discord username/);

  refused('whatsapp', '12345', /country code/);
  refused('whatsapp', 'call me maybe', /country code/);
  refused('whatsapp', 'https://wa.me/123456789?text=hi', /country code/);
});

test('a save is checked whole: unknown types, labels and values refused with their place', () => {
  const contact = load();

  const result = contact.validateContactSettings({
    channels: [
      { type: 'email', label: 'Support', value: 'help@example.com' },
      { type: 'pigeon', label: 'Coo', value: 'roof' },
      { type: 'other', label: 'x'.repeat(61), value: 'javascript:alert(1)' },
      { type: 'telegram', value: 'ab' },
    ],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map(({ index, field }) => [index, field]),
    [
      [1, 'type'],
      [2, 'label'],
      [2, 'value'],
      [3, 'value'],
    ]
  );

  assert.equal(contact.validateContactSettings({ channels: 'nope' }).ok, false);
  const tooMany = contact.validateContactSettings({
    channels: Array.from({ length: 11 }, () => ({ type: 'email', value: 'a@example.com' })),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors[0].message, /at most 10/);

  // An empty label takes the type's name.
  const fine = contact.validateContactSettings({ channels: [{ type: 'whatsapp', label: '  ', value: '+15551234567' }] });
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.settings.channels, [{ type: 'whatsapp', label: 'WhatsApp', value: '+15551234567' }]);
});

async function serve() {
  const { dbDir } = useTempStorage(`contact-routes-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('boss@example.com');
  loadFresh('../dist/database/sqlite');
  loadFresh('../dist/database/settingsRepository');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/services/contact');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const routes = loadFresh('../dist/routes/contact');

  const boss = users.createUser({ email: 'boss@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/contact', routes.default);
  app.use('/api/admin/contact', routes.adminContactRouter);
  const server = app.listen(0);
  const port = server.address().port;
  const tokens = { boss: users.createSession(boss.id), alice: users.createSession(alice.id) };

  const call = async (who, path, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { dbDir, call, close: () => server.close() };
}

test('anybody - signed in or not - reads the channels, and nothing but the channels', async () => {
  const s = await serve();
  try {
    const empty = await s.call(null, '/api/contact');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { channels: [] });

    const saved = await s.call('boss', '/api/admin/contact', {
      method: 'PUT',
      body: {
        channels: [
          { type: 'email', label: 'Support', value: 'help@example.com' },
          { type: 'telegram', label: '', value: '@tailor_support' },
          { type: 'discord', label: 'Discord', value: 'tailor.admin' },
          { type: 'whatsapp', label: 'WhatsApp', value: '+44 7700 900123' },
          { type: 'other', label: 'Help desk', value: 'https://help.example.com' },
        ],
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const signedOut = await s.call(null, '/api/contact');
    assert.equal(signedOut.status, 200);
    assert.equal(signedOut.headers.get('cache-control'), 'no-store');
    assert.deepEqual(signedOut.body, {
      channels: [
        { type: 'email', label: 'Support', value: 'help@example.com', href: 'mailto:help@example.com' },
        { type: 'telegram', label: 'Telegram', value: '@tailor_support', href: 'https://t.me/tailor_support' },
        { type: 'discord', label: 'Discord', value: 'tailor.admin', href: null },
        { type: 'whatsapp', label: 'WhatsApp', value: '+447700900123', href: 'https://wa.me/447700900123' },
        { type: 'other', label: 'Help desk', value: 'https://help.example.com', href: 'https://help.example.com/' },
      ],
    });
    assert.deepEqual((await s.call('alice', '/api/contact')).body, signedOut.body, 'the same for a signed-in account');
  } finally {
    s.close();
  }
});

test('only an administrator edits them, and a bad save is refused field by field', async () => {
  const s = await serve();
  try {
    assert.equal((await s.call(null, '/api/admin/contact')).status, 401);
    assert.equal((await s.call('alice', '/api/admin/contact')).status, 403);
    const put = { method: 'PUT', body: { channels: [{ type: 'email', value: 'a@example.com' }] } };
    assert.equal((await s.call(null, '/api/admin/contact', put)).status, 401);
    assert.equal((await s.call('alice', '/api/admin/contact', put)).status, 403);

    const editor = await s.call('boss', '/api/admin/contact');
    assert.equal(editor.status, 200);
    assert.deepEqual(editor.body.types, ['email', 'telegram', 'discord', 'whatsapp', 'other']);
    assert.deepEqual(editor.body.limits, { channels: 10, label: 60, value: 200 });

    const bad = await s.call('boss', '/api/admin/contact', {
      method: 'PUT',
      body: {
        channels: [
          { type: 'email', label: 'Support', value: 'help@example.com' },
          { type: 'other', label: 'Click', value: 'javascript:alert(1)' },
        ],
      },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'contact-invalid');
    assert.deepEqual(bad.body.fieldErrors.map(({ index, field }) => [index, field]), [[1, 'value']]);
    // Refused whole: the good channel beside it was not saved either.
    assert.deepEqual((await s.call(null, '/api/contact')).body, { channels: [] });
  } finally {
    s.close();
  }
});

test('a stored row edited by hand cannot put a script link in front of anybody', async () => {
  const s = await serve();
  try {
    writeSettingRaw(
      s.dbDir,
      'contact',
      JSON.stringify({
        channels: [
          { type: 'other', label: 'Click me', value: 'javascript:alert(1)' },
          { type: 'email', label: 'Support', value: 'help@example.com' },
          { type: 'other', label: 'Data', value: 'data:text/html,<script>alert(1)</script>' },
          { type: 'evil', label: 'x', value: 'y' },
        ],
      })
    );
    const read = await s.call(null, '/api/contact');
    assert.deepEqual(read.body.channels, [
      { type: 'email', label: 'Support', value: 'help@example.com', href: 'mailto:help@example.com' },
    ]);

    writeSettingRaw(s.dbDir, 'contact', '{not json');
    const broken = await s.call(null, '/api/contact');
    assert.equal(broken.status, 200);
    assert.deepEqual(broken.body, { channels: [] }, 'a broken row shows nothing rather than failing the sign-in page');
  } finally {
    s.close();
  }
});
