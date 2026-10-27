// CSV export: one row per response, one column per question.
//
// Escaping follows RFC 4180 (quote and double any quote, wrap fields that
// contain separators or newlines). Cells a spreadsheet would treat as
// formulas (leading =, +, @ or tab) are prefixed with a single quote, the
// usual mitigation for CSV injection, so a respondent typing "=1+1" into an
// answer cannot turn the export into an active spreadsheet cell.
"use strict";

function csvCell(value) {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+@\t\r]/.test(text)) text = "'" + text;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",") + "\r\n";
}

// Builds the CSV body for a form's responses. `form` needs `questions`;
// `responses` are the stored response objects.
function responsesCsv(form, responses) {
  const header = ["submittedAt"];
  const seenLabels = new Map();
  for (const q of form.questions) {
    // Two questions may share a label; keep the columns distinguishable.
    seenLabels.set(q.label, (seenLabels.get(q.label) || 0) + 1);
    header.push(seenLabels.get(q.label) > 1 ? `${q.label} (${q.id})` : q.label);
  }
  const rows = [csvRow(header)];
  for (const response of [...responses].sort((a, b) =>
    String(a.submittedAt).localeCompare(String(b.submittedAt)),
  )) {
    const cells = [response.submittedAt];
    for (const q of form.questions) {
      cells.push(response.answers ? response.answers[q.id] : "");
    }
    rows.push(csvRow(cells));
  }
  return rows.join("");
}

module.exports = { responsesCsv, csvCell };