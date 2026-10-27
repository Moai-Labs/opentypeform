// Private owner accounts: email + password sign-up, sign-in, sessions.
//
// This replaces the single owner token of the earlier steps: every form now
// belongs to the account that created it, and the owner endpoints require a
// session for that account. Respondents still never need an account.
//
//   - Accounts and sessions live in the data directory and are written
//     through to disk on every mutation, like the rest of the store.
//   - Passwords are salted scrypt hashes; the hash comparison is
//     constant-time.
//   - Browsers authenticate with an HttpOnly session cookie set by
//     signup/login; API clients use Authorization: Bearer <session token>.
//   - There is no email verification: no mail service exists in this stack,
//     so the address is only the sign-in credential, and the UI says so.
//
// The first account created on a deployment also adopts the ownerless forms
// left behind by the earlier steps (the seeded template), so nothing on an
// existing deployment becomes invisible.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ACCOUNTS_FILE = "accounts.json";
const SESSIONS_FILE = "sessions.json";
const COOKIE_NAME = "otf_session";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const SESSION_DAYS = 30;
const SCRYPT_N = 16384;

function id() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

class Accounts {
  constructor(dir) {
    this.accountsFile = path.join(dir, ACCOUNTS_FILE);
    this.sessionsFile = path.join(dir, SESSIONS_FILE);
    this.accounts = [];
    this.sessions = [];
    this.load();
  }

  load() {
    this.accounts = readJson(this.accountsFile, []);
    this.sessions = readJson(this.sessionsFile, []);
  }

  writeJson(file, value) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  saveAccounts() {
    this.writeJson(this.accountsFile, this.accounts);
  }

  saveSessions() {
    this.writeJson(this.sessionsFile, this.sessions);
  }

  get hasAccounts() {
    return this.accounts.length > 0;
  }

  findAccount(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    return this.accounts.find((a) => a.email === normalized) || null;
  }

  accountExists(accountId) {
    return this.accounts.some((a) => a.id === accountId);
  }

  // Creates an account and signs it in. Returns { account, session } or an
  // error string.
  signup(email, password) {
    const normalized = normalizeEmail(email);
    if (!normalized) return { error: "enter a valid email address" };
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }
    if (password.length > MAX_PASSWORD_LENGTH) return { error: "password is too long" };
    if (this.findAccount(normalized)) return { error: "an account with this email already exists" };
    const salt = crypto.randomBytes(16).toString("hex");
    const account = {
      id: id(),
      email: normalized,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: nowIso(),
    };
    this.accounts.push(account);
    this.saveAccounts();
    return { account, session: this.startSession(account.id) };
  }

  // Verifies a password and signs the account in.
  login(email, password) {
    const account = this.findAccount(email);
    if (!account || typeof password !== "string") return null;
    const candidate = hashPassword(password, account.salt);
    const stored = Buffer.from(account.passwordHash, "hex");
    const given = Buffer.from(candidate, "hex");
    if (given.length !== stored.length || !crypto.timingSafeEqual(stored, given)) return null;
    return { account, session: this.startSession(account.id) };
  }

  startSession(accountId) {
    // Drop this account's expired sessions so the file cannot grow forever.
    const cutoff = Date.now() - SESSION_DAYS * 24 * 60 * 60 * 1000;
    this.sessions = this.sessions.filter((s) => new Date(s.expiresAt).getTime() > cutoff || s.accountId !== accountId);
    const token = crypto.randomBytes(32).toString("base64url");
    const session = {
      token,
      accountId,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    };
    this.sessions.push(session);
    this.saveSessions();
    return session;
  }

  // The account a presented credential belongs to, or null.
  accountFor(token) {
    if (typeof token !== "string" || !token) return null;
    const session = this.sessions.find((s) => s.token === token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return this.accounts.find((a) => a.id === session.accountId) || null;
  }

  logout(token) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.token !== token);
    if (this.sessions.length !== before) this.saveSessions();
  }

  // First sign-up on a deployment: the adoption step for the ownerless forms
  // the earlier steps created (the seeded template). Returns the slugs
  // adopted, so the caller can record and surface it.
  adoptOwnerlessForms(store, accountId) {
    const adopted = [];
    for (const form of store.listForms()) {
      if (!form.ownerAccountId) adopted.push(form.slug);
    }
    if (!adopted.length) return adopted;
    for (const form of store.listForms()) {
      if (!form.ownerAccountId) store.replaceForm(form.slug, { ...form, ownerAccountId: accountId, updatedAt: nowIso() });
    }
    return adopted;
  }
}

function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254) return null;
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

// Salted scrypt; the salt is per-account and stored beside the hash.
function hashPassword(password, saltHex) {
  return crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64, { N: SCRYPT_N }).toString("hex");
}

// --- cookie helpers (same shape as the owner-token cookies they replace) ---

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = Object.create(null);
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    const name = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // A malformed cookie is an odd request, not a crash.
    }
    if (name) cookies[name] = value;
  }
  return cookies;
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim();
}

// The request's presented credential: bearer header first, then cookie.
function presentedToken(req) {
  return bearerToken(req) || parseCookies(req)[COOKIE_NAME] || null;
}

function setSessionCookie(res, token) {
  res.setHeader(
    "set-cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`could not read ${file}: ${err.message}`);
  }
}

module.exports = {
  Accounts,
  parseCookies,
  bearerToken,
  presentedToken,
  setSessionCookie,
  clearSessionCookie,
  COOKIE_NAME,
  MIN_PASSWORD_LENGTH,
  SESSION_DAYS,
};
