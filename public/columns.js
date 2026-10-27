// Response columns, shared by the CSV export and the dashboard's table.
//
// Columns may not come from the current form definition alone: a question
// removed (or relabelled) after answers came in would hide those answers or
// mislabel them. Every stored response therefore carries a snapshot of the
// question schema it answered (`schema: [{ id, label }]`), and the columns
// are the union of the current questions and every stored schema, keyed by
// id *and* label so a relabelled question keeps its history in its own
// column. Works in the browser (globals) and in Node (module.exports).
"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else for (const key of Object.keys(api)) root[key] = api[key];
})(typeof self !== "undefined" ? self : this, function () {
  // Columns for a form and its responses: current questions first, then
  // historical question versions in the order the responses introduced
  // them, then any answer id no question version accounts for.
  function responseColumns(form, responses) {
    const columns = [];
    const seen = new Set();
    const add = (id, label) => {
      const key = `${id}\u0000${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      columns.push({ id, label });
    };

    for (const q of (form && form.questions) || []) add(q.id, q.label);
    for (const r of responses) {
      for (const q of r.schema || []) {
        if (q && q.id) add(q.id, q.label);
      }
    }
    // A legacy answer can outdate even that union: a response stored before
    // schemas existed (or migrated before its form was edited) may carry an
    // answer id that no current question and no recorded schema names. Drop
    // it from the columns and that answer becomes invisible in the table
    // and the export, so give it its own column, labelled by its id — the
    // only name left for it.
    const covered = new Set(columns.map((c) => c.id));
    for (const r of responses) {
      for (const key of Object.keys(r.answers || {})) {
        if (covered.has(key)) continue;
        covered.add(key);
        columns.push({ id: key, label: key, orphan: true });
      }
    }
    return columns;
  }

  // Headers stay distinguishable when two columns share a label.
  function columnHeaders(columns) {
    const seen = new Map();
    return columns.map((c) => {
      const n = (seen.get(c.label) || 0) + 1;
      seen.set(c.label, n);
      return n > 1 ? `${c.label} (${c.id})` : c.label;
    });
  }

  // The value a response contributes to a column: its answer when the
  // response's own schema answered exactly this question version, else
  // nothing. Responses stored before schemas existed map by id alone.
  // An orphan column holds answers whose question version is unknown to
  // every schema, so any response actually carrying that answer id
  // contributes it.
  function cellValue(response, column) {
    if (!column.orphan) {
      if (
        response.schema &&
        !response.schema.some((q) => q && q.id === column.id && q.label === column.label)
      ) {
        return "";
      }
    }
    const v = response.answers ? response.answers[column.id] : undefined;
    return v === undefined || v === null ? "" : v;
  }

  return { responseColumns, columnHeaders, cellValue };
});
