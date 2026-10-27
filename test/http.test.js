// End-to-end HTTP tests. The acceptance path for this step: someone who has
// never seen the product claims the dashboard, builds a form from the
// template, publishes it, submits a test response, sees it in the dashboard
// and exports it as CSV.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../lib/app");
const { OwnerAuth } = require("../lib/owner");
const { TEMPLATE_SLUG } = require("../lib/seed");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otf-http-"));
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app.handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function start(dir) {
  const app = createApp({ dataDir: dir });
  const { server, base } = await listen(app);
  return { base, close: () => new Promise((r) => server.close(r)) };
}

// First-run setup: claim the deployment and return the owner token.
async function claim(base) {
  const r = await fetch(`${base}/api/owner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.ok(body.token);
  return body.token;
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

test("the full owner journey: claim, build from template, publish, answer, see it, export it", async () => {
  const dir = tmpDir();
  const first = await start(dir);
  const token = await claim(first.base);

  // The dashboard and builder pages exist for a human to open.
  assert.match(await (await fetch(`${first.base}/dashboard`)).text(), /dashboard\.js/);
  assert.match(await (await fetch(`${first.base}/builder`)).text(), /builder\.js/);

  // The template comes as a definition the builder can prefill.
  const tpl = await (await fetch(`${first.base}/api/template`)).json();
  assert.ok(tpl.questions.length >= 5);

  // Build a form from the template (draft first, as the builder does).
  const created = await fetch(`${first.base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Project enquiry",
      description: tpl.description,
      questions: tpl.questions.map((q) => ({ ...q })),
      published: false,
    }),
  });
  assert.equal(created.status, 201);
  const form = await created.json();
  assert.equal(form.slug, "project-enquiry");
  assert.equal(form.published, false);

  // A draft is invisible to respondents.
  assert.equal((await fetch(`${first.base}/f/${form.slug}`)).status, 404);

  // Publish, and the share link works.
  const published = await fetch(`${first.base}/api/forms/${form.slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ published: true }),
  });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).published, true);
  assert.equal((await fetch(`${first.base}/f/${form.slug}`)).status, 200);

  // A stranger submits a test response through the share link's API.
  const answers = {
    q1: "Ada Lovelace",
    q2: "ada@example.com",
    q3: "Strategy",
    q5: "A small website.",
  };
  const posted = await fetch(`${first.base}/api/forms/${form.slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  assert.equal(posted.status, 201);

  // The dashboard sees the form with its response count…
  const listed = await fetch(`${first.base}/api/forms`, { headers: bearer(token) });
  assert.equal(listed.status, 200);
  const forms = await listed.json();
  const mine = forms.find((f) => f.slug === form.slug);
  assert.equal(mine.responseCount, 1);

  // …and per-form responses.
  const shown = await fetch(`${first.base}/api/forms/${form.slug}/responses`, { headers: bearer(token) });
  assert.equal(shown.status, 200);
  const responses = await shown.json();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].answers.q1, "Ada Lovelace");

  // …and exports them as CSV with a download header.
  const csv = await fetch(`${first.base}/api/forms/${form.slug}/responses.csv`, { headers: bearer(token) });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /attachment; filename="project-enquiry-responses\.csv"/);
  const text = await csv.text();
  assert.ok(text.startsWith("submittedAt,"));
  assert.match(text, /What's your name\?/);
  assert.match(text, /Ada Lovelace/);

  await first.close();

  // Restart over the same directory: response and owner token survive.
  const second = await start(dir);
  const again = await fetch(`${second.base}/api/forms/${form.slug}/responses`, { headers: bearer(token) });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).length, 1);
  await second.close();
});

