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
  assert.equal(csvCell("-1+1"), "'-1+1", "minus-prefixed arithmetic is defused too");
  assert.equal(csvCell("-cmd"), "'-cmd");
  assert.equal(csvCell("-5"), "-5", "negative numbers stay numbers");
  assert.equal(csvCell("-5.5"), "-5.5");
  assert.equal(csvCell("-1.2e3"), "-1.2e3");
  assert.equal(csvCell("- 5"), "'- 5", "a minus sign alone is not a number");
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

test("answers survive removing or relabelling their question", () => {
  const current = {
    questions: [
      { id: "q1", label: "Name?" },
      { id: "q2", label: "What's the project?" },
    ],
  };
  const responses = [
    {
      submittedAt: "2026-10-27T10:00:00Z",
      // Collected while the form still had the budget question.
      schema: [
        { id: "q1", label: "Name?" },
        { id: "q2", label: "What's the project?" },
        { id: "q3", label: "Budget?" },
      ],
      answers: { q1: "Ada", q2: "A website", q3: 5000 },
    },
  ];

  // The removed question's answers still export, under their own label.
  const csv = responsesCsv(current, responses);
  const lines = csv.split("\r\n");
  assert.deepEqual(lines, [
    "submittedAt,Name?,What's the project?,Budget?",
    "2026-10-27T10:00:00Z,Ada,A website,5000",
    "",
  ]);

  // A relabelled question keeps its history in its own column, so old
  // answers are not presented as answers to the new wording.
  const relabelled = {
    questions: [
      { id: "q1", label: "Name?" },
      { id: "q2", label: "What are you building?" },
    ],
  };
  const relabelledCsv = responsesCsv(relabelled, responses);
  assert.ok(relabelledCsv.includes("What are you building?"), "the new label is a column");
  assert.ok(relabelledCsv.includes("What's the project?"), "the old label keeps its column");
  const relabelledLines = relabelledCsv.split("\r\n");
  assert.deepEqual(relabelledLines, [
    "submittedAt,Name?,What are you building?,What's the project?,Budget?",
    "2026-10-27T10:00:00Z,Ada,,A website,5000",
    "",
  ]);

  // Responses stored before schemas existed still map by question id.
  const legacy = responsesCsv(current, [
    { submittedAt: "2026-10-27T09:00:00Z", answers: { q1: "Grace" } },
  ]);
  assert.match(legacy, /Grace/);
});

test("an answer its own schema omits keeps its own column even when another schema names the id", () => {
  // The form no longer has the email question. One response was collected
  // while it did, so its schema records it; a legacy response backfilled
  // after the removal still carries its answer, but the schema it was
  // backfilled with no longer names the id. That answer must not be
  // folded into the recorded column — it was asked under another version
  // of the question — nor hidden by it.
  const current = { questions: [{ id: "q1", label: "Name?" }] };
  const responses = [
    {
      submittedAt: "2026-10-27T09:00:00Z",
      schema: [
        { id: "q1", label: "Name?" },
        { id: "q2", label: "Email?" },
      ],
      answers: { q1: "B", q2: "b@example.com" },
    },
    {
      submittedAt: "2026-10-27T10:00:00Z",
      schema: [{ id: "q1", label: "Name?" }],
      answers: { q1: "L", q2: "l@example.com" },
    },
  ];
  const csv = responsesCsv(current, responses);
  const lines = csv.split("\r\n");
  assert.deepEqual(lines, [
    "submittedAt,Name?,Email?,q2",
    "2026-10-27T09:00:00Z,B,b@example.com,",
    "2026-10-27T10:00:00Z,L,,l@example.com",
    "",
  ]);
});
