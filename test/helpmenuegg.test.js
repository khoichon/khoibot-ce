const test = require('node:test');
const assert = require('node:assert');

process.env.HELPMENU_EGG_DATES = '15-06-2031=cny';

const settings = {};
const fakeConfig = {
  getGroupSetting: (id, key) => (settings[id] || {})[key],
  setGroupSetting: (id, key, value) => { (settings[id] = settings[id] || {})[key] = value; return true; },
  isGroupEnabled: () => true
};
const configPath = require.resolve('../config.js');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: fakeConfig };

const egg = require('../helpmenuegg.js');
const data = require('../helpmenuegg-data.js');
const { getMessages } = require('../messages.js');
const { normalizeGroupSettings } = require('../storage/normalize.js');

function fakeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => { sent.push(content); return { key: { id: String(sent.length), remoteJid: jid } }; },
    sendPresenceUpdate: async () => { }
  };
}

const msg = { key: { remoteJid: 'g@g.us', id: 'm1' } };
const who = { chatId: 'g@g.us', senderJid: '6591234567@s.whatsapp.net', trusted: false, groupAdmin: false };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fresh() {
  egg.reset();
  egg.setRandom(() => 0.5);
  for (const key of Object.keys(settings)) delete settings[key];
  settings['g@g.us'] = { enablehelpmenu: false, helpmenutries: 0 };
}

test('every refusal line has a twist entry and nothing is left over', () => {
  const lines = getMessages('refusemodhelp');
  assert.strictEqual(lines.length, 61);
  assert.deepStrictEqual(lines.filter(line => !(line in data.TWISTS)), []);
  assert.deepStrictEqual(Object.keys(data.TWISTS).filter(line => !lines.includes(line)), []);
});

test('no repeats: lines are shared out evenly and never repeat back to back, even across a restart', () => {
  fresh();
  egg.setRandom(Math.random);
  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const counts = Object.fromEntries(lines.map(line => [line, 0]));
  let last = null;
  for (let i = 0; i < 700; i++) {
    const pick = egg.draw('g@g.us', 'pool', lines);
    assert.notStrictEqual(pick, last);
    counts[pick]++;
    last = pick;
    if (i % 5 === 0) egg.reset();
  }
  const values = Object.values(counts);
  assert.deepStrictEqual(values, [100, 100, 100, 100, 100, 100, 100]);
});

test('the used lines are saved with the group', () => {
  fresh();
  egg.draw('g@g.us', 'pool', ['a', 'b', 'c']);
  assert.strictEqual(settings['g@g.us'].helpmenuused.pool.length, 1);
});

test('dates: default list parses, bad entries are skipped, holidays are found', () => {
  const all = egg.parseDates(data.DEFAULT_DATES);
  assert.strictEqual(all.length, 13);
  assert.strictEqual(egg.parseDates('31-02=cny,12-12=nope,hello,25-12=christmas').length, 1);
  assert.strictEqual(egg.holidayToday(all, { day: 25, month: 12, year: 2026 }), 'christmas');
  assert.strictEqual(egg.holidayToday(all, { day: 28, month: 10, year: 2027 }), 'deepavali');
  assert.strictEqual(egg.holidayToday(all, { day: 28, month: 10, year: 2026 }), null);
  assert.strictEqual(egg.holidayToday(all, { day: 28, month: 3, year: 2027 }), 'easter');
});

test('a normal try is refused, counted, and followed up once', async t => {
  fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = fakeSock();
  const result = egg.attempt(sock, msg, who);
  await flush();
  assert.strictEqual(result.enable, false);
  assert.strictEqual(settings['g@g.us'].helpmenutries, 1);
  assert.strictEqual(sock.sent.length, 1);
  assert.ok(getMessages('refusemodhelp').includes(sock.sent[0].text));
});

test('already on: nothing is rolled', async () => {
  fresh();
  settings['g@g.us'].enablehelpmenu = true;
  const sock = fakeSock();
  assert.strictEqual(egg.attempt(sock, msg, who).enable, false);
  await flush();
  assert.strictEqual(sock.sent[0].text, 'enablehelpmenu is already true');
  assert.strictEqual(settings['g@g.us'].helpmenutries, 0);
});

test('pity: the 50th try works and the count resets', async t => {
  fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  settings['g@g.us'].helpmenutries = 49;
  const sock = fakeSock();
  assert.strictEqual(egg.attempt(sock, msg, who).enable, true);
  await flush();
  assert.strictEqual(settings['g@g.us'].helpmenutries, 0);
  assert.ok(sock.sent[0].text.endsWith('enablehelpmenu set to true'));
  t.mock.timers.tick(3000);
  await flush();
  assert.strictEqual(sock.sent.length, 2);
});

