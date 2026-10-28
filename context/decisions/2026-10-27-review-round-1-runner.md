# 2026-10-27: Runner review round 1 (post #16) — how the fixes work

## Static assets are routed from the STATIC_FILES map

The map now drives routing: each entry gets an exact-match GET route serving
the file with its declared content type. Nothing is auto-discovered, so a
dropped file into `public/` is not served by accident. HTTP tests fetch both
assets and check their contents (and every path the runner HTML references),
so "the page references a file that 404s" cannot silently return.

## The owner API is bearer-token protected, and off without a token

`ADMIN_TOKEN` (or `createApp({ adminToken })` in tests) gates `POST /api/forms`,
`GET /api/forms`, `GET /api/forms/<slug>` and `GET /api/forms/<slug>/responses`;
comparison is constant-time. When no token is configured the owner endpoints
answer 503 rather than serve: those endpoints hold every respondent's name and
email, so an unconfigured deployment must not serve them at all. Published
definition reads and submissions stay anonymous. Per-form ownership remains
step 3's job; this token is the interim lock.

## `__proto__` is rejected as a question id; everything else is own-property safe

One write-trap (`__proto__`) is rejected at definition time. Ids that merely
shadow inherited names (`constructor`, `toString`, …) stay legal: answer reads
are `Object.hasOwn`-checked in validation, and the runner keeps its answer and
error dictionaries null-prototype. A regression test walks a form with ids
`constructor`/`toString` through submission and a restart-restore.

## Numbers and ratings must arrive as numbers or numeric strings

Coercion through `String()`/`Number()` used to accept `[]` (→ 0), `[4]`,
booleans and objects. Now only JSON numbers and non-empty numeric strings are
converted; everything else is rejected with 400 and stored nowhere (HTTP test
asserts the store stays empty).

## The runner's auto-advance is bound to its question and cancelled on any move

The 250 ms timer remembers the step that scheduled it (`advanceStep`), fires
`next()` only if the form is still there, and `showStep`/`submit` cancel it on
every navigation. `submitting`/`completed` guards make a submission once-only
and freeze navigation after the success screen. The runner test suite drives
the real script in a mini-DOM with hand-fired timers, covering rapid
re-selection, selection-then-Continue, selection-then-Back and stale timers
after success.

## Dockerfile: /data is provisioned before the user switch

`ENV DATA_DIR=/data` plus `mkdir -p /data && chown node:node /data` before
`USER node`: the image's default storage is writable by the unprivileged
process, and a runtime `-e DATA_DIR=…` still wins for deployments mounting
storage elsewhere. Docker is not available in the lane sandbox, so the image
build itself is CI's job; locally I verified the same default-configuration
boot (read-only working directory, `DATA_DIR` set, server as unprivileged
user): seeded template, runner page and both assets serve, a submission is
accepted, and after a kill-and-restart the response is read back through the
owner API.