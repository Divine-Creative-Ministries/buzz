#!/usr/bin/env bash
set -euo pipefail

fail() {
    echo "DCM mobile candidate verification failed: $*" >&2
    exit 1
}

if [[ "$#" != "3" ]]; then
    fail "usage: $0 dcm-mobile-vX.Y.Z-rc.N FULL_SHA X.Y.Z"
fi

candidate_tag="$1"
target_sha="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
version="$3"

expected_repository="Divine-Creative-Ministries/buzz"
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    [[ "$GITHUB_REPOSITORY" == "$expected_repository" ]] \
        || fail "expected repository $expected_repository, got $GITHUB_REPOSITORY"
else
    origin_url="$(git remote get-url origin 2>/dev/null || true)"
    case "$origin_url" in
        https://github.com/Divine-Creative-Ministries/buzz|https://github.com/Divine-Creative-Ministries/buzz.git|git@github.com:Divine-Creative-Ministries/buzz.git) ;;
        *) fail "origin is not $expected_repository: ${origin_url:-missing}" ;;
    esac
fi

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    [[ "${GITHUB_EVENT_NAME:-}" == "workflow_dispatch" ]] \
        || fail "publishing must use workflow_dispatch"
    [[ "${GITHUB_REF:-}" == "refs/heads/dcm-production" ]] \
        || fail "workflow must be dispatched from dcm-production"
fi

version_segment='(0|[1-9][0-9]*)'
candidate_pattern="^dcm-mobile-v(${version_segment}\\.${version_segment}\\.${version_segment})-rc\\.([1-9][0-9]*)$"
[[ "$candidate_tag" =~ $candidate_pattern ]] \
    || fail "tag must match dcm-mobile-vX.Y.Z-rc.N without leading zeroes"
[[ "${BASH_REMATCH[1]}" == "$version" ]] \
    || fail "tag version ${BASH_REMATCH[1]} does not match requested version $version"
[[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] \
    || fail "target SHA must be a complete 40-character commit SHA"

git show-ref --verify --quiet "refs/tags/$candidate_tag" \
    || fail "candidate tag does not exist locally"
[[ "$(git cat-file -t "refs/tags/$candidate_tag")" == "tag" ]] \
    || fail "candidate tag must be annotated, not lightweight"

resolved_sha="$(git rev-parse "refs/tags/$candidate_tag^{commit}")"
[[ "$resolved_sha" == "$target_sha" ]] \
    || fail "candidate resolves to $resolved_sha, not $target_sha"
[[ "$(git rev-parse HEAD)" == "$target_sha" ]] \
    || fail "checkout HEAD does not match the candidate SHA"

git show-ref --verify --quiet refs/remotes/origin/dcm-production \
    || fail "origin/dcm-production is missing"
git merge-base --is-ancestor "$target_sha" refs/remotes/origin/dcm-production \
    || fail "candidate SHA is not present on origin/dcm-production"

[[ -z "$(git status --porcelain --untracked-files=all)" ]] \
    || fail "candidate checkout is not clean"

grep -Fqx 'BUNDLE_IDENTIFIER = org.divinecreative.buzz' mobile/ios/Flutter/Release.xcconfig \
    || fail "iOS release bundle identifier is not org.divinecreative.buzz"
grep -Fqx 'APP_DISPLAY_NAME = DCM Buzz' mobile/ios/Flutter/Release.xcconfig \
    || fail "iOS release display name is not DCM Buzz"
grep -Fqx 'DEVELOPMENT_TEAM = AG96733X49' mobile/ios/Flutter/Release.xcconfig \
    || fail "iOS release team is not AG96733X49"
grep -Fq 'applicationId = "org.divinecreative.buzz"' mobile/android/app/build.gradle.kts \
    || fail "Android application ID is not org.divinecreative.buzz"
grep -Fq 'resValue("string", "app_name", "DCM Buzz")' mobile/android/app/build.gradle.kts \
    || fail "Android release display name is not DCM Buzz"

echo "verified $candidate_tag -> $target_sha (version $version)"
