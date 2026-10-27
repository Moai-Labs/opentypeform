// End-to-end HTTP tests. The acceptance path for this step: a person signs
// up with email and password, hits the free cap and is paused, pays the $9
// plan in test USDC, and the limits lift — with every form owned by the
// account that created it and nobody else's visible.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../lib/app");
const { TEMPLATE_SLUG } = require("../lib/seed");
const { PRICE_UNITS } = require("../lib/billing");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otf-http-"));
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app.handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// A fake chain that answers `units` for any payment address.
function fakeChain(units) {
  return async () => units;
}

async function start(dir, units) {
  const app = createApp({ dataDir: dir, readBalance: units === undefined ? undefined : fakeChain(units) });
  const { server, base } = await listen(app);
  return { base, close: () => new Promise((r) => server.close(r)) };
}

async function post(base, url, body, token) {
  return fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

// Signs an account up and returns { token, email }.
async function signUp(base, email, password) {
  const r = await post(base, "/api/auth/signup", { email, password });
  const body = await r.json();
  return { status: r.status, token: body.token, body };
}

async function login(base, email, password) {
  const r = await post(base, "/api/auth/login", { email, password });
  return { status: r.status, token: (await r.json()).token };
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

async function getJson(base, url, token) {
  const r = await fetch(`${base}${url}`, { headers: token ? bearer(token) : {} });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function submitAnswer(base, slug, name) {
  return post(base, `/api/forms/${slug}/responses`, { answers: { q1: name, q2: "a@b.co" } });
}

test("accounts and the paid plan: sign up, hit the cap, pay, and the limits lift", async () => {
  const dir = tmpDir();
  // The fake chain answers "nothing arrived yet" while the account is free.
  const first = await start(dir, 0n);
  try {
    // --- sign up ---
    const me0 = await getJson(first.base, "/api/me");
    assert.equal(me0.status, 401, "no session yet");
    const a = await signUp(first.base, "owner@example.com", "longenough1");
    assert.equal(a.status, 201);
    assert.ok(a.token);
    const token = a.token;

    // The first account adopts the seeded template; the dashboard lists it.
    const mine = await getJson(first.base, "/api/forms", token);
    assert.equal(mine.status, 200);
    assert.ok(mine.body.some((f) => f.slug === TEMPLATE_SLUG));

    // --- build and publish a form of their own ---
    const created = await post(
      first.base,
      "/api/forms",
      {
        title: "Workshop sign-up",
        questions: [
          { id: "q1", type: "text", label: "Name", required: true },
          { id: "q2", type: "email", label: "Email", required: true },
        ],
      },
      token,
    );
    assert.equal(created.status, 201);
    const form = await created.json();
    await fetch(`${first.base}/api/forms/${form.slug}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ published: true }),
    });

    // The runner shows the badge on the free tier.
    const pub = await getJson(first.base, `/api/public/forms/${form.slug}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.branding.powered, true);
    assert.equal(pub.body.paused, false);

    // --- the free cap: 25 responses a month, then collection pauses ---
    for (let i = 1; i <= 25; i++) {
      const r = await submitAnswer(first.base, form.slug, `person ${i}`);
      assert.equal(r.status, 201, `submission ${i}`);
    }
    const over = await submitAnswer(first.base, form.slug, "person 26");
    assert.equal(over.status, 402);
    assert.equal((await over.json()).code, "plan_limit");

    // Paused collection is visible before the first question, too.
    const pausedPub = await getJson(first.base, `/api/public/forms/${form.slug}`);
    assert.equal(pausedPub.body.paused, true);

    // ...and it counts across every form the account owns.
    const overOnTemplate = await submitAnswer(first.base, TEMPLATE_SLUG, "template person");
    assert.equal(overOnTemplate.status, 402);

    // Usage is visible on /api/me.
    const used = await getJson(first.base, "/api/me", token);
    assert.equal(used.body.plan.tier, "free");
    assert.equal(used.body.plan.used, 25);
    assert.equal(used.body.plan.limit, 25);

    // --- pay the $9 plan in test USDC ---
    const started = await post(first.base, "/api/billing/start", {}, token);
    assert.equal(started.status, 200);
    const payment = await started.json();
    assert.match(payment.address, /^0x[0-9a-f]{40}$/);
    assert.equal(payment.amountUsdc, 9);
    assert.equal(payment.test, true, "payments are labelled as tests");
    assert.match(payment.note, /test/i);

    // Not paid yet: the status shows the same address and keeps waiting.
    const waiting = await getJson(first.base, "/api/billing/status", token);
    assert.equal(waiting.body.awaiting.address, payment.address);

    // The right amount arrives on-chain: the limits lift.
    const paidApp = await start(dir, PRICE_UNITS);
    try {
      const status = await getJson(paidApp.base, "/api/billing/status", token);
      assert.equal(status.body.plan.tier, "paid");
      assert.equal(status.body.plan.limit, 1000);
      assert.equal(status.body.awaiting, null, "nothing more is awaited");

      // Collection resumes everywhere, and the runner goes unbranded.
      const resumed = await submitAnswer(paidApp.base, form.slug, "person 26");
      assert.equal(resumed.status, 201);
      const unbranded = await getJson(paidApp.base, `/api/public/forms/${form.slug}`);
      assert.equal(unbranded.body.branding.powered, false);

      // The paid plan also has a cap: 1,000 a month, then it pauses too.
      const paid = await getJson(paidApp.base, "/api/me", token);
      assert.equal(paid.body.plan.limit, 1000);
    } finally {
      await paidApp.close();
    }

    // --- the whole store survives a restart ---
    const again = await start(dir, PRICE_UNITS);
    try {
      const forms = await getJson(again.base, "/api/forms", token);
      assert.ok(forms.body.some((f) => f.slug === form.slug), "the form is still owned");
      const responses = await getJson(again.base, `/api/forms/${form.slug}/responses`, token);
      assert.equal(responses.body.length, 26);
    } finally {
      await again.close();
    }
  } finally {
    await first.close();
  }
});

test("a paid chain state is read again after a restart without paying twice", async () => {
  // Simulates the restore path: pay, restart, and the plan is still active —
  // the credited units are on disk, so the same balance does not buy twice.
  const dir = tmpDir();
  const before = await start(dir, PRICE_UNITS);
  let token;
  try {
    const a = await signUp(before.base, "owner@example.com", "longenough1");
    token = a.token;
    await post(before.base, "/api/billing/start", {}, token);
    // The first check credits the payment and stores it.
    const paid = await getJson(before.base, "/api/billing/status", token);
    assert.equal(paid.body.plan.tier, "paid");
  } finally {
    await before.close();
  }
  const after = await start(dir, PRICE_UNITS);
  try {
    const status = await getJson(after.base, "/api/billing/status", token);
    assert.equal(status.body.plan.tier, "paid");
    const days = (new Date(status.body.plan.paidUntil).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 29.9 && days <= 30.01, `still a single 30-day window, got ${days}`);
  } finally {
    await after.close();
  }
});

test("each account sees only its own forms", async () => {
  const dir = tmpDir();
  const app = await start(dir);
  try {
    const a = await signUp(app.base, "a@example.com", "longenough1");
    const b = await signUp(app.base, "b@example.com", "longenough2");
    const created = await post(
      app.base,
      "/api/forms",
      { title: "A's form", questions: [{ id: "q1", type: "text", label: "Name", required: true }] },
      a.token,
    );
    assert.equal(created.status, 201);
    const formA = await created.json();

    const bsList = await getJson(app.base, "/api/forms", b.token);
    assert.ok(!bsList.body.some((f) => f.slug === formA.slug));
    assert.equal((await getJson(app.base, `/api/forms/${formA.slug}`, b.token)).status, 404);
    assert.equal(
      (await fetch(`${app.base}/api/forms/${formA.slug}/responses`, { headers: bearer(b.token) })).status,
      404,
    );
    assert.equal(
      (await fetch(`${app.base}/api/forms/${formA.slug}`, { method: "DELETE", headers: bearer(b.token) })).status,
      404,
    );
    // A's own list shows it, and so does nothing of B's.
    const asList = await getJson(app.base, "/api/forms", a.token);
    assert.ok(asList.body.some((f) => f.slug === formA.slug));
  } finally {
    await app.close();
  }
});

test("sign-in, sign-out and bad credentials behave", async () => {
  const dir = tmpDir();
  const app = await start(dir);
  try {
    await signUp(app.base, "a@example.com", "longenough1");
    const bad = await login(app.base, "a@example.com", "wrong-password");
    assert.equal(bad.status, 401);
    const good = await login(app.base, "a@example.com", "longenough1");
    assert.equal(good.status, 200);
    assert.ok(good.token);

    const me = await getJson(app.base, "/api/me", good.token);
    assert.equal(me.body.email, "a@example.com");

    await post(app.base, "/api/auth/logout", {}, good.token);
    assert.equal((await getJson(app.base, "/api/me", good.token)).status, 401);

    // Duplicate sign-up is refused with a clear message.
    const dup = await signUp(app.base, "a@example.com", "another-pass-1");
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /already exists/);
  } finally {
    await app.close();
  }
});

test("the dashboard, builder, login and billing pages exist for a human", async () => {
  const dir = tmpDir();
  const app = await start(dir);
  try {
    for (const [pathName, script] of [
      ["/dashboard", "dashboard.js"],
      ["/builder", "builder.js"],
      ["/login", "login.js"],
      ["/billing", "billing.js"],
    ]) {
      const r = await fetch(`${app.base}${pathName}`);
      assert.equal(r.status, 200, pathName);
      assert.match(await r.text(), new RegExp(script));
    }
  } finally {
    await app.close();
  }
});

test("static pages: home, dashboard, builder, health, unknown paths", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  assert.match(await (await fetch(`${base}/`)).text(), /conversation/);
  assert.equal((await fetch(`${base}/dashboard`)).status, 200);
  assert.equal((await fetch(`${base}/builder`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/f/`)).status, 404);
  server.close();
});
test("answers stay exported and identifiable after their question is removed", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = (await signUp(base, "history@example.com", "longenough1")).token;
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "History",
      questions: [
        { id: "q1", type: "text", label: "Name?", required: true },
        { id: "q2", type: "number", label: "Budget?" },
      ],
      published: true,
    }),
  });
  const form = await created.json();
  const posted = await fetch(`${base}/api/forms/${form.slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { q1: "Ada", q2: 5000 } }),
  });
  assert.equal(posted.status, 201);

  // The owner removes the budget question.
  const updated = await fetch(`${base}/api/forms/${form.slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      questions: [{ id: "q1", type: "text", label: "Name?", required: true }],
    }),
  });
  assert.equal(updated.status, 200);

  // The response keeps the question schema it was collected under…
  const responses = await (
    await fetch(`${base}/api/forms/${form.slug}/responses`, { headers: bearer(token) })
  ).json();
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].schema, [
    { id: "q1", label: "Name?" },
    { id: "q2", label: "Budget?" },
  ]);

  // …and the export still carries the answer under its original label.
  const csv = await (
    await fetch(`${base}/api/forms/${form.slug}/responses.csv`, { headers: bearer(token) })
  ).text();
  assert.match(csv, /Budget\?/);
  assert.match(csv, /5000/);
  server.close();
});
