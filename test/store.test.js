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

test("monthly usage is charged on acceptance and survives deleting its form", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "f", title: "F", ownerAccountId: "acc1", published: true, questions: [] });

  // No usage has been charged yet, and nothing derived is remembered.
  assert.equal(store.monthlyUsage("acc1", "2026-10", "2026-10-01T00:00:00.000Z"), 0);

  // Two accepted responses charge two.
  store.chargeMonthly("acc1", "2026-10");
  store.chargeMonthly("acc1", "2026-10");
  assert.equal(store.monthlyUsage("acc1", "2026-10", "2026-10-01T00:00:00.000Z"), 2);

  // Deleting the form and its responses does not restore the allowance.
  store.deleteForm("f");
  assert.equal(store.monthlyUsage("acc1", "2026-10", "2026-10-01T00:00:00.000Z"), 2);

  // A restart keeps the charged count.
  const second = new Store(dir);
  assert.equal(second.monthlyUsage("acc1", "2026-10", "2026-10-01T00:00:00.000Z"), 2);

  // A new month expires the old count.
  assert.equal(second.monthlyUsage("acc1", "2026-11", "2026-11-01T00:00:00.000Z"), 0);
});

test("usage migrates from responses a store collected before it kept usage", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  // A store from before usage.json existed: responses on disk, no usage
  // record. The derived count is the truth and must still enforce.
  store.addForm({ slug: "f", title: "F", ownerAccountId: "acc1", published: true, questions: [] });
  store.addResponse({ id: "r1", formSlug: "f", answers: { q1: "a" }, submittedAt: "2026-10-14T10:00:00.000Z" });
  store.addResponse({ id: "r2", formSlug: "f", answers: { q1: "b" }, submittedAt: "2026-10-15T10:00:00.000Z" });
  store.addResponse({ id: "r3", formSlug: "f", answers: { q1: "c" }, submittedAt: "2026-09-30T23:59:59.000Z" });
  delete store.usage; // pretend the record never existed
  store.loadUsage();

  assert.equal(store.monthlyUsage("acc1", "2026-10", "2026-10-01T00:00:00.000Z"), 2, "only this month's responses count");

  // A restart over the same directory derives the same count again.
  const second = new Store(dir);
  assert.equal(second.monthlyUsage("acc1", "2026-10", "2026-10-01T00:00:00.000Z"), 2);
});

test("a crash between the response write and the usage write heals, not undercounts", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "f", title: "F", ownerAccountId: "acc1", published: true, questions: [] });

  // One response was accepted and charged; the next one got its response
  // written but the usage write for it was lost in a crash.
  store.chargeMonthly("acc1", "2026-10");
  store.addResponse({ id: "r1", formSlug: "f", answers: { q1: "a" }, submittedAt: "2026-10-14T10:00:00.000Z" });
  store.addResponse({ id: "r2", formSlug: "f", answers: { q1: "b" }, submittedAt: "2026-10-15T10:00:00.000Z" });
  store.usage.acc1 = { month: "2026-10", count: 1 };
  store.saveUsage();

  assert.equal(store.monthlyUsage("acc1", "2026-10", "2026-10-01T00:00:00.000Z"), 2, "the derived count fills the gap");
});
