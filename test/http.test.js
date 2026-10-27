// End-to-end HTTP tests: the acceptance path is "a stranger opens a link,
// answers, and the response is stored and survives a restart".
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../lib/app");
const { Store } = require("../lib/store");
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
  const listed = await fetch(`${second.base}/api/forms/${TEMPLATE_SLUG}/responses`);
  assert.equal(listed.status, 200);
  const responses = await listed.json();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, id);
  assert.deepEqual(responses[0].answers, { ...answers, q3: "Strategy" });
  assert.ok(responses[0].submittedAt);
  await second.close();
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
  const store = new Store(dir);
  store.addForm({ slug: "secret", title: "Secret", published: false, questions: [] });
  const { server, base } = await listen(createApp({ dataDir: dir, store }));

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
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));

  const created = await fetch(`${base}/api/forms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

test("form creation is rate-limited", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  const body = JSON.stringify({ title: "Spam", questions: [{ type: "text", label: "?" }] });
  let last;
  for (let i = 0; i < 25; i++) {
    last = await fetch(`${base}/api/forms`, { method: "POST", headers: { "content-type": "application/json" }, body });
  }
  assert.equal(last.status, 429);
  server.close();
});

test("static pages: home, health, unknown paths", async () => {
  const { server, base } = await listen(createApp({ dataDir: tmpDir() }));
  assert.match(await (await fetch(`${base}/`)).text(), /conversation/);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/f/`)).status, 404);
  server.close();
});
