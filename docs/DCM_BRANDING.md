# DCM Buzz Branding

The canonical DCM Buzz application icon is
[`docs/brand/dcm-buzz-app-icon.png`](brand/dcm-buzz-app-icon.png). It is the
approved source artwork for every customized Divine Creative client.

## Application icon contract

- Keep the source artwork square, opaque, and at least 1024 by 1024 pixels.
- Do not substitute the upstream Buzz mark on `dcm-production`.
- Resize from the canonical artwork with high-quality downsampling. Do not
  repeatedly resize a smaller generated file.
- iOS marketing and launcher icons must remain opaque; iOS applies its own
  device mask.
- Android adaptive icons use the black `ic_launcher_background` and the DCM
  artwork as the foreground. Keep the legacy round launcher files circularly
  masked for devices that do not use adaptive icons.
- Desktop `.icns`, `.ico`, PNG, in-app QR/avatar, web favicon, and admin
  favicon derivatives must be regenerated from the same source in one change.

## Derived targets

| Surface | Generated files |
| --- | --- |
| iOS mobile | `mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset/` |
| Android mobile | `mobile/android/app/src/main/res/mipmap-*/ic_launcher*.png` |
| Mobile launch and in-app art | `mobile/android/app/src/main/res/mipmap-*/launch_image.png`, `mobile/assets/images/buzz-icon.png` |
| Desktop installers and shells | `desktop/src-tauri/icons/` |
| Desktop in-app icon | `desktop/public/app-icon@2x.png`, `desktop/public/app-icon@3x.png` |
| Web client | `web/src/assets/app-icon@3x.png`, `web/public/favicon.png` |
| Admin client | `admin-web/public/favicon.png` |

Changing the icon does not authorize a store or desktop release. Release the
generated assets only through the existing reviewed `dcm-production`, mobile
test-lane, notarization, and internal-distribution processes.
