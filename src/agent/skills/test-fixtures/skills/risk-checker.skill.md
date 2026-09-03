---
name: risk_checker
description: Pre-trade risk validation checks
type: risk
tags:
  - risk
  - validation
requires:
  env:
    - RISK_API_KEY
  config:
    - risk.maxDrawdown
confidence: 0.9
---

Before any trade:
1. Verify position size does not exceed 5% of portfolio.
2. Check that max daily loss has not been reached.
3. Ensure correlation with existing positions is below 0.7.
4. Validate that the asset has sufficient liquidity (spread < 0.1%).
5. Confirm that the exchange is operational (status API).
