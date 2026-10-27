// The form runner: renders one question at a time and posts the answers.
// Plain JavaScript on purpose — no build step, no framework.
"use strict";

(function () {
  const app = document.getElementById("app");
  const bar = document.getElementById("progress-bar");
  const slug = location.pathname.split("/").pop();
  let form = null;
  let step = -1; // -1 = welcome, 0..n-1 = questions, n = done
  // Null-prototype dictionaries: question ids come from the form definition,
  // so a stray "__proto__" must never reach an inherited property.
  const answers = Object.create(null);
  const errors = Object.create(null);
  // Auto-advance state: the pending timer, the question that scheduled it, and
  // guards so a submission can happen once and stale callbacks do nothing.
  let advanceTimer = null;
  let advanceStep = -1;
  let submitting = false;
  let completed = false;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  fetch(`/api/public/forms/${encodeURIComponent(slug)}`)
    .then(async (r) => {
      if (!r.ok) throw new Error("not found");
      form = await r.json();
      document.title = form.title;
      showWelcome();
    })
    .catch(() => {
      app.replaceChildren(
        el("h1", null, "Form not found"),
        el("p", "muted", "This link may be wrong, or the form is no longer published."),
      );
    });

  function showWelcome() {
    cancelAdvance();
    step = -1;
    setProgress(0);
    app.replaceChildren(
      el("h1", null, form.title),
      form.description ? el("p", "muted", form.description) : null,
      el("button", "primary", "Start"),
    );
    const start = app.querySelector("button");
    start.addEventListener("click", () => showStep(0));
    start.focus();
  }

  function showStep(i) {
    if (completed) return; // nothing may move the form after the success screen
    cancelAdvance();
    step = i;
    const q = form.questions[i];
    setProgress(i / form.questions.length);
    app.replaceChildren(
      el("p", "step-count", `${i + 1} of ${form.questions.length}`),
      questionEl(q),
      el("p", "error", errors[q.id] || ""),
      controlsEl(q),
    );
    const input = app.querySelector("input, textarea");
    if (input) input.focus();
  }

  function questionEl(q) {
    const wrap = el("div", "question");
    wrap.append(el("h1", null, q.label));
    if (q.description) wrap.append(el("p", "muted", q.description));

    if (q.type === "choice") {
      const list = el("div", "choices");
      for (const opt of q.options) {
        const label = el("label", "choice");
        const radio = el("input");
        radio.type = "radio";
        radio.name = q.id;
        radio.value = opt;
        if (answers[q.id] === opt) radio.checked = true;
        radio.addEventListener("change", () => {
          answers[q.id] = opt;
          delete errors[q.id];
          render();
          scheduleAdvance(step);
        });
        label.append(radio, el("span", null, opt));
        list.append(label);
      }
      wrap.append(list);
      return wrap;
    }

    if (q.type === "rating") {
      const row = el("div", "rating");
      const max = q.max || 5;
      for (let v = 1; v <= max; v++) {
        const btn = el("button", "rating-btn", String(v));
        if (answers[q.id] === v) btn.classList.add("selected");
        btn.type = "button";
        btn.addEventListener("click", () => {
          answers[q.id] = v;
          delete errors[q.id];
          render();
          scheduleAdvance(step);
        });
        row.append(btn);
      }
      wrap.append(row);
      return wrap;
    }

    const input = q.multiline ? el("textarea") : el("input");
    if (!q.multiline) input.type = q.type === "email" ? "email" : q.type === "number" ? "number" : "text";
    if (q.placeholder) input.placeholder = q.placeholder;
    if (answers[q.id] !== undefined) input.value = answers[q.id];
    input.addEventListener("input", () => {
      answers[q.id] = input.value;
      delete errors[q.id];
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !q.multiline) {
        e.preventDefault();
        next();
      }
    });
    if (q.multiline) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          next();
        }
      });
    }
    wrap.append(input);
    return wrap;
  }

  function controlsEl(q) {
    const row = el("div", "controls");
    if (step > 0) {
      const back = el("button", "ghost", "↑ Back");
      back.type = "button";
      back.addEventListener("click", () => showStep(step - 1));
      row.append(back);
    }
    if (!q.required) row.append(el("span", "hint", "optional — press Enter to skip"));
    const isLast = step === form.questions.length - 1;
    const nextBtn = el("button", "primary", isLast ? "Submit" : "Continue");
    nextBtn.type = "button";
    nextBtn.addEventListener("click", next);
    row.append(nextBtn);
    return row;
  }

  function render() {
    // Re-render the current question so choice/rating selections repaint.
    // showStep cancels any pending auto-advance and reschedules none, so a
    // repaint never leaves a stale timer behind.
    if (step >= 0 && step < form.questions.length) showStep(step);
  }

  function setProgress(fraction) {
    bar.style.width = `${Math.round(fraction * 100)}%`;
  }

  // Auto-advance 250 ms after a choice/rating selection. The timer remembers
  // which question scheduled it and is cancelled the moment the form moves, so
  // rapid selections and manual navigation can never leave a callback that
  // acts on the wrong question.
  function scheduleAdvance(fromStep) {
    cancelAdvance();
    advanceStep = fromStep;
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      if (submitting || completed) return;
      if (step !== advanceStep) return;
      next();
    }, 250);
  }

  function cancelAdvance() {
    if (advanceTimer !== null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    advanceStep = -1;
  }

  function next() {
    if (submitting || completed) return;
    const q = form.questions[step];
    if (!q) return;
    const value = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined;
    const empty = value === undefined || value === null || String(value).trim() === "";
    if (empty && q.required) {
      errors[q.id] = "This question is required.";
      render();
      return;
    }
    if (!empty && q.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim())) {
      errors[q.id] = "Please enter a valid email address.";
      render();
      return;
    }
    if (!empty && q.type === "number" && !Number.isFinite(Number(String(value).trim()))) {
      errors[q.id] = "Please enter a number.";
      render();
      return;
    }
    delete errors[q.id];
    if (step < form.questions.length - 1) {
      showStep(step + 1);
    } else {
      submit();
    }
  }

  async function submit() {
    // One submission in flight, one ever completed: stale timers or double
    // clicks on the last question cannot post the same response twice.
    if (submitting || completed) return;
    submitting = true;
    cancelAdvance();
    setProgress(1);
    app.replaceChildren(el("p", "muted", "Sending…"));
    const cleaned = {};
    for (const q of form.questions) {
      const v = Object.hasOwn(answers, q.id) ? answers[q.id] : undefined;
      if (v !== undefined && String(v).trim() !== "") cleaned[q.id] = String(v).trim();
    }
    try {
      const r = await fetch(`/api/forms/${encodeURIComponent(slug)}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: cleaned }),
      });
      if (!r.ok) {
        submitting = false;
        const body = await r.json().catch(() => ({}));
        if (r.status === 400 && body.field) errors[body.field] = body.error;
        if (body.field) {
          const i = form.questions.findIndex((q) => q.id === body.field);
          if (i >= 0) return showStep(i);
        }
        return renderError(body.error || "Something went wrong. Please try again.");
      }
      completed = true;
      showDone();
    } catch {
      submitting = false;
      renderError("Network error. Please try again.");
    }
  }

  function renderError(message) {
    app.replaceChildren(
      el("p", "error", message),
      el("button", "primary", "Back to the form"),
    );
    app.querySelector("button").addEventListener("click", () => showStep(form.questions.length - 1));
  }

  function showDone() {
    setProgress(1);
    app.replaceChildren(
      el("h1", null, "Thank you!"),
      el("p", "muted", "Your response has been recorded."),
    );
  }
})();
