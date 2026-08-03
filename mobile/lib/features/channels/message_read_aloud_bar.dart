import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../shared/theme/theme.dart';
import 'message_read_aloud.dart';

class MessageReadAloudBar extends HookConsumerWidget {
  const MessageReadAloudBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final playback = ref.watch(messageReadAloudProvider);
    final showPreparing = useState(false);
    useEffect(() {
      if (playback.status != MessageReadAloudStatus.preparing) {
        showPreparing.value = false;
        return null;
      }
      final timer = Timer(const Duration(milliseconds: 200), () {
        showPreparing.value = true;
      });
      return timer.cancel;
    }, [playback.status]);
    if (playback.messageId == null ||
        playback.status == MessageReadAloudStatus.idle ||
        playback.status == MessageReadAloudStatus.finished ||
        (playback.status == MessageReadAloudStatus.preparing &&
            !showPreparing.value)) {
      return const SizedBox.shrink();
    }

    final notifier = ref.read(messageReadAloudProvider.notifier);
    final isPaused = playback.status == MessageReadAloudStatus.paused;
    final isError = playback.status == MessageReadAloudStatus.error;
    final isPreparing = playback.status == MessageReadAloudStatus.preparing;

    return Semantics(
      liveRegion: true,
      label: isError
          ? playback.error
          : isPreparing
          ? 'Preparing audio'
          : 'Reading message from ${playback.author}',
      child: Container(
        margin: const EdgeInsets.fromLTRB(
          Grid.gutter,
          Grid.quarter,
          Grid.gutter,
          Grid.quarter,
        ),
        padding: const EdgeInsets.symmetric(
          horizontal: Grid.half,
          vertical: Grid.quarter,
        ),
        constraints: const BoxConstraints(minHeight: 44),
        decoration: BoxDecoration(
          color: context.colors.surface,
          border: Border.all(color: context.colors.outlineVariant),
          borderRadius: BorderRadius.circular(Radii.lg),
        ),
        child: Row(
          children: [
            if (isPreparing)
              SizedBox.square(
                dimension: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: context.colors.primary,
                ),
              )
            else
              Icon(
                LucideIcons.volume2,
                size: 18,
                color: context.colors.primary,
              ),
            const SizedBox(width: Grid.half),
            Expanded(
              child: Text(
                isError
                    ? "Couldn't play audio. Try again."
                    : isPreparing
                    ? 'Preparing audio…'
                    : 'Reading message from ${playback.author}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: context.textTheme.bodySmall?.copyWith(
                  color: context.colors.onSurfaceVariant,
                ),
              ),
            ),
            if (isError)
              TextButton.icon(
                onPressed: () => unawaited(notifier.retry()),
                icon: const Icon(LucideIcons.rotateCcw, size: 16),
                label: const Text('Retry'),
              )
            else if (!isPreparing)
              IconButton(
                tooltip: isPaused ? 'Resume reading' : 'Pause reading',
                onPressed: () =>
                    unawaited(isPaused ? notifier.resume() : notifier.pause()),
                icon: Icon(
                  isPaused ? LucideIcons.play : LucideIcons.pause,
                  size: 18,
                ),
              ),
            IconButton(
              tooltip: 'Stop reading',
              onPressed: notifier.stop,
              icon: const Icon(LucideIcons.x, size: 18),
            ),
          ],
        ),
      ),
    );
  }
}
