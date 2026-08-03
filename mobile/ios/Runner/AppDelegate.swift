import AVFoundation
import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate,
  AVSpeechSynthesizerDelegate
{
  private var mediaUploadChannel: FlutterMethodChannel?
  private var qrScannerChannel: FlutterMethodChannel?
  private var inlinePhotoPickerSupportChannel: FlutterMethodChannel?
  private var nativeAttachmentPopoverCoordinator: NativeAttachmentPopoverCoordinator?
  private var messageReadAloudChannel: FlutterMethodChannel?
  private let messageSpeechSynthesizer = AVSpeechSynthesizer()
  private var speakingMessageId: String?
  private var speakingUtterance: AVSpeechUtterance?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().requestAuthorization(options: [.badge]) { _, _ in }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    let messenger = engineBridge.applicationRegistrar.messenger()
    mediaUploadChannel = FlutterMethodChannel(
      name: "buzz/media_upload",
      binaryMessenger: messenger
    )
    mediaUploadChannel?.setMethodCallHandler { [weak self] call, result in
      self?.handleMediaUploadMethodCall(call, result: result)
    }
    qrScannerChannel = FlutterMethodChannel(
      name: "buzz/qr_scanner",
      binaryMessenger: messenger
    )
    qrScannerChannel?.setMethodCallHandler { call, result in
      Self.handleQrScannerMethodCall(call, result: result)
    }
    inlinePhotoPickerSupportChannel = FlutterMethodChannel(
      name: "buzz/inline_photo_picker",
      binaryMessenger: messenger
    )
    inlinePhotoPickerSupportChannel?.setMethodCallHandler { call, result in
      guard call.method == "isSupported" else {
        result(FlutterMethodNotImplemented)
        return
      }
      if #available(iOS 17.0, *) {
        result(true)
      } else {
        result(false)
      }
    }
    messageReadAloudChannel = FlutterMethodChannel(
      name: "buzz/message_read_aloud",
      binaryMessenger: messenger
    )
    messageSpeechSynthesizer.delegate = self
    messageReadAloudChannel?.setMethodCallHandler { [weak self] call, result in
      self?.handleMessageReadAloudMethodCall(call, result: result)
    }

    if let inlinePhotoPickerRegistrar = engineBridge.pluginRegistry.registrar(
      forPlugin: "BuzzInlinePhotoPicker"
    ) {
      inlinePhotoPickerRegistrar.register(
        InlinePhotoPickerFactory(
          messenger: messenger,
          parentViewController: inlinePhotoPickerRegistrar.viewController
        ),
        withId: "buzz/inline_photo_picker"
      )
    }

    let nativeAttachmentRegistrar = engineBridge.pluginRegistry.registrar(
      forPlugin: "BuzzNativeAttachmentPopover"
    )
    nativeAttachmentPopoverCoordinator = NativeAttachmentPopoverCoordinator(
      messenger: messenger,
      parentViewController: nativeAttachmentRegistrar?.viewController
    )
  }

  private func handleMessageReadAloudMethodCall(
    _ call: FlutterMethodCall,
    result: @escaping FlutterResult
  ) {
    switch call.method {
    case "speak":
      guard
        let arguments = call.arguments as? [String: Any],
        let messageId = arguments["messageId"] as? String,
        let author = arguments["author"] as? String,
        let text = arguments["text"] as? String,
        !text.isEmpty
      else {
        result(
          FlutterError(
            code: "invalid_arguments",
            message: "Expected a message id, author, and non-empty text.",
            details: nil
          )
        )
        return
      }

      if messageSpeechSynthesizer.isSpeaking || messageSpeechSynthesizer.isPaused {
        speakingMessageId = nil
        speakingUtterance = nil
        messageSpeechSynthesizer.stopSpeaking(at: .immediate)
      }
      do {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(
          .playback,
          mode: .spokenAudio,
          options: [.duckOthers]
        )
        try audioSession.setActive(true)
      } catch {
        result(
          FlutterError(
            code: "audio_session_failed",
            message: "Unable to start message audio.",
            details: error.localizedDescription
          )
        )
        return
      }
      let utterance = AVSpeechUtterance(string: text)
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate
      speakingMessageId = messageId
      speakingUtterance = utterance
      messageSpeechSynthesizer.speak(utterance)
      UIAccessibility.post(
        notification: .announcement,
        argument: "Reading message from \(author)"
      )
      result(nil)
    case "pause":
      result(messageSpeechSynthesizer.pauseSpeaking(at: .word))
    case "resume":
      result(messageSpeechSynthesizer.continueSpeaking())
    case "stop":
      speakingMessageId = nil
      speakingUtterance = nil
      if messageSpeechSynthesizer.isSpeaking || messageSpeechSynthesizer.isPaused {
        messageSpeechSynthesizer.stopSpeaking(at: .immediate)
      }
      try? AVAudioSession.sharedInstance().setActive(
        false,
        options: [.notifyOthersOnDeactivation]
      )
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    guard speakingUtterance === utterance, let messageId = speakingMessageId else {
      return
    }
    speakingMessageId = nil
    speakingUtterance = nil
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: [.notifyOthersOnDeactivation]
    )
    messageReadAloudChannel?.invokeMethod("finished", arguments: messageId)
  }

  private static func handleQrScannerMethodCall(
    _ call: FlutterMethodCall,
    result: @escaping FlutterResult
  ) {
    switch call.method {
    case "usesDynamicIslandQrScannerPortal":
      result(
        UIDevice.current.userInterfaceIdiom == .phone
          && usesDynamicIslandQrScannerPortal(
            safeAreaTopInset: activeWindowSafeAreaTopInset()
          )
      )
    case "setDynamicIslandScannerStatusBarHidden":
      guard let hidden = call.arguments as? Bool else {
        result(
          FlutterError(
            code: "invalid_arguments",
            message: "Expected a Bool status-bar visibility value.",
            details: nil
          )
        )
        return
      }
      UIApplication.shared.setStatusBarHidden(hidden, with: .fade)
      result(nil)
    case "performDynamicIslandQrScanSuccessHaptic":
      let generator = UINotificationFeedbackGenerator()
      generator.prepare()
      generator.notificationOccurred(.success)
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  static func usesDynamicIslandQrScannerPortal(
    safeAreaTopInset: CGFloat
  ) -> Bool {
    safeAreaTopInset > 50
  }

  private static func activeWindowSafeAreaTopInset() -> CGFloat {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?
      .safeAreaInsets.top ?? 0
  }

  private func handleMediaUploadMethodCall(
    _ call: FlutterMethodCall,
    result: @escaping FlutterResult
  ) {
    switch call.method {
    case "sanitizeImageForUpload":
      guard
        let arguments = call.arguments as? [String: Any],
        let typedData = arguments["bytes"] as? FlutterStandardTypedData,
        let mimeType = arguments["mimeType"] as? String
      else {
        result(
          FlutterError(
            code: "invalid_arguments",
            message: "Expected image bytes and mime type.",
            details: nil
          )
        )
        return
      }

      guard let image = UIImage(data: typedData.data) else {
        result(
          FlutterError(
            code: "sanitize_failed",
            message: "Unable to decode picked image.",
            details: nil
          )
        )
        return
      }

      do {
        guard let sanitizedData = try MediaSanitizer.sanitizeImage(image, mimeType: mimeType) else {
          result(
            FlutterError(
              code: "sanitize_failed",
              message: "Unable to sanitize picked image.",
              details: mimeType
            )
          )
          return
        }
        result(FlutterStandardTypedData(bytes: sanitizedData))
      } catch {
        result(
          FlutterError(
            code: "sanitize_failed",
            message: "Unable to sanitize picked image.",
            details: mimeType
          )
        )
      }
    case "transcodeImageToJpeg":
      guard let typedData = call.arguments as? FlutterStandardTypedData else {
        result(
          FlutterError(
            code: "invalid_arguments",
            message: "Expected raw image bytes.",
            details: nil
          )
        )
        return
      }

      guard let image = UIImage(data: typedData.data) else {
        result(
          FlutterError(
            code: "transcode_failed",
            message: "Unable to convert picked image to JPEG.",
            details: nil
          )
        )
        return
      }

      do {
        guard let jpegData = try MediaSanitizer.encodeJpeg(image) else {
          result(
            FlutterError(
              code: "transcode_failed",
              message: "Unable to convert picked image to JPEG.",
              details: nil
            )
          )
          return
        }
        result(FlutterStandardTypedData(bytes: jpegData))
      } catch {
        result(
          FlutterError(
            code: "transcode_failed",
            message: "Unable to convert picked image to JPEG.",
            details: nil
          )
        )
      }
    case "transcodeVideoToMp4":
      guard let sourcePath = call.arguments as? String else {
        result(
          FlutterError(
            code: "invalid_arguments",
            message: "Expected source file path as String.",
            details: nil
          )
        )
        return
      }
      transcodeVideoToMp4(sourcePath: sourcePath, result: result)
    case "clipboardHasImage":
      result(UIPasteboard.general.hasImages)
    case "readClipboardImage":
      guard let imageData = Self.clipboardImageData(from: UIPasteboard.general) else {
        result(nil)
        return
      }
      result(FlutterStandardTypedData(bytes: imageData))
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  static func clipboardImageData(from pasteboard: UIPasteboard) -> Data? {
    if let pngData = pasteboard.data(forPasteboardType: "public.png") {
      return pngData
    }
    if let jpegData = pasteboard.data(forPasteboardType: "public.jpeg") {
      return jpegData
    }
    for imageType in ["public.heic", "public.heif", "org.webmproject.webp", "com.compuserve.gif"] {
      if let imageData = pasteboard.data(forPasteboardType: imageType) {
        return imageData
      }
    }
    guard let image = pasteboard.image else {
      return nil
    }
    return image.pngData()
  }

  private func transcodeVideoToMp4(
    sourcePath: String,
    result: @escaping FlutterResult
  ) {
    let sourceURL = URL(fileURLWithPath: sourcePath)
    let asset = AVURLAsset(url: sourceURL)

    guard
      let exportSession = AVAssetExportSession(
        asset: asset,
        presetName: AVAssetExportPresetPassthrough
      )
    else {
      result(
        FlutterError(
          code: "transcode_failed",
          message: "Unable to create export session.",
          details: nil
        )
      )
      return
    }

    let outputURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("mp4")

    exportSession.outputURL = outputURL
    exportSession.outputFileType = .mp4
    exportSession.shouldOptimizeForNetworkUse = true
    exportSession.metadataItemFilter = AVMetadataItemFilter.forSharing()

    exportSession.exportAsynchronously {
      switch exportSession.status {
      case .completed:
        result(outputURL.path)
      default:
        let errorMessage =
          exportSession.error?.localizedDescription
          ?? "Video transcoding failed with status \(exportSession.status.rawValue)."
        result(
          FlutterError(
            code: "transcode_failed",
            message: errorMessage,
            details: nil
          )
        )
        // Clean up partial output on failure.
        try? FileManager.default.removeItem(at: outputURL)
      }
    }
  }
}
