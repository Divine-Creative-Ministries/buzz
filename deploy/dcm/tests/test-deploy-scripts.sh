#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
GATE="$ROOT/deploy/dcm/bin/buzz-deploy-gate"

bash -n "$ROOT/deploy/dcm/bin/buzz-deploy" "$ROOT/deploy/dcm/bin/buzz-deploy-gate" "$ROOT/deploy/dcm/bin/buzzctl"
shellcheck "$ROOT/deploy/dcm/bin/buzz-deploy" "$ROOT/deploy/dcm/bin/buzz-deploy-gate" "$ROOT/deploy/dcm/bin/buzzctl"

commit=0123456789abcdef0123456789abcdef01234567
digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
image="ghcr.io/divine-creative-ministries/buzz@sha256:$digest"

actual=$(SSH_ORIGINAL_COMMAND="deploy $commit $image" BUZZ_DEPLOY_GATE_TEST_ONLY=true "$GATE")
[[ "$actual" == "deploy $commit $image" ]]

invalid_commands=(
  "deploy short $image"
  "deploy $commit ghcr.io/other/buzz@sha256:$digest"
  "deploy $commit $image extra"
  "rollback"
  ""
)

for command in "${invalid_commands[@]}"; do
  if SSH_ORIGINAL_COMMAND="$command" BUZZ_DEPLOY_GATE_TEST_ONLY=true "$GATE" >/dev/null 2>&1; then
    echo "Gate accepted invalid command: $command" >&2
    exit 1
  fi
done

echo "DCM deployment script validation passed"
