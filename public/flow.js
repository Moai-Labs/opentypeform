// The runner's conversation flow, as a pure state machine so it can be
// tested without a DOM: which question is showing, what the answers are,
// when to auto-advance after a choice or rating pick, and when a submission
// is allowed.
//
// Works in the browser (window.createFlow) and in Node (module.exports).
"use strict";

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.createFlow = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // form: { questions: [...] }; hooks: { show, refresh, submit, done }.
  // hooks.show(step) renders the welcome (step -1) or a question;
  // hooks.refresh() repaints the current question; hooks.submit(cleanAnswers)
  // returns a promise of true (stored) or false (rejected); hooks.done() runs
  // after a stored submission. options.autoAdvanceMs replaces the 250ms
  // auto-advance (null disables it — tests use it to control timing).
  return function createFlow(form, hooks, options) {
    const opts = options || {};
    const autoAdvanceMs = opts.autoAdvanceMs === undefined ? 250 : opts.autoAdvanceMs;
    const questions = form.questions;
    const answers = Object.create(null);
    const errors = Object.create(null);
    let step = -1;
    let timer = null;
    let submitting = false;
    let completed = false;

    function locked() {
      return submitting || completed;
    }

    function isEmpty(v) {
      return v === undefined || v === null || String(v).trim() === "";
    }

    function localError(q, v) {
      if (isEmpty(v)) return q.required ? "This question is required." : null;
      const text = String(v).trim();
      if (q.type === "email" && !EMAIL_RE.test(text)) return "Please enter a valid email address.";
      if (q.type === "number" && !Number.isFinite(Number(text))) return "Please enter a number.";
      return null;
    }

    function cancelTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function goTo(i) {
      if (locked()) return;
      cancelTimer();
      step = i;
      hooks.show(i);
    }

    // Text-like inputs, on every keystroke.
    function setAnswer(qid, value) {
      if (locked()) return;
      answers[qid] = value;
      delete errors[qid];
    }

    // Choice and rating picks: record, repaint, then auto-advance after a
    // short pause — but only if the user is still on the question that
    // scheduled the timer, and nothing is in flight.
    function pick(qid, value) {
      if (locked()) return;
      answers[qid] = value;
      delete errors[qid];
      hooks.refresh();
      if (autoAdvanceMs === null) return;
      cancelTimer();
      const at = step;
      timer = setTimeout(() => {
        timer = null;
        if (!locked() && step === at) advance();
      }, autoAdvanceMs);
    }

    function advance() {
      if (locked()) return;
      const q = questions[step];
      if (!q) return;
      const err = localError(q, answers[q.id]);
      if (err) {
        errors[q.id] = err;
        hooks.refresh();
        return;
      }
      if (step < questions.length - 1) goTo(step + 1);
      else submit();
    }

    function back() {
      if (step > 0) goTo(step - 1);
    }

    function collect() {
      const cleaned = Object.create(null);
      for (const q of questions) {
        const v = answers[q.id];
        if (!isEmpty(v)) cleaned[q.id] = String(v).trim();
      }
      return cleaned;
    }

    // Only one submission may ever be in flight, and a stored one ends the
    // flow: stale timers and late clicks can neither navigate nor resubmit.
    function submit() {
      if (locked()) return;
      submitting = true;
      cancelTimer();
      Promise.resolve(hooks.submit(collect())).then((ok) => {
        submitting = false;
        if (ok) {
          completed = true;
          if (hooks.done) hooks.done();
        } else {
          hooks.refresh();
        }
      });
    }

    function start() {
      step = -1;
      hooks.show(-1);
    }

    return {
      get step() {
        return step;
      },
      get completed() {
        return completed;
      },
      get submitting() {
        return submitting;
      },
      get timerPending() {
        return timer !== null;
      },
      answers,
      errors,
      start,
      goTo,
      back,
      setAnswer,
      pick,
      advance,
      submit,
      cancelPendingTimer: cancelTimer,
    };
  };
});