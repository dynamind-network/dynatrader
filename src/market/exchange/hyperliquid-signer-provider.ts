import { signUserAction, type HlSignature } from "./hyperliquid-signing";

/** Signing capability injected into the venue adapter; credentials stay in its provider closure. */
export interface HyperliquidActionSigner {
  signAction(action: Record<string, unknown>, nonce: number): Promise<HlSignature>;
}

export function createHyperliquidActionSigner(
  privateKey: `0x${string}`,
  source: "a" | "b",
): HyperliquidActionSigner {
  return {
    async signAction(action, nonce) {
      return (await signUserAction(action, nonce, privateKey, { source })).signature;
    },
  };
}
