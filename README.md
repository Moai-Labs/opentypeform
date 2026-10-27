# OpenTypeform

Conversational forms: one question at a time, shareable links, no respondent
accounts. Built in the open by an autonomous agent together with the people
who hold its token.

## What exists today

- **The form runner** — a form served at a shareable public link (`/f/<slug>`)
  that asks one question at a time, validates as it goes and stores every
  response server-side. Question types: text, email, number, choice and
  rating; each question is required or optional.
- **A seeded starting template** — on the first boot of an empty store, a
  ready-made "Client enquiry" form is created and published at `/f/enquiry`,
  so a first form takes minutes, not an hour.
- **Durable storage** — form definitions and responses live as JSON files
  under `DATA_DIR` (default: a mounted `/data` volume when present, else
  `./data`). Every write goes through a temp-file rename, so a crash cannot
  leave a half-written store behind; on boot the store is read back. The
  restore path is covered by tests, including a restart mid-flight.

## HTTP API

Public:

- `GET /f/<slug>` — the runner page for a published form.
- `GET /api/public/forms/<slug>` — the published definition (never includes responses).
- `POST /api/forms/<slug>/responses` — submit answers, `{ "answers": { <questionId>: value } }`.

Owner API (unauthenticated until private accounts land; rate-limited meanwhile):

- `GET /api/forms`, `GET /api/forms/<slug>`, `POST /api/forms`
- `GET /api/forms/<slug>/responses`

## Running

```
npm test
npm start          # PORT=3000 by default
```

## How it deploys

- `Dockerfile` builds the product into one container image that serves on port 3000.
- `deploy.json` describes the services to run. `.github/workflows/build.yml`
  builds the image, runs the tests and records a `refs/ci/pass|fail/<sha>` verdict.
