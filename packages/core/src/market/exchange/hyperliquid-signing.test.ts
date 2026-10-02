import { describe, it, expect } from "vitest";
import { concatHex, keccak256 } from "viem";
import { hashAction, signUserAction } from "./hyperliquid-signing";

const OFFICIAL_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123" as const;
const OFFICIAL_ACTION = { type: "dummy", num: 100000000000 };
const VECTORS = [
  { source: "a", r: "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298", s: "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", v: 27 },
  { source: "b", r: "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510", s: "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", v: 28 },
] as const;

describe("Hyperliquid official SDK L1 signing vectors", () => {
  it.each(VECTORS)("matches the exact $source offline SDK signature", async ({ source, r, s, v }) => {
    const result = await signUserAction(OFFICIAL_ACTION, 0, OFFICIAL_KEY, { source });
    expect(result.signature).toEqual({ r, s, v });
  });

  it("hashes MessagePack bytes plus uint64 nonce and the absent-vault marker", () => {
    const msgpackAction = "0x82a474797065a564756d6d79a36e756dcf000000174876e800";
    const nonce = "0x0000000000000000";
    expect(hashAction(OFFICIAL_ACTION, 0)).toBe(keccak256(concatHex([msgpackAction, nonce, "0x00"])));
  });
});
