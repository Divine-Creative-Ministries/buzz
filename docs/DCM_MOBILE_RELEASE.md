# DCM Mobile Release

This document is the authoritative release boundary for the Divine Creative
customized Buzz mobile app. It applies to the
`Divine-Creative-Ministries/buzz` fork and its `dcm-production` branch.

## Permanent store identities

| Platform | Store owner | App identity | Store record |
| --- | --- | --- | --- |
| iOS | App Store Connect: `bailey@divinecreative.org`; Apple Business administrator: `bailey.mullens@divinecreative.appleaccount.com`; Divine Creative Ministries, Inc. | Bundle ID `org.divinecreative.buzz`; display name **DCM Buzz** | Apple Team ID `AG96733X49`; App Store Connect ID `6797194443`; SKU `DCM-BUZZ-IOS-001`; Apple Business organization ID `460525025918` |
| Android | `hello@divinecreative.org`; Divine Creative Ministries | Package `org.divinecreative.buzz`; display name **DCM Buzz** | Google Play developer account ID `6923830550302882193`; Google Play app ID `4972357676646821881`; managed organization ID `C01d4v998` |

Treat the bundle ID, package name, Apple team ownership, App Store Connect
record, Google Play developer ownership, and store distribution methods as
permanent. Do not replace, transfer, rename, or make them public without an
explicitly approved migration plan.

The first DCM store release is version `1.0.0` with build/version code `1`.
Every uploaded build must use a monotonically increasing build number on iOS
and version code on Android.

## Current store setup

Update this section when a listed state changes; do not infer approval from a
submitted form or an existing store record.

- Apple Business domain `divinecreative.org` is verified. Organization
  verification was submitted on 2026-08-02 and may remain **In Review** for up
  to five business days. Apple Business Custom Apps cannot be enabled until
  Apple permits that setting.
- The App Store Connect app record exists. Its Private Custom App availability
  must name Apple Business organization ID `460525025918` before a production
  submission is finalized.
- The protected TestFlight group is exactly `DCM Internal Testing`.
- App Store Connect automation uses the `DCM Mobile Publisher` API key with
  App Manager access (key ID `LXDUV28A4G`, issuer
  `4cb9bbc1-da60-492b-99ab-939e9a37543f`). Apple signing uses distribution
  certificate `XA26G7GRBJ` and App Store provisioning profile
  `DCM Buzz App Store GitHub Actions` (`Z5BK3W54S2`); both expire on
  2027-08-02.
- The Google Play app record exists and is restricted to Divine Creative's
  managed organization `C01d4v998`.
- Google Play automation uses service account
  `dcm-buzz-mobile-publisher@pc-api-6923830550302882193-257.iam.gserviceaccount.com`
  in Cloud project `pc-api-6923830550302882193-257`. The Android Publisher API
  is enabled. Play Console grants this identity access only to DCM Buzz, with
  read-only app/quality information and release-to-testing-tracks permission;
  it has no production, financial, admin, tester-management, or other-app
  access. A live API check against the `internal` track passed on 2026-08-02.

## Release lanes and approval gates

The release order is mandatory:

| Gate | iOS | Android | Promotion rule |
| --- | --- | --- | --- |
| Candidate | Signed IPA built from an immutable DCM candidate tag | Signed AAB built from the same immutable DCM candidate tag | Record source SHA, version, and platform build numbers |
| Team test | TestFlight **internal testing** | Google Play **internal testing** | Run the real-device checklist; failures require a new build number/code and candidate |
| Optional wider beta | TestFlight external group after Beta App Review | Closed testing | Use only when the release owner requests a broader beta |
| Private production | Private Custom App for Apple Business organization `460525025918` | Managed Google Play private production restricted to `C01d4v998` | Promote only after explicit approval; never auto-promote on merge or tag |

TestFlight is the recommended and required first iOS delivery step. Internal
TestFlight builds are convenient for the team but expire after 90 days; the
approved Private Custom App is the durable production channel. On Android,
the internal-testing track serves the equivalent release-candidate role.

