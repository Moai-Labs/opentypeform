// DOM-level tests for the dashboard page: the owner can reach the New form
// button, open a form's responses, and export them as CSV — including
// answers collected by questions that were later removed. Runs the real
// public/dashboard.js in a minimal DOM (test/fake-dom.js).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDocument, runPage, tick } = require("./fake-dom");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "dashboard.js"), "utf8");
const columnsSource = fs.readFileSync(path.join(__dirname, "..", "public", "columns.js"), "utf8");

function jsonResponse(status, body) {
  return { status, ok: status < 400, json: async () => body };
}

const form = () => ({
  slug: "client-enquiry",
  title: "Client enquiry",
  published: true,
  responseCount: 2,
  questions: [
    { id: "q1", type: "text", label: "What's your name?", required: true },
    { id: "q2", type: "text", label: "What's the project?" },
  ],
});

// Two responses: the second one answers a question that has since been
// removed from the form, and carries the schema it was collected under.
const responses = () => [
  {
    id: "r1",
    submittedAt: "2026-10-27T10:00:00Z",
    schema: [
      { id: "q1", label: "What's your name?" },
      { id: "q2", label: "What's the project?" },
    ],
    answers: { q1: "Ada Lovelace", q2: "A small website." },
  },
  {
    id: "r2",
    submittedAt: "2026-10-27T11:00:00Z",
    schema: [
      { id: "q1", label: "What's your name?" },
      { id: "q2", label: "What's the project?" },
      { id: "q3", label: "What's your budget, in USD?" },
    ],
    answers: { q1: "Grace Hopper", q2: "A compiler.", q3: 5000 },
  },
];

function boot() {
  const { document, app } = createDocument();
  const calls = [];
  const fetchStub = async (path, options) => {
    calls.push({ path, options: options || null });
    if (path === "/api/me") {
      return jsonResponse(200, { email: "owner@example.com", plan: { tier: "free", used: 4, limit: 25 } });
    }
    if (path === "/api/forms") return jsonResponse(200, [form()]);
    if (path === "/api/forms/client-enquiry") return jsonResponse(200, form());
    if (path === "/api/forms/client-enquiry/responses") return jsonResponse(200, responses());
    throw new Error(`unexpected fetch: ${path}`);
  };
  runPage(source, { document, fetch: fetchStub, preludes: [columnsSource] });
  return { app, calls };
}

async function settle(times = 2) {
  for (let i = 0; i < times; i++) await tick();
}

const findByText = (nodes, text) => nodes.find((n) => n.textContent === text);

test("the dashboard lists forms with every row control attached", async () => {
  const { app } = boot();
  await settle();

  assert.ok(app.querySelector("h1"), "the list heading renders as a heading");
  assert.ok(findByText(app.querySelectorAll("button"), "New form"), "the New form button exists");
  for (const label of ["Responses", "Edit", "Unpublish", "Delete"]) {
    assert.ok(findByText(app.querySelectorAll("button"), label), `the ${label} control exists`);
  }
});

test("opening a form shows its responses and a working CSV export", async () => {
  const { app } = boot();
  await settle();

  findByText(app.querySelectorAll("button"), "Responses").emit("click");
  await settle(3);

  assert.ok(findByText(app.querySelectorAll("h1"), "Client enquiry"), "the form's page opens");

  // The response-view toolbar has every control, export included.
  const exportLink = findByText(app.querySelectorAll("a"), "Export CSV");
  assert.ok(exportLink, "the export control exists");
  assert.equal(exportLink.href, "/api/forms/client-enquiry/responses.csv");
  for (const label of ["Copy share link", "Unpublish", "Edit form", "Delete form"]) {
    assert.ok(findByText(app.querySelectorAll("button"), label), `the ${label} control exists`);
  }

  // The table keeps a column for a question that was removed after the
  // answer came in, under the label it was asked with.
  const headers = app.querySelectorAll("th").map((th) => th.textContent);
  assert.deepEqual(headers, [
    "Submitted",
    "What's your name?",
    "What's the project?",
    "What's your budget, in USD?",
  ]);
  const rows = app.querySelectorAll("tbody tr");
  assert.equal(rows.length, 2);
  const lastCells = rows[1].querySelectorAll("td").map((td) => td.textContent);
  assert.deepEqual(lastCells, ["2026-10-27 11:00", "Grace Hopper", "A compiler.", "5000"]);
});