test('a lucky roll wins', async t => {
  fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  egg.setRandom(() => 0.0001);
  const sock = fakeSock();
  assert.strictEqual(egg.attempt(sock, msg, who).enable, true);
  await flush();
  assert.ok(sock.sent[0].text.endsWith('enablehelpmenu set to true'));
});

test('streak taunts show up at 5 tries', async t => {
  fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  settings['g@g.us'].helpmenutries = 4;
  const sock = fakeSock();
  egg.attempt(sock, msg, who);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.ok(sock.sent.some(item => item.text === "that's 5 tries. bold."));
});

test('a new try drops the older follow-ups', async t => {
  fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = fakeSock();
  egg.attempt(sock, msg, who);
  await flush();
  egg.attempt(sock, msg, who);
  await flush();
  t.mock.timers.tick(100000);
  await flush();
  const twists = new Set(Object.values(data.TWISTS).flat().map(step => step.say).filter(Boolean));
  const followUps = sock.sent.filter(item => twists.has(item.text) && !getMessages('refusemodhelp').includes(item.text));
  assert.ok(followUps.length <= 2);
});

test('ask nicely: only the first please counts, and only from the same person', async t => {
  fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = fakeSock();
  let found = null;
  for (let i = 0; i < 70 && !found; i++) {
    settings['g@g.us'].helpmenutries = 0;
    const jid = `65${i}@s.whatsapp.net`;
    sock.sent.length = 0;
    egg.attempt(sock, msg, { ...who, senderJid: jid });
    await flush();
    if (sock.sent[0]?.text === 'ask nicely') found = jid;
  }
  assert.ok(found);
  assert.strictEqual(egg.listen(sock, msg, { chatId: 'g@g.us', senderJid: 'someone@else', text: 'please' }), false);
  assert.strictEqual(egg.listen(sock, msg, { chatId: 'g@g.us', senderJid: found, text: 'hello' }), false);
  assert.strictEqual(egg.listen(sock, msg, { chatId: 'g@g.us', senderJid: found, text: 'pretty please' }), true);
  await flush();
  assert.strictEqual(sock.sent.at(-1).text, 'closer, but no.');
  assert.strictEqual(egg.listen(sock, msg, { chatId: 'g@g.us', senderJid: found, text: 'please' }), false);
});

test('error 429 gives a real cooldown with one slow down', async t => {
  fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = fakeSock();
  const jid = '6598765432@s.whatsapp.net';
  let hit = false;
  for (let i = 0; i < 70 && !hit; i++) {
    settings['g@g.us'].helpmenutries = 0;
    sock.sent.length = 0;
    egg.attempt(sock, msg, { ...who, senderJid: jid });
    await flush();
    hit = sock.sent[0]?.text === 'error 429: too many requests, go away';
  }
  assert.ok(hit);
  sock.sent.length = 0;
  assert.strictEqual(egg.attempt(sock, msg, { ...who, senderJid: jid }).enable, false);
  await flush();
  assert.strictEqual(sock.sent[0].text, 'slow down.');
  egg.attempt(sock, msg, { ...who, senderJid: jid });
  await flush();
  assert.strictEqual(sock.sent.length, 1);
});

test('a one minute follow-up survives another try, but a newer one replaces it', async t => {
  fresh();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sock = fakeSock();
  const jid = '6598765432@s.whatsapp.net';
  const energy = 'you do not have enough energy to do this action';
  let hit = false;
  let jidHit = jid;
  for (let i = 0; i < 70 && !hit; i++) {
    settings['g@g.us'].helpmenutries = 0;
    sock.sent.length = 0;
    jidHit = `65${i}@s.whatsapp.net`;
    egg.attempt(sock, msg, { ...who, senderJid: jidHit });
    await flush();
    hit = sock.sent[0]?.text === energy;
  }
  assert.ok(hit);
  settings['g@g.us'].helpmenutries = 0;
  egg.attempt(sock, msg, { ...who, senderJid: 'other@s.whatsapp.net' });
  await flush();
  t.mock.timers.tick(70000);
  for (let i = 0; i < 5; i++) await flush();
  assert.ok(sock.sent.some(item => item.text === 'energy: 3/10. still not enough.'));
});

test('the group setting keeps the try count and repairs junk', () => {
  assert.strictEqual(normalizeGroupSettings({}).settings.helpmenutries, 0);
  assert.strictEqual(normalizeGroupSettings({ helpmenutries: 12 }).settings.helpmenutries, 12);
  assert.strictEqual(normalizeGroupSettings({ helpmenutries: -3 }).settings.helpmenutries, 0);
  assert.strictEqual(normalizeGroupSettings({ helpmenutries: 'x' }).settings.helpmenutries, 0);
});
