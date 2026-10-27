// Persistence tests: what a store writes survives a restart, and an empty
// store is seeded with the starting template exactly once.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../lib/store");
const { seedIfNeeded, TEMPLATE_SLUG } = require("../lib/seed");

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
