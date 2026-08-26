/* Wires the LensSocket to the store. Components never touch the socket:
   they change store state (symbol, venue filter) and the wiring here
   re-subscribes; the socket pushes messages back into the store. */

import { LensSocket } from "./socket";
import { useLensStore } from "../store/lens";

let socket: LensSocket | null = null;

function sendSubscribe(): void {
  const { symbol, activeVenues, binMults } = useLensStore.getState();
  socket?.send({
    cmd: "subscribe", symbol, venues: activeVenues ?? undefined,
    binMult: binMults[symbol] ?? 1,
  });
}

/** Idempotent: App calls this once on mount; StrictMode double-mount and
    HMR both hit the guard. */
export function startConnection(): void {
  if (socket !== null) return;
  const store = useLensStore.getState();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new LensSocket(`${protocol}://${location.host}/ws`, {
    onMessage: (message) => useLensStore.getState().applyMessage(message),
    onStatus: (status) => useLensStore.getState().setConnection(status),
    onOpen: () => {
      // A (re)connect means the seed about to arrive is the only truth:
      // drop whatever the previous connection left behind, then subscribe.
      useLensStore.getState().resetStreams();
      sendSubscribe();
    },
  });
  socket.start();
  store.setConnection("connecting");

  // Symbol or venue-filter changes re-issue the subscription (the server
  // keys each client's stream on its latest subscribe command).
  useLensStore.subscribe((state) => state.symbol, sendSubscribe);
  useLensStore.subscribe((state) => state.activeVenues, sendSubscribe);
  useLensStore.subscribe((state) => state.binMults, sendSubscribe);
}
