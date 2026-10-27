// Unit tests for CSV export formatting and escaping.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { responsesCsv, csvCell } = require("../lib/csv");

const form = () => ({
  questions: [
    { id: "q1", type: "text", label: "Name?" },
    { id: "q2", type: "rating", label: "Rating" },
  ],
});

test("csvCell escapes separators, quotes and newlines", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(5), "5");
});

test("cells a spreadsheet would treat as formulas are defused", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+sum"), "'+sum");
  assert.equal(csvCell("@x"), "'@x");
  assert.equal(csvCell("-5"), "-5", "negative numbers stay numbers");
  assert.equal(csvCell("totally=fine"), "totally=fine");
});

test("responsesCsv writes one row per response in submission order", () => {
  const responses = [
    { submittedAt: "2026-10-27T10:00:00Z", answers: { q1: "Later" } },
    { submittedAt: "2026-10-27T09:00:00Z", answers: { q1: "Earlier", q2: 4 } },
  ];
  const csv = responsesCsv(form(), responses);
  const lines = csv.split("\r\n");
  assert.deepEqual(lines, [
    "submittedAt,Name?,Rating",
    "2026-10-27T09:00:00Z,Earlier,4",
    "2026-10-27T10:00:00Z,Later,",
    "",
  ]);
});

test("duplicate question labels stay distinguishable in the header", () => {
  const csv = responsesCsv(
    { questions: [{ id: "q1", label: "Same" }, { id: "q2", label: "Same" }] },
    [],
  );
  assert.ok(csv.startsWith("submittedAt,Same,Same (q2)"));
});