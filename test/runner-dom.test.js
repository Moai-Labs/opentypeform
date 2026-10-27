// Browser-level tests for the public runner: they run the real
// public/runner.js source in a mini-DOM, against the real seeded template,
// with timers that fire only when a test decides — the auto-advance bugs the
// runner must never grow back live exactly there.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { templateForm } = require("../lib/seed");
const { createDocument, makeTimers, runPage, tick } = require("./fake-dom");

const runnerSource = fs.readFileSync(path.join(__dirname, "..", "public", "runner.js"), "utf8");

// Boots the runner against the seeded template. posts records every response
// submission body; timers.fire() runs whatever auto-advance is pending.
function setup() {
  const form = templateForm();
  const { app, bar, document } = createDocument();
  const timers = makeTimers();
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
  const location = { pathname: `/f/${form.slug}` };
  runPage(runnerSource, { document, fetch, location, timers });

  const s = {
    app,
    bar,
    timers,
    posts,
    form,
    label: () => (app.querySelector("h1") || {}).textContent,
    step: () => (app.querySelector(".step-count") || {}).textContent || "",
    error: () => (app.querySelector("p.error") || {}).textContent || "",
    button: (text) => app.querySelectorAll("button").find((b) => b.textContent === text),
    input: () => app.querySelector("input, textarea"),
    radio: (value) => app.querySelectorAll(".choices input").find((r) => r.value === value),
    rating: (value) => app.querySelectorAll(".rating button").find((b) => b.textContent === String(value)),
    type(value) {
      const input = app.querySelector("input, textarea");
      input.value = value;
      input.emit("input");
    },
  };
  return s;
}