test("static assets are served with their content types", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const css = await fetch(`${base}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  assert.match(await css.text(), /progress-bar/);

  for (const name of ["runner.js", "flow.js", "dashboard.js", "builder.js"]) {
    const js = await fetch(`${base}/${name}`);
    assert.equal(js.status, 200, `${name} should be served`);
    assert.match(js.headers.get("content-type"), /javascript/);
    assert.ok((await js.text()).length > 100, `${name} has content`);
  }
  server.close();
});

test("owner endpoints are closed to anonymous callers", async () => {
  const dir = tmpDir();
  const { server, base } = await listen(createApp({ dataDir: dir }));
  const token = await claim(base);

  const denied = [
    ["GET", "/api/forms"],
    ["POST", "/api/forms"],
    ["GET", `/api/forms/${TEMPLATE_SLUG}`],
    ["PUT", `/api/forms/${TEMPLATE_SLUG}`],
    ["DELETE", `/api/forms/${TEMPLATE_SLUG}`],
    ["GET", `/api/forms/${TEMPLATE_SLUG}/responses`],
    ["GET", `/api/forms/${TEMPLATE_SLUG}/responses.csv`],
  ];
  for (const [method, url] of denied) {
    const init = { method, headers: { "content-type": "application/json", ...bearer("wrong-token-here") } };
    if (method !== "GET") init.body = "{}";
    const r = await fetch(`${base}${url}`, init);
    assert.equal(r.status, 401, `${method} ${url} requires the owner token`);
    assert.equal((await r.json()).error, "owner token required");
  }

  // Anonymous callers can still read published forms and answer them —
  // only owner data is closed off.
  assert.equal((await fetch(`${base}/api/public/forms/${TEMPLATE_SLUG}`)).status, 200);
  const posted = await fetch(`${base}/api/forms/${TEMPLATE_SLUG}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: {} }),
  });
  assert.equal(posted.status, 400, "submission reaches validation, not the owner wall");
  server.close();
});

test("the owner token: wrong token rejected, browser cookie accepted, logout clears it", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = await claim(base);

  const wrong = await fetch(`${base}/api/forms`, { headers: bearer("not-the-token-at-all") });
  assert.equal(wrong.status, 401);

  // The browser flow: login sets an HttpOnly cookie that authenticates.
  const login = await fetch(`${base}/api/owner/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  const jar = cookie.split(";")[0];

  const withCookie = await fetch(`${base}/api/forms`, { headers: { cookie: jar } });
  assert.equal(withCookie.status, 200);

  const badLogin = await fetch(`${base}/api/owner/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "wrong-token-here" }),
  });
  assert.equal(badLogin.status, 401);

  const out = await fetch(`${base}/api/owner/logout`, { method: "POST", headers: { cookie: jar } });
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
  server.close();
});

test("claiming is first-come-only and validates the token", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));

  const short = await fetch(`${base}/api/owner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "short" }),
  });
  assert.equal(short.status, 400);

  const token = await claim(base);
  const again = await fetch(`${base}/api/owner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "another-long-token" }),
  });
  assert.equal(again.status, 409);
  assert.ok(token.length > 20);
  server.close();
});

test("ADMIN_TOKEN pins the owner token and disables claiming", async () => {
  const dir = tmpDir();
  const { server, base } = await listen(createApp({ dataDir: dir, owner: new OwnerAuth(dir, "pinned-env-token") }));

  const claim = await fetch(`${base}/api/owner/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(claim.status, 409);

  const ok = await fetch(`${base}/api/forms`, { headers: bearer("pinned-env-token") });
  assert.equal(ok.status, 200);
  server.close();
});

test("the builder edits and reorders questions without changing the slug", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = await claim(base);
  const create = async (body) =>
    fetch(`${base}/api/forms`, { method: "POST", headers: { "content-type": "application/json", ...bearer(token) }, body: JSON.stringify(body) });

  const created = await create({
    title: "Tea or Coffee?",
    questions: [
      { type: "text", label: "Your name?", required: true },
      { type: "choice", label: "Which one?", options: ["Tea", "Coffee"], required: true },
    ],
  });
  assert.equal(created.status, 201);
  const { slug } = await created.json();

  // Reorder, edit a label, and unpublish in one update.
  const updated = await fetch(`${base}/api/forms/${slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      questions: [
        { id: "q2", type: "choice", label: "Tea or coffee?", options: ["Tea", "Coffee"], required: true },
        { id: "q1", type: "text", label: "Your name?", required: false },
      ],
      published: false,
    }),
  });
  assert.equal(updated.status, 200);
  const form = await updated.json();
  assert.equal(form.slug, slug, "the slug is identity and never changes");
  assert.equal(form.published, false);
  assert.equal(form.questions[0].id, "q2");
  assert.equal(form.questions[0].label, "Tea or coffee?");

  // The public API reflects the new state: draft is hidden, and the edited
  // definition shows once published again.
  assert.equal((await fetch(`${base}/f/${slug}`)).status, 404);
  await fetch(`${base}/api/forms/${slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ published: true }),
  });
  const def = await (await fetch(`${base}/api/public/forms/${slug}`)).json();
  assert.equal(def.questions[0].label, "Tea or coffee?");

  // Bad updates are rejected without touching the stored form.
  const bad = await fetch(`${base}/api/forms/${slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ questions: [] }),
  });
  assert.equal(bad.status, 400);
  const current = await (await fetch(`${base}/api/public/forms/${slug}`)).json();
  assert.equal(current.questions.length, 2);

  // An unknown slug is a 404, not an upsert.
  const missing = await fetch(`${base}/api/forms/nope-nope`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ published: true }),
  });
  assert.equal(missing.status, 404);
  server.close();
});

