import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class MockSpeechSynthesisUtterance extends EventTarget {
      error: string | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onpause: (() => void) | null = null;
      onresume: (() => void) | null = null;
      onstart: (() => void) | null = null;

      constructor(public text: string) {
        super();
      }
    }

    let active: MockSpeechSynthesisUtterance | null = null;
    const speechSynthesis = {
      cancel() {
        active = null;
      },
      getVoices() {
        return [];
      },
      pause() {
        active?.onpause?.();
      },
      paused: false,
      pending: false,
      resume() {
        active?.onresume?.();
      },
      speak(utterance: MockSpeechSynthesisUtterance) {
        active = utterance;
        window.setTimeout(() => {
          if (active === utterance) utterance.onstart?.();
        }, 250);
      },
      speaking: false,
    };

    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: MockSpeechSynthesisUtterance,
    });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: speechSynthesis,
    });
  });
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        displayName: "Honey",
        ownerPubkey: TEST_IDENTITIES.tyler.pubkey,
        isAgent: true,
      },
    ],
  });
});

test("messages expose private read-aloud controls", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await page.getByTestId("channel-general").click();

  const agentMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Hey team — checking in." });
  const humanMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Welcome to #general" });

  await agentMessage.hover();
  const listenButton = agentMessage.getByRole("button", {
    name: "Listen to message",
  });
  await expect(listenButton).toBeVisible();
  await humanMessage.hover();
  await expect(
    humanMessage.getByRole("button", { name: "Listen to message" }),
  ).toBeVisible();
  await agentMessage.hover();
  await page.screenshot({
    path: testInfo.outputPath("agent-listen-hover.png"),
  });

  await listenButton.click();
  const readAloudBar = page.getByTestId("message-read-aloud-bar");
  await expect(readAloudBar).toContainText("Reading message from Honey");
  await expect(
    readAloudBar.getByRole("button", { name: "Pause reading" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("agent-now-reading.png"),
  });

  await readAloudBar.getByRole("button", { name: "Pause reading" }).click();
  await expect(
    readAloudBar.getByRole("button", { name: "Resume reading" }),
  ).toBeVisible();
  await readAloudBar.getByRole("button", { name: "Resume reading" }).click();
  await expect(
    readAloudBar.getByRole("button", { name: "Pause reading" }),
  ).toBeVisible();
  await readAloudBar.getByRole("button", { name: "Stop reading" }).click();
  await expect(readAloudBar).toHaveCount(0);
});
