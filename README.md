# About this repository

This repository holds an open-source product that is built in the open by an autonomous agent
together with the people who hold its token. The agent writes the code, decides what to build
next and ships it. Holders steer the work: they post ideas, discuss them and vote on what
matters most. Everything the agent builds is public, here, from the first commit.

## The product

- **Accounts** — owners sign up with email and password (no verification
  email: this stack has no mail service, so the address is the sign-in
  credential). Every form belongs to the account that created it; one
  account never sees another's.
- **The form runner** — a form served at a shareable public link (`/f/<slug>`)
  that asks one question at a time, validates as it goes and stores every
  response server-side. Question types: text, email, number, choice and
  rating; each question is required or optional.
- **The dashboard** (`/dashboard`) — the owner's home: lists every form with
  its response count, opens a form's responses as a table, exports them as
  CSV, publishes/unpublishes, and deletes a form together with its responses.
- **The builder** (`/builder`) — create a form blank or from the starting
  template; add, edit, reorder and remove questions; save; publish; copy the
  share link.
- **Billing** (`/billing`) — the free tier and the paid plan, payable in
  test USDC verified on-chain by the product itself.
- **A seeded starting template** — on first boot, a ready-made "Client
  enquiry" form is created and published at `/f/enquiry`, so a first form
  takes minutes, not an hour. It is seeded exactly once (marked durably), so
  deleting every form does not bring it back on a restart.
- **Durable storage** — form definitions and responses live as JSON files
  under `DATA_DIR` (default: a mounted `/data` volume when present, else
  `./data`; the Docker image defaults to `/data`). Every write goes through a
  temp-file rename, so a crash cannot leave a half-written store behind; on
  boot the store is read back. The restore path is covered by tests.

- `POST /api/auth/*` — email + password accounts; every form belongs to its creator.
- `/builder` — create and edit questions, publish, get the share link.
- `/f/<slug>` — the runner, one question at a time, with validation on both ends.
- `/dashboard` — responses per form, counts, CSV export, deletion.
- `/billing` — the paid plan.

## Plans

- **Free**: 25 responses a month across your forms; the runner shows a
  "Built with OpenTypeform" badge.
- **Pro, $9 per 30 days**: 1,000 responses a month; unbranded runners.

Enforcement is real: over the limit, collection pauses — the runner tells the respondent and
further submissions are refused until the plan is paid or the month rolls over.

## Payments (test USDC — tests, clearly labelled)

The $9 plan is paid in **test USDC** on the **Base Sepolia** testnet. Every payment on the
billing page is labelled as a test because that is what it is: no real money changes hands.

How it works, verified in the product itself:

1. Starting a payment generates the product its own receiving keypair (secp256k1 via
   node:crypto, address from keccak-256) and shows the address.
2. The payer sends exactly 9 test USDC to that address from any wallet.
3. The server reads the USDC balance of that address through a JSON-RPC node
   (`RPC_URL`, default `https://sepolia.base.org`) and credits one 30-day plan per whole
   9 USDC that arrived and was not credited before. The state is on disk, so a restart
   neither loses a payment nor credits one twice.

Token: Circle's official test USDC on Base Sepolia,
`0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals). A payer can get test USDC from
Circle's public faucet at faucet.circle.com (20 per request). Card checkout is out of scope
until a holder provides it.

## How it runs

- `Dockerfile` builds the product into one container image that serves on port 3000.
- `deploy.json` describes the services to run: their image, size, port and whether they are
  reachable from the internet. Changing this file is how the product's infrastructure changes.
- `.github/workflows/build.yml` runs on every push to the default branch: it builds the image,
  runs the tests when `package.json` has a `test` script, publishes the image to the GitHub
  container registry tagged with the commit, and records the result as `refs/ci/pass/<commit>`
  or `refs/ci/fail/<commit>`. An image named in `deploy.json` without a tag runs the commit
  being deployed.

## Development

```
npm install
npm test          # node --test
npm start         # serves on PORT, state in DATA_DIR (or /data if writable)
```

State lives in plain JSON files (`forms.json`, `responses.json`, `accounts.json`,
`sessions.json`, `billing.json`) written atomically on every mutation and read back on boot;
the restore path is covered by tests. No customer data or secrets belong in the repository.

## Licence

No licence has been chosen yet; see `LICENSE`.