Test the exact signed artifacts intended for promotion. Do not rebuild after
testing and call the rebuild equivalent. If a signing, configuration, or code
change requires another artifact, increment its iOS build number or Android
version code and repeat the test gate.

## Production distribution

### iOS

- Distribution method: **Private — Available as a custom app on Apple Business
  or Apple School Manager**.
- Restrict the App Store Connect record to the verified Divine Creative Apple
  Business organization ID.
- Submit every production version to Apple App Review.
- Assign approved licenses through Apple Business. Prefer managed app
  assignment through the organization's MDM when available.
- TestFlight is a temporary pre-release validation channel only.

### Android

- Distribution method: **Managed Google Play private app**.
- Restrict availability to the Divine Creative Google organization and assign
  access through managed users or groups.
- Use the internal-testing track to validate the exact signed candidate before
  promoting it to private production.
- Internal App Sharing and direct APK links are temporary testing mechanisms,
  not durable production distribution.

## Source and release boundary

`dcm-production` is the only production source branch. A merge to it deploys
the VPS application, but it does **not** automatically publish a mobile build.
Mobile store publication is a separate, manual release action because it
requires immutable version numbers, signed artifacts, store metadata, review,
and an explicit promotion decision.

The upstream `scripts/mobile-release.sh` is intentionally restricted to
`block/buzz:main`; agents must not weaken that guard or use its upstream
`mobile-v*` tags for a DCM release. DCM candidates originate from
`origin/dcm-production` and use signed annotated tags of the form
`dcm-vX.Y.Z` or `dcm-vX.Y.Z-rc.N`. Creating a candidate tag, uploading a test build, and
promoting to production are separate auditable actions.

### 1. Cut one immutable DCM candidate

1. Fetch `origin` and `upstream` and verify that the intended commit is present
   on `origin/dcm-production`.
2. Require a clean worktree and a green PR/branch check for that commit.
3. Create, sign, and push an annotated `dcm-vX.Y.Z[-suffix]` tag at that exact
   commit. The private publisher accepts only GitHub-verified tags and exact
   SHAs that belong to `dcm-production`. Never move or reuse a release tag.
4. Record the tag, complete commit SHA, marketing version, next unused iOS
   build number, and next unused Android version code before building.

### 2. Build the Flutter artifacts

Build both platforms from a clean checkout of the candidate tag. The release
fallback relay must be the production HTTPS origin:

```bash
git switch --detach dcm-vX.Y.Z-rc.N
test -z "$(git status --porcelain)"

just mobile-check
just mobile-test

cd mobile
flutter pub get
flutter build ipa --release \
  --build-name X.Y.Z \
  --build-number IOS_BUILD_NUMBER \
  --dart-define=BUZZ_RELAY_URL=https://buzz.divinecreative.org

flutter build appbundle --release \
  --build-name X.Y.Z \
  --build-number ANDROID_VERSION_CODE \
  --dart-define=BUZZ_RELAY_URL=https://buzz.divinecreative.org
```

The Android command requires the external `BUZZ_ANDROID_UPLOAD_*` signing
values described below, unless the approved central signer is used. Run the
iOS build only on an approved macOS signing runner. Do not put credentials or
local credential paths into the command history, tag, release notes, or
repository.

Before upload, verify:

- iOS bundle ID `org.divinecreative.buzz`, display name **DCM Buzz**, version,
  build number, Apple team, provisioning profile, and production relay;
- Android package `org.divinecreative.buzz`, display name **DCM Buzz**, version,
  version code, upload signature, AAB format, and production relay;
- both artifacts came from the recorded tag and source SHA.

### 3. Upload to the test lanes

#### iOS: TestFlight first

1. Upload the IPA to App Store Connect record `6797194443` using the approved
   App Store Connect API key or the authenticated Xcode/Transporter workflow.
2. Wait for processing and complete export-compliance questions if prompted.
3. Add the build to the Divine Creative internal TestFlight group. Do not send
   it to App Review or production yet.
4. Record the App Store Connect build number and TestFlight status.

#### Android: internal testing first

1. Upload the AAB to the **internal testing** track for Google Play app
   `4972357676646821881`, using the least-privileged publishing service account
   or an authenticated Play Console session.
