# Divine Creative Fork Workflow

This document defines how Divine Creative Ministries maintains and deploys its
Buzz fork without losing local work when the upstream project changes.

## Repository and Branch Roles

| Name | Role |
| --- | --- |
| `block/buzz` (`upstream`) | Official Buzz source and destination for generally useful contributions |
| `Divine-Creative-Ministries/buzz` (`origin`) | Divine Creative fork |
| `Divine-Creative-Ministries/buzz-dcm-publish` | Private, source-free mobile and desktop signing/publishing automation |
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

## Customized iOS App Distribution

The preferred and required production distribution method for Divine
Creative's customized Buzz iOS app is an Apple **Private Custom App**:

1. Maintain the app under Divine Creative's active Apple Developer Program
   organization account.
2. Create the app record in App Store Connect with **Private** distribution
   selected from the outset.
3. Restrict availability to Divine Creative's verified Apple Business
   organization ID.
4. Submit the app and every production update to Apple App Review.
5. Assign the approved app privately through Apple Business, preferably using
   managed app assignment through the organization's MDM when device management
   is available.

This uses Apple's App Store distribution infrastructure without listing the
app publicly. Production releases do not have TestFlight's 90-day build
expiration, and installed App Store-distributed apps are not tied to an Ad Hoc
or development provisioning profile that must be periodically replaced.

Keep the Apple Developer membership, Apple Business organization, bundle ID,
signing access, and App Store Connect ownership active and documented. This is
a durable deployment method, not a promise that a build will remain compatible
with every future iOS release or continue to be downloadable after accounts or
agreements lapse.

The following methods have narrower purposes and are not the production path:

- **TestFlight:** temporary internal or external beta testing only; each build
  expires after 90 days.
- **Development or Ad Hoc signing:** device-limited testing only; these methods
  depend on registered devices and provisioning profiles.
- **Apple Developer Enterprise Program:** not the default; it is restricted to
  qualifying organizations and its in-house distribution still requires
  certificate, profile, and membership lifecycle management.
- **Unlisted App Store distribution:** not private because anyone with the link
  can potentially access it.
- **Public App Store distribution:** requires a separate documented decision.
  Apple does not allow an approved app record to switch freely between private
  and public distribution.

Agents preparing an iOS release must verify the target is the Private Custom
App record and the Divine Creative Apple Business organization before upload.
Do not create a replacement public or unlisted record, change the bundle ID, or
rotate signing ownership without explicit approval and a migration plan.

Official references:

- [Set distribution methods](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/set-distribution-methods)
- [Learn about Custom Apps in Apple Business](https://support.apple.com/guide/business/learn-about-custom-apps-axm58ba3112a/web)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)
- [Apple Developer Program renewal](https://developer.apple.com/help/account/membership/renewal)

## Customized Android App Distribution

The required production distribution method for Divine Creative's customized
Buzz Android app is a **Managed Google Play private app**:

1. Keep the app in the verified Divine Creative Ministries organization Google
   Play developer account owned by `hello@divinecreative.org`.
2. Keep the permanent package name `org.divinecreative.buzz`.
3. Restrict Managed Google Play availability to the Divine Creative Google
   organization and assign the app only to approved team users or device
   groups.
4. Use Google Play's internal-testing track to validate signed release
   candidates before promoting an approved build to the private production
   channel.
5. Keep the Play App Signing key under Google's protection and keep the upload
   key and automated-publishing credential outside the repository.

Internal App Sharing links are temporary delivery aids, not the production
channel. A public production track or a package owned by a personal developer
account requires an explicit, documented exception. See
[DCM_MOBILE_RELEASE.md](DCM_MOBILE_RELEASE.md) for the authoritative DCM store
identities and release boundary.

Official references:

- [Publish private apps from Play Console](https://support.google.com/work/android/answer/9495634)
- [Set up an internal test](https://support.google.com/googleplay/android-developer/answer/9845334)
- [Google Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)

## Deployment Rules

A merge into `dcm-production` is permission to build and automatically deploy
that exact commit to `buzz.divinecreative.org`. Agents and reviewers must treat
the merge button as a production release action. The complete trust boundary,
backup, health-check, and rollback contract is defined in
[DCM_PRODUCTION_DEPLOYMENT.md](DCM_PRODUCTION_DEPLOYMENT.md).

- Never use the live VPS as a development workspace. Do not hand-edit
  `/opt/buzz`, files inside running containers, or production database state to
  implement a feature.
- Build and publish an immutable image tag, such as
  `ghcr.io/divine-creative-ministries/buzz:dcm-<git-sha>`. Record the complete
  source commit and resulting image digest, and deploy by digest rather than by
  the mutable tag.
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
- Pause automatic deployment before merging changes that require a maintenance
  window, uninstalled root-owned configuration, or a migration whose recovery
  path has not been proven. Deployment-security scripts on the VPS never update
  themselves from a repository merge.

Secrets, private keys, `.env` contents, backup archives, and production data
must never be committed to Git or attached to a public pull request.

Mobile and desktop publication is deliberately separate from the VPS deploy.
After a reviewed production commit is ready for client release, create a signed
annotated `dcm-vX.Y.Z[-suffix]` tag at that exact commit. The private
`buzz-dcm-publish` repository fetches that public source ephemerally, verifies
the GitHub signature and ancestry in `dcm-production`, and publishes only after
an explicit owner dispatch that repeats the exact source SHA. Signing and store
credentials live only in that private repository's platform environments;
agents and this public fork never receive their values.

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
