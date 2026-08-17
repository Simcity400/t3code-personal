export function formatAgentElapsed(startedAt: string, endedAtMs: number): string | null {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    return null;
  }

  const seconds = Math.floor((endedAtMs - startedAtMs) / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;

  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function workingDotOpacities(
  tick: number,
  reduceMotion: boolean,
): readonly [number, number, number] {
  const visibleDots = reduceMotion ? 3 : Math.abs(Math.floor(tick)) % 4;
  return [1, 2, 3].map((dot) => (dot <= visibleDots ? 1 : 0.18)) as [number, number, number];
}

export function agentStatusAccessibilityLabel(status: string, elapsed: string | null): string {
  return elapsed ? `${status}, ${elapsed}` : status;
}
