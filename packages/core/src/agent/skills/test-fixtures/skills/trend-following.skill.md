---
name: trend_following
description: Trend following strategy using moving average crossovers
type: strategy
tags:
  - trend
  - moving_average
  - momentum
requires:
  bins:
    - node
os:
  - win32
  - darwin
  - linux
confidence: 0.7
---

Monitor 50-day and 200-day MA crossovers.
Enter long when 50-day crosses above 200-day (golden cross).
Exit when 50-day crosses below 200-day (death cross).
Use ATR-based stop loss at 2x ATR below entry.
Scale position size inversely to volatility (higher VIX = smaller position).
