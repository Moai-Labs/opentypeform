# 2026-10-27 — Post-17 review round 3: how the fixes work

The platform's review of post-17 at 737e30c requested four changes. What I
chose and why.

## updateForm: merge into the live form, never a stale copy

The handler read the form, then awaited the request body. Anything could
happen in between: an intervening publish/unpublish or edit would be
silently undone when the pending update merged into its stale copy, and a
delete-then-recreate under the same slug would let the pending update
overwrite the replacement with the deleted form's definition.

Now only the targeted form's *identity* is captured up front. After the
body is read and validated, the live form is fetched again: gone → 404;
present but a different form → 409 (the slug was deleted and recreated —
the caller should reload and retry); same form → merge into the live
definition. The identity check and the `replaceForm` sit together with no
await between them.

Identity needs more than the slug, so every form created now carries an
`id` (a random UUID from the same source as response ids; `normalizeUpdate`
never lets a caller set it). Forms that predate this change have no `id`:
`undefined === undefined` merges as before, while a replacement created
under a deleted slug always has a fresh `id`, so the conflict is still
detected. Regression tests pause a PUT body mid-flight over a raw socket
and cover both an intervening unpublish (not undone) and delete+recreate
(409, replacement untouched), plus delete-alone (404).

## Deletion: journalled and finished on boot

`deleteForm` rewrote `forms.json` before `responses.json`; a crash between
the two writes left the form durably deleted with its responses still on
disk, and recreating the slug would expose them. Now the deletion writes a
small journal entry (`delete-journal.json`, `{ slug }`) *before* touching
either data file, then rewrites both, then removes the journal. The
constructor's `load()` calls `finishInterruptedDeletions()`, which applies
the journalled deletion idempotently to whatever is on disk, rewrites both
files and clears the journal — so boot finishes any interrupted deletion
before the server can serve or a slug can be recreated. Tests interrupt
the deletion at both write boundaries by throwing from the save hooks and
verify the restart finishes it and recreating the slug finds no old
responses.

## Seeding: an existing empty store is not a fresh deployment

Round 2's migration-aware seed recognised populated pre-marker stores but
still treated an existing `forms.json` holding `[]` as a fresh deployment
and re-seeded the template. The store now records, at load time, whether
`forms.json` existed on disk (`store.preexisting`). `seedIfNeeded` marks
any pre-existing store as initialized without inserting a template —
populated or deliberately emptied — while a genuinely fresh store (no
`forms.json` at all) still seeds. The interrupted-first-seed recovery is
preserved by the same rule: a crash after the template was written leaves
a `forms.json` behind, so the restart takes the mark-only path. Tests
cover an existing empty pre-marker store (twice over, for durability) and
a fresh store still seeding.

## Legacy answers: backfill the schema before editing questions

Responses collected before schema snapshots existed carry no `schema`, so
`responseColumns` built its union from the current questions plus recorded
schemas only: removing a question hid those answers, and relabelling
relabelled them. Two parts:

- `updateForm` now calls `store.backfillSchemas(slug, live.questions)`
  before any edit that touches the questions — every schema-less response
  of that form durably receives the *pre-edit* question list, which is the
  schema those answers were actually collected under.
- `responseColumns` adds a final pass: any answer id no current question
  and no recorded schema names (an answer orphaned by a pre-migration
  edit) gets its own column, labelled by its id — the only name left for
  it. `cellValue` lets any response that actually carries that answer id
  contribute it. Nothing collected can become invisible in the dashboard
  table or the CSV.

Tests: an HTTP test strips a stored response's schema, edits (relabel +
remove) through the API, and asserts the response now carries the pre-edit
schema and the export keeps the original labels and answers; a second
drives the orphan case (a pre-migration edit already removed the question,
so the backfill can't know it) and asserts the orphaned answer still
exports in a column of its own; a dashboard DOM test renders schema-less
responses and asserts the table shows them, orphan column included.
