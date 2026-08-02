#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verifier="$repo_root/scripts/verify-dcm-mobile-candidate.sh"
workflow="$repo_root/.github/workflows/dcm-mobile-internal-testing.yml"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

pass() {
    echo "PASS: $*"
}

test_repo="$tmp/repo"
git init -q "$test_repo"
git -C "$test_repo" config user.name test
git -C "$test_repo" config user.email test@example.com
git -C "$test_repo" remote add origin https://github.com/Divine-Creative-Ministries/buzz.git
mkdir -p "$test_repo/mobile/ios/Flutter" "$test_repo/mobile/android/app"
cat > "$test_repo/mobile/ios/Flutter/Release.xcconfig" <<'EOF'
BUNDLE_IDENTIFIER = org.divinecreative.buzz
APP_DISPLAY_NAME = DCM Buzz
DEVELOPMENT_TEAM = AG96733X49
EOF
cat > "$test_repo/mobile/android/app/build.gradle.kts" <<'EOF'
applicationId = "org.divinecreative.buzz"
resValue("string", "app_name", "DCM Buzz")
EOF
git -C "$test_repo" add .
git -C "$test_repo" commit -qm initial
target_sha="$(git -C "$test_repo" rev-parse HEAD)"
git -C "$test_repo" update-ref refs/remotes/origin/dcm-production "$target_sha"
git -C "$test_repo" tag -a dcm-mobile-v1.2.3-rc.1 -m candidate "$target_sha"

if (
    cd "$test_repo"
    GITHUB_ACTIONS=true \
        GITHUB_EVENT_NAME=workflow_dispatch \
        GITHUB_REF=refs/heads/dcm-production \
    GITHUB_REPOSITORY=Divine-Creative-Ministries/buzz \
        "$verifier" dcm-mobile-v1.2.3-rc.1 "$target_sha" 1.2.3 >/dev/null
); then
    pass "accepts an exact annotated DCM candidate"
else
    fail "valid candidate was rejected"
fi

if (
    cd "$test_repo"
    GITHUB_ACTIONS=true \
        GITHUB_EVENT_NAME=pull_request \
        GITHUB_REF=refs/heads/dcm-production \
        GITHUB_REPOSITORY=Divine-Creative-Ministries/buzz \
        "$verifier" dcm-mobile-v1.2.3-rc.1 "$target_sha" 1.2.3 >/dev/null 2>&1
); then
    fail "non-manual GitHub Actions event must be rejected"
else
    pass "rejects non-manual GitHub Actions events"
fi

if (
    cd "$test_repo"
    GITHUB_ACTIONS=true \
        GITHUB_EVENT_NAME=workflow_dispatch \
        GITHUB_REF=refs/heads/main \
        GITHUB_REPOSITORY=Divine-Creative-Ministries/buzz \
        "$verifier" dcm-mobile-v1.2.3-rc.1 "$target_sha" 1.2.3 >/dev/null 2>&1
); then
    fail "dispatch from a non-production branch must be rejected"
else
    pass "rejects dispatches outside dcm-production"
fi

if (
    cd "$test_repo"
    GITHUB_ACTIONS=true \
        GITHUB_EVENT_NAME=workflow_dispatch \
        GITHUB_REF=refs/heads/dcm-production \
    GITHUB_REPOSITORY=attacker/buzz \
        "$verifier" dcm-mobile-v1.2.3-rc.1 "$target_sha" 1.2.3 >/dev/null 2>&1
); then
    fail "wrong repository must be rejected"
else
    pass "rejects the wrong repository"
fi

git -C "$test_repo" tag dcm-mobile-v1.2.3-rc.2 "$target_sha"
if (
    cd "$test_repo"
    GITHUB_ACTIONS=true \
        GITHUB_EVENT_NAME=workflow_dispatch \
        GITHUB_REF=refs/heads/dcm-production \
    GITHUB_REPOSITORY=Divine-Creative-Ministries/buzz \
        "$verifier" dcm-mobile-v1.2.3-rc.2 "$target_sha" 1.2.3 >/dev/null 2>&1
); then
    fail "lightweight candidate tag must be rejected"
else
    pass "rejects lightweight candidate tags"
fi

if (
    cd "$test_repo"
    GITHUB_ACTIONS=true \
        GITHUB_EVENT_NAME=workflow_dispatch \
        GITHUB_REF=refs/heads/dcm-production \
    GITHUB_REPOSITORY=Divine-Creative-Ministries/buzz \
        "$verifier" dcm-mobile-v1.2.3-rc.1 "$target_sha" 1.2.4 >/dev/null 2>&1
); then
    fail "version mismatch must be rejected"
else
    pass "rejects version mismatches"
fi

wrong_sha="0000000000000000000000000000000000000000"
if (
    cd "$test_repo"
    GITHUB_ACTIONS=true \
        GITHUB_EVENT_NAME=workflow_dispatch \
        GITHUB_REF=refs/heads/dcm-production \
    GITHUB_REPOSITORY=Divine-Creative-Ministries/buzz \
        "$verifier" dcm-mobile-v1.2.3-rc.1 "$wrong_sha" 1.2.3 >/dev/null 2>&1
); then
    fail "SHA mismatch must be rejected"
else
    pass "rejects SHA mismatches"
fi

printf 'dirty\n' >> "$test_repo/mobile/ios/Flutter/Release.xcconfig"
if (
    cd "$test_repo"
    GITHUB_ACTIONS=true \
        GITHUB_EVENT_NAME=workflow_dispatch \
        GITHUB_REF=refs/heads/dcm-production \
    GITHUB_REPOSITORY=Divine-Creative-Ministries/buzz \
        "$verifier" dcm-mobile-v1.2.3-rc.1 "$target_sha" 1.2.3 >/dev/null 2>&1
); then
    fail "dirty candidate checkout must be rejected"
else
    pass "rejects dirty candidate checkouts"
fi
git -C "$test_repo" checkout -q -- mobile/ios/Flutter/Release.xcconfig

[[ -f "$workflow" ]] || fail "DCM internal-testing workflow is missing"
if grep -Fq 'workflow_dispatch:' "$workflow"; then
    pass "workflow is manually dispatched"
else
    fail "workflow must use workflow_dispatch"
fi
if grep -Eq '^  (push|pull_request):' "$workflow"; then
    fail "publishing workflow must not run on push or pull_request"
else
    pass "workflow has no automatic publish trigger"
fi
if grep -Fq 'refs/heads/dcm-production' "$workflow"; then
    pass "workflow requires dispatch from dcm-production"
else
    fail "workflow must require dcm-production"
fi
if [[ "$(grep -Fc 'environment: mobile-testing' "$workflow")" == "2" ]]; then
    pass "both signing jobs use the protected mobile-testing environment"
else
    fail "both signing jobs must use mobile-testing"
fi
if grep -Fq 'TestFlight internal testing' "$workflow" \
    && grep -Fq 'Google Play internal testing' "$workflow"; then
    pass "workflow targets only the two internal testing lanes"
else
    fail "workflow must name both internal testing lanes"
fi
if grep -Eiq '(track:|--track |track =>)[[:space:]]*(production|beta|alpha)' "$workflow"; then
    fail "workflow must not reference a non-internal Play track"
else
    pass "workflow contains no non-internal Play track"
fi
if grep -Eiq 'upload_to_app_store|deliver|submit_for_review|distribute_external:[[:space:]]*true' \
    "$workflow" "$repo_root/mobile/fastlane/Fastfile"; then
    fail "workflow must not promote or externally distribute iOS builds"
else
    pass "workflow contains no iOS production or external promotion action"
fi

echo "DCM mobile publishing contract passed"
