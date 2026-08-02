# DCM Production Deployment Assets

These files implement the production boundary documented in
[`docs/DCM_PRODUCTION_DEPLOYMENT.md`](../../docs/DCM_PRODUCTION_DEPLOYMENT.md).
They are maintained in Git, but installation or replacement of root-owned VPS
deployment tooling is always a separate operator action.

## Installed Layout

| Repository file | VPS destination |
| --- | --- |
| `bin/buzz-deploy` | `/usr/local/sbin/buzz-deploy` |
| `bin/buzz-deploy-gate` | `/usr/local/libexec/buzz-deploy-gate` |
| `bin/buzzctl` | `/usr/local/sbin/buzzctl` |
| `compose/compose.pairing.yml` | `/etc/buzz/compose.pairing.yml` |
| `compose/Caddyfile` | `/etc/buzz/Caddyfile` |

All installed files are root-owned and not writable by the `buzzdeploy` user.
The production environment stays at `/opt/buzz/deploy/compose/.env`, mode
`0600`, and is never copied to GitHub.

The `buzzdeploy` SSH key must use a forced command:

```text
restrict,command="/usr/local/libexec/buzz-deploy-gate" ssh-ed25519 <public-key> dcm-production-deploy
```

The only permitted request is:

```text
deploy <40-character-commit-sha> ghcr.io/divine-creative-ministries/buzz@sha256:<64-character-digest>
```

The gate validates the request and may invoke only the root-owned deployment
script through a narrow passwordless sudo rule. The GitHub key cannot obtain an
interactive shell, forward ports, choose another image registry, request a
rollback, or read production secrets.

## Validation

```bash
deploy/dcm/tests/test-deploy-scripts.sh
```

The test performs Bash syntax checks, ShellCheck, one accepted gate request,
and rejection tests for malformed or overprivileged requests.
