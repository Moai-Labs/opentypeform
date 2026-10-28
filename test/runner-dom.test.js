// Browser-level test for the public runner page: the real public/runner.js
// in a mini-DOM, against the real seeded template. This file pins the page
// itself — boot from the public API, welcome screen, one question at a time,
// exactly one submission. The auto-advance and submission guards live in
// flow.js and are covered in flow.test.js.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { templateForm } = require("../lib/seed");
const { createDocument, runPage, tick } = require("./fake-dom");

const runnerSource = fs.readFileSync(path.join(__dirname, "..", "public", "runner.js"), "utf8");
// The real page loads flow.js before runner.js; the flow machine is a global.
const flowSource = fs.readFileSync(path.join(__dirname, "..", "public", "flow.js"), "utf8");

// The page's auto-advance runs on a real 250 ms timer.
const advance = () => new Promise((r) => setTimeout(r, 320));

function setup() {
  const form = templateForm();
  const { app, document } = createDocument();
  const bar = { style: {} };
  const posts = [];
  const fetch = async (url, opts = {}) => {
    if (!opts.method && url === `/api/public/forms/${form.slug}`) {
      return { ok: true, status: 200, json: async () => form };
    }
    if (opts.method === "POST" && url === `/api/forms/${form.slug}/responses`) {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({ id: "r1" }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  };
  runPage(runnerSource, {
    preludes: [flowSource],
    document: {
      ...document,
      getElementById: (id) => (id === "app" ? app : id === "progress-bar" ? bar : null),
    },
    fetch,
    location: { pathname: `/f/${form.slug}` },
  });

  return {
    app,
    bar,
    posts,
    form,
    label: () => (app.querySelector("h1") || {}).textContent,
    step: () => (app.querySelector(".step-count") || {}).textContent || "",
    button: (text) => app.querySelectorAll("button").find((b) => b.textContent === text),
    input: () => app.querySelector("input, textarea"),
    radio: (value) => app.querySelectorAll(".choices input").find((r) => r.value === value),
    rating: (value) =>
      app.querySelectorAll(".rating button").find((b) => b.textContent === String(value)),
    type(value) {
      const input = app.querySelector("input, textarea");
      input.value = value;
      input.emit("input");
    },
  };
}

test("a stranger answers the seeded template one question at a time", async () => {
  const s = setup();
  await tick(); // the definition fetch settles
  assert.equal(s.label(), "Client enquiry", "welcome screen shows the form title");

  s.button("Start").emit("click");
  assert.equal(s.label(), "What's your name?");
  assert.equal(s.step(), "1 of 6");

  s.type("Ada Lovelace");
  s.button("Continue").emit("click");
  assert.equal(s.label(), "What's the best email to reach you?");

  s.type("ada@example.com");
  s.button("Continue").emit("click");
  assert.equal(s.label(), "What do you need help with?");

  // A choice auto-advances once its timer fires, not before.
  s.radio("Design").emit("change");
  assert.equal(s.label(), "What do you need help with?", "no advance before the timer");
  await advance();
  assert.equal(s.label(), "What's your budget, in USD?");

  // Optional number: skipped empty.
  s.button("Continue").emit("click");
  assert.equal(s.label(), "Tell us a little about the project.");

  s.type("A small website, by December.");
  s.input().emit("keydown", { key: "Enter", ctrlKey: true });
  assert.equal(s.label(), "How urgent is this?");

  s.rating(4).emit("click");
  await advance();
  assert.equal(s.posts.length, 1, "the response is posted exactly once");
  assert.deepEqual(s.posts[0].answers, {
    q1: "Ada Lovelace",
    q2: "ada@example.com",
    q3: "Design",
    q5: "A small website, by December.",
    q6: "4",
  });
  await tick();
  assert.equal(s.label(), "Thank you!");
  assert.equal(s.bar.style.width, "100%");
});
