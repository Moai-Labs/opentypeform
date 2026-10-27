// Owner authentication, until private accounts land in the next step.
//
// The owner endpoints (create, edit, delete, list responses, export) protect
// respondent data, so they are never anonymous. The mechanism is a single
// owner token:
//
//   - ADMIN_TOKEN env pins the token at boot, for real deployments.
//   - Otherwise the token is claimed once through the first-run setup flow
//     (POST /api/owner/claim) and persisted in the data directory, so it
//     survives restarts. Until it is claimed, the data endpoints return 401.
//
// Browsers authenticate with an HttpOnly cookie set by claim/login; API
// clients use the usual Authorization: Bearer header. Both are accepted.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TOKEN_FILE = "owner-token.json";
const MIN_TOKEN_LENGTH = 8;
const MAX_TOKEN_LENGTH = 200;
const COOKIE_NAME = "otf_owner";

function generateToken() {
  return crypto.randomBytes(32).toString("base64url");
}

// A string token within the length bounds, or null.
function validToken(candidate) {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (trimmed.length < MIN_TOKEN_LENGTH || trimmed.length > MAX_TOKEN_LENGTH) return null;
  return trimmed;
}

class OwnerAuth {
  constructor(dir, envToken) {
    this.file = path.join(dir, TOKEN_FILE);
    // An explicitly configured token always wins over a claimed one.
    this.token = validToken(envToken || "") || this.readClaimed();
  }

  readClaimed() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return validToken(saved.token);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return null;
    }
  }

  get configured() {
    return this.token !== null;
  }

  // First-run setup: exactly one claim, ever (env-pinned deployments never
  // accept one). Returns true when the claim was accepted.
  claim(token) {
    if (this.configured) return false;
    const value = validToken(token);
    if (!value) return false;
    this.token = value;
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ token: value, claimedAt: new Date().toISOString() }));
    fs.renameSync(tmp, this.file);
    return true;
  }

  // Constant-time comparison, via a hash so lengths never leak.
  check(candidate) {
    if (!this.configured || typeof candidate !== "string") return false;
    const a = crypto.createHash("sha256").update(candidate).digest();
    const b = crypto.createHash("sha256").update(this.token).digest();
    return crypto.timingSafeEqual(a, b);
  }
}

// --- cookie helpers ---

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

function setCookie(res, token) {
  res.setHeader(
    "set-cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  );
}

function clearCookie(res) {
  res.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  OwnerAuth,
  generateToken,
  validToken,
  parseCookies,
  bearerToken,
  presentedToken,
  setCookie,
  clearCookie,
  COOKIE_NAME,
  MIN_TOKEN_LENGTH,
};