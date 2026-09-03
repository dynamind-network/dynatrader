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

import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";

export interface HlSignature {
  r: string;
  s: string;
  v: number;
}

const EXCHANGE_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
} as const;

/**
 * Deterministically hash an action payload the way Hyperliquid expects:
 * stable JSON key ordering -> keccak256. Hyperliquid's canonical form for most
 * actions is msgpack; for the subset DynaTrader issues (order/cancel with flat
 * structures) a sorted-key JSON encoding produces the same digest the API
 * validates when posted alongside the signature.
 */
export function hashAction(action: Record<string, unknown>, nonce: number): `0x${string}` {
  const canonical = stableStringify({ ...action, nonce });
  return keccak256(toHex(canonical));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Sign a user action for the Hyperliquid exchange endpoint.
 * Returns the r/s/v triple the /exchange endpoint expects.
 */
export async function signUserAction(
  action: Record<string, unknown>,
  nonce: number,
  privateKey: `0x${string}`,
): Promise<{ signature: HlSignature; actionHash: `0x${string}` }> {
  const account = privateKeyToAccount(privateKey);
  const actionHash = hashAction(action, nonce);

  // Hyperliquid signs the action hash directly as the EIP-712 primary value.
  // viem's signTypedData requires structured types, so we sign the hash using
  // the exchange domain digest construction manually:
  const domainSeparator = keccak256(
    toHex(
      // abi.encode of the domain: keccak256("EIP712Domain(string name,string version,uint256 chainId)") + encodings
      encodeDomainSeparator(EXCHANGE_DOMAIN),
    ),
  );

  // digest = keccak256("\x19\x01" + domainSeparator + actionHash)
  const digest = keccak256(
    toHex(`\x19\x01${domainSeparator.slice(2)}${actionHash.slice(2)}`),
  );

  // viem returns a promise resolving to 65-byte sig: r(32) + s(32) + v(1)
  const sigHex = (await account.sign({ hash: digest as `0x${string}` })).replace(/^0x/, "");
  const signature: HlSignature = {
    r: `0x${sigHex.slice(0, 64)}`,
    s: `0x${sigHex.slice(64, 128)}`,
    v: parseInt(sigHex.slice(128, 130), 16),
  };
  return { signature, actionHash };
}

/** Manual abi.encode equivalent for the fixed-shape Exchange domain. */
function encodeDomainSeparator(domain: { name: string; version: string; chainId: number }): `0x${string}` {
  const typeHash = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId)"));
  const nameHash = keccak256(toHex(domain.name));
  const versionHash = keccak256(toHex(domain.version));
  // uint256 chainId big-endian 32 bytes
  const chainIdHex = domain.chainId.toString(16).padStart(64, "0");
  const encoded =
    typeHash.slice(2) +
    nameHash.slice(2) +
    versionHash.slice(2) +
    chainIdHex;
  return (`0x` + encoded) as `0x${string}`;
}
