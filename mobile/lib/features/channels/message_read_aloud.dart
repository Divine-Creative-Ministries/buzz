import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

enum MessageReadAloudStatus {
  idle,
  preparing,
  playing,
  paused,
  finished,
  error,
}

@immutable
class MessageReadAloudState {
  final String? messageId;
  final String author;
  final String text;
  final MessageReadAloudStatus status;
  final String? error;

  const MessageReadAloudState({
    this.messageId,
    this.author = '',
    this.text = '',
    this.status = MessageReadAloudStatus.idle,
    this.error,
  });
}

String messageTextForSpeech(String markdown) {
  final codeSpans = <String>[];
  String preserveCode(String text) {
    final index = codeSpans.length;
    codeSpans.add(text);
    return '\uE000$index\uE001';
  }

  return markdown
      .replaceAllMapped(
        RegExp(r'```(?:[^\n`]*)\n?([\s\S]*?)```'),
        (match) => preserveCode(match.group(1) ?? ''),
      )
      .replaceAllMapped(
        RegExp(r'`([^`]+)`'),
        (match) => preserveCode(match.group(1) ?? ''),
      )
      .replaceAllMapped(
        RegExp(r'!\[([^\]]*)\]\([^)]*\)'),
        (match) => match.group(1) ?? '',
      )
      .replaceAllMapped(
        RegExp(r'\[([^\]]+)\]\([^)]*\)'),
        (match) => match.group(1) ?? '',
      )
      .replaceAll(
        RegExp(r'^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+', multiLine: true),
        '',
      )
      .replaceAllMapped(
        RegExp(r'\*\*([^*\n]+)\*\*'),
        (match) => match.group(1) ?? '',
      )
      .replaceAllMapped(
        RegExp(r'(?<!\w)__([^_\n]+)__(?!\w)'),
        (match) => match.group(1) ?? '',
      )
      .replaceAllMapped(
        RegExp(r'(?<!\*)\*([^*\n]+)\*(?!\*)'),
        (match) => match.group(1) ?? '',
      )
      .replaceAllMapped(
        RegExp(r'(?<![\w_])_([^_\n]+)_(?![\w_])'),
        (match) => match.group(1) ?? '',
      )
      .replaceAllMapped(
        RegExp(r'~~([^~\n]+)~~'),
        (match) => match.group(1) ?? '',
      )
      .replaceAllMapped(
        RegExp(r'\uE000(\d+)\uE001'),
        (match) => codeSpans[int.parse(match.group(1)!)],
      )
      .replaceAll(RegExp(r'\n{3,}'), '\n\n')
      .trim();
}

class MessageReadAloudNotifier extends Notifier<MessageReadAloudState> {
  static const _channel = MethodChannel('buzz/message_read_aloud');
  AppLifecycleListener? _lifecycleListener;
  bool _disposed = false;
  bool get _isSupported => defaultTargetPlatform == TargetPlatform.iOS;

  @override
  MessageReadAloudState build() {
    _channel.setMethodCallHandler(_handleNativeCallback);
    _lifecycleListener?.dispose();
    _lifecycleListener = AppLifecycleListener(onPause: stop, onDetach: stop);
    ref.onDispose(() {
      _disposed = true;
      _lifecycleListener?.dispose();
      _lifecycleListener = null;
      _channel.setMethodCallHandler(null);
      if (_isSupported) unawaited(_channel.invokeMethod<void>('stop'));
    });
    return const MessageReadAloudState();
  }

  /// Stop playback from a widget dispose path. Route disposal can run inside
  /// the build phase, where a synchronous provider write is forbidden, so the
  /// write is deferred to a microtask and skipped if the container is gone.
  void stopDeferred() {
    scheduleMicrotask(() {
      if (!_disposed) stop();
    });
  }

  Future<void> listen({
    required String messageId,
    required String author,
    required String markdown,
  }) async {
    if (state.messageId == messageId) {
      if (state.status == MessageReadAloudStatus.playing ||
          state.status == MessageReadAloudStatus.preparing) {
        await pause();
        return;
      }
      if (state.status == MessageReadAloudStatus.paused) {
        await resume();
        return;
      }
    }

    await _speakText(
      messageId: messageId,
      author: author,
      text: messageTextForSpeech(markdown),
    );
  }

  Future<void> _speakText({
    required String messageId,
    required String author,
    required String text,
  }) async {
    state = MessageReadAloudState(
      messageId: messageId,
      author: author,
      text: text,
      status: MessageReadAloudStatus.preparing,
    );

    if (!_isSupported || text.isEmpty) {
      _fail(messageId);
      return;
    }

    try {
      await _channel.invokeMethod<void>('speak', {
        'messageId': messageId,
        'author': author,
        'text': text,
      });
      if (state.messageId == messageId &&
          state.status == MessageReadAloudStatus.preparing) {
        state = MessageReadAloudState(
          messageId: messageId,
          author: author,
          text: text,
          status: MessageReadAloudStatus.playing,
        );
      }
    } catch (error) {
      debugPrint('message read aloud failed: $error');
      _fail(messageId);
    }
  }

  Future<void> pause() async {
    if (state.status != MessageReadAloudStatus.playing) return;
    final paused = await _channel.invokeMethod<bool>('pause') ?? false;
    if (paused) {
      state = MessageReadAloudState(
        messageId: state.messageId,
        author: state.author,
        text: state.text,
        status: MessageReadAloudStatus.paused,
      );
    }
  }

  Future<void> resume() async {
    if (state.status != MessageReadAloudStatus.paused) return;
    final resumed = await _channel.invokeMethod<bool>('resume') ?? false;
    if (resumed) {
      state = MessageReadAloudState(
        messageId: state.messageId,
        author: state.author,
        text: state.text,
        status: MessageReadAloudStatus.playing,
      );
    }
  }

  Future<void> retry() async {
    final messageId = state.messageId;
    if (messageId == null) return;
    // `state.text` is already flattened — re-running messageTextForSpeech
    // would treat code content (e.g. `__init__`) as Markdown markers.
    await _speakText(
      messageId: messageId,
      author: state.author,
      text: state.text,
    );
  }

  void stop() {
    if (_isSupported) unawaited(_channel.invokeMethod<void>('stop'));
    state = const MessageReadAloudState();
  }

  Future<void> _handleNativeCallback(MethodCall call) async {
    final messageId = call.arguments as String?;
    if (messageId == null || state.messageId != messageId) return;
    if (call.method == 'finished') {
      state = MessageReadAloudState(
        messageId: state.messageId,
        author: state.author,
        text: state.text,
        status: MessageReadAloudStatus.finished,
      );
    } else if (call.method == 'failed') {
      _fail(messageId);
    }
  }

  void _fail(String messageId) {
    if (state.messageId != messageId) return;
    state = MessageReadAloudState(
      messageId: state.messageId,
      author: state.author,
      text: state.text,
      status: MessageReadAloudStatus.error,
      error: "Couldn't play audio. Try again.",
    );
  }
}

final messageReadAloudProvider =
    NotifierProvider<MessageReadAloudNotifier, MessageReadAloudState>(
      MessageReadAloudNotifier.new,
    );
