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
    const add = (id, label, extra) => {
      const key = `${id}\u0000${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      columns.push({ id, label, ...extra });
    };

    for (const q of (form && form.questions) || []) add(q.id, q.label);
    for (const r of responses) {
      for (const q of r.schema || []) {
        if (q && q.id) add(q.id, q.label);
      }
    }
    const coveredIds = new Set(columns.map((c) => c.id));
    // An answer can still have no column of its own, per response:
    //
    // 1. A response WITH a schema carrying an answer id its own schema does
    //    not name — a legacy response backfilled after its question was
    //    removed, most often. Another response's schema naming that id must
    //    not hide it: the two answers were collected under different
    //    question versions, and folding the unaccounted one into the
    //    recorded column would mislabel it as that version's answer.
    // 2. A response WITHOUT a schema (collected before schemas existed)
    //    carrying an id no current question and no recorded schema names.
    //
    // Both get their own column, labelled by the id — the only name left
    // for it. `covered` records whether a schema-backed column for the id
    // also exists, so cellValue can keep a schema-less answer (which maps
    // by id alone) out of the orphan column when that column already
    // collects it elsewhere.
    for (const r of responses) {
      const schemaIds = r.schema
        ? new Set(r.schema.filter((q) => q && q.id).map((q) => q.id))
        : null;
      for (const key of Object.keys(r.answers || {})) {
        if (schemaIds ? schemaIds.has(key) : coveredIds.has(key)) continue;
        add(key, key, { orphan: true, covered: coveredIds.has(key) });
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
  //
  // An orphan column holds answers whose question version no schema
  // accounts for, and which answers land there is decided per response:
  //   - a response WITH a schema contributes an answer only when its own
  //     schema does not name the id — when it does, the answer already
  //     sits in that schema-backed column, and repeating it here would
  //     duplicate it;
  //   - a response WITHOUT a schema maps by id alone, so it contributes
  //     only when no schema-backed column for the id exists to take it
  //     (`covered` off) — otherwise it would appear in both columns.
  function cellValue(response, column) {
    if (column.orphan) {
      if (response.schema) {
        if (response.schema.some((q) => q && q.id === column.id)) return "";
      } else if (column.covered) {
        return "";
      }
    } else if (
      response.schema &&
      !response.schema.some((q) => q && q.id === column.id && q.label === column.label)
    ) {
      return "";
    }
    const v = response.answers ? response.answers[column.id] : undefined;
    return v === undefined || v === null ? "" : v;
  }

  return { responseColumns, columnHeaders, cellValue };
});
