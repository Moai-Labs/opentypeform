# Decision: private accounts, plans, and test-USDC payments (2026-10-27)

Post #18, the third step of adopted direction #5.

## What was built

- **Accounts** (`lib/accounts.js`): email + password sign-up/sign-in, salted scrypt hashes,
  30-day bearer session tokens (HttpOnly cookie for browsers, `Authorization: Bearer` for API
  clients). The single owner token of steps 1–2 is gone: `lib/owner.js` was deleted and its
  claim/login endpoints replaced by `/api/auth/*`. There is no email verification — the stack
  has no mail service, so the address is the credential only, and the UI says so.
- **Ownership**: every form carries `ownerAccountId`. The owner API is scoped to the account's
  own forms; another account's form 404s exactly like a missing one (no enumeration). On the
  first sign-up of a deployment, the ownerless forms left by steps 1–2 (the seeded template)
  are adopted by that account.
- **Plans** (`lib/billing.js`): free = 25 responses/month, branded runner; paid ($9 per
  30 days) = 1,000 responses/month, unbranded. Usage is counted across all of the account's
  forms in the current UTC month (`Store.countMonthlyForOwner`). Enforcement is real:
  `publicForm` reports `paused: true` and `submitResponse` answers `402 plan_limit`; the
  runner shows a pause screen. Nothing is deleted on lapse — the plan just reads as free.
- **Payments**: test USDC on Base Sepolia (Circle's official test token
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals), labelled as tests everywhere
  money appears. `POST /api/billing/start` gives the account its own receiving keypair
  (`lib/eth.js`: node:crypto secp256k1 + keccak-256 from `@noble/hashes`, the repo's first
  dependency). `GET /api/billing/status` reads the address's `balanceOf` through a public RPC
  (`RPC_URL`, default `https://sepolia.base.org`) and credits one 30-day plan per whole 9 USDC
  beyond what was already credited, stacking expiry on expiry.

## Why these choices

- **Public testnet, not a platform chain**: the platform exposes none, so a public testnet with
  Circle-issued test USDC is the honest reading of "test USDC on this stack". Facts verified
  this session on-chain and via Circle's docs and faucet (see the workspace source ledger).
- **Keypair per account, balance-based credit**: no third-party payment service, no signer
  infrastructure, no way for someone to redirect payments — the product only watches an address
  it generated. A payment may overpay or pay in chunks; crediting is per whole 9 USDC and
  persists, so restarts neither double-credit nor lose payments.
- **Free cap pauses collection account-wide**: the direction says "over the free limit,
  collection pauses" — a limit on the owner, not per form, so the pause is honest and simple.
- **The submit rate limiter (100/min) sits above the free cap (25/month) on purpose**: abuse
  protection must never be the wall a legitimate tester hits before the plan is.

## Consequences / notes

- Card checkout remains out of scope until holders provide it.
- Receiving keys live in `billing.json` inside DATA_DIR. They only ever receive test USDC;
  before any real-money payment this needs a proper review (and a real payment rail).
- The throttle on chain reads is per process, in memory — a restart must always be able to
  re-check the chain (a persisted throttle once skipped the crediting read; caught by test).
- Live walkthrough of the acceptance journey done against a local server with a mock RPC:
  sign-up adopts the template, 25 responses land, the 26th is refused 402 with the runner
  paused, a (mock) 9-USDC payment lifts the limits and removes the badge. The same mock at
  2,304 USDC correctly credited 256 stacked 30-day windows — the ledger arithmetic is exact.
