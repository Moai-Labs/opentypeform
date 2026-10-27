// Persistence tests: what a store writes survives a restart, and an empty
// store is seeded with the starting template exactly once.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../lib/store");
const { seedIfNeeded, templateForm, TEMPLATE_SLUG } = require("../lib/seed");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "otf-store-"));
}

test("forms and responses written by one store are restored by a new store", () => {
  const dir = tmpDir();
  const first = new Store(dir);
  first.addForm({ slug: "hello", title: "Hello", published: true, questions: [] });
  first.addResponse({ id: "r1", formSlug: "hello", answers: { q1: "hi" }, submittedAt: "t" });

  // A restart: a fresh store instance over the same directory.
  const second = new Store(dir);
  assert.equal(second.getForm("hello").title, "Hello");
  assert.deepEqual(second.listResponses("hello"), [
    { id: "r1", formSlug: "hello", answers: { q1: "hi" }, submittedAt: "t" },
  ]);
});

test("restore keeps the write atomic even when interrupted", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "a", title: "A", published: true, questions: [] });
  // A crashed write leaves a temp file behind, never a corrupt store.
  fs.writeFileSync(path.join(dir, "forms.json.tmp"), "{ half-written");
  const restarted = new Store(dir);
  assert.equal(restarted.getForm("a").title, "A");
});

test("a corrupt store file fails loudly instead of wiping data", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "forms.json"), "{ not json");
  assert.throws(() => new Store(dir), /could not read/);
});

test("an empty store is seeded with the starting template once", () => {
  const dir = tmpDir();
  const first = new Store(dir);
  const seeded = seedIfNeeded(first);
  assert.ok(seeded, "expected the template to be seeded");
  assert.equal(seeded.slug, TEMPLATE_SLUG);
  assert.equal(seeded.published, true);
  assert.ok(seeded.questions.length >= 5, "template covers the question types");

  const second = new Store(dir);
  assert.equal(seedIfNeeded(second), null, "seeding must not duplicate on restart");
  assert.equal(second.listForms().length, 1);
});

test("deleting a form removes it and all of its responses", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "a", title: "A", published: true, questions: [] });
  store.addForm({ slug: "b", title: "B", published: true, questions: [] });
  store.addResponse({ id: "r1", formSlug: "a", answers: { q1: "x" }, submittedAt: "t" });
  store.addResponse({ id: "r2", formSlug: "b", answers: { q1: "y" }, submittedAt: "t" });

  assert.equal(store.countResponses("a"), 1);
  assert.ok(store.deleteForm("a"));
  assert.equal(store.getForm("a"), null);
  assert.deepEqual(store.listResponses("a"), []);
  assert.equal(store.countResponses("a"), 0);
  assert.equal(store.countResponses("b"), 1, "other forms keep their responses");

  // The deletion is durable.
  const restarted = new Store(dir);
  assert.equal(restarted.getForm("a"), null);
  assert.equal(restarted.listResponses("a").length, 0);
  assert.equal(restarted.countResponses("b"), 1);

  assert.equal(store.deleteForm("a"), false, "deleting twice changes nothing");
});

test("deleting every form does not bring the template back on restart", () => {
  const dir = tmpDir();
  const first = new Store(dir);
  assert.ok(seedIfNeeded(first), "first boot seeds");
  first.deleteForm(TEMPLATE_SLUG);
  assert.equal(first.listForms().length, 0);

  // A restart over an intentionally emptied store must stay empty.
  const second = new Store(dir);
  assert.equal(seedIfNeeded(second), null, "an initialized empty store stays empty");
  assert.equal(second.listForms().length, 0);
});

test("a populated store that predates the seed marker is adopted, not re-seeded", () => {
  const dir = tmpDir();
  // A store from before the marker existed: forms on disk, no meta flag.
  const first = new Store(dir);
  first.addForm({ slug: "old-form", title: "Old", published: true, questions: [] });
  assert.equal(first.getMeta("seeded"), undefined);

  const second = new Store(dir);
  assert.equal(seedIfNeeded(second), null, "an existing store gets no second template");
  assert.equal(second.listForms().length, 1, "the owner's form is untouched");
  assert.equal(second.getForm(TEMPLATE_SLUG), null);
  assert.equal(second.getMeta("seeded"), true, "the store is marked initialized");

  // The adoption is durable: a further restart neither seeds nor re-marks.
  const third = new Store(dir);
  assert.equal(seedIfNeeded(third), null);
  assert.equal(third.listForms().length, 1);
});

test("an interruption between seeding and its marker cannot duplicate the template", () => {
  const dir = tmpDir();
  // A crash after the seeded form was written but before the marker landed.
  const interrupted = new Store(dir);
  interrupted.addForm(templateForm());
  assert.equal(interrupted.getMeta("seeded"), undefined);

  const restarted = new Store(dir);
  assert.equal(seedIfNeeded(restarted), null, "the restart recognizes the seeded store");
  assert.equal(restarted.listForms().length, 1, "exactly one enquiry form exists");
  assert.equal(restarted.getForm(TEMPLATE_SLUG).title, "Client enquiry");

  // And the marker now covers the next restart too.
  const again = new Store(dir);
  assert.equal(seedIfNeeded(again), null);
  assert.equal(again.listForms().length, 1);
});
