// The HTTP app: routes, JSON API, static assets.
//
// Accounts: every owner endpoint requires a session (email + password
// sign-in — see lib/accounts.js), and every form belongs to the account that
// created it. Respondents never need an account.
//
// Plans: an account on the free tier gets 25 responses a month across its
// forms and branded runners; a paid account ($9 per 30 days, paid in test
// USDC — see lib/billing.js) gets 1,000 and unbranded runners. Over the
// limit, collection pauses: the runner says so and further submissions are
// refused until the plan is paid or the month rolls over. Everything is
// rate-limited and size-limited.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Store, id } = require("./store");
const { normalizeDefinition, normalizeUpdate, validateAnswers } = require("./validate");
const { seedIfNeeded, templateForm } = require("./seed");
const { responsesCsv } = require("./csv");
const { Accounts, presentedToken, setSessionCookie, clearSessionCookie } = require("./accounts");
const { Billing, monthStart } = require("./billing");
const { NETWORK_NAME, CHAIN_ID } = require("./chain");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MAX_BODY_BYTES = 100 * 1024;
// The only files served straight off disk, with their content types.
const STATIC_FILES = new Map([
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/runner.js", ["runner.js", "text/javascript; charset=utf-8"]],
  ["/flow.js", ["flow.js", "text/javascript; charset=utf-8"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["/builder.js", ["builder.js", "text/javascript; charset=utf-8"]],
  ["/login.js", ["login.js", "text/javascript; charset=utf-8"]],
  ["/billing.js", ["billing.js", "text/javascript; charset=utf-8"]],
]);
const PAGES = new Map([
  ["/dashboard", "dashboard.html"],
  ["/builder", "builder.html"],
  ["/login", "login.html"],
  ["/billing", "billing.html"],
]);

function createApp(options = {}) {
  const dir = options.dataDir || dataDir();
  const store = options.store || new Store(dir);
  const accounts = options.accounts || new Accounts(dir);
  const billing = options.billing || new Billing(dir);
  const readBalance = options.readBalance || null;
  const seeded = seedIfNeeded(store);
  const limiter = rateLimiter();
  // In-memory only: when a process last read the chain for an account.
  const lastChainCheck = new Map();

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

      ["POST", /^\/api\/auth\/signup$/, () => signup],
      ["POST", /^\/api\/auth\/login$/, () => login],
      ["POST", /^\/api\/auth\/logout$/, () => logout],
      ["GET", /^\/api\/me$/, () => me],

      ["POST", /^\/api\/billing\/start$/, () => billingStart],
      ["GET", /^\/api\/billing\/status$/, () => billingStatus],
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

  // The plan state of a form's owner, as the runner needs it: whether
  // collection is paused (over the monthly limit) and whether the
  // "Built with OpenTypeform" badge shows (free tier = branded).
  function planStateFor(form) {
    if (!form.ownerAccountId || !accounts.accountExists(form.ownerAccountId)) {
      // Forms with no owner yet (a fresh deployment before anyone signs up)
      // collect freely and stay branded.
      return { paused: false, branding: { powered: true } };
    }
    const used = monthlyUsage(form.ownerAccountId);
    const plan = billing.plan(form.ownerAccountId, used);
    return { paused: billing.paused(plan), branding: { powered: !paidActive(plan) }, used, limit: plan.limit };
  }

  function paidActive(plan) {
    return plan.tier === "paid";
  }

  // Responses the account collected this calendar month, across its forms.
  function monthlyUsage(accountId) {
    return store.countMonthlyForOwner(accountId, monthStart());
  }

  async function publicForm(req, res, [slug]) {
    const form = store.getForm(slug);
    if (!form || !form.published) return notFound(res);
    const planState = planStateFor(form);
    sendJson(res, 200, {
      slug: form.slug,
      title: form.title,
      description: form.description,
      questions: form.questions,
      paused: planState.paused,
      branding: planState.branding,
    });
  }

  async function submitResponse(req, res, [slug]) {
    // The limiter is abuse protection, not the plan: it must never be the
    // reason a legitimate respondent hits a wall before the plan limit does.
    if (limited(limiter, req, "responses", 100)) {
      return sendJson(res, 429, { error: "too many submissions, try again later" });
    }
    const form = store.getForm(slug);
    if (!form || !form.published) return notFound(res);
    // Enforcement is real: over the plan's limit, collection pauses.
    const planState = planStateFor(form);
    if (planState.paused) {
      return sendJson(res, 402, {
        error: "This form has paused collecting responses — the owner's monthly limit is reached.",
        code: "plan_limit",
      });
    }
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

  // --- accounts and billing ---

  function deny(res) {
    sendJson(res, 401, { error: "sign in required" });
  }

  // Returns the signed-in account; responds 401 and returns null otherwise.
  function requireAccount(req, res) {
    const account = accounts.accountFor(presentedToken(req));
    if (!account) deny(res);
    return account;
  }

  async function signup(req, res) {
    if (limited(limiter, req, "auth", 10)) {
      return sendJson(res, 429, { error: "too many requests, try again later" });
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const result = accounts.signup(body.email, body.password);
    if (result.error) return sendJson(res, 400, { error: result.error });
    const first = accounts.accounts.length === 1;
    const adopted = first ? accounts.adoptOwnerlessForms(store, result.account.id) : [];
    setSessionCookie(res, result.session.token);
    sendJson(res, 201, {
      token: result.session.token,
      account: { email: result.account.email },
      adopted,
    });
  }

  async function login(req, res) {
    if (limited(limiter, req, "auth", 10)) {
      return sendJson(res, 429, { error: "too many requests, try again later" });
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const result = accounts.login(body.email, body.password);
    if (!result) return sendJson(res, 401, { error: "email or password is wrong" });
    setSessionCookie(res, result.session.token);
    sendJson(res, 200, { token: result.session.token, account: { email: result.account.email } });
  }

  async function logout(req, res) {
    const token = presentedToken(req);
    if (token) accounts.logout(token);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
  }

  async function me(req, res) {
    const account = requireAccount(req, res);
    if (!account) return;
    const used = monthlyUsage(account.id);
    sendJson(res, 200, {
      email: account.email,
      createdAt: account.createdAt,
      plan: billing.plan(account.id, used),
    });
  }

  // Starts a payment: returns the receiving address and how much to send.
  async function billingStart(req, res) {
    const account = requireAccount(req, res);
    if (!account) return;
    if (limited(limiter, req, "billing-start", 5)) {
      return sendJson(res, 429, { error: "too many requests, try again later" });
    }
    const details = billing.paymentDetails(account.id);
    sendJson(res, 200, {
      ...details,
      note: "Test payment — test USDC on a public testnet. Nothing real changes hands.",
    });
  }

  // Where the payment stands: reads the chain (throttled to one read per
  // account every few seconds, per process) and credits what arrived.
  async function billingStatus(req, res) {
    const account = requireAccount(req, res);
    if (!account) return;
    const used = monthlyUsage(account.id);
    const plan = billing.plan(account.id, used);
    const rec = billing.recordFor(account.id);
    let details = null;
    let checked;
    if (rec) {
      // One chain read per account per 5 seconds per process; the rest is
      // cached state. The throttle lives in memory on purpose: a restart
      // must always be free to read the chain again.
      const last = lastChainCheck.get(account.id) || 0;
      if (Date.now() - last > 5_000) {
        lastChainCheck.set(account.id, Date.now());
        checked = await billing.checkPayment(account.id, readBalance);
      }
      details = {
        address: rec.address,
        amountUsdc: plan.priceUsdc,
        amountUnits: (BigInt(plan.priceUsdc) * 1_000_000n).toString(),
        chainId: CHAIN_ID,
        network: NETWORK_NAME,
        token: plan.token,
        test: true,
      };
    }
    const after = billing.plan(account.id, used);
    sendJson(res, 200, {
      plan: after,
      awaiting: after.tier === "paid" ? null : details,
      lastCheckError: checked && checked.available === false ? checked.error : null,
    });
  }

  // The starting template as a definition, so the builder can prefill a new
  // form from it. Static shape, no stored data.
  async function templateDefinition(req, res) {
    const t = templateForm();
    sendJson(res, 200, { title: t.title, description: t.description, questions: t.questions });
  }

  // --- owner API (account session required; only the owner's own forms) ---

  async function createForm(req, res) {
    const account = requireAccount(req, res);
    if (!account) return;
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
    const form = store.addForm({ ...result.form, ownerAccountId: account.id });
    sendJson(res, 201, form);
  }

  // The dashboard's list: the account's own forms, published or not.
  async function listForms(req, res) {
    const account = requireAccount(req, res);
    if (!account) return;
    sendJson(
      res,
      200,
      store
        .listForms()
        .filter((f) => f.ownerAccountId === account.id)
        .map((f) => ({ ...f, responseCount: store.countResponses(f.slug) })),
    );
  }

  // A form the account owns, or null after a 404 — another account's form
  // looks the same as one that does not exist.
  function ownForm(res, slug, account) {
    const form = store.getForm(slug);
    if (!form || form.ownerAccountId !== account.id) {
      notFound(res);
      return null;
    }
    return form;
  }

  async function getForm(req, res, [slug]) {
    const account = requireAccount(req, res);
    if (!account) return;
    const form = ownForm(res, slug, account);
    if (!form) return;
    sendJson(res, 200, { ...form, responseCount: store.countResponses(slug) });
  }

  // Edits a form's definition (title, description, questions — including
  // reorder) and its publish state. The slug is identity and never changes,
  // so share links stay stable.
  async function updateForm(req, res, [slug]) {
    const account = requireAccount(req, res);
    if (!account) return;
    const form = ownForm(res, slug, account);
    if (!form) return;
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const result = normalizeUpdate(body);
    if (result.error) return sendJson(res, 400, { error: result.error });
    delete result.fields.slug;
    sendJson(res, 200, store.replaceForm(slug, { ...form, ...result.fields }));
  }

  // Deletes the form and every response it collected.
  async function deleteForm(req, res, [slug]) {
    const account = requireAccount(req, res);
    if (!account) return;
    const form = ownForm(res, slug, account);
    if (!form) return;
    store.deleteForm(slug);
    res.writeHead(204);
    res.end();
  }

  async function listResponses(req, res, [slug]) {
    const account = requireAccount(req, res);
    if (!account) return;
    const form = ownForm(res, slug, account);
    if (!form) return;
    sendJson(res, 200, store.listResponses(slug));
  }

  async function exportResponses(req, res, [slug]) {
    const account = requireAccount(req, res);
    if (!account) return;
    const form = ownForm(res, slug, account);
    if (!form) return;
    const csv = responsesCsv(form, store.listResponses(slug));
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}-responses.csv"`,
      "cache-control": "no-cache",
    });
    res.end(csv);
  }

  return { handler, store, accounts, billing, seeded };
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
