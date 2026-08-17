import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Notifications from "expo-notifications";

import {
  __resetPersonalExpoPushRegistrationForTest,
  getPersonalExpoPushRegistrationStatus,
  isPersonalExpoPushRegistrationAccepted,
  readPersonalExpoPushRegistration,
  requestPersonalExpoPushRegistrationRefresh,
  setPersonalExpoPushRegistrationStatus,
  subscribePersonalExpoPushRegistrationStatus,
  onPersonalExpoPushRegistrationRefresh,
} from "./expoPushRegistration";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        personalExpoPushAlerts: true,
        eas: { projectId: "personal-project" },
      },
    },
  },
}));

vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
  getExpoPushTokenAsync: vi.fn(() =>
    Promise.resolve({ type: "expo", data: "ExponentPushToken[personal]" }),
  ),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

beforeEach(() => {
  __resetPersonalExpoPushRegistrationForTest();
  vi.clearAllMocks();
});

describe("personal Expo push registration", () => {
  it("reads the project-scoped Expo token after notification permission is granted", async () => {
    await expect(readPersonalExpoPushRegistration()).resolves.toEqual({
      enabled: true,
      token: "ExponentPushToken[personal]",
    });
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: "personal-project",
    });
  });

  it("returns an explicit disabled registration when permission is off", async () => {
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValueOnce({
      granted: false,
    } as Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
    await expect(readPersonalExpoPushRegistration()).resolves.toEqual({ enabled: false });
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it("publishes status and refresh changes to subscribers", () => {
    const statusListener = vi.fn();
    const refreshListener = vi.fn();
    const removeStatus = subscribePersonalExpoPushRegistrationStatus(statusListener);
    const removeRefresh = onPersonalExpoPushRegistrationRefresh(refreshListener);

    setPersonalExpoPushRegistrationStatus("registered");
    requestPersonalExpoPushRegistrationRefresh();
    expect(getPersonalExpoPushRegistrationStatus()).toBe("registered");
    expect(statusListener).toHaveBeenCalledTimes(1);
    expect(refreshListener).toHaveBeenCalledTimes(1);

    removeStatus();
    removeRefresh();
  });

  it("accepts only acknowledgements matching the requested registration state", () => {
    expect(
      isPersonalExpoPushRegistrationAccepted(
        { enabled: true, token: "ExponentPushToken[personal]" },
        { registered: true },
      ),
    ).toBe(true);
    expect(
      isPersonalExpoPushRegistrationAccepted(
        { enabled: true, token: "ExponentPushToken[personal]" },
        { registered: false },
      ),
    ).toBe(false);
    expect(isPersonalExpoPushRegistrationAccepted({ enabled: false }, { registered: false })).toBe(
      true,
    );
  });
});