// Walks from the welcome screen to question index `n` (0-based), answering
// the required questions along the way. Choice and rating questions use their
// own auto-advance (fire the timer) instead of the Continue button.
function walkTo(s, n) {
  s.button("Start").emit("click");
  for (let i = 0; i <= n; i++) {
    const q = s.form.questions[i];
    if (q.type === "choice") {
      if (i === n) return;
      s.radio(q.options[0]).emit("change");
      s.timers.fire();
      continue;
    }
    if (q.type === "rating") {
      if (i === n) return;
      s.rating(3).emit("click");
      s.timers.fire();
      continue;
    }
    s.type(q.type === "email" ? "ada@example.com" : q.type === "number" ? "5000" : "An answer.");
    if (i < n) {
      const btn = s.button(i === s.form.questions.length - 1 ? "Submit" : "Continue");
      btn.emit("click");
    }
  }
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

  // A choice auto-advances once its 250 ms timer fires.
  s.radio("Design").emit("change");
  assert.equal(s.label(), "What do you need help with?", "no advance before the timer");
  s.timers.fire();
  assert.equal(s.label(), "What's your budget, in USD?");

  // Optional number: skipped empty.
  s.button("Continue").emit("click");
  assert.equal(s.label(), "Tell us a little about the project.");

  s.type("A small website, by December.");
  const area = s.input();
  area.emit("keydown", { key: "Enter", ctrlKey: true });
  assert.equal(s.label(), "How urgent is this?");

  s.rating(4).emit("click");
  s.timers.fire();
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

test("rapid re-selection leaves a single advance, and it advances once", async () => {
  const s = setup();
  await tick();
  walkTo(s, 2); // the choice question
  assert.equal(s.step(), "3 of 6");

  // Two selections in quick succession: the second must replace the first
  // timer, never stack a second one.
  s.radio("Strategy").emit("change");
  s.radio("Design").emit("change");
  assert.equal(s.timers.pending.filter((t) => !t.cancelled).length, 1, "one live timer");

  s.timers.fire();
  assert.equal(s.step(), "4 of 6", "advanced exactly one question");
  s.timers.fire();
  assert.equal(s.step(), "4 of 6", "the cancelled first timer is inert");
});

test("selection followed by manual navigation leaves no stale advance", async () => {
  const s = setup();
  await tick();
  walkTo(s, 2);

  // Pick an option, then press Continue before the timer fires: the pending
  // callback belongs to the question just left and must do nothing.
  s.radio("Strategy").emit("change");
  s.button("Continue").emit("click");
  assert.equal(s.step(), "4 of 6");
  s.timers.fire();
  assert.equal(s.step(), "4 of 6", "the stale timer did not navigate again");

  // Same for Back.
  const s2 = setup();
  await tick();
  walkTo(s2, 2);
  s2.radio("Strategy").emit("change");
  s2.button("↑ Back").emit("click");
  assert.equal(s2.step(), "2 of 6");
  s2.timers.fire();
  assert.equal(s2.step(), "2 of 6", "the stale timer did not pull the form forward");
});

test("the last question submits once, and stale callbacks die after success", async () => {
  const s = setup();
  await tick();
  walkTo(s, 5); // the rating question
  assert.equal(s.step(), "6 of 6");

  // Select a rating (schedules auto-advance) and click Submit before it
  // fires: one submission, the timer is stale.
  s.rating(4).emit("click");
  const submit = s.button("Submit");
  submit.emit("click");
  submit.emit("click"); // a double click racing the fetch
  s.timers.fire();
  assert.equal(s.posts.length, 1, "no duplicate submission");
  assert.equal(s.app.textContent.includes("Sending…"), true);

  await tick();
  assert.equal(s.label(), "Thank you!");
  assert.equal(s.posts.length, 1, "still exactly one submission after success");

  // Whatever is left pending can no longer navigate or submit.
  s.timers.fire();
  assert.equal(s.label(), "Thank you!");
  assert.equal(s.posts.length, 1);
});

test("a failed submission returns to the rejected question and can retry", async () => {
  const form = templateForm();
  const { app, document } = createDocument();
  const timers = makeTimers();
  let attempts = 0;
  const fetch = async (url, opts = {}) => {
    if (!opts.method) return { ok: true, status: 200, json: async () => form };
    attempts++;
    if (attempts === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "Please pick one of the listed options.", field: "q3" }),
      };
    }
    return { ok: true, status: 201, json: async () => ({ id: "r1" }) };
  };
  runPage(runnerSource, {
    document,
    fetch,
    location: { pathname: `/f/${form.slug}` },
    timers,
  });

  const s2 = {
    app,
    label: () => (app.querySelector("h1") || {}).textContent,
    step: () => (app.querySelector(".step-count") || {}).textContent || "",
    button: (text) => app.querySelectorAll("button").find((b) => b.textContent === text),
    radio: (value) => app.querySelectorAll(".choices input").find((r) => r.value === value),
    input: () => app.querySelector("input, textarea"),
  };

  await tick();
  s2.button("Start").emit("click");
  s2.input().value = "Ada Lovelace";
  s2.input().emit("input");
  s2.button("Continue").emit("click");
  s2.input().value = "ada@example.com";
  s2.input().emit("input");
  s2.button("Continue").emit("click");
  s2.radio("Design").emit("change");
  timers.fire();
  s2.button("Continue").emit("click"); // q4, optional
  s2.input().value = "A website.";
  s2.input().emit("input");
  s2.button("Continue").emit("click"); // q5
  s2.button("Submit").emit("click"); // q6, optional rating — last question
  await tick();

  assert.equal(s2.step(), "3 of 6", "the runner returns to the rejected question");
  assert.match((s2.app.querySelector("p.error") || {}).textContent || "", /listed options/);

  // The retry: answer the rejected question again and walk forward.
  s2.radio("Design").emit("change");
  timers.fire(); // auto-advance to q4
  s2.button("Continue").emit("click"); // q4, optional
  s2.input().value = "A website.";
  s2.input().emit("input");
  s2.button("Continue").emit("click"); // q5
  s2.button("Submit").emit("click"); // q6
  await tick();
  assert.equal(s2.label(), "Thank you!", "the retried submission goes through");
});