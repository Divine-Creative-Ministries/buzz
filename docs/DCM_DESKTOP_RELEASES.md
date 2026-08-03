# DCM Desktop Releases

How Divine Creative Ministries builds and distributes the customized Buzz
desktop app (macOS, Windows, Linux) from the fork. This is the desktop
counterpart to [DCM_PRODUCTION_DEPLOYMENT.md](DCM_PRODUCTION_DEPLOYMENT.md):
the VPS deploy ships only the relay image — desktop UI changes reach users
only through the releases described here.

The lane is implemented by
[`.github/workflows/dcm-desktop-release.yml`](../.github/workflows/dcm-desktop-release.yml),
a DCM-only addition. The upstream release lane (`release.yml`) is gated to
`block/buzz` and depends on Block's internal signing infrastructure; it is
intentionally untouched.

## Cutting a release

Releases are cut by pushing a `dcm-desktop-v<semver>` tag that points into
reviewed `dcm-production` history (the workflow hard-fails otherwise):

```bash
git fetch origin dcm-production
git tag dcm-desktop-v0.1.0 origin/dcm-production
git push origin dcm-desktop-v0.1.0
```

The workflow then builds four artifact sets and publishes a GitHub Release
named `dcm-desktop-v<version>` on the fork:

| Platform | Artifact | Signed? |
|----------|----------|---------|
| macOS Apple Silicon | `Buzz_<version>_aarch64.dmg` (with `--features mesh-llm`, matching upstream) | Yes, when Apple secrets are configured; `_unsigned` suffix otherwise |
| macOS Intel | `Buzz_<version>_x64.dmg` | Same as above |
| Windows x64 | NSIS `*_unsigned.exe` installer | No (matches upstream OSS lane) |
| Linux x64 | `.deb` + `.AppImage` | No signing required |

Versions containing a `-` suffix (e.g. `0.1.0-beta.1`) publish as prereleases.

**No auto-updater.** The Tauri updater endpoints stay empty, so installed
apps never self-update; each release is installed manually from the Releases
page. Wiring the updater (endpoint + Tauri signing keypair + `latest.json`)
is a possible follow-up, documented at the bottom.

## macOS signing setup (owner runbook)

Until these secrets exist, macOS builds are produced **unsigned** with an
`_unsigned` filename suffix. Unsigned apps trigger Gatekeeper: open via
right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Buzz.app`.

Signing requires an active [Apple Developer Program](https://developer.apple.com)
membership. Two credentials are needed: a **Developer ID Application
certificate** (signs the app) and an **App Store Connect API key**
(notarizes it). This is a different certificate type from the iOS
Private Custom App path in
[DIVINE_CREATIVE_FORK_WORKFLOW.md](DIVINE_CREATIVE_FORK_WORKFLOW.md) — the
same Apple account issues both.

### 1. Developer ID Application certificate

1. On a Mac, open **Keychain Access → Certificate Assistant → Request a
   Certificate From a Certificate Authority…** Enter the Apple ID email,
   leave CA Email empty, select **Saved to disk**. This saves a `.certSigningRequest`.
2. At [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list)
   click **+**, choose **Developer ID Application**, upload the CSR, and
   download the resulting `.cer`.
3. Double-click the `.cer` to install it into the login keychain (it pairs
   with the private key created in step 1).
4. In Keychain Access, find the certificate ("Developer ID Application:
   <Name> (<TEAMID>)"), expand it to confirm the private key is attached,
   then right-click → **Export** both as a single `.p12`, choosing a strong
   export password.

### 2. App Store Connect API key (for notarization)

1. At [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
   click **+** to generate a **Team key** with the **Developer** role.
2. Record the **Issuer ID** (UUID at the top of the page) and the **Key ID**.
3. Download the `.p8` key file (downloadable only once).

### 3. Add the six repository secrets

From a terminal on the machine holding the files:

```bash
REPO=Divine-Creative-Ministries/buzz

base64 -i DeveloperID.p12 | gh secret set DCM_APPLE_CERTIFICATE --repo "$REPO"
gh secret set DCM_APPLE_CERTIFICATE_PASSWORD --repo "$REPO"   # paste the .p12 export password
gh secret set DCM_APPLE_SIGNING_IDENTITY --repo "$REPO" \
  --body "Developer ID Application: <Name> (<TEAMID>)"        # exact certificate common name
gh secret set DCM_APPLE_API_ISSUER --repo "$REPO"             # paste the Issuer ID
gh secret set DCM_APPLE_API_KEY --repo "$REPO"                # paste the Key ID
base64 -i AuthKey_<KEYID>.p8 | gh secret set DCM_APPLE_API_KEY_CONTENT --repo "$REPO"
```

Then delete the local `.p12` and `.p8` copies (or move them to secure
offline storage). Never commit them.

The workflow validates the set: if `DCM_APPLE_CERTIFICATE` exists but any of
the other five is missing, the release fails fast in setup instead of
producing a half-signed build. The next `dcm-desktop-v*` tag after the
secrets exist produces signed, notarized DMGs automatically — no workflow
change needed.

## Security properties

- The workflow runs only on `Divine-Creative-Ministries/buzz` and only for
  tags whose commit is an ancestor of `dcm-production` — release binaries
  can only be built from reviewed history.
- All third-party actions are SHA-pinned and the Linux container image,
  appimagetool, and AppImage runtime are digest/hash-pinned (inherited from
  the upstream lane).
- Build jobs run with `contents: read`; only the final publish job has
  `contents: write`, and it only creates/edits the `dcm-desktop-v*` release.
- Secrets never appear in artifacts; the notarization key is written to the
  runner temp directory only for the signed build step.

## Possible follow-ups (not in scope today)

- **Auto-updates:** generate a Tauri updater keypair, add the public key +
  a fork-hosted `latest.json` endpoint via `desktop/scripts/build-release-config.mjs`,
  and re-enable `createUpdaterArtifacts` — mirroring the upstream lane.
- **Windows Authenticode signing** to remove the SmartScreen warning.
- **`buzz-desktop-latest` rolling release** pointer like upstream's.
