// DOM-level tests for the builder page: a fresh visitor builds a form from
// the template and saves it, question controls are attached and usable, and
// question ids stay stable across edits and saves. Runs the real
// public/builder.js in a minimal DOM (test/fake-dom.js).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDocument, runPage, tick } = require("./fake-dom");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "builder.js"), "utf8");

const template = () => ({
  title: "Client enquiry",
  description: "A short enquiry form.",
  questions: [
    { id: "q1", type: "text", label: "What's your name?", required: true },
    { id: "q2", type: "email", label: "What's the best email to reach you?", required: true },
    { id: "q3", type: "choice", label: "What do you need help with?", options: ["Strategy", "Design"] },
    { id: "q4", type: "number", label: "What's your budget, in USD?" },
    { id: "q5", type: "text", label: "Tell us a little about the project.", multiline: true },
    { id: "q6", type: "rating", label: "How urgent is this?", max: 5 },
  ],
});

// Boots the builder at a given ?form= slug with a scripted API.
function boot({ search = "", form = null, template: tpl = template(), navigator: nav } = {}) {
  const { document, app } = createDocument();
  const location = { search, href: "", origin: "http://localhost" };
  const calls = [];
  const fetchStub = async (pathArg, options) => {
    calls.push({ path: pathArg, options: options || null });
    if (pathArg === "/api/template") return jsonResponse(200, tpl);
    if (form && pathArg === `/api/forms/${form.slug}` && (!options || !options.method)) {
      return jsonResponse(200, form);
    }
    if (pathArg === "/api/forms" && options && options.method === "POST") {
      return jsonResponse(201, { slug: "client-enquiry", ...JSON.parse(options.body) });
    }
    if (options && options.method === "PUT") {
      return jsonResponse(200, { ...form, ...JSON.parse(options.body) });
    }
    throw new Error(`unexpected fetch: ${options ? options.method || "GET" : "GET"} ${pathArg}`);
  };
  runPage(source, { document, fetch: fetchStub, location, navigator: nav });
  return { app, location, calls };
}

function jsonResponse(status, body) {
  return { status, ok: status < 400, json: async () => body };
}

const findByText = (nodes, text) => nodes.find((n) => n.textContent === text);

async function settle(times = 2) {
  for (let i = 0; i < times; i++) await tick();
}

test("a visitor builds a form from the template and saves it", async () => {
  const tpl = template();
  const { app, location, calls } = boot();
  await settle();

  // The start screen offers the template.
  const startBtn = findByText(app.querySelectorAll("button"), "Start from the enquiry template");
  assert.ok(startBtn, "the template button exists");
  startBtn.emit("click");
  await settle();

  // Every question card carries its label input and type select.
  const cards = app.querySelectorAll(".questions .qcard");
  assert.equal(cards.length, tpl.questions.length);
  for (const card of cards) {
    assert.ok(card.querySelector("input"), "each question has its label input");
    assert.ok(card.querySelector("select"), "each question has its type select");
  }

  // The toolbar's create button is attached and works.
  const save = findByText(app.querySelectorAll("button"), "Create form");
  assert.ok(save, "the create button exists");

  const title = app.querySelector("input");
  title.value = "Client enquiry";
  title.emit("input");
  save.emit("click");
  await settle();

  const posted = calls.find((c) => c.options && c.options.method === "POST");
  assert.ok(posted, "the form was posted to the owner API");
  const body = JSON.parse(posted.options.body);
  assert.equal(body.title, "Client enquiry");
  assert.deepEqual(
    body.questions.map((q) => q.label),
    tpl.questions.map((q) => q.label),
  );
  assert.ok(body.questions.every((q) => /^[A-Za-z0-9_-]+$/.test(q.id)), "every question has an id");
  assert.equal(location.href, "/builder?form=client-enquiry", "the builder follows the saved form");
});

const existingForm = () => ({
  slug: "client-enquiry",
  title: "Client enquiry",
  published: false,
  questions: [
    { id: "q1", type: "text", label: "What's your name?", required: true },
    { id: "q2", type: "email", label: "What's the best email to reach you?", required: true },
  ],
});

function addQuestion(app, type) {
  const add = app.querySelectorAll("select").find((s) =>
    s.textContent.includes("+ Add a question"),
  );
  assert.ok(add, "the add-question select exists");
  add.value = type;
  add.emit("change");
}

const putBodies = (calls) =>
  calls
    .filter((c) => c.options && c.options.method === "PUT")
    .map((c) => JSON.parse(c.options.body));

