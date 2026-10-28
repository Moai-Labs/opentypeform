# 2026-10-28: Runner review round 2 (post #16) — the JSON null body, and the merge

## The bug (round 2's request)

`readJsonBody` returned `null` both when it had already answered with an error
and when the client sent the valid JSON literal `null` (`JSON.parse("null")`
is a successful parse). Handlers used `if (body === null) return;` to mean
"error already sent", so a POST with body `null` fell through both branches:
no response was ever written and the request hung until the client gave up.

Errors now return a `BODY_ERROR` symbol, which can never be confused with a
parsed value; a successfully parsed `null` is additionally rejected outright
with 400 ("body must be a JSON object") because no endpoint accepts a null
body. All five handlers check `body === BODY_ERROR`.

The HTTP test posts the literal body `null` to both the anonymous response
endpoint and the authorized form-creation endpoint: each must answer 400
promptly, and the store must be unchanged afterwards. The test runs under a
5-second abort signal and drops the server's sockets in a `finally`, so a
regression fails the test quickly instead of hanging the run. Verified both
ways: with the fix reverted the test fails, with it the suite is green.

## The merge with main (builder step)

Main carried the merged builder step (post-17), which had evolved the same
files from the same base. Conflicts were resolved in main's favour — its
versions went through four review rounds — and each round-1 requirement was
then audited in the merged tree:

- static asset serving: main's `serveStatic` + its content-type test
- writable container data dir: main's Dockerfile (`chown node:node /data`,
  `DATA_DIR=/data`)
- owner authorization: main's OwnerAuth (claim/login, ADMIN_TOKEN pinning),
  anonymous-denied tests kept
- runner auto-advance guards: main moved the flow into public/flow.js;
  flow.test.js covers rapid re-picks, navigation cancelling the timer, single
  in-flight submission, and stale callbacks after completion
- prototype-safe ids/answers: main rejects `__proto__`/`constructor`/
  `prototype` outright and builds answers with `Object.create(null)`
- strict numeric validation: main's `numericValue` rejects arrays, objects
  and booleans

The branch's old runner-dom tests targeted the replaced inline runner. The
page-level journey test was adapted to main's runner.js (flow.js is now a
separate script, loaded as a prelude; fake-dom's emit learned to pass
keyboard event properties). The three timer-guard DOM tests were dropped:
that logic lives in flow.js now, where flow.test.js covers it. One small
runner bug surfaced while adapting: showDone passed 100 to setProgress, which
expects a 0–1 fraction, painting the bar at 10000% width — fixed to 1.
