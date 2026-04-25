import { describe, it, expect } from "vitest";
import {
  meter,
  ALGORAND_TESTNET_CAIP2,
  parseAlgoPrice,
  encodeHeader,
  decodeHeader,
  isAlgoPayment,
  isEvmPayment,
  Session,
  type AlgoPaymentPayload,
  type Voucher,
} from "../src/core/index.js";

describe("vendored core (round-trip)", () => {
  it("parseAlgoPrice converts USD-style strings to atomic microALGO", () => {
    expect(parseAlgoPrice("$0.001")).toBe(1_000n);
    expect(parseAlgoPrice("0.001")).toBe(1_000n);
    expect(parseAlgoPrice("$1")).toBe(1_000_000n);
    expect(parseAlgoPrice("$0.0001")).toBe(100n);
  });

  it("meter() builds Algorand-shaped requirement and challenge", () => {
    const m = meter({ request: "$0.001" }, { appId: 12345, appAddress: "AAAA" });
    expect(m.price({ kind: "request" })).toBe("$0.001");
    expect(m.priceAtomic({ kind: "request" })).toBe(1_000n);

    const req = m.requirement({ kind: "request" }, "RECEIVER");
    expect(req.network).toBe(ALGORAND_TESTNET_CAIP2);
    expect(req.asset).toBe("ALGO");
    expect(req.amount).toBe("1000");
    expect(req.payTo).toBe("RECEIVER");
    expect(req.extra?.appId).toBe(12345);
    expect(req.extra?.appAddress).toBe("AAAA");
    expect(req.extra?.name).toBe("AlgorandAtomicPay");

    const ch = m.challenge({ kind: "request" }, {
      payTo: "RECEIVER", resourceUrl: "http://x/y",
    });
    expect(ch.x402Version).toBe(2);
    expect(ch.accepts[0].network).toBe(ALGORAND_TESTNET_CAIP2);
  });

  it("AlgoPaymentPayload round-trips and is correctly discriminated", () => {
    const payload: AlgoPaymentPayload = {
      x402Version: 2,
      network: "algorand:testnet-v1.0",
      payload: { sender: "AAAA", txId: "TXID", appId: 99 },
    };
    const b64 = encodeHeader(payload);
    const decoded = decodeHeader<AlgoPaymentPayload>(b64);
    expect(decoded).toEqual(payload);
    expect(isAlgoPayment(decoded)).toBe(true);
    expect(isEvmPayment(decoded)).toBe(false);
  });

  it("Session accumulates AlgoPaymentPayload-shaped vouchers", async () => {
    const flushed: Voucher[][] = [];
    const session = new Session({
      flushEveryN: 2,
      flushEveryMs: 60_000,
      onFlush: async (vs) => {
        flushed.push(vs);
        return 1;
      },
    });

    for (let i = 0; i < 4; i++) {
      const v: Voucher = {
        id: `v${i}`,
        signal: { kind: "request" },
        payload: {
          x402Version: 2,
          network: "algorand:testnet-v1.0",
          payload: { sender: "AAAA", txId: `TXID${i}`, appId: 1 },
        },
        signedAt: Date.now(),
      };
      await session.record(v);
    }
    await session.close();

    expect(flushed.length).toBeGreaterThanOrEqual(2);
    expect(flushed.flat()).toHaveLength(4);
    flushed.flat().forEach((v) => {
      expect(isAlgoPayment(v.payload)).toBe(true);
    });
  });

  it("an unknown UsageKind throws (no silent miss)", () => {
    const m = meter({ request: "$0.001" });
    expect(() => m.price({ kind: "tokens", count: 100 })).toThrow(/No price rule/);
  });
});
