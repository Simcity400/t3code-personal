import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";

/** Match the server's continuation guard when switching an existing thread's account. */
export function compatibleProviderInstanceIdsForThread(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly driver?: string | null;
}): ReadonlySet<string> {
  const compatible = new Set<string>([input.instanceId]);
  const lockedProvider = input.providers.find(
    (provider) => provider.instanceId === input.instanceId,
  );
  const lockedDriver = lockedProvider?.driver ?? input.driver;
  if (!lockedDriver) {
    return compatible;
  }

  const continuationGroupKey = lockedProvider?.continuation?.groupKey;
  if (lockedDriver === "antigravity" && continuationGroupKey === undefined) {
    return compatible;
  }

  for (const provider of input.providers) {
    if (
      provider.driver === lockedDriver &&
      (continuationGroupKey === undefined ||
        provider.continuation?.groupKey === continuationGroupKey)
    ) {
      compatible.add(provider.instanceId);
    }
  }
  return compatible;
}

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

/** A model can disappear while the picker is open. */
export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some((model) => model.key === pending.key && !model.isUnavailable),
  );
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
