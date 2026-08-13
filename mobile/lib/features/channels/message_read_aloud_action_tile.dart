import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'message_read_aloud.dart';
import 'timeline_message.dart';

/// iOS action-sheet control for starting or controlling message narration.
class MessageReadAloudActionTile extends ConsumerWidget {
  final TimelineMessage message;
  final String author;

  const MessageReadAloudActionTile({
    super.key,
    required this.message,
    required this.author,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final playback = ref.watch(messageReadAloudProvider);
    final isThisMessage = playback.messageId == message.id;
    final status = isThisMessage
        ? playback.status
        : MessageReadAloudStatus.idle;
    final label = switch (status) {
      MessageReadAloudStatus.preparing => 'Preparing audio…',
      MessageReadAloudStatus.playing => 'Pause reading',
      MessageReadAloudStatus.paused => 'Resume reading',
      MessageReadAloudStatus.finished => 'Replay message',
      _ => 'Listen to message',
    };
    final icon = switch (status) {
      MessageReadAloudStatus.playing => LucideIcons.pause,
      MessageReadAloudStatus.paused => LucideIcons.play,
      MessageReadAloudStatus.finished => LucideIcons.rotateCcw,
      _ => LucideIcons.volume2,
    };

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon),
      title: Text(label),
      onTap: status == MessageReadAloudStatus.preparing
          ? null
          : () {
              Navigator.of(context).pop();
              unawaited(
                ref
                    .read(messageReadAloudProvider.notifier)
                    .listen(
                      messageId: message.id,
                      author: author,
                      markdown: message.content,
                    ),
              );
            },
    );
  }
}
