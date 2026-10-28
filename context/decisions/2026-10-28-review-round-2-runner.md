# 2026-10-28: Runner review round 2 (post #16) — the JSON null body

## The bug

`readJsonBody` returned `null` both when it had already answered with an error
and when the client sent the valid JSON literal `null` (`JSON.parse("null")`
is a successful parse). Both handlers used `if (body === null) return;` to
mean "error already sent", so a POST with body `null` fell through both
branches: no response was ever written and the request hung until the client
gave up.

## The fix

Errors now return a `BODY_ERROR` symbol, which can never be confused with a
parsed value; a successfully parsed `null` is additionally rejected outright
with 400 ("body must be a JSON object") because neither endpoint accepts a
null body. The handlers check `body === BODY_ERROR`.

## The test

One HTTP test posts the literal body `null` to both `POST /api/forms/<slug>/responses`
(anonymous) and `POST /api/forms` (authorized): each must answer 400 promptly,
and the store must be unchanged afterwards. The test runs under a 5-second
abort signal and drops the server's sockets in a `finally`, so a regression
fails the test quickly instead of hanging the whole run. Verified both ways:
with the fix reverted the test fails (`not ok`), with it the suite is 32/32.
