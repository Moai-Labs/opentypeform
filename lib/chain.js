// The chain client: reads a testnet USDC balance through a JSON-RPC node.
//
// Payments are verified in the product itself: to confirm a payment the
// server asks a node for the token's balanceOf at the payment address and
// credits what arrived. No wallet, no signer, no key management beyond the
// receiving keys lib/eth.js generates — the product only reads.
//
// The defaults point at Base Sepolia, where Circle's official test USDC
// lives (verified on-chain this session: name "USDC", 6 decimals; see the
// README for the addresses and sources). Every value is overridable via
// environment or constructor options so tests run offline.
"use strict";

const DEFAULT_RPC_URL = "https://sepolia.base.org";
const DEFAULT_TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CHAIN_ID = 84532;
const NETWORK_NAME = "Base Sepolia";

// Reads the token balance (as a BigInt of base units) for an address.
// Throws on a node error or a malformed answer; callers treat an error as
// "not known yet" rather than a payment.
async function tokenBalance(options) {
  const { rpcUrl = process.env.RPC_URL || DEFAULT_RPC_URL, token = process.env.USDC_ADDRESS || DEFAULT_TOKEN, address } = options;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("bad address");
  }
  // balanceOf(address) — selector 0x70a08231.
  const result = await rpcCall(rpcUrl, "eth_call", [
    { to: token, data: "0x70a08231" + address.toLowerCase().slice(2).padStart(64, "0") },
    "latest",
  ]);
  if (typeof result !== "string") throw new Error("bad balanceOf answer");
  return BigInt(result);
}

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`rpc error: ${body.error.message || body.error.code}`);
  return body.result;
}

module.exports = { tokenBalance, DEFAULT_RPC_URL, DEFAULT_TOKEN, CHAIN_ID, NETWORK_NAME };
