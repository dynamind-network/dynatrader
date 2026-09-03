# Portfolio Rebalancing Skill

## Purpose
Optimize portfolio allocation, rebalance positions, and manage diversification.

## Rebalancing Strategies

### 1. Equal Weight
- Allocate equal capital to each asset
- Rebalance when deviation > 5%
- Best for: diversified portfolio, low conviction

### 2. Market Cap Weight
- Allocate based on market capitalization
- Rebalance monthly or on significant deviation
- Best for: large-cap focused portfolio

### 3. Risk Parity
- Allocate based on inverse volatility
- Equal risk contribution from each asset
- Best for: risk-averse portfolio

### 4. Momentum Weight
- Overweight recent winners, underweight losers
- Rebalance weekly or on momentum shift
- Best for: trend-following strategy

## Rebalancing Triggers
- **Time-based**: Monthly or quarterly rebalance
- **Threshold-based**: When allocation deviates > 5% from target
- **Event-based**: After significant market moves (>10% in 24h)

## Transaction Cost Analysis
Before rebalancing, calculate:
- Trading fees (maker/taker)
- Slippage estimate
- Tax implications (if applicable)

Only rebalance if expected benefit > transaction cost.

## Output Format
```json
{
  "strategy": "equal_weight",
  "current_allocation": {
    "BTC": 0.45,
    "ETH": 0.35,
    "SOL": 0.20
  },
  "target_allocation": {
    "BTC": 0.33,
    "ETH": 0.33,
    "SOL": 0.33
  },
  "trades_needed": [
    {"symbol": "<BASE/QUOTE>", "action": "SELL", "amount": 0.002},
    {"symbol": "SOL/USDT", "action": "BUY", "amount": 0.5}
  ],
  "estimated_cost": 12.50,
  "expected_benefit": "Reduced concentration risk"
}
```

## Constraints
- Never execute rebalancing trades directly
- Always calculate transaction costs first
- Document rebalancing rationale
- Maintain minimum position sizes (>$100 value)
