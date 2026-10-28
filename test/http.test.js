// End-to-end HTTP tests: the acceptance path is "a stranger opens a link,
// answers, and the response is stored and survives a restart".
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp, dataDir } = require("../lib/app");
const { Store } = require("../lib/store");
const { TEMPLATE_SLUG } = require("../lib/seed");

const TOKEN = "test-admin-token";
const OWNER = { authorization: `Bearer ${TOKEN}` };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otf-http-"));
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app.handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function start(dir, adminToken = TOKEN) {
  const app = createApp({ dataDir: dir, adminToken });
  const { server, base } = await listen(app);
  return { base, close: () => new Promise((r) => server.close(r)) };
}

test("the full stranger journey: open link, answer, stored, survives restart", async () => {
  const dir = tmpDir();
  const first = await start(dir);

  // The shareable link serves the runner page.
  const page = await fetch(`${first.base}/f/${TEMPLATE_SLUG}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /runner\.js/);

  // The runner's definition comes from the public API.
  const def = await fetch(`${first.base}/api/public/forms/${TEMPLATE_SLUG}`);
  assert.equal(def.status, 200);
  const form = await def.json();
  assert.ok(form.questions.length >= 5);
  assert.ok(!("responses" in form), "the public view never leaks responses");

  // The stranger answers everything.
  const answers = { q1: "Ada Lovelace", q2: "ada@example.com", q3: "Strategy", q5: "A small website." };
  const posted = await fetch(`${first.base}/api/forms/${TEMPLATE_SLUG}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  assert.equal(posted.status, 201);
  const { id } = await posted.json();
  assert.ok(id);

  await first.close();

  // Restart over the same data directory: the response is still there.
  const second = await start(dir);
  const listed = await fetch(`${second.base}/api/forms/${TEMPLATE_SLUG}/responses`, { headers: OWNER });
  assert.equal(listed.status, 200);
  const responses = await listed.json();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, id);
  assert.deepEqual(responses[0].answers, { ...answers, q3: "Strategy" });
  assert.ok(responses[0].submittedAt);
  await second.close();
});

test("the runner's static assets are served so a stranger can actually answer", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir(), adminToken: TOKEN }));

  const css = await fetch(`${base}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  const cssBody = await css.text();
  assert.match(cssBody, /\.progress-bar/, "the progress bar the runner animates is styled");
  assert.match(cssBody, /\.card/, "the runner card is styled");

  const js = await fetch(`${base}/runner.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /text\/javascript|application\/javascript/);
  const jsBody = await js.text();
  assert.match(jsBody, /showWelcome/, "the real runner script, not an error page");
  assert.match(jsBody, /api\/public\/forms/, "it fetches the definition from the public API");

  // The two files the runner page references are exactly the two we serve.
  const page = await fetch(`${base}/f/${TEMPLATE_SLUG}`);
  const html = await page.text();
  for (const asset of [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1])) {
    const res = await fetch(`${base}${asset}`);
    assert.equal(res.status, 200, `asset ${asset} referenced by the runner page must load`);
  }
  server.close();
});

test("the server rejects invalid submissions with a helpful error", async () => {
  const app = createApp({ dataDir: tmpDir(), adminToken: TOKEN });
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

// JSON.parse("null") succeeds, so a literal null body is valid JSON — it used
// to be mistaken for the "already handled" sentinel and the request hung.
test("a JSON null body gets a prompt 400 on submission and creation, storing nothing", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir(), adminToken: TOKEN }));
  const post = (path, headers) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: "null",
      signal: AbortSignal.timeout(5_000),
    });

  try {
    const submission = await post(`/api/forms/${TEMPLATE_SLUG}/responses`, {
      "content-type": "application/json",
    });
    assert.equal(submission.status, 400, "a null submission is rejected, not hung");
    assert.match((await submission.json()).error, /JSON object/);

    const creation = await post("/api/forms", { ...OWNER, "content-type": "application/json" });
    assert.equal(creation.status, 400, "a null creation body is rejected, not hung");
    assert.match((await creation.json()).error, /JSON object/);

    // Neither request may have mutated the store.
    const responses = await fetch(`${base}/api/forms/${TEMPLATE_SLUG}/responses`, {
      headers: OWNER,
    });
    assert.deepEqual(await responses.json(), [], "no response was stored from a null body");
    const forms = await fetch(`${base}/api/forms`, { headers: OWNER });
    const formList = await forms.json();
    assert.equal(
      formList.filter((f) => f.slug !== TEMPLATE_SLUG).length,
      0,
      "no form was created from a null body",
    );
  } finally {
    // A hanging request (the bug this guards against) must not hang the
    // process: drop the sockets even when the assertions above fail.
    server.closeAllConnections();
    server.close();
  }
});

