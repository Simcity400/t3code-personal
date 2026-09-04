import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: input.selections,
  });
}

/**
 * Labels for the option values currently in effect (select values plus
 * enabled booleans), used to summarize the thread configuration in the
 * composer trigger pill.
 */
export function providerOptionValueLabels(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<string> {
  return descriptors.flatMap((descriptor) => {
    if (descriptor.type === "boolean") {
      return descriptor.currentValue ? [descriptor.label] : [];
    }
    const label = getProviderOptionCurrentLabel(descriptor);
    return label ? [label] : [];
  });
}

function providerOptionStatusLabel(descriptor: ProviderOptionDescriptor): string | null {
  if (descriptor.type === "boolean") {
    return `${descriptor.label} ${descriptor.currentValue ? "on" : "off"}`;
  }
  return getProviderOptionCurrentLabel(descriptor) ?? null;
}

/**
 * Compact composer readout for the two settings users need before sending:
 * reasoning/thinking quality and execution speed. Other provider metadata
 * stays in the settings sheet so these values remain visible without ellipsis.
 */
export function composerProviderOptionLabels(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<string> {
  const reasoning = descriptors.find((descriptor) =>
    /reason|effort|thinking/i.test(`${descriptor.id} ${descriptor.label}`),
  );
  const speed = descriptors.find((descriptor) =>
    /fast|speed|tier/i.test(`${descriptor.id} ${descriptor.label}`),
  );
  const visibleDescriptors = [reasoning, speed].filter(
    (descriptor, index, values): descriptor is ProviderOptionDescriptor =>
      descriptor !== undefined && values.indexOf(descriptor) === index,
  );
  const fallbackDescriptors =
    visibleDescriptors.length > 0 ? visibleDescriptors : descriptors.slice(0, 1);
  return fallbackDescriptors.flatMap((descriptor) => {
    const label = providerOptionStatusLabel(descriptor);
    return label ? [label] : [];
  });
}

/**
 * Applies one option change (by descriptor id) and returns the full selection
 * list to store on the model selection, or null when the change doesn't match
 * an advertised descriptor / choice.
 */
export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof change.value !== "string" ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: change.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}
