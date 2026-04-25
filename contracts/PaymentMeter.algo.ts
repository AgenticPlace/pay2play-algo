/**
 * PaymentMeter — AlgoKit TypeScript smart contract for pay2play-algo.
 *
 * Mirrors the HTTP 402 pattern from pay2play-arc but settles on Algorand AVM.
 * Clients must include a pay transaction in the same atomic group to access
 * gated API calls.
 *
 * Compile: pnpm tsx node_modules/@algorandfoundation/puya-ts/bin/puya-ts.js contracts/PaymentMeter.algo.ts
 * Deploy:  pnpm deploy
 *
 * Ref: https://docs.arc.network/ (Algorand TypeScript patterns)
 *      https://github.com/algorandfoundation/algokit-utils-ts
 */

import {
  Contract,
  GlobalState,
  assert,
  gtxn,
  sendPayment,
  log,
  op,
} from "@algorandfoundation/algorand-typescript";

import type { uint64, PayTxn } from "@algorandfoundation/algorand-typescript";

export class PaymentMeter extends Contract {
  // Price per API call in microALGO (1000 = 0.001 ALGO ≈ $0.001 at ~$1/ALGO)
  pricePerCall = GlobalState<uint64>({ initialValue: 1_000n });

  // Total ALGO received (for observability)
  totalReceived = GlobalState<uint64>({ initialValue: 0n });

  // Total calls served
  callCount = GlobalState<uint64>({ initialValue: 0n });

  /**
   * Verify a group transaction payment, then record the call.
   * Must be called as part of a 2-txn atomic group:
   *   [0] PayTxn: caller → app.address, amount >= pricePerCall
   *   [1] AppCallTxn: this.pay()
   */
  pay(): void {
    const payTxn = gtxn<PayTxn>(0);
    assert(payTxn.receiver === this.app.address, "payment must go to app");
    assert(
      payTxn.amount >= this.pricePerCall.value,
      "payment below required price",
    );
    this.totalReceived.value  = this.totalReceived.value  + payTxn.amount;
    this.callCount.value      = this.callCount.value      + 1n;
    log(`paid:${payTxn.amount}:call:${this.callCount.value}`);
  }

  /** Creator updates the price per call. */
  setPrice(newPrice: uint64): void {
    assert(
      this.txn.sender === this.app.creator,
      "only creator can set price",
    );
    assert(newPrice > 0n, "price must be > 0");
    this.pricePerCall.value = newPrice;
  }

  /** Creator withdraws accumulated ALGO. */
  withdraw(amount: uint64): void {
    assert(
      this.txn.sender === this.app.creator,
      "only creator can withdraw",
    );
    sendPayment({
      receiver: this.txn.sender,
      amount,
      note: "pay2play-algo withdrawal",
    });
  }

  /** Read current price and stats (no payment required). */
  getStats(): readonly [uint64, uint64, uint64] {
    return [
      this.pricePerCall.value,
      this.totalReceived.value,
      this.callCount.value,
    ];
  }
}
