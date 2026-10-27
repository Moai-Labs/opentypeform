// CSV export: one row per response, one column per question version.
//
// Escaping follows RFC 4180 (quote and double any quote, wrap fields that
// contain separators or newlines). Cells a spreadsheet would treat as
// formulas (leading =, +, -, @ or tab) are prefixed with a single quote, the
// usual mitigation for CSV injection, so a respondent typing "=1+1" or
// "-1+1" into an answer cannot turn the export into an active spreadsheet
// cell. Strings that are plainly numbers ("-5", "42.5") keep their value:
// a strict numeric check, not the leading character, decides.
//
// Columns come from the shared column logic in public/columns.js, so
// answers collected by questions that were later removed or relabelled
// still export, under the label they were asked with.
"use strict";

const { responseColumns, columnHeaders, cellValue } = require("../public/columns");

const NUMERIC = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

function csvCell(value) {
  let text = value === undefined || value === null ? "" : String(value);
  const numeric = NUMERIC.test(text) && Number.isFinite(Number(text));
  if (!numeric && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\r\n";
}

// Builds the CSV body for a form's responses. `form` needs `questions`;
// `responses` are the stored response objects.
function responsesCsv(form, responses) {
  const ordered = [...responses].sort((a, b) =>
    String(a.submittedAt).localeCompare(String(b.submittedAt)),
  );
  const columns = responseColumns(form, ordered);
  const rows = [csvRow(["submittedAt", ...columnHeaders(columns)])];
  for (const response of ordered) {
    rows.push(csvRow([response.submittedAt, ...columns.map((c) => cellValue(response, c))]));
  }
  return rows.join("");
}

module.exports = { responsesCsv, csvCell };
