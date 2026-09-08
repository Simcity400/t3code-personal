import * as Notifications from "expo-notifications";

const agentNotificationForegroundBehavior: Notifications.NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

/** Make remote agent alerts visible when T3 Code is already in the foreground. */
export function configureAgentNotificationPresentation(): void {
  Notifications.setNotificationHandler({
    handleNotification: () => Promise.resolve(agentNotificationForegroundBehavior),
  });
}
