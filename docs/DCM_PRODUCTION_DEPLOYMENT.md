# Divine Creative Production Deployment

This is the operating contract for `buzz.divinecreative.org`. It applies to
humans, coding agents, GitHub Actions, and VPS operators.

## Deployment Authorization

Merging a pull request into `dcm-production` authorizes and automatically
starts a production deployment. Do not merge work that is experimental,
partially tested, waiting on configuration, or not intended for immediate
production use.

The fork's `main` branch never deploys and remains an exact upstream mirror.
Feature branches and upstream-sync branches target `dcm-production` through
pull requests. Direct pushes and force-pushes to either protected branch are
prohibited.

Set the repository variable `DCM_DEPLOY_PAUSED=true` before merging when a
maintenance window, external dependency, unsafe migration, or production
incident makes automatic deployment inappropriate. While paused, the workflow
still builds and attests the immutable image but does not contact the VPS.
Unpausing and manually dispatching the workflow from `dcm-production` deploys
the current approved commit.

## Trust Boundary

The workflow `.github/workflows/dcm-production-deploy.yml`:

1. Validates the DCM deployment scripts.
2. Builds the exact `dcm-production` commit for Linux AMD64.
3. Publishes `ghcr.io/divine-creative-ministries/buzz:dcm-<full-sha>`.
4. Records the immutable digest and creates GitHub build provenance.
5. Verifies that provenance before the deployment job starts.
6. Uses the GitHub `production` environment to request deployment over SSH.

The environment contains only a dedicated SSH private key. Its matching public
key is installed for the VPS user `buzzdeploy` with a forced command and SSH
forwarding disabled. The key cannot open a shell. It can request only a deploy
of the expected GHCR repository using a full commit SHA and SHA-256 digest.

The GitHub runner pins the VPS's Ed25519 host key with strict host-key checking.
The VPS pulls by digest, then verifies the image's
`org.opencontainers.image.revision` label matches the requested commit.

## On-Host Deployment

`/usr/local/sbin/buzz-deploy` is root-owned and serialized by
`/run/lock/buzz-deploy.lock`. A deployment performs these steps:

1. Pull and verify the candidate image without changing running services.
2. Record the current SQLx migration version.
3. Stop the relay and pairing write paths for a consistent backup window.
4. Create a PostgreSQL custom-format dump and archives of MinIO media, Git
   objects, and Redis state under `/var/backups/buzz`.
5. Copy the root-only environment and deployment configuration into that
   root-only backup and generate SHA-256 checksums.
6. Retain the ten newest pre-deployment backups.
7. Pin both relay and pairing services to the candidate image digest.
8. Start the stack and wait for Compose health checks.
9. Verify public liveness, readiness, NIP-11, TLS routing, and the `/pair`
   WebSocket upgrade.
10. Record the successful commit, digest, and migration version in
    `/var/lib/buzz-deploy`.

Deployment events are written to `/var/log/buzz-deploy.log`, the system journal,
and the GitHub Actions run. Secret values are never logged.

Backups on the VPS are fast rollback safeguards, not disaster recovery for a
lost server. Copying encrypted backups to the Divine Creative NAS remains a
separate infrastructure task.

## Failure and Rollback

If the candidate fails and the SQLx migration version did not change, the
deployment script automatically restores the preceding image overlay, starts
the prior release, and verifies its health.

If the migration version changed, automatic binary rollback is prohibited. An
older binary may not understand the new schema. The workflow fails and operator
review is required; recovery may require restoring the complete pre-deploy
backup. Never improvise a database downgrade.

Changes under `migrations/` therefore require explicit migration and recovery
notes in the pull request. Pause automatic deployment before merge unless the
change is demonstrably backward-compatible and the recovery procedure has been
tested.

## Operator Commands

Run these through the existing `buzzops` account with `sudo`:

```bash
sudo buzzctl status
sudo buzzctl config >/dev/null
sudo buzzctl logs relay
sudo buzzctl backup
sudo buzzctl rollback
```

`rollback` refuses to proceed when the current database migration version does
not match the previous release's recorded version.

Root-owned deployment scripts and Compose overrides do not update themselves
from GitHub. Updating those security-sensitive files requires a separate,
reviewed operator installation and validation. Ordinary application code
deploys automatically through the immutable image.

## Agent Rules

- Treat every merge to `dcm-production` as an immediate production release.
- Never add arbitrary SSH commands, secret printing, floating image tags, or
  mutable remote scripts to the workflow.
- Never broaden the `buzzdeploy` sudo or `authorized_keys` permissions.
- Never store the production environment, SSH private key, database dumps, or
  application data in the repository or workflow artifacts.
- Preserve workflow concurrency and the VPS `flock`; deployments must remain
  serial.
- Do not bypass build, attestation, backup, migration, health, or rollback
  checks to make a deployment pass.
- Deployment-infrastructure changes require both repository review and a
  separate root-owned VPS installation. A merge alone does not replace the
  installed trust-boundary scripts.
- If production behavior, migration safety, or recovery compatibility is
  uncertain, pause deployment before merge and ask the operator.
