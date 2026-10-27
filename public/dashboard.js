// The owner dashboard: set up the owner token on first run, then list forms
// with their response counts, show a form's responses, export them as CSV,
// publish/unpublish, and delete. Plain JavaScript, no build step.
"use strict";

(function () {
  const app = document.getElementById("app");

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
    const status = await api("/api/owner/status");
    if (!status.body || !status.body.configured) return renderClaim();
    const forms = await api("/api/forms");
    if (forms.status === 200) return renderList(forms.body);
    renderLogin();
  }

  // --- first run: exactly one owner token may claim this deployment ---

  function renderClaim() {
    const input = el("input");
    input.placeholder = "Or type your own passphrase (8+ characters)";
    const hint = el("p", "muted", "This deployment has no owner yet. The first person to claim it manages its forms — the token stays in this browser.");
    const error = el("p", "error");
    const claimBtn = el("button", "primary", "Generate an owner token");
    claimBtn.type = "button";
    claimBtn.addEventListener("click", async () => {
      const r = await api("/api/owner/claim", json("POST", {}));
      if (r.status !== 201) {
        error.textContent = r.body.error || "Claiming failed.";
        return;
      }
      showGeneratedToken(r.body.token);
    });
    const ownBtn = el("button", "secondary", "Claim with my own token");
    ownBtn.type = "button";
    ownBtn.addEventListener("click", async () => {
      const r = await api("/api/owner/claim", json("POST", { token: input.value }));
      if (r.status !== 201) {
        error.textContent = r.body.error || "Claiming failed.";
        return;
      }
      load();
    });
    app.replaceChildren(
      el("h1", null, "Set up your dashboard"),
      hint,
      claimBtn,
      el("p", "muted", "— or —"),
      input,
      ownBtn,
      error,
    );
  }

  function showGeneratedToken(token) {
    const code = el("code", "token", token);
    const copy = el("button", "secondary", "Copy");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(token);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select and copy";
      }
    });
    const cont = el("button", "primary", "Continue to the dashboard");
    cont.type = "button";
    cont.addEventListener("click", load);
    app.replaceChildren(
      el("h1", null, "Your owner token"),
      el("p", "muted", "Save this somewhere safe — it is shown once and is the key to this dashboard from other browsers."),
      code,
      copy,
      cont,
    );
  }

  function renderLogin() {
    const input = el("input");
    input.placeholder = "Owner token";
    const error = el("p", "error");
    const btn = el("button", "primary", "Open dashboard");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      const r = await api("/api/owner/login", json("POST", { token: input.value }));
      if (r.status !== 200) {
        error.textContent = "That token does not match this deployment.";
        return;
      }
      load();
    });
    app.replaceChildren(
      el("h1", null, "Owner sign-in"),
      el("p", "muted", "Enter the owner token for this deployment."),
      input,
      btn,
      error,
    );
  }

  // --- the form list ---

  async function load() {
    const forms = await api("/api/forms");
    if (forms.status === 200) renderList(forms.body);
    else renderLogin();
  }

  function renderList(forms) {
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

    app.replaceChildren(
      el("div", "list-head", el("h1", null, "Your forms"), newBtn),
      forms.length ? table : el("p", "muted", "No forms yet. Create one — the starting template takes a minute."),
    );
  }

  // --- one form's responses ---

  async function renderResponses(slug) {
    const detail = await api(`/api/forms/${encodeURIComponent(slug)}`);
    const listed = await api(`/api/forms/${encodeURIComponent(slug)}/responses`);
    if (detail.status !== 200 || listed.status !== 200) {
      if (detail.status === 401 || listed.status === 401) return renderLogin();
      app.replaceChildren(el("p", "muted", "That form no longer exists."));
      return;
    }
    const form = detail.body;
    const responses = listed.body;
    const shareUrl = `${location.origin}/f/${form.slug}`;

    const back = el("button", "link", "← All forms");
    back.type = "button";
    back.addEventListener("click", load);

    const share = el("input", "share");
    share.value = shareUrl;
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
    const ordered = [...responses].sort((a, b) =>
      String(a.submittedAt).localeCompare(String(b.submittedAt)),
    );
    // Columns cover the questions as they are now *and* as they were when
    // each answer was collected, so edits and removals never hide or
    // mislabel history (shared with the CSV export).
    const columns = responseColumns(form, ordered);
    const headers = columnHeaders(columns);

    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    hr.append(el("th", null, "Submitted"));
    for (const label of headers) hr.append(el("th", null, label));
    thead.append(hr);
    const tbody = el("tbody");
    for (const r of ordered) {
      const tr = el("tr");
      tr.append(el("td", "muted", String(r.submittedAt).replace("T", " ").slice(0, 16)));
      for (const c of columns) {
        tr.append(el("td", null, String(cellValue(r, c))));
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    return table;
  }
})();