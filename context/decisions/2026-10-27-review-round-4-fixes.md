# 2026-10-27 — Post-17 review round 4: how the fixes work

The platform's review of post-17 at 19d04d7 requested three changes. What I
chose and why.

## submitResponse: identity, not just existence (lib/app.js)

After awaiting the body, the handler re-checked only that a *published
form* still lived under the slug — but a deleted-and-recreated slug also
satisfies that, so a submission caught in flight would be validated against
the replacement and stored under it, handing the deleted form's answers to
a form that never asked them.

It now captures only the targeted form's identity up front and, after the
body, compares it with the live form: gone or unpublished → 404; a
different form under the slug → 409; same form → validate and store, with
the final check and the store mutation together and no await between them
(the same shape updateForm got in round 3). The test pauses a submission
inside the body read, deletes and recreates the slug, then completes it and
asserts a 409 and an empty response list on the replacement.

## The store refuses writes while a deletion journal is pending (lib/store.js)

deleteForm writes its journal first, then both data files. If a write
fails, the HTTP handler catches it and the server keeps running — with the
journal still ordering a deletion and memory no longer matching disk. The
old code left the store mutable in that state: a replacement created under
the freed slug would be destroyed by the recovery on the next boot, and a
further deletion would overwrite the pending journal.

Every mutator (addForm, replaceForm, addResponse, setMeta, backfillSchemas,
deleteForm) now calls `ensureMutable()` first. While `pendingDeletion` is
set it retries the recovery once — a transient write failure clears right
there — and otherwise throws `EDELETIONPENDING`, which surfaces as a 500
with the journal intact. `tryFinishPendingDeletion()` restores the
in-memory collections when the writes fail again, so a read-only store
still reports what is actually on disk; boot recovery that cannot write
leaves the store up but read-only instead of crashing it. The test injects
a write failure mid-deletion, refuses recreation and a second deletion,
then lets the writes recover and verifies the accepted replacement survives
a reload; a second test does the same for a failure during boot recovery.

## Orphan answers are detected per response (public/columns.js)

Orphan detection used one global set of covered ids, while cellValue
suppressed answers absent from each response's own schema. So a legacy
response backfilled *after* its question was removed — schema without the
id, answer still present — was hidden whenever another response's schema
did name that id: no orphan column was created, and the schema check
blanked the cell. The answer vanished from the table and the CSV.

Columns are now built per response: a response *with* a schema gets an
unknown-schema column for any answer id its own schema does not name; a
response *without* a schema keeps the old rule (an id nothing covers gets
an orphan column). The orphan column carries `covered: true` when a
schema-backed column for the id also exists, and cellValue routes
accordingly: a schema-bearing response contributes only when its own schema
lacks the id (so an answer never appears in both columns); a schema-less
response maps by id alone into the recorded column when one exists,
otherwise into the orphan one. CSV and dashboard regressions both pair a
backfilled legacy response with a schema-omitted answer and another
response whose schema names that id.
