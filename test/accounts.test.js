// Unit tests for private owner accounts: sign-up, sign-in, sessions.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Accounts, presentedToken, COOKIE_NAME } = require("../lib/accounts");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otf-accounts-"));
}

test("sign-up requires a valid email and a real password", () => {
  const dir = tmpDir();
  let accounts = new Accounts(dir);
  assert.match(accounts.signup("not-an-email", "longenough1").error, /valid email/);
  assert.match(accounts.signup(undefined, "longenough1").error, /valid email/);
  assert.match(accounts.signup("a@b.co", "short").error, /at least 8/);
  assert.match(accounts.signup("a@b.co").error, /at least 8/);

  const ok = accounts.signup("Ada@Example.COM ", "correct horse battery");
  assert.equal(ok.error, undefined);
  assert.equal(ok.account.email, "ada@example.com");
  // Re-reading from disk finds the same account: persistence works.
  accounts = new Accounts(dir);
  assert.equal(accounts.findAccount("ada@example.com").email, "ada@example.com");
});

test("a second account cannot take an existing email", () => {
  const accounts = new Accounts(tmpDir());
  accounts.signup("a@b.co", "longenough1");
  assert.match(accounts.signup("a@b.co", "longenough2").error, /already exists/);
  assert.match(accounts.signup("A@B.CO", "longenough2").error, /already exists/);
});

test("passwords are salted and hashed, never stored raw", () => {
  const accounts = new Accounts(tmpDir());
  const a = accounts.signup("a@b.co", "longenough1").account;
  const b = accounts.signup("c@d.co", "longenough1").account;
  assert.notEqual(a.passwordHash, "longenough1");
  assert.notEqual(a.passwordHash, b.passwordHash, "the same password salts differently");
  assert.equal(a.passwordHash.length, 128); // scrypt, 64 bytes hex
});

test("login checks the password and hands out a session", () => {
  const accounts = new Accounts(tmpDir());
  accounts.signup("a@b.co", "longenough1");
  assert.equal(accounts.login("a@b.co", "wrong-password-1"), null);
  assert.equal(accounts.login("nobody@b.co", "longenough1"), null);
  const good = accounts.login("a@b.co", "longenough1");
  assert.equal(good.account.email, "a@b.co");
  assert.ok(good.session.token.length >= 20);
});

test("a session token resolves to its account until logout", () => {
  const accounts = new Accounts(tmpDir());
  const { session } = accounts.signup("a@b.co", "longenough1");
  assert.equal(accounts.accountFor(session.token).email, "a@b.co");
  accounts.logout(session.token);
  assert.equal(accounts.accountFor(session.token), null);
  assert.equal(accounts.accountFor("not-a-token"), null);
});

test("presented credentials come from the bearer header, then the cookie", () => {
  const req = { headers: { authorization: "Bearer abc123", cookie: `${COOKIE_NAME}=cookie456` } };
  assert.equal(presentedToken(req), "abc123");
  assert.equal(presentedToken({ headers: { cookie: `${COOKIE_NAME}=cookie456` } }), "cookie456");
  assert.equal(presentedToken({ headers: {} }), null);
});

test("the first sign-up adopts the ownerless forms left by earlier steps", () => {
  const dir = tmpDir();
  // A store with the seeded template, as an existing deployment has.
  const { Store } = require("../lib/store");
  const { seedIfNeeded } = require("../lib/seed");
  const store = new Store(dir);
  seedIfNeeded(store);
  const accounts = new Accounts(dir);

  const before = accounts.signup("first@b.co", "longenough1");
  assert.deepEqual(accounts.adoptOwnerlessForms(store, before.account.id), ["enquiry"]);
  assert.equal(store.getForm("enquiry").ownerAccountId, before.account.id);

  // The second account adopts nothing and sees no forms.
  const second = accounts.signup("second@b.co", "longenough2");
  assert.deepEqual(accounts.adoptOwnerlessForms(store, second.account.id), []);
  assert.notEqual(store.getForm("enquiry").ownerAccountId, second.account.id);
});
