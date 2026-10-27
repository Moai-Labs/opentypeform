// The owner dashboard: list forms with their response counts, show a form's
// responses, export them as CSV, publish/unpublish, and delete. Plain
// JavaScript, no build step.
//
// Sign-in lives on /login; this page just bounces there when the session is
// gone and keeps the plan state (usage, limits) visible.
"use strict";

(function () {
  const app = document.getElementById("app");
  const header = document.querySelector("header.owner-header nav");

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function api(path, options) {
    const r = await fetch(path, options);
    if (r.status === 204) return { status: 204, body: null };
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  }

  const json = (method, body) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  init();

  async function init() {
    const me = await api("/api/me");
    if (me.status !== 200) return (location.href = "/login");
    renderHeader(me.body);
    const forms = await api("/api/forms");
    if (forms.status === 200) return renderList(forms.body, me.body);
    if (forms.status === 401) return (location.href = "/login");
    app.replaceChildren(el("p", "muted", "Something went wrong loading your forms."));
  }

  // The header carries the account: email, plan, usage, and the way out.
  function renderHeader(me) {
    header.replaceChildren(
      el("span", "muted small", `${me.email} · ${me.plan.tier === "paid" ? "Pro" : "Free"} · ${me.plan.used}/${me.plan.limit} this month`),
      (() => {
        const a = el("a", null, me.plan.tier === "paid" ? "Billing" : "Upgrade — $9/mo");
        a.href = "/billing";
        return a;
      })(),
      (() => {
        const out = el("a", null, "Sign out");
        out.href = "#";
        out.addEventListener("click", async (e) => {
          e.preventDefault();
          await fetch("/api/auth/logout", { method: "POST" });
          location.href = "/login";
        });
        return out;
      })(),
    );
  }

  // --- the form list ---

  async function load() {
    const me = await api("/api/me");
    if (me.status !== 200) return (location.href = "/login");
    renderHeader(me.body);
    const forms = await api("/api/forms");
    if (forms.status === 200) renderList(forms.body, me.body);
    else location.href = "/login";
  }

  function renderList(forms, me) {
    const paused = me.plan.used >= me.plan.limit;

    const rows = forms.map((f) => {
      const row = el("tr");
      const title = el("td");
      title.append(el("strong", null, f.title));
      title.append(el("div", "muted small", f.published ? "Live" : "Draft"));
      row.append(title);

      const count = el("td", null, String(f.responseCount));
      count.className = "num";
      row.append(count);

      const actions = el("td", "actions");
      const responses = el("button", "link", "Responses");
      responses.type = "button";
      responses.addEventListener("click", () => renderResponses(f.slug));
      actions.append(responses);

      const edit = el("button", "link", "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => (location.href = `/builder?form=${encodeURIComponent(f.slug)}`));
      actions.append(edit);

      const toggle = el("button", "link", f.published ? "Unpublish" : "Publish");
      toggle.type = "button";
      toggle.addEventListener("click", async () => {
        await api(`/api/forms/${encodeURIComponent(f.slug)}`, json("PUT", { published: !f.published }));
        load();
      });
      actions.append(toggle);

      const del = el("button", "link danger", "Delete");
      del.type = "button";
      del.addEventListener("click", () => {
        const what = f.responseCount === 1 ? "and its 1 response" : "and all its responses";
        if (!confirm(`Delete "${f.title}" ${what}? This cannot be undone.`)) return;
        api(`/api/forms/${encodeURIComponent(f.slug)}`, { method: "DELETE" }).then(load);
      });
      actions.append(del);

      row.append(actions);
      return row;
    });

    const table = el("table", "forms");
    const thead = el("thead");
    const hr = el("tr");
    hr.append(el("th", null, "Form"), el("th", null, "Responses"), el("th"));
    thead.append(hr);
    const tbody = el("tbody");
    for (const r of rows) tbody.append(r);
    table.append(thead, tbody);

    const newBtn = el("button", "primary", "New form");
    newBtn.type = "button";
    newBtn.addEventListener("click", () => (location.href = "/builder"));

    const pausedNote = paused
      ? el(
          "p",
          "error",
          me.plan.tier === "paid"
            ? `You have used all ${me.plan.limit} responses of the Pro plan this month. Collection is paused until the next payment or next month.`
            : `Collection is paused — you have used all ${me.plan.limit} free responses this month. Upgrade to Pro ($${me.plan.priceUsdc}/month) on the billing page to lift the limit immediately.`,
        )
      : null;

    app.replaceChildren(
      el("div", "list-head", el("h1", null, "Your forms"), newBtn),
      pausedNote,
      forms.length ? table : el("p", "muted", "No forms yet. Create one — the starting template takes a minute."),
    );
  }

  // --- one form's responses ---

  async function renderResponses(slug) {
    const detail = await api(`/api/forms/${encodeURIComponent(slug)}`);
    const listed = await api(`/api/forms/${encodeURIComponent(slug)}/responses`);
    if (detail.status !== 200 || listed.status !== 200) {
      if (detail.status === 401 || listed.status === 401) return (location.href = "/login");
      app.replaceChildren(el("p", "muted", "That form no longer exists."));
      return;
    }
    const form = detail.body;
    const responses = listed.body;
    const shareUrl = `${location.origin}/f/${form.slug}`;

    const back = el("button", "link", "← All forms");
    back.type = "button";
    back.addEventListener("click", load);

    const share = el("input", "share", shareUrl);
    share.readOnly = true;
    const copy = el("button", "secondary", "Copy share link");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        copy.textContent = "Copied";
      } catch {
        share.select();
      }
    });

    const toggle = el("button", "secondary", form.published ? "Unpublish" : "Publish");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      await api(`/api/forms/${encodeURIComponent(slug)}`, json("PUT", { published: !form.published }));
      renderResponses(slug);
    });

    const edit = el("button", "secondary", "Edit form");
    edit.type = "button";
    edit.addEventListener("click", () => (location.href = `/builder?form=${encodeURIComponent(slug)}`));

    const exportLink = el("a", "secondary button-like", "Export CSV");
    exportLink.href = `/api/forms/${encodeURIComponent(slug)}/responses.csv`;

    const del = el("button", "secondary danger", "Delete form");
    del.type = "button";
    del.addEventListener("click", () => {
      const what = responses.length === 1 ? "and its 1 response" : "and all its responses";
      if (!confirm(`Delete "${form.title}" ${what}? This cannot be undone.`)) return;
      api(`/api/forms/${encodeURIComponent(slug)}`, { method: "DELETE" }).then(load);
    });

    const table = responsesTable(form, responses);

    app.replaceChildren(
      el("div", "list-head", el("h1", null, form.title), el("span", "pill", form.published ? "Live" : "Draft")),
      el("div", "toolbar", back),
      el("p", null, `${responses.length} response${responses.length === 1 ? "" : "s"}`),
      el("div", "toolbar", share, copy, toggle, edit, exportLink, del),
      table || el("p", "muted", `No responses yet. Share the link above — responses appear here the moment they arrive.`),
    );
  }

  function responsesTable(form, responses) {
    if (!responses.length) return null;
    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    hr.append(el("th", null, "Submitted"));
    for (const q of form.questions) hr.append(el("th", null, q.label));
    thead.append(hr);
    const tbody = el("tbody");
    for (const r of [...responses].sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))) {
      const tr = el("tr");
      tr.append(el("td", "muted", String(r.submittedAt).replace("T", " ").slice(0, 16)));
      for (const q of form.questions) {
        const v = r.answers ? r.answers[q.id] : "";
        tr.append(el("td", null, v === undefined || v === null ? "" : String(v)));
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    return table;
  }
})();
