// CORE_SYNCED_AT: 2026-04-26T00:02Z
// CORE_SOURCE: github.com/AgenticPlace/pay2play @ 7e386939ef9812e1e87b65ec3d461ff0fbc50140
// DO NOT EDIT BY HAND — sync via scripts/sync-core.sh
import type { PaymentPayload, UsageSignal } from "./types.js";

/**
 * A voucher — a signed PaymentPayload together with the usage signal that
 * triggered it. Clients accumulate vouchers as the user/agent consumes
 * a stream; servers flush them into a batched on-chain settlement.
 */
export interface Voucher {
  id: string;
  signal: UsageSignal;
  payload: PaymentPayload;
  signedAt: number;  // unix ms
}

export interface SessionOptions {
  /** Flush when this many vouchers have accumulated. Default: 100. */
  flushEveryN?: number;
  /** Flush when this many milliseconds elapsed since last flush. Default: 5000. */
  flushEveryMs?: number;
  /** Called when a flush is due. Return settlement-count or throw. */
  onFlush: (vouchers: Voucher[]) => Promise<number>;
  /** Optional counters for observability. */
  onCounterChange?: (counters: SessionCounters) => void;
}

export interface SessionCounters {
  vouchersSigned: number;
  vouchersFlushed: number;
  batchesSettled: number;
  lastFlushAt: number | null;
}

/**
 * A Session accumulates signed vouchers on one side (client) or receives
 * them and flushes them on the other (server). Decouples "how often to
 * sign" from "how often to settle on-chain".
 *
 * The same class serves both ends: the client calls `.record(voucher)` as
 * it generates signed authorizations; the server calls `.record(voucher)`
 * as vouchers arrive, and the `onFlush` callback invokes
 * `BatchFacilitatorClient.settle` on behalf of the server.
 */
export class Session {
  private buffer: Voucher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private counters: SessionCounters = {
    vouchersSigned: 0,
    vouchersFlushed: 0,
    batchesSettled: 0,
    lastFlushAt: null,
  };

  constructor(private opts: SessionOptions) {}

  get snapshot(): SessionCounters {
    return { ...this.counters };
  }

  async record(voucher: Voucher): Promise<void> {
    this.buffer.push(voucher);
    this.counters.vouchersSigned += 1;
    this.opts.onCounterChange?.(this.snapshot);

    const flushN = this.opts.flushEveryN ?? 100;
    if (this.buffer.length >= flushN) {
      await this.flush();
    } else if (this.timer === null) {
      const flushMs = this.opts.flushEveryMs ?? 5000;
      this.timer = setTimeout(() => {
        void this.flush();
      }, flushMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const toFlush = this.buffer;
    this.buffer = [];

    const settled = await this.opts.onFlush(toFlush);
    this.counters.vouchersFlushed += toFlush.length;
    this.counters.batchesSettled += settled;
    this.counters.lastFlushAt = Date.now();
    this.opts.onCounterChange?.(this.snapshot);
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

let nextId = 1;
export function mkVoucherId(): string {
  return `v${Date.now().toString(36)}${(nextId++).toString(36)}`;
}