test("malformed number and rating answers are rejected, not coerced or stored", async () => {
  const dir = tmpDir();
  const { server, base } = await listen(createApp({ dataDir: dir, adminToken: TOKEN }));
  const post = (answers) =>
    fetch(`${base}/api/forms/${TEMPLATE_SLUG}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    });

  // q4 is the optional number, q6 the optional rating. An empty array used to
  // pass as a number (stored as 0) and a one-element array as a rating.
  for (const [field, bad] of [
    ["number-as-empty-array", { q1: "A", q2: "a@b.co", q3: "Strategy", q5: "x", q4: [] }],
    ["number-as-object", { q1: "A", q2: "a@b.co", q3: "Strategy", q5: "x", q4: { value: 5 } }],
    ["number-as-boolean", { q1: "A", q2: "a@b.co", q3: "Strategy", q5: "x", q4: true }],
    ["rating-as-array", { q1: "A", q2: "a@b.co", q3: "Strategy", q5: "x", q6: [4] }],
    ["rating-as-boolean", { q1: "A", q2: "a@b.co", q3: "Strategy", q5: "x", q6: false }],
  ]) {
    const res = await post(bad);
    assert.equal(res.status, 400, `${field} must be rejected`);
  }

  // A rejected submission is never persisted.
  const listed = await fetch(`${base}/api/forms/${TEMPLATE_SLUG}/responses`, { headers: OWNER });
  assert.deepEqual(await listed.json(), [], "rejected submissions leave no stored response");
  server.close();
});

test("accepted question ids keep their answers through submission and restore", async () => {
  const dir = tmpDir();
  const first = await start(dir);
  const created = await fetch(`${first.base}/api/forms`, {
    method: "POST",
    headers: { ...OWNER, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Odd ids",
      questions: [
        { id: "constructor", type: "text", label: "Text?", required: true },
        { id: "toString", type: "choice", label: "Pick?", options: ["A", "B"], required: true },
      ],
    }),
  });
  assert.equal(created.status, 201, "ids shadowing inherited names are accepted as ids");
  const form = await created.json();

  const answers = { constructor: "an answer", toString: "A" };
  const posted = await fetch(`${first.base}/api/forms/${form.slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  assert.equal(posted.status, 201);
  await first.close();

  // Restore over the same directory: every accepted id still holds its answer.
  const second = await start(dir);
  const listed = await fetch(`${second.base}/api/forms/${form.slug}/responses`, { headers: OWNER });
  const responses = await listed.json();
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].answers, answers);
  await second.close();
});

test("unpublished forms are invisible to respondents", async () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "secret", title: "Secret", published: false, questions: [] });
  const { server, base } = await listen(createApp({ dataDir: dir, store, adminToken: TOKEN }));

  assert.equal((await fetch(`${base}/f/secret`)).status, 404);
  assert.equal((await fetch(`${base}/api/public/forms/secret`)).status, 404);
  const posted = await fetch(`${base}/api/forms/secret/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: {} }),
  });
  assert.equal(posted.status, 404);
  server.close();
});

test("the owner API creates a form that is immediately answerable", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir(), adminToken: TOKEN }));

  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { ...OWNER, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Tea or Coffee?",
      questions: [
        { type: "choice", label: "Which one?", options: ["Tea", "Coffee"], required: true },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const form = await created.json();
  assert.equal(form.slug, "tea-or-coffee");

  const answer = await fetch(`${base}/api/forms/${form.slug}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: { q1: "Tea" } }),
  });
  assert.equal(answer.status, 201);
  server.close();
});