test("deleting a form removes it and every response it collected", async () => {
  const dir = tmpDir();
  const first = await start(dir);
  const token = await claim(first.base);
  const created = await fetch(`${first.base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ title: "Short lived", questions: [{ type: "text", label: "Name?" }] }),
  });
  const { slug } = await created.json();
  await fetch(`${first.base}/api/forms/${slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ published: true }),
  });
  await fetch(`${first.base}/api/forms/${slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { q1: "Ada" } }),
  });

  const deleted = await fetch(`${first.base}/api/forms/${slug}`, {
    method: "DELETE",
    headers: bearer(token),
  });
  assert.equal(deleted.status, 204);

  assert.equal((await fetch(`${first.base}/api/forms/${slug}`, { headers: bearer(token) })).status, 404);
  assert.equal((await fetch(`${first.base}/api/forms/${slug}/responses`, { headers: bearer(token) })).status, 404);
  assert.equal((await fetch(`${first.base}/api/forms/${slug}/responses.csv`, { headers: bearer(token) })).status, 404);
  assert.equal((await fetch(`${first.base}/f/${slug}`)).status, 404);

  // The response data is really gone from the store, not just hidden.
  const forms = await (await fetch(`${first.base}/api/forms`, { headers: bearer(token) })).json();
  assert.ok(!forms.some((f) => f.slug === slug));
  await first.close();

  const second = await start(dir);
  const after = await (await fetch(`${second.base}/api/forms`, { headers: bearer(token) })).json();
  assert.ok(!after.some((f) => f.slug === slug));
  await second.close();
});

test("a submission still in flight cannot outlive its deleted form", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = await claim(base);
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Vanishing",
      questions: [{ type: "text", label: "Name?" }],
      published: true,
    }),
  });
  const { slug } = await created.json();

  // Open the submission by hand: headers first, then only a sliver of the
  // body, so the server sits inside readJsonBody.
  const payload = JSON.stringify({ answers: { q1: "posted too late" } });
  const url = new URL(base);
  const socket = net.connect({ host: "127.0.0.1", port: Number(url.port) });
  await once(socket, "connect");
  socket.write(
    `POST /api/forms/${slug}/responses HTTP/1.1\r\n` +
      `host: 127.0.0.1\r\n` +
      `content-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(payload)}\r\n` +
      `connection: close\r\n\r\n`,
  );
  socket.write(payload.slice(0, 10));
  await new Promise((r) => setTimeout(r, 100));

  // The owner deletes the form while the body is still arriving.
  const deleted = await fetch(`${base}/api/forms/${slug}`, {
    method: "DELETE",
    headers: bearer(token),
  });
  assert.equal(deleted.status, 204);

  // Finishing the submission must not resurrect anything.
  socket.end(payload.slice(10));
  const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  assert.match(raw, /^HTTP\/1\.1 404/, "the late submission is rejected");

  // No orphan response survives, not even under a recreated form with the
  // same slug.
  const recreated = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Vanishing",
      questions: [{ type: "text", label: "Name?" }],
      published: true,
    }),
  });
  assert.equal(recreated.status, 201);
  const responses = await (
    await fetch(`${base}/api/forms/${slug}/responses`, { headers: bearer(token) })
  ).json();
  assert.deepEqual(responses, []);
  server.close();
});

test("a submission paused over a deleted-and-recreated form is rejected, not stored under the replacement", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = await claim(base);
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Displaced",
      questions: [{ type: "text", label: "Name?" }],
      published: true,
    }),
  });
  const { slug } = await created.json();

  // Open the submission and pause it inside the body read.
  const payload = JSON.stringify({ answers: { q1: "meant for the deleted form" } });
  const socket = await pausedRequest(base, "POST", `/api/forms/${slug}/responses`, null, payload);

  // While the body is arriving, the owner deletes the form and publishes a
  // replacement under the same slug.
  const deleted = await fetch(`${base}/api/forms/${slug}`, { method: "DELETE", headers: bearer(token) });
  assert.equal(deleted.status, 204);
  const recreated = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Displaced",
      questions: [{ type: "number", label: "Budget?" }],
      published: true,
    }),
  });
  assert.equal(recreated.status, 201);

  // Completing the submission must not validate it against — or store it
  // under — the replacement: the deleted form's answers are not its data.
  socket.end(payload.slice(10));
  assert.match(
    await drain(socket),
    /^HTTP\/1\.1 409/,
    "recreation is a conflict, not a misattributed answer",
  );

  const responses = await (
    await fetch(`${base}/api/forms/${slug}/responses`, { headers: bearer(token) })
  ).json();
  assert.deepEqual(responses, [], "the replacement receives no response");
  server.close();
});

test("CSV export escapes separators, quotes, newlines and formulas", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = await claim(base);
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Tricky",
      questions: [
        { type: "text", label: "Say it", required: true },
        { type: "text", label: "Say it", id: "q2", required: true },
      ],
    }),
  });
  const { slug } = await created.json();
  await fetch(`${base}/api/forms/${slug}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ published: true }),
  });
  await fetch(`${base}/api/forms/${slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { q1: 'He said "hi", then left\nand returned', q2: "=1+1" } }),
  });

  const csv = await (await fetch(`${base}/api/forms/${slug}/responses.csv`, { headers: bearer(token) })).text();
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "submittedAt,Say it,Say it (q2)", "duplicate labels stay distinguishable");
  assert.ok(
    lines[1].endsWith(`"He said ""hi"", then left\nand returned",'=1+1`),
    "multi-line answers are quoted and formulas defused",
  );
  server.close();
});