2. Confirm the release remains restricted to managed organization
   `C01d4v998`; never add public availability.
3. Publish the internal-test release and record its version code and status.

### 4. Test both signed candidates

Install through TestFlight and Google Play internal testing on real team
devices. At minimum verify:

- clean install and upgrade over the prior production version;
- onboarding, invite/deep-link handling, and connection to
  `https://buzz.divinecreative.org`;
- sign-in or key import, channel list/history, send/receive, notifications, and
  reconnect after backgrounding and relaunch;
- image/file upload and download, camera/photo permissions where applicable,
  and mobile pairing;
- no debug branding, worktree bundle suffix, localhost fallback, test keys, or
  development endpoints;
- crash-free launch and no release-blocking TestFlight, Play pre-launch, or
  server-side errors.

Record tester, device/OS, result, and any exception. A failed gate produces a
new candidate with new build numbers; never replace an uploaded artifact.

### 5. Promote only the approved candidate

After the release owner explicitly approves the recorded test evidence:

1. In App Store Connect, confirm distribution is **Private — Available as a
   custom app**, restricted to Divine Creative Ministries, Inc. organization
   ID `460525025918`; complete metadata and submit the tested TestFlight build
   to App Review. After approval, make it available in Apple Business and
   assign it through MDM or Apps & Books.
2. Promote the tested Android version from internal testing to the private
   production track without changing its AAB, keep managed organization
   `C01d4v998` as the only organization, and use a staged rollout when the
   console supports it.
3. Record the tag, SHA, artifact hashes, build numbers, review outcomes,
   availability, rollout result, and rollback/stop decision in release notes.

Merging `dcm-production`, creating a candidate tag, or passing tests is not by
itself authorization to promote. Agents may automate reproducible checks,
builds, uploads to the two test lanes, and status reporting. Production
promotion must remain an explicit manual or protected-environment approval
until a separately reviewed policy says otherwise.

## Private protected publisher

`Divine-Creative-Ministries/buzz-dcm-publish` is the only automated DCM
store-upload and desktop-release boundary. It is a private, source-free
repository: its manually dispatched workflows fetch the requested immutable
source from this public fork into an ephemeral GitHub-hosted runner. This
public repository must not contain store/signing secrets or a credentialed DCM
publishing workflow.

The private `publish-mobile.yml` workflow accepts the signed `dcm-v*` tag, its
exact 40-character SHA in `confirm_sha`, the marketing version, and the next
unused platform build numbers. Its first job is secret-free and verifies the
owner dispatcher (`Realmullens`), the typed SHA, GitHub tag verification, the
tag's membership in `dcm-production`, DCM app identity, and mobile tests. Only
then may its iOS and Android jobs enter the separate `dcm-ios` and
`dcm-android` environments. It never creates or moves a source tag, merges
code, deploys the VPS, submits to App Review, or promotes a Google Play release
beyond internal testing.

The private `dcm-ios` environment owns these secrets:

| Secret | Purpose |
| --- | --- |
| `DCM_ASC_KEY_ID` | App Store Connect API key identifier |
| `DCM_ASC_ISSUER_ID` | App Store Connect API issuer identifier |
| `DCM_ASC_PRIVATE_KEY` | One-time downloaded `.p8` private key contents |
| `DCM_IOS_DISTRIBUTION_CERTIFICATE_P12` | Base64-encoded Apple Distribution certificate and private key |
| `DCM_IOS_DISTRIBUTION_CERTIFICATE_PASSWORD` | Password protecting the `.p12` file |
| `DCM_IOS_PROVISIONING_PROFILE` | Base64-encoded App Store provisioning profile for `org.divinecreative.buzz` |

Set the non-secret `dcm-ios` environment variable
`DCM_TESTFLIGHT_INTERNAL_GROUP` to the exact Divine Creative internal group
name.

The private `dcm-android` environment owns:

