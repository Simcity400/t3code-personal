export interface ReducedMotionPreference {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

interface WorkingDotsAnimationInput {
  readonly motionPreference: ReducedMotionPreference;
  readonly writeDots: (value: string) => void;
  readonly setInterval: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  readonly clearInterval: (intervalId: ReturnType<typeof setInterval>) => void;
}

export function workingDotsFrame(frame: number): string {
  const visibleDots = Math.max(0, Math.min(3, Math.floor(frame)));
  return `${".".repeat(visibleDots)}${"\u00a0".repeat(3 - visibleDots)}`;
}

export function startWorkingDotsAnimation(input: WorkingDotsAnimationInput): () => void {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let frame = 0;

  const stopInterval = () => {
    if (intervalId === null) return;
    input.clearInterval(intervalId);
    intervalId = null;
  };
  const syncMotionPreference = () => {
    stopInterval();
    if (input.motionPreference.matches) {
      input.writeDots("...");
      return;
    }

    frame = 1;
    input.writeDots(workingDotsFrame(frame));
    intervalId = input.setInterval(() => {
      frame = (frame + 1) % 4;
      input.writeDots(workingDotsFrame(frame));
    }, 650);
  };

  input.motionPreference.addEventListener("change", syncMotionPreference);
  syncMotionPreference();
  return () => {
    stopInterval();
    input.motionPreference.removeEventListener("change", syncMotionPreference);
  };
}