test("the server rejects invalid submissions with a helpful error", async () => {
  const app = createApp({ dataDir: tmpDir() });
  const { server, base } = await listen(app);
  const post = (body) =>
    fetch(`${base}/api/forms/${TEMPLATE_SLUG}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const missingRequired = await post({ answers: {} });
  assert.equal(missingRequired.status, 400);
  assert.equal((await missingRequired.json()).field, "q1");

  const badEmail = await post({ answers: { q1: "A", q2: "not-an-email", q3: "Strategy", q5: "x" } });
  assert.equal(badEmail.status, 400);
  assert.equal((await badEmail.json()).field, "q2");

  const badChoice = await post({ answers: { q1: "A", q2: "a@b.co", q3: "Nonsense", q5: "x" } });
  assert.equal(badChoice.status, 400);

  const unknown = await post({ answers: { nope: "x" } });
  assert.equal(unknown.status, 400);

  const badJson = await fetch(`${base}/api/forms/${TEMPLATE_SLUG}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });
  assert.equal(badJson.status, 400);
  server.close();
});

test("unpublished forms are invisible to respondents", async () => {
  const dir = tmpDir();
  const { server, base } = await listen(createApp({ dataDir: dir }));
  const token = await claim(base);
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({ title: "Secret", questions: [{ type: "text", label: "Name?" }], published: false }),
  });
  const { slug } = await created.json();

  assert.equal((await fetch(`${base}/f/${slug}`)).status, 404);
  assert.equal((await fetch(`${base}/api/public/forms/${slug}`)).status, 404);
  const posted = await fetch(`${base}/api/forms/${slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: {} }),
  });
  assert.equal(posted.status, 404);
  server.close();
});

test("form creation is rate-limited", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = await claim(base);
  const body = JSON.stringify({ title: "Spam", questions: [{ type: "text", label: "?" }] });
  let last;
  for (let i = 0; i < 25; i++) {
    last = await fetch(`${base}/api/forms`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body,
    });
  }
  assert.equal(last.status, 429);
  server.close();
});

test("owner setup endpoints are rate-limited against brute force", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  let last;
  for (let i = 0; i < 15; i++) {
    last = await fetch(`${base}/api/owner/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: `wrong-guess-${i}` }),
    });
  }
  assert.equal(last.status, 429);
  server.close();
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
  const token = await claim(base);
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

