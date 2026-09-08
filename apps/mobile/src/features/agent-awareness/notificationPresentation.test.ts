import * as Notifications from "expo-notifications";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { configureAgentNotificationPresentation } from "./notificationPresentation";

vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
}));

describe("configureAgentNotificationPresentation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows foreground notifications in both the banner and notification list", async () => {
    configureAgentNotificationPresentation();

    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = vi.mocked(Notifications.setNotificationHandler).mock.calls[0]?.[0];
    expect(handler).toBeDefined();
    await expect(handler!.handleNotification({} as never)).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });
  });
});
