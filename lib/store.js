// Durable store for form definitions and responses.
//
// Everything lives in JSON files under DATA_DIR and every mutation is
// written straight through to disk (write to a temp file, then rename, so a
// crash mid-write can never leave a half-written store behind). On boot the
// files are read back; that restore path is covered by a test. Deleting a
// form spans two files, so it goes through a small journal: the deletion is
// journalled first and boot finishes any interrupted deletion before the
// store is served (see finishInterruptedDeletions).
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
    this.finishInterruptedDeletions();
  }

  // Small durable flags that live beside the data (used for the seed-once
  // marker, which must survive even when every form is deleted).
  getMeta(key) {
    return this.meta[key];
  }

  setMeta(key, value) {
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
    this.forms.push(form);
    this.saveForms();
    return form;
  }

  replaceForm(slug, form) {
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
    if (!this.slugTaken(slug)) return false;
    this.writeJson(this.journalFile, { slug, startedAt: new Date().toISOString() });
    this.forms = this.forms.filter((f) => f.slug !== slug);
    this.responses = this.responses.filter((r) => r.formSlug !== slug);
    this.saveForms();
    this.saveResponses();
    fs.rmSync(this.journalFile, { force: true });
    return true;
  }

  // Boot recovery for deleteForm. Idempotent: re-filtering an already
  // applied deletion changes nothing, so finishing the write that was
  // interrupted and dropping the journal leaves the store consistent.
  finishInterruptedDeletions() {
    const journal = readJson(this.journalFile, null);
    if (!journal || !journal.slug) return;
    this.forms = this.forms.filter((f) => f.slug !== journal.slug);
    this.responses = this.responses.filter((r) => r.formSlug !== journal.slug);
    this.saveForms();
    this.saveResponses();
    fs.rmSync(this.journalFile, { force: true });
  }

  // Attaches a question schema to every response of a form that is still
  // missing one, durably. Used before an edit changes a form's questions:
  // the pre-edit definition is the schema those answers were actually
  // collected under, and attaching it keeps them identifiable under their
  // original labels after the edit (public/columns.js).
  backfillSchemas(slug, schema) {
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
