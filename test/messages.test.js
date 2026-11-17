const test = require('node:test');
const assert = require('node:assert');
const { getMessage } = require('../messages.js');

test('getMessage returns a message for a valid key', () => {
  const message = getMessage('refusemodhelp');
  assert.ok(message);
});

test('getMessage throws an error for an invalid key', () => {
  assert.throws(() => {
    getMessage('invalidkey');
  }, /Message key "invalidkey" not found in messages.yaml/);
});

test('getMessage returns random message', () => {
  const messages = new Set();
  for (let i = 0; i < 100; i++) {
    messages.add(getMessage('refusemodhelp'));
  }
  // Assert that we have more than one unique message returned, indicating randomness
  assert.ok(messages.size > 1);
});

test('getMessage returns a string', () => {
  const message = getMessage('refusemodhelp');
  assert.strictEqual(typeof message, 'string');
});