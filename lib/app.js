// The HTTP app: routes, JSON API, static assets.
//
// Owner endpoints (create, edit, delete, list responses, export) require the
// owner token — see lib/owner.js. Until private accounts land in the next
// step, that token is claimed once through first-run setup (or pinned with
// ADMIN_TOKEN). Public endpoints (published form reads, response submission)
// stay anonymous. Everything is rate-limited and size-limited.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Store, id } = require("./store");
const { normalizeDefinition, normalizeUpdate, validateAnswers } = require("./validate");
const { seedIfNeeded, templateForm } = require("./seed");
const { responsesCsv } = require("./csv");
const {
  OwnerAuth,
  generateToken,
  validToken,
  presentedToken,
  setCookie,
  clearCookie,
  MIN_TOKEN_LENGTH,
} = require("./owner");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MAX_BODY_BYTES = 100 * 1024;
// The only files served straight off disk, with their content types.
const STATIC_FILES = new Map([
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/runner.js", ["runner.js", "text/javascript; charset=utf-8"]],
  ["/flow.js", ["flow.js", "text/javascript; charset=utf-8"]],
  ["/columns.js", ["columns.js", "text/javascript; charset=utf-8"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["/builder.js", ["builder.js", "text/javascript; charset=utf-8"]],
]);
const PAGES = new Map([
  ["/dashboard", "dashboard.html"],
  ["/builder", "builder.html"],
]);

function createApp(options = {}) {
  const dir = options.dataDir || dataDir();
  const store = options.store || new Store(dir);
  const owner = options.owner || new OwnerAuth(dir, process.env.ADMIN_TOKEN);
  const seeded = seedIfNeeded(store);
  const limiter = rateLimiter();

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
    } finally {
      // A response that went out before the request body was read (auth
      // failures, rate limits, 404s) leaves bytes unconsumed, which would
      // hold the connection open forever. Dump whatever is left.
      req.resume();
    }
  }

  function routeMatch(method, pathname) {
    const routes = [
      ["GET", /^\/healthz$/, () => ok],
      ["GET", /^\/$/, () => home],
      ["GET", /^\/f\/([a-z0-9][a-z0-9-]*)$/, () => runnerPage],
      ["GET", /^\/api\/public\/forms\/([a-z0-9][a-z0-9-]*)$/, () => publicForm],
      ["POST", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)\/responses$/, () => submitResponse],

      ["POST", /^\/api\/owner\/claim$/, () => claimOwner],
      ["POST", /^\/api\/owner\/login$/, () => loginOwner],
      ["POST", /^\/api\/owner\/logout$/, () => logoutOwner],
      ["GET", /^\/api\/owner\/status$/, () => ownerStatus],
      ["GET", /^\/api\/template$/, () => templateDefinition],

      ["POST", /^\/api\/forms$/, () => createForm],
      ["GET", /^\/api\/forms$/, () => listForms],
      ["GET", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)$/, () => getForm],
      ["PUT", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)$/, () => updateForm],
      ["DELETE", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)$/, () => deleteForm],
      ["GET", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)\/responses$/, () => listResponses],
      ["GET", /^\/api\/forms\/([a-z0-9][a-z0-9-]*)\/responses\.csv$/, () => exportResponses],
    ];
    for (const [m, re, get] of routes) {
      if (m !== method) continue;
      const match = pathname.match(re);
      if (match) return { fn: get(), params: match.slice(1) };
    }
    const asset = STATIC_FILES.get(pathname);
    if (method === "GET" && asset) return { fn: serveStatic, params: asset };
    const page = PAGES.get(pathname);
    if (method === "GET" && page) return { fn: servePage, params: [page] };
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

  async function serveStatic(req, res, [name, type]) {
    serveFile(res, name, type);
  }

  async function servePage(req, res, [name]) {
    serveFile(res, name, "text/html; charset=utf-8");
  }

  async function runnerPage(req, res, [slug]) {
    // The runner page itself is static; it pulls the live definition from the
    // public API, so an unpublished form never renders.
    const form = store.getForm(slug);
    if (!form || !form.published) return notFound(res);
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
    // The owner may have deleted (or unpublished) the form while the body
    // was arriving, so the definition read above can be stale. Re-check
    // against the live store and keep that final check and the store
    // mutation together with no await between them: a submission either
    // lands against a form that exists right now, or it does not land.
    const live = store.getForm(slug);
    if (!live || !live.published) return notFound(res);
    const result = validateAnswers(live, body);
    if (result.error) {
      return sendJson(res, 400, { error: result.error, field: result.field });
    }
    const response = {
      id: id(),
      formSlug: slug,
      // Snapshot the question schema the respondent actually saw, so the
      // dashboard and export keep every answer identifiable after the form
      // is later edited (public/columns.js).
      schema: live.questions.map(({ id, label }) => ({ id, label })),
      answers: result.answers,
      submittedAt: new Date().toISOString(),
    };
    store.addResponse(response);
    sendJson(res, 201, { id: response.id });
  }

  // --- owner setup and session (see lib/owner.js) ---

  function denyOwner(res) {
    sendJson(res, 401, {
      error: owner.configured
        ? "owner token required"
        : "no owner has claimed this deployment yet",
    });
  }

  // Returns true when the request carries the owner token; responds 401 otherwise.
  function requireOwner(req, res) {
    if (owner.check(presentedToken(req))) return true;
    denyOwner(res);
    return false;
  }

  async function ownerStatus(req, res) {
    sendJson(res, 200, { configured: owner.configured });
  }

  // First-run setup: exactly one claim per deployment. An empty body generates
  // a strong token and returns it once; { token } sets the caller's own.
  async function claimOwner(req, res) {
    if (limited(limiter, req, "owner-auth", 10)) {
      return sendJson(res, 429, { error: "too many requests, try again later" });
    }
    if (owner.configured) {
      return sendJson(res, 409, { error: "an owner token is already configured" });
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    let token = validToken(body.token);
    let generated = false;
    if (!token && !body.token) {
      token = generateToken();
      generated = true;
    }
    if (!token) {
      return sendJson(res, 400, {
        error: `token must be a string of ${MIN_TOKEN_LENGTH}-200 characters`,
      });
    }
    owner.claim(token);
    setCookie(res, token);
    sendJson(res, 201, generated ? { token } : { ok: true });
  }

  async function loginOwner(req, res) {
    if (limited(limiter, req, "owner-auth", 10)) {
      return sendJson(res, 429, { error: "too many requests, try again later" });
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    if (!owner.check(body.token)) return denyOwner(res);
    setCookie(res, owner.token);
    sendJson(res, 200, { ok: true });
  }

  async function logoutOwner(req, res) {
    clearCookie(res);
    sendJson(res, 200, { ok: true });
  }

  // The starting template as a definition, so the builder can prefill a new
  // form from it. Static shape, no stored data.
  async function templateDefinition(req, res) {
    const t = templateForm();
    sendJson(res, 200, { title: t.title, description: t.description, questions: t.questions });
  }

  // --- owner API (token required) ---

  async function createForm(req, res) {
    if (!requireOwner(req, res)) return;
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

  // The dashboard's list: every form, published or not, with its count.
  async function listForms(req, res) {
    if (!requireOwner(req, res)) return;
    sendJson(
      res,
      200,
      store.listForms().map((f) => ({ ...f, responseCount: store.countResponses(f.slug) })),
    );
  }

  async function getForm(req, res, [slug]) {
    if (!requireOwner(req, res)) return;
    const form = store.getForm(slug);
    if (!form) return notFound(res);
    sendJson(res, 200, { ...form, responseCount: store.countResponses(slug) });
  }

  // Edits a form's definition (title, description, questions — including
  // reorder) and its publish state. The slug is identity and never changes,
  // so share links stay stable.
  async function updateForm(req, res, [slug]) {
    if (!requireOwner(req, res)) return;
    // Only the targeted form's identity is captured up front; its definition
    // is read again after the body, which can take arbitrarily long.
    const targeted = store.getForm(slug);
    if (!targeted) return notFound(res);
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const result = normalizeUpdate(body);
    if (result.error) return sendJson(res, 400, { error: result.error });
    delete result.fields.slug;
    // The form read above is stale by now: an intervening edit or
    // publish/unpublish must not be silently undone, and if the form was
    // deleted — perhaps recreated under the same slug — the pending update
    // must not overwrite the replacement with the old definition. So merge
    // into the live form, keeping the identity check and the replacement
    // together with no await between them.
    const live = store.getForm(slug);
    if (!live) return notFound(res);
    if (live.id !== targeted.id) {
      return sendJson(res, 409, {
        error: "this form was deleted and its slug recreated; reload the dashboard and edit the new form",
      });
    }
    // If this edit touches the questions, first attach the pre-edit schema
    // to every response still stored without one, so answers collected
    // under the old questions keep their labels (public/columns.js).
    if (result.fields.questions) store.backfillSchemas(slug, live.questions);
    sendJson(res, 200, store.replaceForm(slug, { ...live, ...result.fields }));
  }

  // Deletes the form and every response it collected.
  async function deleteForm(req, res, [slug]) {
    if (!requireOwner(req, res)) return;
    if (!store.deleteForm(slug)) return notFound(res);
    res.writeHead(204);
    res.end();
  }

  async function listResponses(req, res, [slug]) {
    if (!requireOwner(req, res)) return;
    if (!store.getForm(slug)) return notFound(res);
    sendJson(res, 200, store.listResponses(slug));
  }

  async function exportResponses(req, res, [slug]) {
    if (!requireOwner(req, res)) return;
    const form = store.getForm(slug);
    if (!form) return notFound(res);
    const csv = responsesCsv(form, store.listResponses(slug));
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}-responses.csv"`,
      "cache-control": "no-cache",
    });
    res.end(csv);
  }

  return { handler, store, owner, seeded };
}

// --- helpers ---

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

function limited(limiter, req, bucket, max) {
  const ip = req.socket.remoteAddress || "unknown";
  return limiter.limited(ip, bucket, max);
}

module.exports = { createApp, slugify };