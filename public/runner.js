// The form runner: renders one question at a time and posts the answers.
// Plain JavaScript on purpose — no build step, no framework. The state
// machine lives in flow.js; this file is the DOM around it.
"use strict";

(function () {
  const app = document.getElementById("app");
  const bar = document.getElementById("progress-bar");
  const slug = location.pathname.split("/").pop();
  let form = null;
  let flow = null;

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
      flow = createFlow(form, {
        show: showStep,
        refresh: () => showStep(flow.step),
        submit,
        done: showDone,
      });
      flow.start();
    })
    .catch(() => {
      app.replaceChildren(
        el("h1", null, "Form not found"),
        el("p", "muted", "This link may be wrong, or the form is no longer published."),
      );
    });

  function showStep(i) {
    if (i === -1) return showWelcome();
    const q = form.questions[i];
    setProgress(i / form.questions.length);
    app.replaceChildren(
      el("p", "step-count", `${i + 1} of ${form.questions.length}`),
      questionEl(q),
      el("p", "error", flow.errors[q.id] || ""),
      controlsEl(q),
    );
    const input = app.querySelector("input, textarea");
    if (input) input.focus();
  }

  function showWelcome() {
    setProgress(0);
    app.replaceChildren(
      el("h1", null, form.title),
      form.description ? el("p", "muted", form.description) : null,
      el("button", "primary", "Start"),
    );
    const start = app.querySelector("button");
    start.addEventListener("click", () => flow.goTo(0));
    start.focus();
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
        radio.checked = flow.answers[q.id] === opt;
        radio.addEventListener("change", () => flow.pick(q.id, opt));
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
        btn.type = "button";
        if (flow.answers[q.id] === v) btn.classList.add("selected");
        btn.addEventListener("click", () => flow.pick(q.id, v));
        row.append(btn);
      }
      wrap.append(row);
      return wrap;
    }

    const input = q.multiline ? el("textarea") : el("input");
    if (!q.multiline) input.type = q.type === "email" ? "email" : q.type === "number" ? "number" : "text";
    if (q.placeholder) input.placeholder = q.placeholder;
    if (flow.answers[q.id] !== undefined) input.value = flow.answers[q.id];
    input.addEventListener("input", () => flow.setAnswer(q.id, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !q.multiline) {
        e.preventDefault();
        flow.advance();
      }
    });
    if (q.multiline) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          flow.advance();
        }
      });
    }
    wrap.append(input);
    return wrap;
  }

  function controlsEl(q) {
    const row = el("div", "controls");
    if (flow.step > 0) {
      const back = el("button", "ghost", "↑ Back");
      back.type = "button";
      back.addEventListener("click", () => flow.back());
      row.append(back);
    }
    if (!q.required) row.append(el("span", "hint", "optional — press Enter to skip"));
    const isLast = flow.step === form.questions.length - 1;
    const nextBtn = el("button", "primary", isLast ? "Submit" : "Continue");
    nextBtn.type = "button";
    nextBtn.addEventListener("click", () => flow.advance());
    row.append(nextBtn);
    return row;
  }

  function setProgress(fraction) {
    bar.style.width = `${Math.round(fraction * 100)}%`;
  }

  // Returns true when the response was stored; the flow ends the conversation
  // only on that outcome, so a rejected submission stays answerable.
  async function submit(cleaned) {
    setProgress(1);
    try {
      const r = await fetch(`/api/forms/${encodeURIComponent(slug)}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: cleaned }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (body.field) {
          flow.errors[body.field] = body.error || "Please check this answer.";
          const i = form.questions.findIndex((q) => q.id === body.field);
          if (i >= 0) showStep(i);
          return false;
        }
        return renderRetry(body.error || "Something went wrong. Please try again.");
      }
      return true;
    } catch {
      return renderRetry("Network error. Please try again.");
    }
  }

  // A network or server failure is not a validation error on one question;
  // offer a retry from the last step.
  function renderRetry(message) {
    app.replaceChildren(
      el("p", "error", message),
      el("button", "primary", "Back to the form"),
    );
    app.querySelector("button").addEventListener("click", () => {
      setProgress(flow.step / form.questions.length);
      showStep(flow.step);
    });
    return false;
  }

  function showDone() {
    setProgress(100);
    app.replaceChildren(
      el("h1", null, "Thank you!"),
      el("p", "muted", "Your response has been recorded."),
    );
  }
})();