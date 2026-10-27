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

test("an intentionally emptied store that predates the marker is not re-seeded", () => {
  const dir = tmpDir();
  // A store from before the marker existed whose owner deleted every form:
  // forms.json is on disk and empty, and no meta flag was ever written.
  fs.writeFileSync(path.join(dir, "forms.json"), "[]\n");

  const first = new Store(dir);
  assert.equal(first.preexisting, true, "an existing forms.json marks the store pre-existing");
  assert.equal(seedIfNeeded(first), null, "an existing empty store gets no template");
  assert.equal(first.listForms().length, 0);
  assert.equal(first.getMeta("seeded"), true, "the store is marked initialized");

  // The decision is durable: a further restart neither seeds nor re-marks.
  const second = new Store(dir);
  assert.equal(seedIfNeeded(second), null);
  assert.equal(second.listForms().length, 0);
});

test("a brand-new store is still recognized as new and seeded", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  assert.equal(store.preexisting, false, "no forms.json means a fresh store");
  const seeded = seedIfNeeded(store);
  assert.ok(seeded, "a fresh store is seeded");
  assert.equal(seeded.slug, TEMPLATE_SLUG);
});

test("an interruption between the two writes of a deletion is finished on boot", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "a", title: "A", published: true, questions: [] });
  store.addForm({ slug: "b", title: "B", published: true, questions: [] });
  store.addResponse({ id: "r1", formSlug: "a", answers: { q1: "x" }, submittedAt: "t" });
  store.addResponse({ id: "r2", formSlug: "b", answers: { q1: "y" }, submittedAt: "t" });

  // Crash right after forms.json was rewritten: the deletion journal and
  // the form-less forms file are on disk, but responses.json still holds
  // every response, including form a's.
  const crashing = new Store(dir);
  crashing.saveResponses = () => {
    throw new Error("crash between the two writes");
  };
  assert.throws(() => crashing.deleteForm("a"), /crash between the two writes/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "responses.json"), "utf8")).length, 2);
  assert.ok(fs.existsSync(path.join(dir, "delete-journal.json")), "the deletion is journalled");

  // The next boot finishes the interrupted deletion before anything else.
  const restarted = new Store(dir);
  assert.equal(restarted.getForm("a"), null);
  assert.deepEqual(restarted.listResponses("a"), [], "no deleted response survives");
  assert.equal(restarted.countResponses("b"), 1, "other forms keep their responses");
  assert.ok(!fs.existsSync(path.join(dir, "delete-journal.json")), "the journal is cleared");

  // Recreating the slug finds no old responses waiting under it.
  restarted.addForm({ slug: "a", title: "A again", published: true, questions: [] });
  assert.deepEqual(restarted.listResponses("a"), []);
  assert.equal(restarted.countResponses("a"), 0);
});

test("an interruption before the first write of a deletion is finished on boot", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "a", title: "A", published: true, questions: [] });
  store.addResponse({ id: "r1", formSlug: "a", answers: { q1: "x" }, submittedAt: "t" });

  // Crash after the journal landed but before either data file was written.
  const crashing = new Store(dir);
  crashing.saveForms = () => {
    throw new Error("crash before the first write");
  };
  assert.throws(() => crashing.deleteForm("a"), /crash before the first write/);

  const restarted = new Store(dir);
  assert.equal(restarted.getForm("a"), null, "the journalled deletion is completed");
  assert.deepEqual(restarted.listResponses("a"), []);
});

