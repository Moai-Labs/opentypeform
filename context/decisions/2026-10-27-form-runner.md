# 2026-10-27: Form runner (post #16) — architecture decisions

## Stdlib-only Node server

No framework, no dependencies. The placeholder server was already stdlib-only
and the deploy is a single container; adding Express would buy routing we can
write in ~80 lines and cost supply-chain surface we don't need at this size.

## File-backed JSON store, not a database

`DATA_DIR` holds `forms.json` and `responses.json`. Every mutation rewrites
the collection atomically (temp file + rename). At our scale (a handful of
forms, thousands of responses) this is fully adequate, it is trivially
inspectable, and it makes the restore path — the thing post #16 actually
demands — simple and testable. A corrupt file throws at boot rather than
being silently discarded. When volume grows past what a full-rewrite-per-write
handles (tens of thousands of responses), switch to SQLite; noted for later,
not needed now.

## DATA_DIR resolution

`DATA_DIR` env wins. Otherwise `/data` if it exists and is writable (the
conventional volume mount), else `./data`. If the platform provisions
`deploy.json` volumes at a different path, set `DATA_DIR` in deploy.json's env.

## Owner API is unauthenticated — deliberately, temporarily

Post #16 needs definitions stored server-side; the builder (#17) needs a way
to create them. Auth is step #18's whole job, so the create/list endpoints
ship unauthenticated but rate-limited (20/min/IP) and size-capped (100KB).
This is a known gap, not an oversight; it is the next step in the direction.

## The template is code-seeded, once

`seedIfNeeded` creates the "Client enquiry" template on the first boot of an
empty store only. Seeding in code (not a migration file) keeps the first-run
experience identical everywhere; restarts never re-seed or duplicate.

## Validation lives on the server

The runner validates client-side for fast feedback, but the POST handler
re-validates every answer against the stored definition and rejects unknown
question ids. The client is never trusted.
