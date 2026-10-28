# OpenTypeform

Conversational forms: one question at a time, shareable links, no respondent
accounts. Built in the open by an autonomous agent together with the people
who hold its token.

## What exists today

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
- **A seeded starting template** — on first boot, a ready-made "Client
  enquiry" form is created and published at `/f/enquiry`, so a first form
  takes minutes, not an hour. It is seeded exactly once (marked durably), so
  deleting every form does not bring it back on a restart.
- **Durable storage** — form definitions and responses live as JSON files
  under `DATA_DIR` (default: a mounted `/data` volume when present, else
  `./data`; the Docker image defaults to `/data`). Every write goes through a
  temp-file rename, so a crash cannot leave a half-written store behind; on
  boot the store is read back. The restore path is covered by tests.

## Owner access

Until private accounts land, one owner token guards every owner endpoint:

- Set `ADMIN_TOKEN` in the environment to pin it, or
- open `/dashboard` on a fresh deployment and claim the token once (generated
  for you or your own passphrase); it is persisted and survives restarts.

Browsers sign in with the token once and keep an HttpOnly cookie; API clients
send `Authorization: Bearer <token>`.

## HTTP API

Public:

- `GET /f/<slug>` — the runner page for a published form.
- `GET /api/public/forms/<slug>` — the published definition (never includes responses).
- `POST /api/forms/<slug>/responses` — submit answers, `{ "answers": { <questionId>: value } }`.
- `GET /api/template` — the starting template as a definition, for prefilling the builder.
- `GET /api/owner/status` — whether an owner token has been claimed/pinned.

Owner (token required):

- `POST /api/owner/claim` — first-run setup, accepted exactly once; `POST /api/owner/login` signs a browser in; `POST /api/owner/logout` clears the cookie.
- `POST /api/forms` — create (draft unless `"published": true`).
- `GET /api/forms` — all forms with `responseCount`; `GET /api/forms/<slug>` — one of them.
- `PUT /api/forms/<slug>` — edit title, description, questions (including order) and `published`. The slug never changes.
- `DELETE /api/forms/<slug>` — delete the form and all of its responses.
- `GET /api/forms/<slug>/responses` — every response, newest stored last.
- `GET /api/forms/<slug>/responses.csv` — the CSV export.

## Running

```
npm test
npm start          # PORT=3000 by default
```

## How it deploys

- `Dockerfile` builds the product into one container image that serves on port 3000.
- `deploy.json` describes the services to run. `.github/workflows/build.yml`
  builds the image, runs the tests and records a `refs/ci/pass|fail/<sha>` verdict.
