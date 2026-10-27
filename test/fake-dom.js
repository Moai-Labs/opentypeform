// A minimal DOM for testing the plain-JavaScript runner (public/runner.js) in
// Node — just the element APIs the script uses, plus a vm sandbox that runs
// the page source with controllable timers. No dependencies on purpose.
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
    this.type = "";
    this.placeholder = "";
    this.href = "";
    this.name = "";
    this.id = "";
    this.style = {};
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

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  // Fires a listener with just enough event shape for the runner: an optional
  // detail (e.g. { key: "Enter" }) merged over a preventDefault stub.
  emit(type, detail = {}) {
    const event = { preventDefault() {}, target: this, ...detail };
    for (const fn of this.listeners[type] || []) fn(event);
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

// Supports what the runner uses: "button", "p.error", "input, textarea" and
// descendant chains like ".choices input".
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
  const app = new FakeElement("main");
  app.id = "app";
  const bar = new FakeElement("div");
  bar.id = "progress-bar";
  return {
    app,
    bar,
    document: {
      title: "",
      getElementById: (id) => (id === "app" ? app : id === "progress-bar" ? bar : null),
      createElement: (tag) => new FakeElement(tag),
      createTextNode: (t) => String(t),
    },
  };
}

// Manually fired timers: the runner's auto-advance is a 250 ms setTimeout, and
// these tests need to decide exactly when it fires — and that nothing fires
// twice after a navigation cancelled it.
function makeTimers() {
  const pending = [];
  let nextId = 1;
  return {
    pending,
    setTimeout(fn, ms) {
      const timer = { id: nextId++, fn, ms, cancelled: false };
      pending.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const timer = pending.find((t) => t.id === id);
      if (timer) timer.cancelled = true;
    },
    // Runs the timers that were pending when it was called, in order; timers
    // scheduled while firing wait for the next call, exactly like real time.
    fire() {
      const due = pending.splice(0);
      for (const t of due) if (!t.cancelled) t.fn();
    },
  };
}

// Runs the runner script in a sandbox with the given document, location and
// fetch stub. Returns the sandbox so tests can inspect the rendered app.
function runPage(source, { document, fetch, location, timers }) {
  const vm = require("node:vm");
  const sandbox = {
    document,
    fetch,
    location,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    console,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "runner.js" });
  return sandbox;
}

// Lets the runner's fetch promise settle.
const tick = () => new Promise((r) => setTimeout(r, 0));

module.exports = { FakeElement, createDocument, makeTimers, runPage, tick };