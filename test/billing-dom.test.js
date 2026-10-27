// DOM-level tests for the billing page: it renders for free and paid
// accounts, and a renewal is only ever confirmed when the plan's expiry
// actually moves — never merely because the account is already paid. Runs
// the real public/billing.js in a minimal DOM (test/fake-dom.js), with
// timers under test control because the page polls.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDocument, runPage, tick } = require("./fake-dom");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "billing.js"), "utf8");

const DETAILS = {
  address: "0xabc0000000000000000000000000000000000001",
  amountUsdc: 9,
  amountUnits: "9000000",
  chainId: 84532,
  network: "Base Sepolia",
  token: "USDC (test)",
  test: true,
};

const DAY = 24 * 60 * 60 * 1000;
const paidUntil = (days) => new Date(Date.now() + days * DAY).toISOString();

// The server state the fetch stub serves; a test mutates it between polls.
function serverState(overrides) {
  return {
    me: { email: "owner@example.com", plan: { tier: "free", used: 0, limit: 25, priceUsdc: 9 } },
    status: { plan: { tier: "free", used: 0, limit: 25, priceUsdc: 9, paidUntil: null }, awaiting: null, payment: DETAILS, lastCheckError: null },
    ...overrides,
  };
}

function bootBilling(state) {
  const { document, app } = createDocument();
  const scheduled = [];
  const timers = {
    // Polls are queued, not run: the test flushes them when it chooses.
    setTimeout: (fn, ms) => (scheduled.push({ fn, ms }), scheduled.length),
    clearTimeout: () => {},
  };
  const fetchStub = async (path, options) => {
    if (path === "/api/me") return json(200, state.me);
    if (path === "/api/billing/status") return json(200, state.status);
    if (path === "/api/billing/start" && options && options.method === "POST") {
      return json(200, { ...DETAILS, note: "Test payment — test USDC on a public testnet. Nothing real changes hands." });
    }
    throw new Error(`unexpected fetch: ${path}`);
  };
  runPage(source, {
    document,
    fetch: fetchStub,
    location: { href: "http://localhost/billing", reload() {} },
    timers,
  });
  return { app, scheduled };
}

function json(status, body) {
  return { status, ok: status < 400, json: async () => body };
}

async function settle(times = 3) {
  for (let i = 0; i < times; i++) await tick();
}

// Runs the callbacks queued so far (polls, the refresh timer), in order.
// Anything a run queues — the next poll, five seconds out — waits for the
// next flush, so one flush is one round of the page's own clock.
async function flushTimers(scheduled) {
  const due = scheduled.splice(0, scheduled.length);
  for (const { fn } of due) {
    await fn();
    await settle(2);
  }
}

const findByText = (nodes, text) => nodes.find((n) => n.textContent === text);
const buttons = (app) => app.querySelectorAll("button");

test("a free account renders its plans, the upgrade button and the test label", async () => {
  const { app, scheduled } = bootBilling(serverState());
  await settle();

  assert.ok(findByText(app.querySelectorAll("h1"), "Billing"), "the page renders past its loading screen");
  assert.ok(findByText(buttons(app), "Upgrade to Pro"), "the upgrade control exists");
  assert.ok(findByText(app.querySelectorAll("p"), "0 of 25 responses used this month"));
  assert.match(app.textContent, /TEST PAYMENT/, "money screens are labelled as tests");

  // Starting the payment shows the receiving address with its copy control.
  findByText(buttons(app), "Upgrade to Pro").emit("click");
  await settle();
  assert.ok(findByText(buttons(app), "Copy"), "the receiving address has a copy control");
  scheduled.splice(0, scheduled.length); // leave no pending poll behind
});

test("a paused free account says collection is paused", async () => {
  const state = serverState();
  state.me.plan = { tier: "free", used: 25, limit: 25, priceUsdc: 9 };
  state.status.plan = { tier: "free", used: 25, limit: 25, priceUsdc: 9, paidUntil: null };
  const { app } = bootBilling(state);
  await settle();

  assert.match(app.textContent, /Collection is paused/);
});

