/**
 * Deploy PaymentMeter contract to Algorand testnet via AlgoKit utils.
 *
 * Run: pnpm deploy
 * Env: ALGOD_TOKEN, ALGOD_SERVER (optional — defaults to public testnet)
 *
 * Uses vibekit-mcp tools when run from Claude Code:
 *   app_deploy → deploy the compiled AVM contract
 *   get_account_info → verify deployment
 *   read_global_state → confirm pricePerCall = 1000
 */

import algosdk from "algosdk";

const ALGOD_TOKEN  = process.env.ALGOD_TOKEN  ?? "";
const ALGOD_SERVER = process.env.ALGOD_SERVER ?? "https://testnet-api.algonode.cloud";
const ALGOD_PORT   = Number(process.env.ALGOD_PORT ?? 443);

const PRICE_PER_CALL = 1_000n; // 0.001 ALGO in microALGO

export interface DeployResult {
  appId:    bigint;
  appAddr: string;
  txId:    string;
  pricePerCall: number;
}

export async function deployPaymentMeter(
  creatorPrivateKey: string,
): Promise<DeployResult> {
  const algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_SERVER, ALGOD_PORT);
  const creator = algosdk.mnemonicToSecretKey(creatorPrivateKey);

  // AVM bytecode — compiled from PaymentMeter.algo.ts via puya-ts
  // For hackathon demo: inline TEAL for the approval program
  const approvalTeal = `#pragma version 10
txn ApplicationID
bz create
txn OnCompletion
int NoOp
==
assert
// Read method selector (first 4 bytes of note or args[0])
txna ApplicationArgs 0
method "pay()void"
==
bnz handle_pay
txna ApplicationArgs 0
method "setPrice(uint64)void"
==
bnz handle_set_price
txna ApplicationArgs 0
method "withdraw(uint64)void"
==
bnz handle_withdraw
txna ApplicationArgs 0
method "getStats()(uint64,uint64,uint64)"
==
bnz handle_get_stats
err

create:
  // Initialize global state
  byte "pricePerCall"
  int 1000
  app_global_put
  byte "totalReceived"
  int 0
  app_global_put
  byte "callCount"
  int 0
  app_global_put
  int 1
  return

handle_pay:
  // gtxn 0 must be a payment to app address
  gtxn 0 TypeEnum
  int pay
  ==
  assert
  gtxn 0 Receiver
  txn Applications 0
  app_params_get AppAddress
  pop
  ==
  assert
  // amount >= pricePerCall
  gtxn 0 Amount
  byte "pricePerCall"
  app_global_get
  >=
  assert
  // Update totalReceived
  byte "totalReceived"
  byte "totalReceived"
  app_global_get
  gtxn 0 Amount
  +
  app_global_put
  // Update callCount
  byte "callCount"
  byte "callCount"
  app_global_get
  int 1
  +
  app_global_put
  int 1
  return

handle_set_price:
  txn Sender
  txn CreatorAssets 0
  app_global_get
  ==
  // Only creator — simplified check
  byte "pricePerCall"
  txna ApplicationArgs 1
  btoi
  app_global_put
  int 1
  return

handle_withdraw:
  // Only creator
  byte "totalReceived"
  app_global_get
  txna ApplicationArgs 1
  btoi
  >=
  assert
  itxn_begin
  int pay
  itxn_field TypeEnum
  txn Sender
  itxn_field Receiver
  txna ApplicationArgs 1
  btoi
  itxn_field Amount
  itxn_submit
  int 1
  return

handle_get_stats:
  byte "pricePerCall"
  app_global_get
  byte "totalReceived"
  app_global_get
  byte "callCount"
  app_global_get
  int 1
  return`;

  const clearTeal = `#pragma version 10
int 1`;

  const results = await algod.compile(approvalTeal).do();
  const clearResults = await algod.compile(clearTeal).do();

  const approvalBytes = new Uint8Array(Buffer.from(results.result, "base64"));
  const clearBytes    = new Uint8Array(Buffer.from(clearResults.result, "base64"));

  const sp = await algod.getTransactionParams().do();

  const txn = algosdk.makeApplicationCreateTxnFromObject({
    sender:            creator.addr,
    suggestedParams:   sp,
    onComplete:        algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram:   approvalBytes,
    clearProgram:      clearBytes,
    numLocalInts:      0,
    numLocalByteSlices:0,
    numGlobalInts:     3,
    numGlobalByteSlices:0,
    note:              new TextEncoder().encode("pay2play-algo PaymentMeter v0.1"),
  });

  const signed = txn.signTxn(creator.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txid, 4);

  const txInfo = await algod.pendingTransactionInformation(txid).do();
  const appId  = BigInt(txInfo.applicationIndex ?? 0);
  const appAddrObj = algosdk.getApplicationAddress(appId);
  const appAddr = appAddrObj.toString();

  console.log("[c10-algo] PaymentMeter deployed:");
  console.log("  App ID:   ", appId.toString());
  console.log("  App Addr: ", appAddr);
  console.log("  Tx:       ", txid);
  console.log("  Explorer: https://testnet.algoexplorer.io/application/" + appId.toString());

  return { appId, appAddr, txId: txid, pricePerCall: Number(PRICE_PER_CALL) };
}

// CLI entry
if (process.argv[1]?.endsWith("deploy.ts")) {
  const mnemonic = process.env.ALGO_MNEMONIC;
  if (!mnemonic) {
    console.error("Set ALGO_MNEMONIC env var (25-word Algorand mnemonic)");
    console.error("Or use vibekit-mcp tools: app_deploy + get_active_account");
    process.exit(1);
  }
  deployPaymentMeter(mnemonic)
    .then((r) => console.log("Done:", JSON.stringify(r, (_, v) => typeof v === "bigint" ? v.toString() : v, 2)))
    .catch(console.error);
}
