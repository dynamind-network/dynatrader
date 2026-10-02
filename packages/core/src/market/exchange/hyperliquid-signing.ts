/**
 * Hyperliquid Action Signing — EIP-712 via viem
 *
 * Implements the Hyperliquid signing spec:
 * 1. Serialize the action and hash it with keccak256 (Hyperliquid's "action hash")
 * 2. Construct the EIP-712 "hyperliquidTokenBridge"-style exchange domain
 *    (name: "Exchange", version: "1", chainId: 1337)
 * 3. Sign the digest with the wallet's private key (secp256k1)
 *
 * Spec reference:
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
 */

import { encode } from "@msgpack/msgpack";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, concatHex, toHex } from "viem";

export interface HlSignature {
  r: string;
  s: string;
  v: number;
}

export interface HyperliquidSigningOptions {
  source?: "a" | "b";
  vaultAddress?: `0x${string}`;
  expiresAfter?: number;
}

const DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

export function hashAction(
  action: Record<string, unknown>,
  nonce: number,
  options: Pick<HyperliquidSigningOptions, "vaultAddress" | "expiresAfter"> = {},
): `0x${string}` {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("nonce must be a non-negative safe integer");
  const nonceBytes = uint64(nonce);
  const vaultMarker = options.vaultAddress ? concatHex(["0x01", options.vaultAddress]) : "0x00";
  const expiry = options.expiresAfter === undefined ? "0x" : concatHex(["0x00", uint64(options.expiresAfter)]);
  return keccak256(concatHex([toHex(encode(action)), nonceBytes, vaultMarker, expiry]));
}

export async function signUserAction(
  action: Record<string, unknown>,
  nonce: number,
  privateKey: `0x${string}`,
  options: HyperliquidSigningOptions = {},
): Promise<{ signature: HlSignature; actionHash: `0x${string}` }> {
  const source = options.source ?? "a";
  const actionHash = hashAction(action, nonce, options);
  const signatureHex = await privateKeyToAccount(privateKey).signTypedData({
    domain: DOMAIN,
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source, connectionId: actionHash },
  });
  return {
    actionHash,
    signature: {
      r: `0x${signatureHex.slice(2, 66).replace(/^0+/, "")}`,
      s: `0x${signatureHex.slice(66, 130)}`,
      v: parseInt(signatureHex.slice(130, 132), 16),
    },
  };
}

function uint64(value: number): `0x${string}` {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("value must be a non-negative safe integer");
  return `0x${BigInt(value).toString(16).padStart(16, "0")}`;
}
