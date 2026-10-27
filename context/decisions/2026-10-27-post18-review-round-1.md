# Post-18 review round 1: what was wrong and how it was fixed

The platform's review of the accounts-and-billing step (post-18) asked for
nine changes. This note records what each one was and how it is fixed, so
the next person reading the diff does not have to re-derive it.

## What the review found, and the fixes

1. **The billing page crashed on both branches of its renderer.**
   `public/billing.js` built its children into an array and then called
   `children.append(...)`, which Arrays do not have — the page stayed on its
   loading screen forever, taking the whole payment journey with it. The
   panels are now added with `push` and handed to `replaceChildren`. A new
   `test/billing-dom.test.js` runs the real page script in a mini-DOM for
   free and paid accounts.

2. **The builder's `el()` helper dropped DOM children.** Already fixed on
   the post-17 branch (the helper now takes any mix of nodes and text); this
   branch merged that fix in rather than duplicating it.

3. **The dashboard lost its heading and New form button to the same
   `el()` bug.** Same story: fixed upstream on post-17, merged here, and
   its DOM test was retargeted at the accounts world (it stubs `/api/me`
   and the account header now exists in the fake document).

4. **A submission could slip past the cap.** `submitResponse` checked the
   plan limit before awaiting the request body, so N concurrent requests
   could all pass at usage 24 and all be written. The route now re-reads
   the form after the body arrives (so an unpublished or deleted form, or
   an edited question set, is judged as it stands at write time), and the
   final limit check and the write run with no await between them — within
   one process, exactly one of two racing submissions can be the 25th. A
   test fires two submissions at one remaining slot and expects one 201 and
   one 402.

5. **Deleting a form refunded the month.** Usage was derived from
   responses belonging to forms that still exist, so collect 25, delete,
   repeat, was an unlimited plan. Usage is now charged into its own
   `usage.json` when a submission is accepted, survives deletion and
   restart, and expires only when the calendar month rolls over. Stores
   that predate the file keep their counts: the effective usage is the
   larger of the persisted count and what retained responses show, which
   also heals a crash between the response write and the usage write.

6. **The runner repainted over its own pause and retry screens.** The flow
   called `hooks.refresh()` after every non-true submit result, so a
   mid-conversation 402 immediately repainted the last question over the
   pause screen. `false` now means "the submit hook rendered the whole
   outcome — leave the screen alone"; `{ field }` navigates to the rejected
   question (updating the real step), `{ error }` parks on the retry
   screen. A test holds the pause screen up mid-conversation and asserts
   nothing repaints it.

7. **A renewal "confirmed" itself instantly.** The polling logic treated
   any paid plan with nothing awaited as proof of the new payment, so
   clicking "Extend" on a paid account confirmed on the spot. Confirmation
   is now keyed to what changed: a first payment confirms when the plan
   turns paid; a renewal only when the expiry moves past where it stood
   when the payment was started. The server reports `awaiting` while
   uncredited test USDC actually sits on the address (balance minus
   credited units at or above one price), and always includes the
   receiving address as `payment`, so a page reloaded mid-renewal keeps
   the address and the waiting state up. The billing DOM test walks a
   renewal with an unchanged balance (still waiting) and then a further 9
   USDC (confirmed).

8. **Payment keys with leading zero bytes vanished on restart.** Node's
   ECDH hands out minimal hex, so roughly one key in 256 was saved shorter
   than 32 bytes, and the address re-derivation rejected anything that was
   not exactly 32 — the receiving address and paid entitlement silently
   disappeared. Keys are now saved zero-padded to 64 hex characters, and
   re-derivation accepts any valid scalar encoding up to 32 bytes
   (including the odd-length minimal hex older records were saved with).
   A record whose key still cannot be derived is kept on its stored
   address and logged rather than dropped. Tests cover both the padding
   and the restore.

9. **Question ids could be stolen by new questions.** Also fixed upstream
   on post-17 (all existing ids are reserved before fresh ones are
   assigned, and the editor adopts the server's normalized ids after each
   save); merged here with its tests.

## Verification

77 tests pass, including the end-to-end acceptance journey (sign up, 25
responses, the 26th refused with 402, a 9-USDC payment, the limits lift and
the badge goes) and the same walk by hand against a live server.