| Secret | Purpose |
| --- | --- |
| `DCM_ANDROID_UPLOAD_KEYSTORE` | Base64-encoded Google Play upload keystore |
| `DCM_ANDROID_UPLOAD_KEYSTORE_PASSWORD` | Upload-keystore password |
| `DCM_ANDROID_UPLOAD_KEY_ALIAS` | Upload-key alias |
| `DCM_ANDROID_UPLOAD_KEY_PASSWORD` | Upload-key password |
| `DCM_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Least-privileged Play publishing service-account credential |

Never copy any credential value into a Buzz agent definition, this public
repository, a repository variable, workflow input, PR, issue, command
transcript, or artifact.

Dispatch through GitHub CLI only after the candidate tag exists and the next
store build numbers are known:

```bash
gh workflow run publish-mobile.yml \
  --repo Divine-Creative-Ministries/buzz-dcm-publish \
  --ref main \
  -f source_ref=dcm-vX.Y.Z-rc.N \
  -f confirm_sha=FULL_40_CHARACTER_SHA \
  -f version=X.Y.Z \
  -f ios_build_number=NEXT_IOS_BUILD \
  -f android_version_code=NEXT_ANDROID_CODE \
  -f upload_ios=true \
  -f upload_android=true
```

The workflow queries TestFlight and every standard Google Play track before
building and rejects a reused build number or version code. Uploads use pinned
fastlane `2.237.0`, TestFlight internal testing, and Google Play internal
testing. The exact uploaded artifacts must still pass the real-device checklist
before Bailey performs either production-promotion step.

## Signing and automation secrets

Never commit any signing or publishing credential. Store these only in the
approved password manager or protected GitHub environment:

- Apple Distribution certificate and password, or an approved automatic
  signing identity;
- App Store Connect API private key, issuer ID, and key ID;
- Apple provisioning profile if automatic signing is not used;
- Android upload keystore, alias, and passwords;
- Google Play publishing service-account credential.

The Android build already fails closed when the required
`BUZZ_ANDROID_UPLOAD_*` values are missing. Release automation must retain that
behavior, use Google Play App Signing, and grant publishing credentials only
the minimum app/track permissions required.

The approved Android upload-key alias is `dcm-buzz-upload`. Durable local
recovery copies use the Mac login Keychain service names below; the service
names are documentation, but their values must never be copied into the
repository or an agent prompt:

- `DCM Buzz App Store Connect API Private Key`
- `DCM Buzz Apple Distribution P12 Base64`
- `DCM Buzz Apple Distribution P12 Password`
- `DCM Buzz App Store Provisioning Profile Base64`
- `DCM Buzz Android Upload Keystore Base64`
- `DCM Buzz Android Upload Keystore Password`
- `DCM Buzz Android Upload Key Alias`
- `DCM Buzz Google Play Service Account JSON`

GitHub Actions receives the matching values only through the private
publisher's protected `dcm-ios` and `dcm-android` environments. Do not export
Keychain values into either Buzz agent definition or a long-lived shell
environment.

Prefer an App Store Connect API key scoped no wider than App Manager for iOS
automation and a Google Play service account limited to DCM Buzz and the
required test/private tracks. Keep API key files, service-account JSON, and
upload keystores in protected CI secrets or an approved password manager. Do
not commit Expo/EAS configuration: this client is Flutter, and store builds use
Flutter/Xcode/Gradle unless the project adopts a separately reviewed migration.

The Buzz Maintainer and Mobile Publisher agent definitions contain no
environment variables. Their normal GitHub access comes from the Mac's existing
authenticated GitHub connection; store and signing credentials are available
only inside the private publisher's protected workflow jobs.

## Required checks before production

- Store owner and app identifiers match the table above.
- The iOS distribution method is Private and names the verified Divine
  Creative Apple Business organization.
- The Android app is private to the Divine Creative Managed Google Play
  organization.
- The artifact was built from the recorded immutable tag and clean source
  tree.
- Mobile checks and tests pass.
- Store privacy, content-rating, export-compliance, review-contact, and support
  metadata are current and accurate.
- A real team account can install, sign in, pair with the relay, and reconnect
  after relaunch on each platform.
- The exact candidate passed TestFlight internal testing and Google Play
  internal testing, and production promotion has explicit release-owner
  approval.
