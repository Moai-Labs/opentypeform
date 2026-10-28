# 2026-10-27 — Post-17 review round 2: how the fixes work

The platform's review of post-17 (builder/dashboard/export) requested four
changes. What I chose and why.

## Share inputs

`el("input", "share", url)` appended the URL as a *text child*, which never
sets an input's value — both share boxes rendered empty and the builder's
copy button copied `""`. Both pages now create the input bare and assign
`share.value = <url>` explicitly. DOM tests in both suites spy on
`navigator.clipboard` (passed through `runPage`) and assert the input value
*and* the string handed to the clipboard.

## Question ids: creation-time, not save-time

Round 1 reserved removed ids only in the live editor's `state.retired`, so
remove → save → reopen → add could hand `q1` out again. Now a new question
gets its id the moment it is created (`freshId()`): `q_` + 12 hex chars of
`crypto.randomUUID()`. That space is disjoint from the server's legacy
`qN` ids, so a fresh editor session can never collide with an id retired in
an earlier session — there is no "first free qN" race left. `withIds` keeps
existing ids unchanged on save and remains the fallback for questions that
arrive without an id (legacy templates), still honouring `state.retired`
within a session. The editor still hydrates from every save response.

## Seeding: migration-aware and idempotent

`seedIfNeeded` no longer equates "no marker" with "fresh deployment":

- marker present → never touched (an emptied store stays empty);
- no marker but forms exist → a store that predates the marker: mark it,
  insert nothing (old deployments get no duplicate enquiry slug);
- no marker, no forms → seed, then mark.

Because the form write and the marker write are each atomic and the
mark-only path recognises a store that already holds the template, a crash
between the two writes can never duplicate the enquiry slug on restart:
the restart either sees the template (marks and moves on) or an empty store
(seeds once). Covered by tests for a populated pre-marker store and an
interrupted first seed.

## Submission vs deletion race

`submitResponse` read the form, then awaited the body — the owner could
delete the form in that window and the captured definition would store an
orphaned response (visible again if the slug was recreated). After the body
arrives the handler re-reads the live form and requires it to still exist
and be published; that final check and `store.addResponse` sit together
with no `await` between them, and the schema snapshot uses the live
definition. The regression test opens the submission by hand (raw socket),
sends a partial body, deletes the form mid-flight, completes the body, and
asserts a 404 and zero responses — including under a recreated form with
the same slug.
