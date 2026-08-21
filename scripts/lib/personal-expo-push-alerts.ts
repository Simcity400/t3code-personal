/**
 * Decides whether a build or update ships the personal Expo push alert route
 * (`extra.personalExpoPushAlerts`), where each connected T3 Code environment
 * pushes straight to exp.host instead of going through a hosted APNs relay.
 *
 * The preview variant *is* the personal build, so it defaults on. That default
 * exists because the previous `=== "1"` check made the whole feature depend on
 * one env var being exported by whichever path happened to publish: the local
 * publisher never set it and shipped OTAs with alerts silently disabled, so the
 * app never even requested a push token. Setting the variable to "0" is still
 * honoured for a deliberate opt-out.
 */
export function resolvePersonalExpoPushAlerts(
  appVariant: "development" | "preview" | "production",
  value: string | undefined,
): boolean {
  if (value === "1") return true;
  if (value === "0") return false;
  return appVariant === "preview";
}
