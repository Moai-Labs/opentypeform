// Unit tests for plans and test-USDC billing: limits, credits, expiry.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Billing, monthStart, PRICE_USDC, PRICE_UNITS, FREE_MONTHLY_LIMIT } = require("../lib/billing");
const { addressForPrivateKey } = require("../lib/eth");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otf-billing-"));
}

test("the free plan is the default: 25 responses a month", () => {
  const billing = new Billing(tmpDir());
  const plan = billing.plan("no-such-account", 0);
  assert.equal(plan.tier, "free");
  assert.equal(plan.limit, 25);
  assert.equal(plan.limit, FREE_MONTHLY_LIMIT);
  assert.equal(plan.priceUsdc, PRICE_USDC);
});

test("monthly usage counts from the first of the UTC month", () => {
  assert.equal(monthStart(new Date("2026-10-27T12:00:00Z")), "2026-10-01T00:00:00.000Z");
  assert.equal(monthStart(new Date("2026-01-05T00:00:00Z")), "2026-01-01T00:00:00.000Z");
});

test("a payment is paused collection's cure: over the limit only while free", () => {
  const billing = new Billing(tmpDir());
  assert.ok(billing.paused(billing.plan("a", 25)), "25 of 25 on free is paused");
  assert.ok(billing.paused(billing.plan("a", 26)), "26 on free is paused");
  assert.ok(!billing.paused(billing.plan("a", 24)));
  assert.ok(!billing.paused(billing.plan("a", 0)));
});

// An account with a payment record whose receiving address the fake chain
// answers for.
function paidUpTo(balanceUnits) {
  const dir = tmpDir();
  const billing = new Billing(dir);
  billing.paymentDetails("acct-1");
  return { billing, read: async () => balanceUnits };
}

test("a payment below the price credits nothing", async () => {
  const { billing, read } = paidUpTo(4_000_000n); // 4 USDC
  const rec = await billing.checkPayment("acct-1", read);
  assert.equal(rec.paidUntil, null);
  assert.equal(billing.plan("acct-1", 0).tier, "free");
});

test("9 test USDC buys exactly 30 days, verified on the balance", async () => {
  const { billing, read } = paidUpTo(PRICE_UNITS);
  const before = Date.now();
  const rec = await billing.checkPayment("acct-1", read);
  const expected = before + 30 * 24 * 60 * 60 * 1000;
  assert.ok(new Date(rec.paidUntil).getTime() >= before);
  assert.ok(Math.abs(new Date(rec.paidUntil).getTime() - expected) < 5_000);
  const plan = billing.plan("acct-1", 0);
  assert.equal(plan.tier, "paid");
  assert.equal(plan.limit, 1000);
});

test("an 18 USDC payment buys 60 days; a partial top-up pays for the rest later", async () => {
  const dir = tmpDir();
  const billing = new Billing(dir);
  billing.paymentDetails("acct-1");
  let balance = 4_000_000n; // 4 USDC: not enough yet
  let rec = await billing.checkPayment("acct-1", async () => balance);
  assert.equal(rec.paidUntil, null);

  balance = 13_000_000n; // +9: one full block past the partial
  rec = await billing.checkPayment("acct-1", async () => balance);
  assert.ok(rec.paidUntil, "the first full 9 USDC credits a plan");

  balance = 18_000_000n; // 18 total: two full blocks
  rec = await billing.checkPayment("acct-1", async () => balance);
  assert.equal(billing.plan("acct-1", 0).tier, "paid");
  // Two 30-day windows from now: the second credit stacked on the first.
  const days = (new Date(rec.paidUntil).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 50 && days <= 60.1, `60 days expected, got ${days}`);
});

test("a lapsed plan falls back to free limits without deleting anything", async () => {
  const { billing, read } = paidUpTo(PRICE_UNITS);
  await billing.checkPayment("acct-1", read);
  // Time-travel the credit into the past.
  billing.records["acct-1"].paidUntil = new Date(Date.now() - 1000).toISOString();
  const plan = billing.plan("acct-1", 0);
  assert.equal(plan.tier, "free");
  assert.equal(plan.limit, 25);
  assert.ok(billing.records["acct-1"].paidUntil, "the record itself stays");
});

test("a failed chain read is never mistaken for a payment", async () => {
  const dir = tmpDir();
  const billing = new Billing(dir);
  billing.paymentDetails("acct-1");
  const rec = await billing.checkPayment("acct-1", async () => {
    throw new Error("rpc down");
  });
  assert.equal(rec.available, false);
  assert.equal(rec.paidUntil, null);
  assert.equal(billing.plan("acct-1", 0).tier, "free");
});

test("every payment address belongs to a key the product can re-derive", () => {
  const dir = tmpDir();
  const billing = new Billing(dir);
  const details = billing.paymentDetails("acct-1");
  assert.match(details.address, /^0x[0-9a-f]{40}$/);
  assert.equal(details.amountUsdc, 9);
  assert.equal(details.test, true, "payments are labelled tests");
  const reloaded = new Billing(dir);
  assert.equal(reloaded.recordFor("acct-1").address, details.address, "the address survives a restart");
  assert.equal(addressForPrivateKey(reloaded.recordFor("acct-1").privateKey), details.address);
});

test("a payment record saved with a leading-zero key restores instead of vanishing", () => {
  // Older versions saved node's minimal hex, which drops leading zero bytes.
  // Such a record must survive the restart with its address and credit.
  const dir = tmpDir();
  const billing = new Billing(dir);
  const keys = billing.paymentDetails("acct-zero");
  // Force a scalar with a leading zero byte and re-save it the old way.
  const scalar = 0x00ff0000000000000000000000000000000000000000000000000000000000abn;
  const oldStyleKey = scalar.toString(16); // 63 hex characters, no padding
  const address = addressForPrivateKey(oldStyleKey);
  assert.ok(address, "the short encoding derives");
  fs.writeFileSync(
    path.join(dir, "billing.json"),
    JSON.stringify({
      "acct-zero": {
        privateKey: oldStyleKey,
        address,
        creditedUnits: PRICE_UNITS.toString(),
        paidUntil: new Date("2026-12-31T00:00:00Z").toISOString(),
        createdAt: keys.createdAt,
      },
    }),
  );

  // A restart: the record is re-derived, kept, and the plan it bought stands.
  const restored = new Billing(dir);
  const rec = restored.recordFor("acct-zero");
  assert.ok(rec, "the record is not dropped");
  assert.equal(rec.address, address);
  assert.equal(restored.plan("acct-zero", 0).tier, "paid", "the paid entitlement survives");
});
