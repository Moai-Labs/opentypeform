// Unit tests for the runner's conversation flow (public/flow.js): the
// auto-advance timers after choice/rating picks, the guards around
// submission, and local validation.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createFlow = require("../public/flow");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const form = () => ({
  questions: [
    { id: "q1", type: "choice", label: "Pick one", options: ["A", "B"], required: true },
    { id: "q2", type: "text", label: "Your name", required: true },
    { id: "q3", type: "rating", label: "How did it go", max: 5 },
  ],
});

// A flow wired to record every hook call. submit resolves after `waitMs`
// (0 by default), or rejects nothing: it returns a promise like the real
// runner's fetch does.
function wired(f, { autoAdvanceMs = 5, submitMs = 0, stored = true } = {}) {
  const log = { shows: [], refreshes: 0, submits: 0, done: 0, errors: [] };
  let resolveSubmit = null;
  const flow = createFlow(f, {
    show: (step) => log.shows.push(step),
    refresh: () => (log.refreshes += 1),
    submit: (cleaned) => {
      log.submits += 1;
      log.lastCleaned = cleaned;
      return new Promise((resolve) => {
        resolveSubmit = () => resolve(stored);
        // The submit hook resolves after submitMs, like a real network call.
        setTimeout(() => resolveSubmit(), submitMs);
      });
    },
    done: () => (log.done += 1),
    error: (message) => log.errors.push(message),
  }, { autoAdvanceMs });
  return { flow, log, flush: () => resolveSubmit && resolveSubmit() };
}

test("the flow walks welcome → questions → done", async () => {
  const { flow, log } = wired(form());
  flow.start();
  assert.deepEqual(log.shows, [-1]);

  flow.goTo(0);
  flow.pick("q1", "A");
  await sleep(10);
  assert.equal(flow.step, 1, "a choice auto-advances");
  flow.setAnswer("q2", "Ada");
  flow.advance();
  assert.equal(flow.step, 2);
  flow.pick("q3", 5);
  await sleep(10);
  assert.equal(log.submits, 1, "the last answer submits");
  assert.equal(log.done, 1);
  assert.equal(flow.completed, true);
  assert.deepEqual({ ...log.lastCleaned }, { q1: "A", q2: "Ada", q3: "5" });
});

test("required questions block advancing and show an error", async () => {
  const { flow, log } = wired(form());
  flow.start();
  flow.goTo(0);
  flow.advance();
  assert.equal(flow.step, 0, "stays on the question");
  assert.match(flow.errors.q1, /required/);
  assert.ok(log.refreshes > 0);
});

test("local validation catches bad email and number text", () => {
  const f = {
    questions: [
      { id: "q1", type: "email", label: "Email", required: true },
      { id: "q2", type: "number", label: "Budget" },
    ],
  };
  const { flow } = wired(f);
  flow.start();
  flow.goTo(0);
  flow.setAnswer("q1", "not-an-email");
  flow.advance();
  assert.match(flow.errors.q1, /valid email/);
  flow.setAnswer("q1", "a@b.co");
  flow.advance();
  assert.equal(flow.errors.q1, undefined);
  flow.setAnswer("q2", "abc");
  flow.advance();
  assert.match(flow.errors.q2, /number/);
});

test("rapid re-picks schedule one advance and keep the latest answer", async () => {
  const { flow, log } = wired(form());
  flow.start();
  flow.goTo(0);
  flow.pick("q1", "A");
  flow.pick("q1", "B");
  flow.pick("q1", "A");
  assert.equal(flow.timerPending, true, "exactly one timer is pending");
  await sleep(10);
  assert.equal(log.submits, 0, "still on question 1, not two questions ahead");
  assert.equal(flow.step, 1);
  assert.equal(flow.answers.q1, "A");
});

test("navigating away cancels the auto-advance timer", async () => {
  const { flow, log } = wired(form());
  flow.start();
  flow.goTo(1);
  flow.pick("q2", "x"); // text via pick — unusual but valid
  assert.equal(flow.timerPending, true);
  flow.back(); // manual navigation before the timer fires
  await sleep(10);
  assert.equal(flow.step, 0, "the stale timer never advanced anything");
  assert.equal(log.submits, 0);
  assert.equal(flow.timerPending, false);
});

test("only one submission can ever be in flight", async () => {
  const { flow, log } = wired(form(), { submitMs: 50 });
  flow.start();
  flow.goTo(0);
  flow.pick("q1", "A");
  await sleep(10);
  flow.setAnswer("q2", "Ada");
  flow.advance();
  flow.pick("q3", 5);
  await sleep(10);
  assert.equal(log.submits, 1);
  flow.submit();
  flow.advance();
  flow.goTo(0);
  assert.equal(log.submits, 1, "nothing re-submits while one is in flight");
  assert.equal(flow.submitting, true);
  await sleep(60);
  assert.equal(log.done, 1);
});

