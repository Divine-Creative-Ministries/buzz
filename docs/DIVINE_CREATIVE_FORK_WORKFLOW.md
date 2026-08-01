# Divine Creative Fork Workflow

This document defines how Divine Creative Ministries maintains and deploys its
Buzz fork without losing local work when the upstream project changes.

## Repository and Branch Roles

| Name | Role |
| --- | --- |
| `block/buzz` (`upstream`) | Official Buzz source and destination for generally useful contributions |
| `Divine-Creative-Ministries/buzz` (`origin`) | Divine Creative fork |
| `main` | Exact, fast-forward-only mirror of `upstream/main`; no Divine Creative commits |
| `dcm-production` | Long-lived integration branch for reviewed Divine Creative changes |
| `agent/*` | Short-lived implementation or upstream-sync branches targeting `dcm-production` |

Keep the two lines of work separate:

- Fixes and features useful to the wider Buzz project should be developed from
  `upstream/main` and proposed to `block/buzz` under its contribution rules.
- Divine Creative branding, private integrations, environment-specific
  behavior, and deployment configuration belong on branches targeting
  `dcm-production`.
- A broadly useful experiment may begin downstream behind a feature flag, then
  be cleaned up and submitted upstream as a separate change.

## Normal Development

1. Fetch current state from both remotes.
2. Create an `agent/<short-description>` branch from `origin/dcm-production`.
3. Make focused commits that follow the upstream project's conventions,
   including DCO sign-off where required.
4. Run the relevant quality gates and tests.
5. Open a pull request into `dcm-production`. Merge only after review and green
   checks.

Do not push feature commits directly to `main` or `dcm-production`.

## Bringing in Upstream Updates

The safe update sequence is:

```bash
git fetch origin --prune
git fetch upstream --prune

git switch main
git merge --ff-only upstream/main
git push origin main

git tag -a "dcm-before-upstream-YYYYMMDD-HHMM" origin/dcm-production \
  -m "Divine Creative state before upstream sync"
git push origin "dcm-before-upstream-YYYYMMDD-HHMM"

git switch -c "agent/sync-upstream-YYYYMMDD" origin/dcm-production
git merge --no-ff origin/main
```

Replace the timestamp placeholders with the actual UTC date and time. Then:

1. Inspect every conflict in the context of both upstream intent and Divine
   Creative's intended behavior.
2. Resolve overlaps manually. Do not use blanket `ours`, blanket `theirs`, or
   "accept all" commands.
3. Review migrations, configuration defaults, external protocols, and client
   behavior even when Git reports no textual conflict.
4. Run `just ci` plus any relevant relay, desktop, mobile, pairing, migration,
   and end-to-end checks.
5. Open a pull request from the sync branch into `dcm-production`. Document
   conflicts, decisions, test evidence, and any deployment or migration notes.

Git normally stops on conflicting edits rather than silently choosing one.
The review and test steps protect against semantic conflicts, where both sets
of code merge cleanly but no longer behave correctly together.

If upstream later implements the same general feature as the fork, remove the
downstream duplicate in a separate reviewed change after verifying that the
upstream behavior fully replaces it.

## Deployment Rules

A merged pull request is not permission to deploy. Deployment must be requested
explicitly and must use a reviewed commit from `dcm-production`.

- Never use the live VPS as a development workspace. Do not hand-edit
  `/opt/buzz`, files inside running containers, or production database state to
  implement a feature.
- Build and publish an immutable image tag, such as
  `ghcr.io/divine-creative-ministries/buzz:dcm-<git-sha>`. Record the complete
  source commit and resulting image digest.
- Before deployment, protect the root-only environment/configuration files and
  create recoverable backups of PostgreSQL, object/media storage, and any
  persistent Git data. Validate restoration in an isolated environment when
  practical.
- Record migration expectations before starting. Do not assume a previous
  binary can safely run after a one-way schema migration.
- After deployment, run service health checks and representative desktop and
  mobile smoke tests.
- Keep the previous image, configuration, and recovery instructions available
  until the new version is proven healthy.

Secrets, private keys, `.env` contents, backup archives, and production data
must never be committed to Git or attached to a public pull request.

## Conflict and Recovery Rules

- Never rewrite or force-push the protected branch histories to simplify a
  sync.
- Never delete a local change only because it conflicts. Preserve it, adapt it,
  or remove it intentionally with a documented reason.
- If a merge becomes unsafe or unclear, abort it and return to the pre-sync tag
  rather than improvising on production.
- Keep changes small enough that a reviewer can identify which behavior is
  upstream, which is Divine Creative-specific, and why both are needed.

This workflow preserves three independent recovery points: the untouched
upstream mirror, the pre-sync production tag, and the previous deployed image.