test("a new question moved before an existing one never steals its id", async () => {
  const { app, calls } = boot({ search: "?form=client-enquiry", form: existingForm() });
  await settle();

  addQuestion(app, "text");
  await tick();

  // Move the new (still untitled) question to the top.
  let cards = app.querySelectorAll(".questions .qcard");
  assert.equal(cards.length, 3);
  findByText(cards[2].querySelectorAll("button"), "↑ Up").emit("click");
  await tick();
  cards = app.querySelectorAll(".questions .qcard");
  findByText(cards[1].querySelectorAll("button"), "↑ Up").emit("click");
  await tick();

  cards = app.querySelectorAll(".questions .qcard");
  assert.equal(cards[0].querySelector("input").value === "", true, "the new question sits first");

  findByText(app.querySelectorAll("button"), "Save changes").emit("click");
  await settle();

  const [body] = putBodies(calls);
  const fresh = body.questions[0].id;
  assert.doesNotMatch(fresh, /^q\d+$/, "the new question carries its own creation-time id");
  assert.equal(body.questions[1].id, "q1", "the existing question keeps its id");
  assert.equal(body.questions[1].label, "What's your name?");
  assert.equal(body.questions[2].id, "q2");
});

test("a removed question's id is never reused, across repeated saves", async () => {
  const form = existingForm();
  const { app, calls } = boot({ search: "?form=client-enquiry", form });
  await settle();

  // Remove q1, add a fresh question, save.
  let cards = app.querySelectorAll(".questions .qcard");
  findByText(cards[0].querySelectorAll("button"), "Remove").emit("click");
  await tick();
  addQuestion(app, "text");
  await tick();
  findByText(app.querySelectorAll("button"), "Save changes").emit("click");
  await settle();

  const [first] = putBodies(calls);
  assert.ok(!first.questions.some((q) => q.id === "q1"), "the removed id stays retired");
  assert.equal(first.questions[0].id, "q2", "the surviving question keeps its id");
  assert.doesNotMatch(first.questions[1].id, /^q\d+$/, "the added question has its creation-time id");

  // The editor hydrates from the save response; a further remove/add cycle
  // still cannot take a retired id.
  cards = app.querySelectorAll(".questions .qcard");
  findByText(cards[0].querySelectorAll("button"), "Remove").emit("click");
  await tick();
  addQuestion(app, "text");
  await tick();
  findByText(app.querySelectorAll("button"), "Save changes").emit("click");
  await settle();

  const [, second] = putBodies(calls);
  assert.ok(!second.questions.some((q) => q.id === "q1"), "still no reuse after a reload-free save");
  const ids = second.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, "ids stay unique");
  assert.ok(app.querySelector("p.saved"), "the save is acknowledged");

  // The published row (share link, publish toggle) is attached once saved.
  assert.ok(app.querySelector("input.share"), "the share link is showing");
  assert.ok(findByText(app.querySelectorAll("button"), "Copy share link"));
  assert.ok(findByText(app.querySelectorAll("button"), "Publish"));
});

test("the share link shows its URL and copies that exact string", async () => {
  let copied = null;
  const navigator = { clipboard: { writeText: async (t) => (copied = t) } };
  const { app } = boot({ search: "?form=client-enquiry", form: existingForm(), navigator });
  await settle();

  const share = app.querySelector("input.share");
  assert.ok(share, "the share input exists");
  assert.equal(share.value, "http://localhost/f/client-enquiry", "the input carries the share URL");

  const copy = findByText(app.querySelectorAll("button"), "Copy share link");
  copy.emit("click");
  await settle();
  assert.equal(copied, "http://localhost/f/client-enquiry", "the clipboard gets the share URL");
  assert.equal(copy.textContent, "Copied");
});

test("a removed question's id is never reused after the editor is reopened", async () => {
  // Session one: remove q1 and save.
  const first = boot({ search: "?form=client-enquiry", form: existingForm() });
  await settle();
  let cards = first.app.querySelectorAll(".questions .qcard");
  findByText(cards[0].querySelectorAll("button"), "Remove").emit("click");
  await tick();
  findByText(first.app.querySelectorAll("button"), "Save changes").emit("click");
  await settle();
  const saved = putBodies(first.calls)[0];
  assert.ok(!saved.questions.some((q) => q.id === "q1"));

  // The owner reopens the builder on what the server now stores; the
  // retired set from the first session is gone.
  const reloaded = { ...existingForm(), questions: saved.questions };
  const second = boot({ search: "?form=client-enquiry", form: reloaded });
  await settle();

  // Add a question with exactly the removed question's label.
  addQuestion(second.app, "text");
  await tick();
  cards = second.app.querySelectorAll(".questions .qcard");
  const label = cards[cards.length - 1].querySelector(".qhead input");
  label.value = "What's your name?";
  label.emit("input");
  findByText(second.app.querySelectorAll("button"), "Save changes").emit("click");
  await settle();

  const [body] = putBodies(second.calls);
  const added = body.questions[body.questions.length - 1];
  assert.equal(added.label, "What's your name?", "the same-label question was added");
  assert.notEqual(added.id, "q1", "its id differs from the removed question's id");
  assert.ok(body.questions.every((q) => q.id !== "q1"), "the removed id is never handed out again");
});