test("the owner API rejects prototype-sensitive question ids", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir(), adminToken: TOKEN }));
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { ...OWNER, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Trap",
      questions: [{ id: "__proto__", type: "text", label: "Name?" }],
    }),
  });
  assert.equal(created.status, 400);
  assert.match((await created.json()).error, /reserved/);
  server.close();
});

test("anonymous callers cannot read responses, definitions or the form list", async () => {
  const dir = tmpDir();
  const store = new Store(dir);
  // An unpublished definition: exactly what a stranger must never read back.
  store.addForm({ slug: "secret", title: "Secret", published: false, questions: [] });
  store.addResponse({ id: "r1", formSlug: "secret", answers: { q1: "Ada" }, submittedAt: "t" });
  const { server, base } = await listen(createApp({ dataDir: dir, store, adminToken: TOKEN }));

  const forbidden = [
    ["GET", "/api/forms"],
    ["GET", "/api/forms/secret"],
    ["GET", "/api/forms/secret/responses"],
  ];
  for (const [method, path] of forbidden) {
    const noHeader = await fetch(`${base}${path}`, { method });
    assert.equal(noHeader.status, 401, `${method} ${path} without a token must be 401`);
    const wrongHeader = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(wrongHeader.status, 401, `${method} ${path} with a wrong token must be 401`);
  }

  // Creating forms is owner-only too, so a stranger cannot add pages that
  // look like ours.
  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Spam", questions: [{ type: "text", label: "?" }] }),
  });
  assert.equal(created.status, 401);

  // The public surface stays anonymous.
  assert.equal((await fetch(`${base}/api/public/forms/secret`)).status, 404, "unpublished stays 404");
  const published = store.getForm("secret");
  published.published = true;
  store.replaceForm("secret", published);
  assert.equal((await fetch(`${base}/api/public/forms/secret`)).status, 200, "published reads stay anonymous");
  server.close();
});

test("without a configured token the owner API is switched off entirely", async () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "hello", title: "Hello", published: true, questions: [] });
  store.addResponse({ id: "r1", formSlug: "hello", answers: { q1: "hi" }, submittedAt: "t" });
  const { server, base } = await listen(createApp({ dataDir: dir, store, adminToken: null }));

  for (const path of ["/api/forms", "/api/forms/hello", "/api/forms/hello/responses"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 503, `${path} must be off without a token`);
  }
  // Submission and public reads still work.
  const posted = await fetch(`${base}/api/forms/hello/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: {} }),
  });
  assert.equal(posted.status, 201);
  server.close();
});

test("form creation is rate-limited", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir(), adminToken: TOKEN }));
  const body = JSON.stringify({ title: "Spam", questions: [{ type: "text", label: "?" }] });
  let last;
  for (let i = 0; i < 25; i++) {
    last = await fetch(`${base}/api/forms`, {
      method: "POST",
      headers: { ...OWNER, "content-type": "application/json" },
      body,
    });
  }
  assert.equal(last.status, 429);
  server.close();
});

test("static pages: home, health, unknown paths", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir(), adminToken: TOKEN }));
  assert.match(await (await fetch(`${base}/`)).text(), /conversation/);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/f/`)).status, 404);
  server.close();
});

test("DATA_DIR overrides the default storage path (mounted storage wins)", () => {
  const original = process.env.DATA_DIR;
  process.env.DATA_DIR = "/tmp/otf-mounted-storage";
  try {
    assert.equal(dataDir(), "/tmp/otf-mounted-storage");
  } finally {
    if (original === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = original;
  }
});