# 2026-10-27: Builder, dashboard and export (post #17) — decisions

## Owner auth: one token, claimed once

The owner endpoints protect respondent data, so they are never anonymous. Until
private accounts land (step #18), the mechanism is a single owner token:

- `ADMIN_TOKEN` env pins it, for deployments where an operator controls the env.
- Otherwise the token is claimed exactly once through first-run setup in the
  dashboard (generate-one or bring-your-own), and persisted in the data
  directory, so it survives restarts. Until claimed, every owner endpoint
  answers 401 — nothing leaks in the meantime.

Browsers authenticate with an HttpOnly cookie (set by claim/login); API clients
use the usual `Authorization: Bearer` header. Both accepted. Claim and login
are rate-limited (10/min/IP) and the comparison is constant-time (SHA-256 +
timingSafeEqual). The window between first boot and the first claim is open on
purpose — it is the setup moment — and closes the instant someone claims. Step
#18 replaces all of this with per-owner accounts; nothing here is long-lived.

## The slug is identity

Editing a form never changes its slug, so share links stay stable. The PUT
endpoint ignores a client-supplied slug.

## Draft by default

Forms the builder creates start unpublished; the owner flips publish when the
form is ready. Unpublished forms are invisible everywhere public (runner page,
public definition API, submission endpoint), as before.

## Deletion removes the responses too

DELETE on a form removes the form and every response it collected in one call
(both store files rewritten). The dashboard asks for confirmation and names the
count. Export-then-delete is the owner's escape hatch; there is no trash.

## CSV export is generated server-side

One row per response, ordered by submission time; columns are `submittedAt`
plus one per question (labels, disambiguated with the id when duplicated).
RFC 4180 escaping; cells that a spreadsheet would treat as formulas (leading
`=`, `+`, `@`, tab) get the usual single-quote defuse, so a respondent typing
`=1+1` cannot turn the export into an active cell. The dashboard links the CSV
endpoint directly — cookie auth makes the download a plain `<a href>`.

## The runner's flow logic is now a testable module

The review of post #16 found real bugs in the runner's auto-advance timers
(stale callbacks could double-submit or navigate after completion). Rather
than patch the DOM code untestably, the state machine moved to `public/flow.js`
(universal module): one pending timer at a time, bound to the question that
scheduled it, cancelled on any navigation; a single in-flight submission;
`completed` blocks everything. `test/flow.test.js` covers rapid re-picks,
navigate-during-timer, double-submit and post-completion staleness.

## Also fixed from the same review

- Static assets: the allowlist (`style.css`, `runner.js`, `flow.js`,
  `dashboard.js`, `builder.js`) is actually routed now, with content types and
  tests that fetch the bytes.
- Dockerfile: `/data` is created and chowned to `node` before `USER node`, and
  `DATA_DIR=/data` is the in-container default, so the store works with no
  mounted volume.
- Question ids are restricted to `[A-Za-z0-9_-]{1,64}` with
  Object.prototype-sensitive names rejected; answer dictionaries are
  prototype-less on both server and client.
- Number/rating answers must be JSON numbers or numeric strings; arrays,
  objects and booleans are rejected instead of coerced to 0.
- Every response path drains unread request bodies (auth failures, rate
  limits, 404s), so such responses no longer hold connections open.
