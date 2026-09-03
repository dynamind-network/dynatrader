# Risk Assessment Skill

## Purpose
Evaluate trading opportunities for risk, calculate position sizes, and manage portfolio exposure.

## Risk Evaluation Framework

### 1. Position Risk
- Maximum position size: 2% of portfolio per trade
- Maximum portfolio exposure: 20% in single asset
- Maximum correlated exposure: 40% in correlated assets

### 2. Market Risk
- Volatility assessment (ATR, historical volatility)
- Liquidity analysis (order book depth, volume)
- Slippage estimation

### 3. Portfolio Risk
- Current drawdown from peak
- Daily loss limit tracking
- Correlation matrix monitoring

## Position Sizing Formula
```
position_size = (portfolio_value * risk_per_trade) / (entry_price - stop_loss_price)
```

Where:
- risk_per_trade = 0.02 (2% default)
- stop_loss_price = entry_price * (1 - stop_loss_percent)

## Risk Scoring
- **Low Risk (0.0-0.3)**: Position within all limits, high liquidity, clear trend
- **Medium Risk (0.3-0.6)**: Approaching limits, moderate volatility, mixed signals
- **High Risk (0.6-0.8)**: Near limits, high volatility, uncertain direction
- **Extreme Risk (0.8-1.0)**: Exceeds limits, illiquid, against trend

## Circuit Breakers
- Daily loss > 5%: Pause trading, require manual review
- Drawdown > 10%: Reduce position sizes by 50%
- Drawdown > 15%: Stop all new positions

## Output Format
```json
{
  "symbol": "<BASE/QUOTE>",
  "risk_score": 0.35,
  "risk_level": "medium",
  "position_size": 0.05,
  "position_value": 2100,
  "stop_loss": 41200,
  "take_profit": 44500,
  "risk_reward_ratio": 2.5,
  "factors": [
    {"factor": "volatility", "score": 0.4, "note": "ATR elevated"},
    {"factor": "liquidity", "score": 0.2, "note": "Good depth"},
    {"factor": "correlation", "score": 0.3, "note": "High BTC/ETH correlation"}
  ],
  "recommendation": "APPROVED|MODIFIED|REJECTED",
  "modifications": []
}
```

## Constraints
- Never execute orders directly
- Always calculate position sizes before approval
- Track all risk metrics in memory
- Escalate to risk-manager agent when limits approached
