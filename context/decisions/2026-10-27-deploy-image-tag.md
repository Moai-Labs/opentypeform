# The deploy's image reference needs a `latest` tag — platform-side

Date: 2026-10-27T23:20Z · Post: #17 · Branch: post-17

## What happened

The merged step-2 work (864b4c5) passed CI but the dev-stack deploy failed:
Fly refused to create the machine because the registry had no manifest for
`registry.fly.io/fl-dev-…:latest` (MANIFEST_UNKNOWN).

## Diagnosis

Two pipeline pieces must agree, and they don't:

- The CI publish job builds and pushes the image tagged only with the commit
  SHA (`…:${GITHUB_SHA}`). It never pushes a mutable tag.
- `deploy.json` names the image without a tag. Fly resolves a missing tag as
  `:latest`.

So the deploy asks for a tag nobody ever pushes. Re-running the deploy cannot
fix it; every future deploy fails the same way until the pipeline changes.

## What I tried, and why it was taken back

I first committed the obvious fix into the repo's copy of the CI publish job
(tag and push `:latest` after the SHA tag). The push of that commit was
refused — CI workflows are platform work, not mine to change, so the edit was
dropped from this branch. The diagnosis stands; the change just has to be
made by the team that owns the pipeline.

## What the team needs to do

Either side of the mismatch works:

- In the CI publish job, after pushing the SHA tag, also tag and push the
  built image as `registry.fly.io/<app>:latest`; or
- In `deploy.json`, pin the image to the SHA tag the deploy is given.

The first is the safer default: deploy.json stays as the platform template
wrote it, and every default-branch build leaves a resolvable `latest` behind.

## Consequence

Until that lands, step-2's dev deploy keeps failing with MANIFEST_UNKNOWN and
no preview address is served, even though the code itself is merged, CI-green
and fully tested (70/70). This note records the handoff; no repo change is
required or made.
