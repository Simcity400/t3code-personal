import type { ForkUpdateState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

// State of the personal-fork updater (see apps/desktop/src/updates/ForkUpdates.ts).
// Subscribes to pushed state first, then seeds with a one-shot fetch so a push
// that lands during the fetch is never clobbered by the (staler) seed.
export function useForkUpdateState(): ForkUpdateState | null {
  const [state, setState] = useState<ForkUpdateState | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onForkUpdateState !== "function") return;
    let cancelled = false;
    let receivedPush = false;
    const unsubscribe = bridge.onForkUpdateState((next) => {
      receivedPush = true;
      setState(next);
    });
    void bridge
      .getForkUpdateState()
      .then((initial) => {
        if (!cancelled && !receivedPush) setState(initial);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
