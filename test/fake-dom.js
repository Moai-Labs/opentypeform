// A minimal DOM for testing the plain-JavaScript owner pages (builder.js,
// dashboard.js) in Node — just the element APIs those scripts use, plus a
// vm sandbox to run a page's source in. No dependencies on purpose.
"use strict";

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.listeners = Object.create(null);
    this.className = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.readOnly = false;
    this.type = "";
    this.placeholder = "";
    this.href = "";
    this.min = "";
    this.max = "";
    const self = this;
    this.classList = {
      add: (c) => self.setClasses(new Set([...self.classes(), c])),
      remove: (c) => {
        const s = self.classes();
        s.delete(c);
        self.setClasses(s);
      },
      contains: (c) => self.classes().has(c),
    };
  }

  classes() {
    return new Set((this.className || "").split(/\s+/).filter(Boolean));
  }

  setClasses(set) {
    this.className = [...set].join(" ");
  }

  get textContent() {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }

  set textContent(text) {
    this.replaceChildren();
    if (text !== undefined && text !== null) this.append(String(text));
  }

  append(...kids) {
    for (const kid of kids) {
      if (kid === null || kid === undefined) continue;
      if (typeof kid === "string") {
        this.children.push(kid);
        continue;
      }
      if (kid.parentNode) kid.parentNode.children.splice(kid.parentNode.children.indexOf(kid), 1);
      kid.parentNode = this;
      this.children.push(kid);
    }
  }

  replaceChildren(...kids) {
    for (const c of this.children) if (typeof c !== "string") c.parentNode = null;
    this.children = [];
    this.append(...kids);
  }

  before(node) {
    const p = this.parentNode;
    if (!p) return;
    p.children.splice(p.children.indexOf(this), 0, node);
    if (typeof node !== "string") node.parentNode = p;
  }

  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  // Fires a listener with just enough event shape for these scripts.
  emit(type) {
    for (const fn of this.listeners[type] || []) {
      fn({ preventDefault() {}, target: this });
    }
  }

  descendants() {
    const out = [];
    for (const c of this.children) {
      if (typeof c === "string") continue;
      out.push(c, ...c.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((e) => matches(e, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  focus() {}
}

// Supports what the pages use: "button", "p.error", "input, textarea" and
// descendant chains like ".questions .qcard".
function matches(el, selector) {
  return selector.split(",").some((part) => matchChain(el, part.trim().split(/\s+/)));
}

function matchChain(el, chain) {
  if (!matchSimple(el, chain[chain.length - 1])) return false;
  let node = el.parentNode;
  for (let i = chain.length - 2; i >= 0; i--) {
    while (node && !matchSimple(node, chain[i])) node = node.parentNode;
    if (!node) return false;
    node = node.parentNode;
  }
  return true;
}

function matchSimple(el, simple) {
  if (!el.tagName) return false;
  const [tag, ...classes] = simple.split(".");
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  const have = el.classes();
  return classes.every((c) => have.has(c));
}

function createDocument() {
  // The pages share a layout: an account header above the #app container.
  const nav = new FakeElement("nav");
  const header = new FakeElement("header");
  header.className = "owner-header";
  header.append(nav);
  const app = new FakeElement("main");
  app.id = "app";
  const root = new FakeElement("body");
  root.append(header, app);
  return {
    app,
    header,
    document: {
      title: "",
      getElementById: (id) => (id === "app" ? app : null),
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (t) => String(t),
      querySelectorAll: (sel) => root.querySelectorAll(sel),
      querySelector: (sel) => root.querySelector(sel),
    },
  };
}

// Runs a page script (builder.js / dashboard.js) in a sandbox with the given
// document, location and fetch stub, plus the other globals they touch.
// `preludes` are extra sources (e.g. columns.js) evaluated first, exactly as
// the page's <script> tags order them. `timers` replaces setTimeout and
// clearTimeout with controllable fakes for pages that poll.
function runPage(source, { document, fetch, location, confirm, preludes = [], timers = {} }) {
  const vm = require("node:vm");
  const sandbox = {
    document,
    fetch,
    location: location || { search: "", href: "", origin: "http://localhost" },
    navigator: {},
    window: { open() {} },
    confirm: confirm || (() => true),
    URLSearchParams,
    setTimeout: timers.setTimeout || setTimeout,
    clearTimeout: timers.clearTimeout || clearTimeout,
    console,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  preludes.forEach((src, i) => vm.runInContext(src, sandbox, { filename: `prelude-${i}.js` }));
  vm.runInContext(source, sandbox, { filename: "page.js" });
  return sandbox;
}

// Lets an async init settle.
const tick = () => new Promise((r) => setTimeout(r, 0));

module.exports = { FakeElement, createDocument, runPage, tick };
