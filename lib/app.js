// The HTTP app: routes, JSON API, static runner assets.
//
// The owner API (form creation, response listing) holds every respondent's
// answers, so it is never public. It is protected by an administrator bearer
// token (ADMIN_TOKEN); when no token is configured the owner endpoints are
// switched off entirely. Private accounts with per-form ownership are step 3.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Store, id } = require("./store");
const { normalizeDefinition, validateAnswers } = require("./validate");
const { seedIfNeeded } = require("./seed");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MAX_BODY_BYTES = 100 * 1024;
const STATIC_FILES = {
  "/style.css": "text/css; charset=utf-8",
  "/runner.js": "text/javascript; charset=utf-8",
};

function createApp(options = {}) {
  const store = options.store || new Store(options.dataDir || dataDir());
  const seeded = seedIfNeeded(store);
  const limiter = rateLimiter();
  const adminToken = options.adminToken !== undefined ? options.adminToken : process.env.ADMIN_TOKEN || null;

  async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const route = routeMatch(req.method, url.pathname);
      if (!route) return notFound(res);
      await route.fn(req, res, route.params, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    }
  }

  function routeMatch(method, pathname) {
    const routes = [
      ["GET", /^\/healthz$/, () => ok],
      ["GET", /^\/$/, () => home],
      ["GET", /^\/f\/([a-z0-9][a-z0-9-]*)$/, () => runnerPage],
      ["GET", /^\/api\/public\/forms\/([a-z0-9][a-z0-9-]*)$/, () => publicForm],
      ["POST", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)\/responses$/, () => submitResponse],
      ["POST", /^\/api\/forms$/, () => createForm],
      ["GET", /^\/api\/forms$/, () => listForms],
      ["GET", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)$/, () => getForm],
      ["GET", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)\/responses$/, () => listResponses],
    ];
    // The runner page loads both assets by absolute path; without these routes
    // a stranger would sit on "Loading…" forever.
    for (const [route, type] of Object.entries(STATIC_FILES)) {
      const re = new RegExp(`^${route.replace(/\./g, "\\.")}$`);
      routes.push(["GET", re, () => (req, res) => serveFile(res, route.slice(1), type)]);
    }
    for (const [m, re, get] of routes) {
      if (m !== method) continue;
      const match = pathname.match(re);
      if (match) return { fn: get(), params: match.slice(1) };
    }
    return null;
  }

  // --- public routes ---

  async function ok(req, res) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
  }

  async function home(req, res) {
    serveFile(res, "index.html", "text/html; charset=utf-8");
  }

  async function runnerPage(req, res, [slug]) {
    // The runner page itself is static; it pulls the live definition from the
    // public API, so an unpublished form never renders.
    if (!store.getForm(slug) || !store.getForm(slug).published) return notFound(res);
    serveFile(res, "runner.html", "text/html; charset=utf-8");
  }

  async function publicForm(req, res, [slug]) {
    const form = store.getForm(slug);
    if (!form || !form.published) return notFound(res);
    sendJson(res, 200, {
      slug: form.slug,
      title: form.title,
      description: form.description,
      questions: form.questions,
    });
  }

  async function submitResponse(req, res, [slug]) {
    if (limited(limiter, req, "responses")) {
      return sendJson(res, 429, { error: "too many submissions, try again later" });
    }
    const form = store.getForm(slug);
    if (!form || !form.published) return notFound(res);
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const result = validateAnswers(form, body);
    if (result.error) {
      return sendJson(res, 400, { error: result.error, field: result.field });
    }
    const response = {
      id: id(),
      formSlug: slug,
      answers: result.answers,
      submittedAt: new Date().toISOString(),
    };
    store.addResponse(response);
    sendJson(res, 201, { id: response.id });
  }

  // --- owner API (administrator token; private accounts are step 3) ---

  // Returns true when the caller may proceed; responds itself otherwise.
  // Without a configured token the owner API is off: the endpoints hold every
  // respondent's name, email and answers, and a deployment that has not been
  // given an administrator must not serve them at all.
  function ownerAuthorized(req, res) {
    if (!adminToken) {
      sendJson(res, 503, { error: "owner API is disabled: no administrator token is configured" });
      return false;
    }
    const header = req.headers.authorization || "";
    const given = /^Bearer (.+)$/s.exec(header);
    if (!given || !sameSecret(given[1], adminToken)) {
      sendJson(res, 401, { error: "owner authorization required" });
      return false;
    }
    return true;
  }

  async function createForm(req, res) {
    if (!ownerAuthorized(req, res)) return;
    if (limited(limiter, req, "form-creation")) {
      return sendJson(res, 429, { error: "too many requests, try again later" });
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const result = normalizeDefinition(
      body,
      slugify,
      (candidate) => store.slugTaken(candidate),
    );
    if (result.error) return sendJson(res, 400, { error: result.error });
    sendJson(res, 201, store.addForm(result.form));
  }

  async function listForms(req, res) {
    if (!ownerAuthorized(req, res)) return;
    sendJson(res, 200, store.listForms());
  }

  async function getForm(req, res, [slug]) {
    if (!ownerAuthorized(req, res)) return;
    const form = store.getForm(slug);
    if (!form) return notFound(res);
    sendJson(res, 200, form);
  }

  async function listResponses(req, res, [slug]) {
    if (!ownerAuthorized(req, res)) return;
    if (!store.getForm(slug)) return notFound(res);
    sendJson(res, 200, store.listResponses(slug));
  }

  return { handler, store, seeded };
}

// --- helpers ---

// Constant-time string comparison so a wrong token cannot be probed byte by
// byte through response timing.
function sameSecret(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  // A mounted volume at /data is the platform's way of keeping state across
  // container replacement; prefer it when it exists and is writable.
  try {
    fs.mkdirSync("/data", { recursive: true });
    fs.accessSync("/data", fs.constants.W_OK);
    return "/data";
  } catch {
    return path.join(process.cwd(), "data");
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}

function serveFile(res, name, type) {
  let body;
  try {
    body = fs.readFileSync(path.join(PUBLIC_DIR, name));
  } catch {
    return notFound(res);
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  res.end(body);
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function notFound(res) {
  sendJson(res, 404, { error: "not found" });
}

// Reads a JSON body up to MAX_BODY_BYTES. Responds itself and returns null
// when the body is missing, oversized or not JSON.
async function readJsonBody(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: "body too large" });
      return null;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "body must be valid JSON" });
    return null;
  }
}

// A tiny in-memory limiter: N requests per minute per IP per bucket.
function rateLimiter() {
  const hits = new Map();
  return {
    limited(ip, bucket, max = 20) {
      const key = `${bucket}:${ip}`;
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < 60_000);
      list.push(now);
      hits.set(key, list);
      // Keep the map bounded even under abuse.
      if (hits.size > 10_000) hits.clear();
      return list.length > max;
    },
  };
}

function limited(limiter, req, bucket) {
  const ip = req.socket.remoteAddress || "unknown";
  return limiter.limited(ip, bucket);
}

module.exports = { createApp, slugify, dataDir };
