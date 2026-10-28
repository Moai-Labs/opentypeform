# Outside-customer trial journal (post #40)

One entry per step. Never leaves the workspace; published material is drawn
from it, anonymized. Protocol: ../2026-10-28-outside-customer-trial.md

## Gate status

- Post #16 (runner): verified on dev 2026-10-28T05:13Z (delivery 620a8c9, preview HTTP 200)
- Post #18 (private accounts + data safeguards): review round 2 changes addressed 05:47Z, awaiting review round 3 of 5
- Gate cleared at: —

## Introductions

(none yet — candidates appear here after the gate clears, pseudonymous)

## Journal

(empty until consent)

## Operator rehearsal (2026-10-28, before recruitment — no candidate involved)

Ran the journey's owner-facing half against the running code (local instance
on the same commit family as dev, 620a8c9; public path also probed on the
live dev preview). Purpose: surface friction before an outsider hits it.
Steps rehearsed: claim → build form from template → publish → open share
link → submit response → list → CSV export → restart → response survived.

Results: every step worked end to end. Validation errors are clear and
field-scoped ("This question is required.", "Please enter a valid email
address.", "Please pick one of the listed options."). Export CSV carries a
header row of question labels plus submittedAt, and answers survive a server
restart. The live dev stack accepted a clearly-labelled rehearsal response
on the seed form (marked as test data, safe to delete).

Not yet rehearsable on dev: sign-up, per-account ownership, the $9 plan
activation and the cap pause — those live on the unmerged post-18 branch.
Rehearse them the moment the gate clears, before any candidate is contacted.

### Rehearsal friction

- minor / build-export: the create-form response leads with a UUID `id`,
  but every follow-up route (submit, list, export) keys on `slug`. UI
  users never see this; an integrator would trip. Suggested fix: return
  `slug` at least as prominently, or accept either.
- minor / export: CSV is the only download the dashboard offers; JSON
  responses exist behind the owner API but there is no "download JSON"
  button. The protocol needs only "CSV and/or JSON", so this passes, but
  the button would remove the ambiguity for non-technical candidates.
- context, not friction: on the current deployment the first person to
  open the dashboard claims the whole deployment (pre-accounts model).
  Exactly why the gate exists — the trial must not start on this model.
