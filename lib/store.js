// Durable store for form definitions and responses.
//
// Everything lives in JSON files under DATA_DIR and every mutation is
// written straight through to disk (write to a temp file, then rename, so a
// crash mid-write can never leave a half-written store behind). On boot the
// files are read back; that restore path is covered by a test. Deleting a
// form spans two files, so it goes through a small journal: the deletion is
// journalled first and boot finishes any interrupted deletion before the
// store is served (see finishInterruptedDeletions). A deletion whose writes
// fail midway keeps that journal pending and the store read-only — no
// mutation is accepted until the recovery succeeds (see ensureMutable).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function id() {
  return crypto.randomUUID();
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.formsFile = path.join(dir, "forms.json");
    this.responsesFile = path.join(dir, "responses.json");
    this.metaFile = path.join(dir, "meta.json");
    this.journalFile = path.join(dir, "delete-journal.json");
    this.forms = [];
    this.responses = [];
    this.meta = {};
    // The slug of a deletion whose journal is still on disk, if any. While
    // it is set the store refuses every mutation: see ensureMutable.
    this.pendingDeletion = null;
    // True when forms.json already existed on disk at load time: the store
    // predates this process, however many forms it holds now. Seeding uses
    // this to tell an initialized store — including one whose forms were
    // deliberately deleted — from a deployment booting for the first time.
    this.preexisting = false;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    this.preexisting = fs.existsSync(this.formsFile);
    this.forms = readJson(this.formsFile, []);
    this.responses = readJson(this.responsesFile, []);
    this.meta = readJson(this.metaFile, {});
    // Boot recovery for an interrupted deletion. If the recovery itself
    // cannot write (a full disk, a read-only mount), the journal stays on
    // disk and pendingDeletion keeps the store read-only: reads still
    // work, but every mutation is refused until the recovery succeeds — a
    // later mutation retries it first (see ensureMutable).
    this.finishInterruptedDeletions();
  }

  // No mutation may run while a deletion journal is unresolved. The journal
  // on disk still orders that deletion, so a form recreated under its slug
  // now would be destroyed by the recovery on the next boot, and a further
  // deletion would overwrite the pending journal. A mutation first retries
  // the recovery — a transient write failure clears here — and refuses
  // with an error when the journal still cannot be finished.
  ensureMutable() {
    if (!this.pendingDeletion) return;
    if (this.tryFinishPendingDeletion()) return;
    const err = new Error(
      `the deletion of "${this.pendingDeletion}" is still unresolved on disk; refusing writes until it is finished`,
    );
    err.code = "EDELETIONPENDING";
    throw err;
  }

  // Retry the interrupted deletion this process already knows about
  // (pendingDeletion). Returns true when the journal is finished and the
  // store is mutable again; false when the writes failed, leaving both the
  // journal and the in-memory collections as they were.
  tryFinishPendingDeletion() {
    const slug = this.pendingDeletion;
    if (!slug) return true;
    const savedForms = this.forms;
    const savedResponses = this.responses;
    this.forms = this.forms.filter((f) => f.slug !== slug);
    this.responses = this.responses.filter((r) => r.formSlug !== slug);
    try {
      this.saveForms();
      this.saveResponses();
    } catch {
      // The writes failed again: put the in-memory collections back, so a
      // read-only store still reports what is on disk, and leave the
      // journal pending.
      this.forms = savedForms;
      this.responses = savedResponses;
      return false;
    }
    fs.rmSync(this.journalFile, { force: true });
    this.pendingDeletion = null;
    return true;
  }

  // Small durable flags that live beside the data (used for the seed-once
  // marker, which must survive even when every form is deleted).
  getMeta(key) {
    return this.meta[key];
  }

  setMeta(key, value) {
    this.ensureMutable();
    this.meta[key] = value;
    this.writeJson(this.metaFile, this.meta);
  }

  // Replace the whole collection in one atomic write.
  writeJson(file, value) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  saveForms() {
    this.writeJson(this.formsFile, this.forms);
  }

  saveResponses() {
    this.writeJson(this.responsesFile, this.responses);
  }

  // --- forms ---

  listForms() {
    return this.forms;
  }

  getForm(slug) {
    return this.forms.find((f) => f.slug === slug) || null;
  }

  slugTaken(slug) {
    return this.forms.some((f) => f.slug === slug);
  }

  addForm(form) {
    this.ensureMutable();
    this.forms.push(form);
    this.saveForms();
    return form;
  }

  replaceForm(slug, form) {
    this.ensureMutable();
    const i = this.forms.findIndex((f) => f.slug === slug);
    if (i === -1) return null;
    this.forms[i] = form;
    this.saveForms();
    return form;
  }

  // --- responses ---

  listResponses(slug) {
    return this.responses.filter((r) => r.formSlug === slug);
  }

  countResponses(slug) {
    return this.responses.reduce((n, r) => (r.formSlug === slug ? n + 1 : n), 0);
  }

  addResponse(response) {
    this.ensureMutable();
    this.responses.push(response);
    this.saveResponses();
    return response;
  }

  // Removes a form and every response it collected. Returns false when the
  // slug was already gone, so nothing was written.
  //
  // The form and its responses live in two files, and a crash between their
  // writes must not leave the form deleted while its responses survive — a
  // form recreated under the same slug would then expose them. So the
  // deletion is journalled before either file is touched: an interruption
  // anywhere in here is finished by finishInterruptedDeletions on the next
  // boot, before the server can serve or the slug can be recreated.
  deleteForm(slug) {
    this.ensureMutable();
    if (!this.slugTaken(slug)) return false;
    this.writeJson(this.journalFile, { slug, startedAt: new Date().toISOString() });
    // From here the deletion is journalled. If any write below fails, the
    // journal on disk still orders the deletion and pendingDeletion keeps
    // the store read-only (ensureMutable): a replacement form cannot be
    // created onto a slug the journal will delete, and a further deletion
    // cannot overwrite the pending journal.
    this.pendingDeletion = slug;
    const savedForms = this.forms;
    const savedResponses = this.responses;
    this.forms = this.forms.filter((f) => f.slug !== slug);
    this.responses = this.responses.filter((r) => r.formSlug !== slug);
    try {
      this.saveForms();
      this.saveResponses();
    } catch (err) {
      // A write failed: the journal on disk still orders the deletion, but
      // the collections go back to what was there before, so reads report
      // the store that actually exists until the recovery finishes.
      this.forms = savedForms;
      this.responses = savedResponses;
      throw err;
    }
    fs.rmSync(this.journalFile, { force: true });
    this.pendingDeletion = null;
    return true;
  }

  // Boot recovery for deleteForm. Idempotent: re-filtering an already
  // applied deletion changes nothing, so finishing the write that was
  // interrupted and dropping the journal leaves the store consistent.
  finishInterruptedDeletions() {
    const journal = readJson(this.journalFile, null);
    if (!journal || !journal.slug) return;
    this.pendingDeletion = journal.slug;
    this.tryFinishPendingDeletion();
  }

  // Attaches a question schema to every response of a form that is still
  // missing one, durably. Used before an edit changes a form's questions:
  // the pre-edit definition is the schema those answers were actually
  // collected under, and attaching it keeps them identifiable under their
  // original labels after the edit (public/columns.js).
  backfillSchemas(slug, schema) {
    this.ensureMutable();
    const snapshot = (schema || []).map(({ id, label }) => ({ id, label }));
    let changed = false;
    for (const r of this.responses) {
      if (r.formSlug === slug && !r.schema) {
        r.schema = snapshot;
        changed = true;
      }
    }
    if (changed) this.saveResponses();
    return changed;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    // A corrupt store is a real problem: crash loudly rather than start over
    // on top of data we could not read.
    throw new Error(`could not read ${file}: ${err.message}`);
  }
}

module.exports = { Store, id, readJson };
