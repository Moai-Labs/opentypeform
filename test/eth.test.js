// Unit tests for the payment-address derivation in lib/eth.js.
//
// The vectors here are public and canonical: private key 1 in secp256k1 is
// the generator point, and its Ethereum address is the well-known one shown
// below. If either changes, something is badly wrong.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { newReceivingKeys, addressForPrivateKey } = require("../lib/eth");

const ONE = "0".repeat(63) + "1";

test("private key 1 derives the canonical generator address", () => {
  assert.equal(addressForPrivateKey(ONE), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
});

test("a generated keypair re-derives to the same address", () => {
  const keys = newReceivingKeys();
  assert.match(keys.privateKey, /^[0-9a-f]{64}$/);
  assert.equal(addressForPrivateKey(keys.privateKey), keys.address);
  assert.notEqual(keys.address, addressForPrivateKey(ONE), "random keys differ from the canonical one");
});

test("a malformed private key yields no address, not a crash", () => {
  assert.equal(addressForPrivateKey("zz"), null);
  assert.equal(addressForPrivateKey(""), null);
});

test("a scalar with leading zero bytes derives the same address however it is written", () => {
  // The scalar 1 written short (as older versions of newReceivingKeys saved
  // it) and written zero-padded are the same key.
  assert.equal(addressForPrivateKey("1"), addressForPrivateKey("0".repeat(63) + "1"));
  // A 31-byte key (one leading zero byte) is still a valid scalar.
  const keys = newReceivingKeys();
  const scalar = BigInt("0x" + keys.privateKey) & ((1n << 248n) - 1n);
  const short = scalar.toString(16).padStart(62, "0");
  assert.equal(addressForPrivateKey(short), addressForPrivateKey(short.padStart(64, "0")));
  assert.notEqual(addressForPrivateKey(short), null);
});

test("a generated private key is always stored as 64 hex characters", () => {
  for (let i = 0; i < 20; i++) {
    const keys = newReceivingKeys();
    assert.match(keys.privateKey, /^[0-9a-f]{64}$/, `key ${i} is zero-padded hex`);
  }
});
