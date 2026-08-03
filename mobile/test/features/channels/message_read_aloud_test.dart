import 'package:buzz/features/channels/message_read_aloud.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('preserves readable words while flattening Markdown', () {
    expect(
      messageTextForSpeech(
        '## **Update**\n\n'
        'Read [the guide](https://example.com), then run `buzz check`.\n\n'
        '```sh\nbuzz status\n```',
      ),
      'Update\n\nRead the guide, then run buzz check.\n\nbuzz status',
    );
  });

  test('keeps image alt text and list content', () {
    expect(
      messageTextForSpeech('- First\n- ![Diagram](https://example.com/a.png)'),
      'First\nDiagram',
    );
  });

  test('preserves code identifiers exactly', () {
    expect(
      messageTextForSpeech(
        'Use `message_read_aloud.dart` and `__init__` next.',
      ),
      'Use message_read_aloud.dart and __init__ next.',
    );
  });
}
