// The form builder: create and edit questions, reorder them, publish, and
// get the share link. Plain JavaScript, no build step.
"use strict";

(function () {
  const app = document.getElementById("app");
  const params = new URLSearchParams(location.search);
  const slug = params.get("form");

  // Builds an element: optional class, then any mix of child nodes, arrays
  // of them, and text.
  const el = (tag, cls, ...children) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    node.append(...children.flat());
    return node;
  };

  async function api(path, options) {
    const r = await fetch(path, options);
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  }

  const json = (method, body) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const TYPES = [
    ["text", "Text"],
    ["email", "Email"],
    ["number", "Number"],
    ["choice", "Choice"],
    ["rating", "Rating"],
  ];

  init();

  async function init() {
    if (slug) {
      const r = await api(`/api/forms/${encodeURIComponent(slug)}`);
      if (r.status === 200) return editor(r.body);
      if (r.status === 401) return (location.href = "/dashboard");
      app.replaceChildren(el("h1", null, "Form not found"), el("button", "secondary", "Back to the dashboard"));
      app.querySelector("button").addEventListener("click", () => (location.href = "/dashboard"));
      return;
    }
    start();
  }

  function start() {
    const template = el("button", "primary", "Start from the enquiry template");
    template.type = "button";
    template.addEventListener("click", async () => {
      const t = await api("/api/template");
      editor({
        title: t.body.title,
        description: t.body.description,
        published: false,
        questions: t.body.questions,
      });
    });
    const blank = el("button", "secondary", "Start blank");
    blank.type = "button";
    blank.addEventListener("click", () =>
      editor({ title: "", description: "", published: false, questions: [newQuestion()] }),
    );
    app.replaceChildren(
      el("h1", null, "New form"),
      el("p", "muted", "The enquiry template is a ready-made client enquiry form; blank starts with one question."),
      template,
      blank,
    );
  }

  function newQuestion(type = "text") {
    return { type, label: "", required: false, ...(type === "choice" ? { options: ["", ""] } : {}) };
  }

  // --- the editor ---

  function editor(form) {
    state = {
      slug: form.slug || null,
      title: form.title || "",
      description: form.description || "",
      published: Boolean(form.published),
      responseCount: form.responseCount || 0,
      questions: (form.questions || []).map((q) => ({ ...q })),
      // Ids of questions removed this session; never handed out again, so a
      // new question cannot inherit a deleted question's answers.
      retired: new Set(),
    };
    render();
  }

  let state = null;

  function render() {
    const error = el("p", "error");
    const title = el("input");
    title.value = state.title;
    title.placeholder = "Form title";
    title.addEventListener("input", () => (state.title = title.value));

    const description = el("input");
    description.value = state.description;
    description.placeholder = "A line of welcome text (optional)";
    description.addEventListener("input", () => (state.description = description.value));

    const list = el("div", "questions");
    state.questions.forEach((q, i) => list.append(questionCard(q, i)));

    const add = el("select");
    add.className = "add-select";
    add.append(el("option", null, "+ Add a question…"));
    for (const [value, label] of TYPES) {
      const opt = el("option", null, label);
      opt.value = value;
      add.append(opt);
    }
    add.addEventListener("change", () => {
      if (!add.value) return;
      state.questions.push(newQuestion(add.value));
      add.value = "";
      render();
      const cards = app.querySelectorAll(".questions .qcard");
      cards[cards.length - 1]?.querySelector("input, textarea")?.focus();
    });

    const save = el("button", "primary", state.slug ? "Save changes" : "Create form");
    save.type = "button";
    save.addEventListener("click", () => saveForm(error));

    const cancel = el("button", "ghost", "Back to dashboard");
    cancel.type = "button";
    cancel.addEventListener("click", () => (location.href = "/dashboard"));

    const after = el("div");
    if (state.slug) after.append(...publishedRow(error));

    app.replaceChildren(
      el("h1", null, state.slug ? `Edit: ${state.title || state.slug}` : "New form"),
      title,
      description,
      list,
      el("div", "toolbar", add, save, cancel),
      after,
      error,
    );
  }

  function questionCard(q, i) {
    const card = el("div", "qcard");
    const label = el("input");
    label.value = q.label;
    label.placeholder = "Question text, e.g. What's your name?";
    label.addEventListener("input", () => (q.label = label.value));

    const type = el("select");
    for (const [value, text] of TYPES) {
      const opt = el("option", null, text);
      opt.value = value;
      type.append(opt);
    }
    type.value = q.type;
    type.addEventListener("change", () => {
      const next = type.value;
      q.type = next;
      if (next === "choice" && !Array.isArray(q.options)) q.options = ["", ""];
      if (next !== "choice") delete q.options;
      if (next === "rating" && !q.max) q.max = 5;
      if (next !== "rating") delete q.max;
      if (next !== "text") delete q.multiline;
      render();
    });

    const required = el("label", "check");
    const reqBox = el("input");
    reqBox.type = "checkbox";
    reqBox.checked = Boolean(q.required);
    reqBox.addEventListener("change", () => (q.required = reqBox.checked));
    required.append(reqBox, el("span", null, "Required"));

    const row = el("div", "qhead", label, type, required);

    // Type-specific fields.
    if (q.type === "text") {
      const multi = el("label", "check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = Boolean(q.multiline);
      box.addEventListener("change", () => (q.multiline = box.checked));
      multi.append(box, el("span", null, "Long answer"));
      row.append(multi);
    }
    if (q.type === "text" || q.type === "email" || q.type === "number") {
      const ph = el("input");
      ph.value = q.placeholder || "";
      ph.placeholder = "Placeholder (optional)";
      ph.addEventListener("input", () => (q.placeholder = ph.value));
      card.append(ph);
    }
    if (q.type === "choice") {
      const options = el("textarea");
      options.value = (q.options || []).join("\n");
      options.placeholder = "One option per line (at least 2)";
      options.addEventListener("input", () => (q.options = options.value.split("\n")));
      card.append(options);
    }
    if (q.type === "rating") {
      const max = el("input");
      max.type = "number";
      max.min = "2";
      max.max = "10";
      max.value = String(q.max || 5);
      max.addEventListener("input", () => (q.max = Math.min(10, Math.max(2, Number(max.value) || 5))));
      const maxLabel = el("label", "check", "Highest rating: ");
      maxLabel.append(max);
      card.append(maxLabel);
    }
    const help = el("input");
    help.value = q.description || "";
    help.placeholder = "Help text under the question (optional)";
    help.addEventListener("input", () => (q.description = help.value));
    card.append(help);

    const move = el("div", "qtools");
    const up = el("button", "link", "↑ Up");
    up.type = "button";
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      [state.questions[i - 1], state.questions[i]] = [state.questions[i], state.questions[i - 1]];
      render();
    });
    const down = el("button", "link", "↓ Down");
    down.type = "button";
    down.disabled = i === state.questions.length - 1;
    down.addEventListener("click", () => {
      [state.questions[i + 1], state.questions[i]] = [state.questions[i], state.questions[i + 1]];
      render();
    });
    const del = el("button", "link danger", "Remove");
    del.type = "button";
    del.addEventListener("click", () => {
      if (q.id) state.retired.add(q.id);
      state.questions.splice(i, 1);
      render();
    });
    move.append(up, down, el("span", "muted small", q.type), del);
    card.append(row, move);
    return card;
  }

  // Assign stable, server-safe ids. Every question that already has an id
  // keeps it, wherever it sits in the list; new ones get the first free qN.
  // Retired ids — questions removed this session — stay reserved, so ids are
  // never reused for an unrelated question and old answers can never be
  // silently attached to a different question.
  function withIds(questions) {
    const present = new Set();
    for (const q of questions) {
      const id = (q.id || "").trim();
      if (id) present.add(id);
    }
    const reserved = new Set([...present, ...state.retired]);
    let n = 0;
    const fresh = () => {
      do {
        n += 1;
      } while (reserved.has(`q${n}`));
      reserved.add(`q${n}`);
      return `q${n}`;
    };
    const seen = new Set();
    return questions.map((q) => {
      let id = (q.id || "").trim();
      if (!id || seen.has(id)) id = fresh();
      seen.add(id);
      const out = { id, type: q.type, label: q.label, required: Boolean(q.required) };
      if (q.type === "choice") out.options = (q.options || []).map((o) => o.trim()).filter(Boolean);
      if (q.type === "text" && q.multiline) out.multiline = true;
      if (q.type === "rating") out.max = Math.min(10, Math.max(2, Number(q.max) || 5));
      const ph = (q.placeholder || "").trim();
      if (ph) out.placeholder = ph;
      const help = (q.description || "").trim();
      if (help) out.description = help;
      return out;
    });
  }

  async function saveForm(error) {
    error.textContent = "";
    const body = {
      title: state.title,
      description: state.description,
      questions: withIds(state.questions),
      published: state.published,
    };
    const r = state.slug
      ? await api(`/api/forms/${encodeURIComponent(state.slug)}`, json("PUT", body))
      : await api("/api/forms", json("POST", body));
    if (r.status === 200 || r.status === 201) {
      if (!state.slug) {
        state.slug = r.body.slug;
        location.href = `/builder?form=${encodeURIComponent(state.slug)}`;
        return;
      }
      // Hydrate the editor from the server's copy: the ids it assigned are
      // now the truth, so further edits build on the saved ids instead of
      // re-deriving them.
      if (Array.isArray(r.body.questions)) {
        state.questions = r.body.questions.map((q) => ({ ...q }));
      }
      state.published = Boolean(r.body.published);
      render();
      renderSaved();
      return;
    }
    error.textContent = r.body.error || "Saving failed.";
  }

  function renderSaved() {
    const saved = el("p", "saved", "Saved.");
    app.querySelector("p.error").before(saved);
    setTimeout(() => saved.remove(), 2000);
  }

  // Publish toggle + share link, once the form exists.
  function publishedRow(error) {
    const share = el("input", "share", `${location.origin}/f/${state.slug}`);
    share.readOnly = true;
    const copy = el("button", "secondary", "Copy share link");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(share.value);
        copy.textContent = "Copied";
      } catch {
        share.select();
      }
    });

    const toggle = el("button", state.published ? "secondary" : "primary", state.published ? "Unpublish" : "Publish");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      error.textContent = "";
      const r = await api(`/api/forms/${encodeURIComponent(state.slug)}`, json("PUT", { published: !state.published }));
      if (r.status !== 200) {
        error.textContent = r.body.error || "Publishing failed.";
        return;
      }
      state.published = !state.published;
      render();
    });

    const preview = el("button", "ghost", "Preview ↗");
    preview.type = "button";
    preview.disabled = !state.published;
    preview.addEventListener("click", () => window.open(`/f/${state.slug}`, "_blank"));

    const responses = el("button", "ghost", `Responses (${state.responseCount})`);
    responses.type = "button";
    responses.addEventListener("click", () => (location.href = `/dashboard`));

    const row = el("div", "toolbar", share, copy, toggle, preview, responses);
    row.className = "toolbar share-row";
    return [row];
  }
})();