test("a failed deletion write blocks mutations until the journal is finished", () => {
  const dir = tmpDir();
  const store = new Store(dir);
  store.addForm({ slug: "a", title: "A", published: true, questions: [] });
  store.addForm({ slug: "b", title: "B", published: true, questions: [] });
  store.addResponse({ id: "r1", formSlug: "a", answers: { q1: "x" }, submittedAt: "t" });

  // The forms write fails mid-deletion: the journal is left pending with
  // the server still running, and neither data file was touched.
  const failing = new Store(dir);
  failing.saveForms = () => {
    throw new Error("disk full");
  };
  assert.throws(() => failing.deleteForm("a"), /disk full/);
  assert.equal(failing.pendingDeletion, "a", "the journal stays pending in memory too");
  assert.equal(failing.getForm("a").title, "A", "reads still report the form on disk");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "forms.json"), "utf8")).length,
    2,
    "forms.json on disk is untouched",
  );

  // Recreation under the still-occupied slug is refused while the journal
  // is unresolved: the mutation first retries the recovery, which fails
  // again, and nothing slips through either way.
  assert.throws(
    () => failing.addForm({ slug: "a", title: "A again", published: true, questions: [] }),
    /unresolved/,
  );
  assert.equal(failing.getForm("a").title, "A", "no replacement was created");

  // A further deletion is refused as well: it must not overwrite the
  // pending journal.
  assert.throws(() => failing.deleteForm("b"), /unresolved/);
  const journal = JSON.parse(fs.readFileSync(path.join(dir, "delete-journal.json"), "utf8"));
  assert.equal(journal.slug, "a", "the journal still names the original deletion");

  // With the writes working again, the next mutation finishes the pending
  // deletion first, and what it then accepts survives a reload.
  delete failing.saveForms;
  failing.addForm({ slug: "a", title: "A again", published: true, questions: [] });
  assert.equal(failing.pendingDeletion, null, "the recovery completed");
  assert.ok(!fs.existsSync(path.join(dir, "delete-journal.json")), "the journal is cleared");

  const reloaded = new Store(dir);
  assert.equal(reloaded.getForm("a").title, "A again", "the replacement survives the reload");
  assert.deepEqual(reloaded.listResponses("a"), [], "no deleted response rides along");
  assert.equal(reloaded.getForm("b").title, "B", "the unrelated form is untouched");
});

test("a store whose boot recovery fails comes up read-only, then recovers with the next mutation", () => {
  const dir = tmpDir();
  const setup = new Store(dir);
  setup.addForm({ slug: "a", title: "A", published: true, questions: [] });
  setup.addResponse({ id: "r1", formSlug: "a", answers: { q1: "x" }, submittedAt: "t" });
  // An interrupted deletion: the journal is on disk, the data files are
  // untouched.
  setup.writeJson(setup.journalFile, { slug: "a", startedAt: "t" });

  // Boot recovery cannot write, so the journal stays pending; the store
  // must come up anyway (reads work) but accept no mutation on top of it.
  const original = Store.prototype.saveForms;
  Store.prototype.saveForms = () => {
    throw new Error("read-only volume");
  };
  let locked;
  try {
    locked = new Store(dir);
  } finally {
    Store.prototype.saveForms = original;
  }
  assert.equal(locked.pendingDeletion, "a", "the failed recovery leaves the journal pending");
  assert.equal(locked.getForm("a").title, "A", "reads still work");

  // While the writes keep failing, every mutation is refused: the
  // recovery retry hits the same error and nothing else is attempted.
  locked.saveForms = () => {
    throw new Error("still read-only");
  };
  assert.throws(
    () => locked.addForm({ slug: "c", title: "C", published: true, questions: [] }),
    /unresolved/,
  );
  assert.throws(
    () => locked.addResponse({ id: "r2", formSlug: "a", answers: { q1: "y" }, submittedAt: "t" }),
    /unresolved/,
  );
  assert.throws(() => locked.deleteForm("a"), /unresolved/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "forms.json"), "utf8")).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "delete-journal.json"), "utf8")).slug, "a");

  // Writes work again: the next mutation finishes the pending deletion
  // first, and its result survives a reload.
  delete locked.saveForms;
  locked.addForm({ slug: "c", title: "C", published: true, questions: [] });
  const reloaded = new Store(dir);
  assert.equal(reloaded.getForm("a"), null, "the journalled deletion is completed");
  assert.deepEqual(reloaded.listResponses("a"), []);
  assert.equal(reloaded.getForm("c").title, "C");
  assert.ok(!fs.existsSync(path.join(dir, "delete-journal.json")));
});
