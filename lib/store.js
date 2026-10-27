// Durable store for form definitions and responses.
//
// Everything lives in two JSON files under DATA_DIR and every mutation is
// written straight through to disk (write to a temp file, then rename, so a
// crash mid-write can never leave a half-written store behind). On boot the
// files are read back; that restore path is covered by a test.
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
    this.forms = [];
    this.responses = [];
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    this.forms = readJson(this.formsFile, []);
    this.responses = readJson(this.responsesFile, []);
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

  addResponse(response) {
    this.responses.push(response);
    this.saveResponses();
    return response;
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
