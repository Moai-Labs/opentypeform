# 2026-10-27 — Post-17 review round 1: how the fixes work

The platform's review of post-17 (builder/dashboard/export) requested seven
changes. What I chose and why.

## DOM: variadic `el`

`el(tag, cls, text)` was called with child nodes in builder.js and
dashboard.js, so controls were stringified or dropped. `el` now takes
`(tag, cls, ...children)` and appends nodes, arrays and text. runner.js
kept its text-only `el` because every call there passes text.

Tests run the real page scripts in `test/fake-dom.js`, a dependency-free
mini DOM (element, selectors, event emit) executed in a `vm` sandbox with a
stubbed fetch. No jsdom: the repo has zero dependencies and CI must not
need a package install.

## Question ids

`withIds` now reserves every id already present *and* every id removed this
session (`state.retired`), so a new question moved before an existing one
can't steal its id and a deleted question's id is never reused. After each
successful save the editor hydrates questions/published state from the
server's response, so the next edit builds on the saved ids.

## Historical answers

Each stored response carries `schema: [{ id, label }]` — the questions the
respondent actually saw (captured in `submitResponse`). Columns for the
dashboard table and CSV export are built by the shared module
`public/columns.js` (UMD, like flow.js; served as `/columns.js`): the union
of current questions and stored schemas, keyed by **id + label**, current
form first. A removed question keeps its column under its own label; a
relabelled question keeps its history in a separate column instead of
re-labelling old answers. Responses stored before schemas existed fall back
to mapping by id.

## Submission failures

`flow.submit`'s hook now resolves `true`, `{ field, message }` or
`{ error }`. The flow itself unlocks, moves `step` to the rejected question
with its error, or parks on a failure state (`flow.failed`) rendered by a
new `hooks.error`. `flow.retry()` returns to the question the respondent was
on. The runner only fetches and maps results; it never paints over an
outcome. The old bug: the runner called `showStep(i)` without touching
`flow.step`, and the flow's post-failure `refresh()` repainted the last
step over it.

## CSV formula mitigation

Minus-prefixed strings are defused too (`-1+1` → `'-1+1`), but a strict
numeric check (`^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$`) keeps legitimate
negative numbers as numbers.

## Seeding

`seedIfNeeded` sets a durable `seeded` marker in a new `meta.json` store
file, so an intentionally emptied store stays empty across restarts.