test("a paid account renders the renewal panel without claiming a payment it never received", async () => {
  const state = serverState({
    me: { email: "owner@example.com", plan: { tier: "paid", used: 30, limit: 1000, priceUsdc: 9, paidUntil: paidUntil(20) } },
    status: {
      plan: { tier: "paid", used: 30, limit: 1000, priceUsdc: 9, paidUntil: paidUntil(20) },
      awaiting: null,
      payment: DETAILS,
      lastCheckError: null,
    },
  });
  const { app, scheduled } = bootBilling(state);
  await settle();
  await flushTimers(scheduled);

  assert.ok(findByText(buttons(app), "Extend Pro with another 30 days"), "the renewal control exists");
  assert.match(app.textContent, /Pro is active until/);
  assert.doesNotMatch(app.textContent, /Payment confirmed/, "no confirmation without a new payment");
});

test("a renewal confirms only when the expiry advances, and keeps waiting until then", async () => {
  const expiry = paidUntil(20);
  const state = serverState({
    me: { email: "owner@example.com", plan: { tier: "paid", used: 30, limit: 1000, priceUsdc: 9, paidUntil: expiry } },
    status: {
      plan: { tier: "paid", used: 30, limit: 1000, priceUsdc: 9, paidUntil: expiry },
      awaiting: null,
      payment: DETAILS,
      lastCheckError: null,
    },
  });
  const { app, scheduled } = bootBilling(state);
  await settle();

  findByText(buttons(app), "Extend Pro with another 30 days").emit("click");
  await settle();

  // The address and the waiting state are up; nothing is confirmed.
  assert.match(app.textContent, /Waiting for the payment/);
  assert.doesNotMatch(app.textContent, /Payment confirmed/);

  // Poll 1: the balance is unchanged — still waiting, still not confirmed.
  await flushTimers(scheduled);
  assert.match(app.textContent, /Waiting for the payment/);
  assert.doesNotMatch(app.textContent, /Payment confirmed/);

  // Poll 2: another 9 USDC arrived and the expiry moved 30 days past the
  // baseline — only now is the renewal confirmed.
  state.status.plan = {
    tier: "paid",
    used: 30,
    limit: 1000,
    priceUsdc: 9,
    paidUntil: new Date(Date.parse(expiry) + 30 * DAY).toISOString(),
  };
  await flushTimers(scheduled);
  assert.match(app.textContent, /Payment confirmed on-chain/);
});

test("a first payment confirms when the plan turns paid", async () => {
  const state = serverState();
  const { app, scheduled } = bootBilling(state);
  await settle();

  findByText(buttons(app), "Upgrade to Pro").emit("click");
  await settle();

  // The server has not credited anything yet: the panel shows the address.
  assert.match(app.textContent, /Waiting for the payment/);
  assert.doesNotMatch(app.textContent, /Payment confirmed/);
  await flushTimers(scheduled);
  assert.doesNotMatch(app.textContent, /Payment confirmed/);

  // The payment lands: the plan turns paid and the limits lift.
  state.status.plan = { tier: "paid", used: 25, limit: 1000, priceUsdc: 9, paidUntil: paidUntil(30) };
  state.status.awaiting = null;
  await flushTimers(scheduled);
  assert.match(app.textContent, /Payment confirmed on-chain/);
});

test("a chain hiccup keeps the waiting state instead of failing the page", async () => {
  const state = serverState();
  const { app, scheduled } = bootBilling(state);
  await settle();

  findByText(buttons(app), "Upgrade to Pro").emit("click");
  await settle();

  state.status.lastCheckError = "seed peer disconnected";
  await flushTimers(scheduled);
  assert.match(app.textContent, /Could not reach the chain just now/);
  assert.doesNotMatch(app.textContent, /Payment confirmed/);
});