// Sends a request whose body is deliberately paused halfway, so the server
// sits inside readJsonBody while the test changes the store behind it.
async function pausedRequest(base, method, path, token, payload) {
  const url = new URL(base);
  const socket = net.connect({ host: "127.0.0.1", port: Number(url.port) });
  await once(socket, "connect");
  socket.write(
    `${method} ${path} HTTP/1.1\r\n` +
      `host: 127.0.0.1\r\n` +
      `authorization: Bearer ${token}\r\n` +
      `content-type: application/json\r\n` +
      `content-length: ${Buffer.byteLength(payload)}\r\n` +
      `connection: close\r\n\r\n`,
  );
  socket.write(payload.slice(0, 10));
  await new Promise((r) => setTimeout(r, 100));
  return socket;
}

async function drain(socket) {
  const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const put = (token, body) => ({
  method: "PUT",
  headers: { "content-type": "application/json", ...bearer(token) },
  body: JSON.stringify(body),
});

test("an update still in flight merges into the live form, not a stale copy", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = await claim(base);
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Concurrent",
      questions: [{ type: "text", label: "Name?" }],
      published: true,
    }),
  });
  const { slug } = await created.json();

  // Open an update and pause it inside the body read.
  const payload = JSON.stringify({ title: "Renamed while paused" });
  const socket = await pausedRequest(base, "PUT", `/api/forms/${slug}`, token, payload);

  // While the body is arriving, the owner unpublishes the form — a change
  // the update's captured copy knew nothing about.
  const unpublished = await fetch(`${base}/api/forms/${slug}`, put(token, { published: false }));
  assert.equal(unpublished.status, 200);

  // The late update lands, merged into the live definition.
  socket.end(payload.slice(10));
  const raw = await drain(socket);
  assert.match(raw, /^HTTP\/1\.1 200/, "the late update succeeds");

  const form = await (await fetch(`${base}/api/forms/${slug}`, { headers: bearer(token) })).json();
  assert.equal(form.title, "Renamed while paused", "the late update is applied");
  assert.equal(form.published, false, "the intervening unpublish is not undone");
  server.close();
});

test("an update paused over a deleted form is rejected, not replayed onto a new form", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const token = await claim(base);
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Doomed",
      questions: [{ type: "text", label: "Name?" }],
      published: true,
    }),
  });
  const { slug } = await created.json();

  // Deletion and recreation under the same slug, both while the update's
  // body is still arriving: the pending update must not overwrite the
  // replacement with the deleted form's definition.
  const firstPayload = JSON.stringify({ title: "Doomed", questions: [{ type: "text", label: "Name?" }] });
  const first = await pausedRequest(base, "PUT", `/api/forms/${slug}`, token, firstPayload);
  const deleted = await fetch(`${base}/api/forms/${slug}`, { method: "DELETE", headers: bearer(token) });
  assert.equal(deleted.status, 204);
  const recreated = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Doomed",
      questions: [{ type: "number", label: "Budget?" }],
      published: true,
    }),
  });
  assert.equal(recreated.status, 201);
  first.end(firstPayload.slice(10));
  assert.match(await drain(first), /^HTTP\/1\.1 409/, "recreation is a conflict, not a silent overwrite");

  const replacement = await (await fetch(`${base}/api/forms/${slug}`, { headers: bearer(token) })).json();
  assert.equal(replacement.questions[0].label, "Budget?", "the replacement keeps its own definition");
  assert.equal(replacement.title, "Doomed");
  assert.equal(replacement.published, true);

  // Deletion alone: the paused update finds nothing to merge into.
  const secondPayload = JSON.stringify({ title: "Late rename" });
  const second = await pausedRequest(base, "PUT", `/api/forms/${slug}`, token, secondPayload);
  const deletedAgain = await fetch(`${base}/api/forms/${slug}`, {
    method: "DELETE",
    headers: bearer(token),
  });
  assert.equal(deletedAgain.status, 204);
  second.end(secondPayload.slice(10));
  assert.match(await drain(second), /^HTTP\/1\.1 404/, "a deleted form is a 404, not an upsert");
  server.close();
});

