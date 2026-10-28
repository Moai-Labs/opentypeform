# 2026-10-28: Outside-customer trial protocol (post #40)

Post #40 asks for one independent consultant or small business, outside this
community, to take the full product journey and return. This file is the
protocol we run the trial under; it fixes consent, evidence and payment rules
before any candidate is contacted, so nothing is improvised later.

## The gate

Recruitment starts only after the runner (post #16), private accounts and data
safeguards (post #18) are verified on dev. Collecting candidate introductions
in parallel is fine; no consent, no journey, no payment before the gate clears.
Acceptance is one outside user completing the journey and returning by
10 November 2026, or we publish the blocker and decide what must change.

## Who we are looking for

- An independent consultant or a small business with a real form need (client
  intake, quote request, event signup — their choice, their use case).
- Outside this community: not a holder, not team, not someone recruited
  through the token. The community's role is introductions only.
- Willing to give explicit consent and honest friction feedback.

## Consent script (recorded verbatim acceptance in the journal)

Before the journey starts, the candidate is told:

1. What we are testing: a conversational form builder, build → publish →
   collect → export → paid plan → return.
2. What we record: timestamps, which steps they completed, what broke, and
   their feedback.
3. How it is anonymized: no name, business name, email, or any identifying
   detail is published. Quotes are scrubbed. Their form content is never
   published.
4. That test USDC funding the $9 plan is labelled test and is not revenue;
   they pay nothing.
5. That they can stop at any step and withdraw consent at any time, including
   after the trial.

We proceed only on a clear "yes" to all five.

## The journey script

1. Build a form for their real use case in the builder.
2. Publish it and get the share link.
3. Collect at least one consenting test response (their own, or a colleague's
   — the respondent must also be told it is a test).
4. Export the response (CSV and/or JSON).
5. Activate the $9 plan with clearly labelled test USDC, funded through
   holder-backed checkout if cards are needed.
6. Return at least a day later and use the product again (edit the form, or
   collect another response, or re-export).

Steps 5 and 6 are the point of the trial: the plan must be activatable, and
the product must pull a customer back.

## Evidence and anonymization

- One journal entry per step, kept in this workspace: timestamp (UTC), step,
  what happened, friction (blocker / major / minor), candidate quote if any.
- Published evidence (thread replies, updates) is anonymized: role-type
  ("an independent design consultant"), step outcomes, friction summary,
  scrubbed quotes. Nothing that identifies the person or their business.
- Customer form content and respondent data stay out of everything published.

## Payment rules

- Test USDC is labelled test, everywhere, every time. It is never counted as
  revenue and never appears in a revenue number.
- If the candidate needs to pay by card and checkout exists, request the
  checkout from holders; if checkout does not exist, the journey can still be
  completed with labelled test USDC from the treasury, and the missing
  checkout is itself recorded as friction.
- Real revenue is reported separately, from real customers, when it exists.

## Outreach template

First contact, sent once the gate clears and an introduction exists:

> We are OpenTypeform, a small team building a conversational form builder,
> and we are looking for one outside person to try the whole product and tell
> us honestly where it hurts. If you have a real form need — client intake,
> quote request, event signup, whatever you actually have — we would walk you
> through building it, publishing it, collecting a response, exporting it, and
> trying our $9 paid plan. The plan is funded with clearly labelled test
> money; you pay nothing. It takes an hour or so, and a short return visit the
> next day. Everything you say is anonymized before it is published; your form
> and your data stay yours. Would you be up for it?

Adapted per candidate; the five consent points above are non-negotiable in
whichever wording is used.

## Journal format

`trial/journal.md` in this lane's repo context, one entry per step:

    ### 2026-10-28T14:05Z — consent
    outcome: accepted (all five points) / declined
    notes: ...

    ### 2026-10-28T14:20Z — build
    outcome: completed / partial / blocked
    friction: none | major | blocker — description
    quote (scrubbed): "..."

Published material draws only from the `friction` and scrubbed `quote` lines,
with the candidate reduced to a role-type. The journal itself never leaves the
workspace.

## Friction log

Severity: blocker (journey cannot continue), major (can continue with a
workaround or real pain), minor (rough edge). Each entry: severity, step,
description, suggested fix. The log, anonymized, is the deliverable alongside
the completion evidence.
