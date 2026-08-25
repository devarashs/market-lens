/* LensSocket — the connection layer the vanilla client never had.

   The old client's twin failure modes (2026-08-25, "things disappear and
   you have to reload"):
     1. A wedged-but-open socket showed "live" forever with a frozen page —
        nothing watched for silence.
     2. One throw inside onmessage silently killed that message's handling;
        no error surfaced anywhere.
   This class exists to make both impossible: a staleness watchdog forces a
   reconnect when the server (which pushes depth every 400ms) goes quiet,
   and every message dispatch is isolated so a bad payload costs one
   message, not the stream. */

import type { ConnectionStatus, ServerMessage } from "./types";

/** The collector broadcasts depth every 400ms — 10s of silence on an open
    socket can only mean a dead connection the TCP stack hasn't noticed. */
const STALE_AFTER_MS = 10_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 15_000;

/** Exponential backoff with full jitter: attempt 0 → up to 1s, doubling to
    a 15s cap. Jitter prevents every open tab reconnecting in lockstep
    after a server restart. Pure — `random` injected for tests. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export interface LensSocketHandlers {
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Called on every (re)open — the owner replies with its current
      subscription so a reconnect is never silently unsubscribed. */
  onOpen: () => void;
}

export class LensSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastMessageAt = 0;
  private reconnectTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private closed = false;

  constructor(private url: string, private handlers: LensSocketHandlers) {}

  start(): void {
    this.closed = false;
    this.handlers.onStatus("connecting");
    this.open();
    this.watchdogTimer = window.setInterval(() => this.checkStaleness(), WATCHDOG_INTERVAL_MS);
    // A backgrounded tab throttles timers; on return, check immediately so
    // a connection that died while hidden recovers without the wait.
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  stop(): void {
    this.closed = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
    // Not open → nothing to do: onOpen re-issues the subscription anyway.
  }

  private open(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.handlers.onStatus("live");
      this.handlers.onOpen();
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.ws?.close(); // funnel every failure into onclose
    this.ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // torn frame: drop it, the stream continues
      }
      try {
        this.handlers.onMessage(message);
      } catch (error) {
        // Isolation, not silence: one bad payload/handler bug costs one
        // message. Logged so it is diagnosable instead of invisible.
        console.error("lens message handler failed", message.type, error);
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.handlers.onStatus("reconnecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, backoffDelayMs(this.attempt++));
  }

  private checkStaleness(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
      this.handlers.onStatus("stale");
      this.ws.close(); // triggers onclose → backoff → fresh socket
    }
  }

  private onVisibility = (): void => {
    if (document.visibilityState === "visible") this.checkStaleness();
  };
}
