---
name: strategy-btc-usdt-binance-trending
description: Reusable strategy skill for BTC/USDT on binance in trending markets
sourceKind: strategy
---

# Learned strategy from BTC/USDT on binance

## Instructions

1. Use the learned strategy for BTC/USDT.
2. Adapt to trending conditions with 0.5 volatility.
3. Preserve the recorded risk rules and exit discipline.

## Approval

- State: approved

## Strategy

```json
{
  "id": "skill-1788044854619-y1ahw0e",
  "venue": "binance",
  "symbol": "BTC/USDT",
  "entry": {
    "type": "momentum",
    "enabled": true,
    "regime": "trending",
    "volatility": 0.5
  },
  "exits": {
    "stopLoss": 0.01
  },
  "sizing": {
    "method": "kelly",
    "kellyFraction": 0.25,
    "maxPositionPct": 0.1
  },
  "risk": {
    "maxPositionNotional": 5000,
    "maxDailyLoss": 500,
    "maxOpenOrders": 3
  },
  "executionMode": "paper"
}
```

## Evidence

- hist-loss-2
- hist-loss-2
- hist-loss-2
- hist-loss-2
- hist-loss-2
- trade-win-2
- trade-win-2
- trade-win-2
- trade-win-2
- trade-win-2
- hist-loss-0
- hist-loss-0
- hist-loss-0
- hist-loss-0
- hist-loss-0
- hist-loss-1
- hist-loss-1
- hist-loss-1
- hist-loss-1
- hist-loss-1
- hist-win-5
- hist-win-5
- hist-win-5
- hist-win-5
- hist-win-5
- hist-win-6
- hist-win-6
- hist-win-6
- hist-win-6
- hist-win-6
- hist-win-3
- hist-win-3
- hist-win-3
- hist-win-3
- hist-win-3
- hist-win-4
- hist-win-4
- hist-win-4
- hist-win-4
- hist-win-4
- hist-win-1
- hist-win-1
- hist-win-1
- hist-win-1
- hist-win-1
- hist-win-2
- hist-win-2
- hist-win-2
- hist-win-2
- hist-win-2
- trade-win-1
- trade-win-1
- trade-win-1
- trade-win-1
- trade-win-1
- hist-win-0
- hist-win-0
- hist-win-0
- hist-win-0
- hist-win-0