test("a stored submission ends the flow: stale timers and clicks do nothing", async () => {
  const { flow, log } = wired(form());
  flow.start();
  flow.goTo(0);
  flow.pick("q1", "A");
  await sleep(10);
  flow.setAnswer("q2", "Ada");
  flow.advance();
  flow.pick("q3", 5);
  await sleep(10);
  assert.equal(flow.completed, true);
  const before = { submits: log.submits, done: log.done, shows: log.shows.length };

  flow.pick("q3", 2);
  flow.advance();
  flow.goTo(0);
  flow.submit();
  await sleep(10);

  assert.equal(log.submits, before.submits, "no resubmission after done");
  assert.equal(log.done, before.done);
  assert.equal(log.shows.length, before.shows, "no navigation after done");
});

test("a rejected submission keeps the flow answerable", async () => {
  const { flow, log } = wired(form(), { stored: false });
  flow.start();
  flow.goTo(0);
  flow.pick("q1", "A");
  await sleep(10);
  flow.setAnswer("q2", "Ada");
  flow.advance();
  flow.pick("q3", 5);
  await sleep(10);
  assert.equal(log.submits, 1);
  assert.equal(flow.completed, false, "not done");
  assert.equal(log.done, 0);
  flow.setAnswer("q2", "Grace");
  flow.advance();
  flow.pick("q3", 4);
  await sleep(10);
  assert.equal(log.submits, 2, "the retry goes through");
});

test("collect trims strings and drops empty answers", () => {
  const { flow, log } = wired(form());
  flow.start();
  flow.goTo(0);
  flow.pick("q1", " A ");
  flow.setAnswer("q2", "  Ada  ");
  flow.setAnswer("q3", "");
  flow.advance();
  flow.advance();
  flow.submit();
  assert.deepEqual({ ...log.lastCleaned }, { q1: "A", q2: "Ada" });
});

test("a server-rejected earlier question is navigated to and stays on screen", async () => {
  const { flow, log, flush } = wired(form(), {
    stored: { field: "q1", message: "Answer is too long (max 2000 characters)." },
  });
  flow.start();
  flow.goTo(0);
  flow.pick("q1", "A");
  await sleep(10);
  flow.setAnswer("q2", "Ada");
  flow.advance();
  flow.pick("q3", 5);
  await sleep(10);
  assert.equal(log.submits, 1);
  flush();
  await sleep(10);

  // The flow unlocked, moved to the rejected question, and kept its error.
  assert.equal(flow.step, 0, "the rejected question is showing");
  assert.equal(log.shows.at(-1), 0);
  assert.equal(flow.errors.q1, "Answer is too long (max 2000 characters).");
  assert.equal(flow.completed, false);
  assert.equal(log.done, 0);

  // Correcting the answer and resubmitting goes back out.
  flow.setAnswer("q1", "B");
  flow.advance();
  flow.setAnswer("q2", "Ada");
  flow.advance();
  flow.pick("q3", 4);
  await sleep(20);
  assert.equal(log.submits, 2, "the retry goes out");
});

test("a network failure parks the flow on a retry screen until retried", async () => {
  const { flow, log, flush } = wired(form(), {
    stored: { error: "Network error. Please try again." },
  });
  flow.start();
  flow.goTo(0);
  flow.pick("q1", "A");
  await sleep(10);
  flow.setAnswer("q2", "Ada");
  flow.advance();
  flow.pick("q3", 5);
  await sleep(10);
  flush();
  await sleep(10);

  assert.equal(flow.failed, "Network error. Please try again.");
  assert.deepEqual(log.errors, ["Network error. Please try again."], "the error screen is showing");
  assert.equal(flow.completed, false);

  // Retrying returns to the question the respondent was on.
  flow.retry();
  assert.equal(flow.failed, null);
  assert.equal(flow.step, 2, "back on the last question");
  assert.equal(log.shows.at(-1), 2);
});
test("a mid-conversation pause owns the screen: nothing repaints over it", async () => {
  // The runner renders the plan-limit pause screen itself and resolves the
  // submit hook with false; the flow must leave that screen alone — no
  // refresh, no navigation, no error park.
  const { flow, log } = wired(form(), { stored: false });
  flow.start();
  flow.goTo(0);
  flow.pick("q1", "A");
  await sleep(10);
  flow.setAnswer("q2", "Ada");
  flow.advance();
  flow.pick("q3", 5);
  await sleep(10);
  assert.equal(log.submits, 1);

  const showsBefore = log.shows.length;
  const refreshesBefore = log.refreshes;
  await sleep(10);

  assert.equal(log.refreshes, refreshesBefore, "the pause screen is not refreshed away");
  assert.equal(log.shows.length, showsBefore, "the flow does not navigate either");
  assert.equal(flow.completed, false, "the conversation did not complete");
  assert.equal(flow.failed, null, "a pause is not a retry-screen error");
});