test("legacy answers without a schema keep their labels when the form is edited", async () => {
  const dir = tmpDir();
  const app = createApp({ dataDir: dir });
  const { server, base } = await listen(app);
  const token = await claim(base);
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
  const { slug } = await created.json();
  const posted = await fetch(`${base}/api/forms/${slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { q1: "Ada", q2: 5000 } }),
  });
  assert.equal(posted.status, 201);

  // Rewrite the stored response as one from before schemas existed.
  for (const r of app.store.listResponses(slug)) delete r.schema;
  app.store.saveResponses();

  // The owner relabels q1 and removes q2 in one edit.
  const updated = await fetch(`${base}/api/forms/${slug}`, put(token, {
    questions: [{ id: "q1", type: "text", label: "Full name?", required: true }],
  }));
  assert.equal(updated.status, 200);

  // The response was durably given the schema it was actually collected
  // under — the pre-edit questions.
  const responses = await (
    await fetch(`${base}/api/forms/${slug}/responses`, { headers: bearer(token) })
  ).json();
  assert.deepEqual(responses[0].schema, [
    { id: "q1", label: "Name?" },
    { id: "q2", label: "Budget?" },
  ]);

  // The export keeps the original labels and answers, and the new label's
  // column stays empty for the row collected before it existed.
  const csv = await (
    await fetch(`${base}/api/forms/${slug}/responses.csv`, { headers: bearer(token) })
  ).text();
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "submittedAt,Full name?,Name?,Budget?");
  assert.match(lines[1], /,Ada,5000$/, "the answers sit under their original labels");
  server.close();
});

test("answers whose question version no schema records still export", async () => {
  const dir = tmpDir();
  const app = createApp({ dataDir: dir });
  const { server, base } = await listen(app);
  const token = await claim(base);
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify({
      title: "Orphans",
      questions: [
        { id: "q1", type: "text", label: "Name?", required: true },
        { id: "q2", type: "number", label: "Budget?" },
      ],
      published: true,
    }),
  });
  const { slug } = await created.json();
  await fetch(`${base}/api/forms/${slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { q1: "Ada", q2: 5000 } }),
  });

  // Legacy state: no schema on the response, and a pre-migration edit that
  // already removed q2 from the stored definition.
  for (const r of app.store.listResponses(slug)) delete r.schema;
  const form = app.store.getForm(slug);
  app.store.replaceForm(slug, {
    ...form,
    questions: [{ id: "q1", type: "text", label: "Name?", required: true }],
  });

  // Now the owner edits the form through the API. The backfill can only
  // attach the live (q2-less) schema, so the q2 answer is orphaned — and
  // must still be exported, in a column of its own.
  const updated = await fetch(`${base}/api/forms/${slug}`, put(token, {
    questions: [{ id: "q1", type: "text", label: "Full name?", required: true }],
  }));
  assert.equal(updated.status, 200);

  const csv = await (
    await fetch(`${base}/api/forms/${slug}/responses.csv`, { headers: bearer(token) })
  ).text();
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "submittedAt,Full name?,Name?,q2", "the orphaned id gets its own column");
  assert.match(lines[1], /,Ada,5000$/, "the orphaned answer is not dropped");
  server.close();
});
