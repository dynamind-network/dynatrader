# Technical Analysis Skill

## Purpose
Perform technical analysis on market data using indicators, chart patterns, and signal generation.

## Available Indicators
- **Trend**: SMA, EMA, MACD, ADX
- **Momentum**: RSI, Stochastic, Williams %R
- **Volatility**: Bollinger Bands, ATR, Keltner Channels
- **Volume**: OBV, VWAP, Volume Profile

## Analysis Workflow
1. Fetch OHLCV data for the target symbol and timeframe
2. Calculate relevant indicators based on the market regime
3. Identify chart patterns (head & shoulders, triangles, flags)
4. Generate signals with confidence scores
5. Document findings with supporting evidence

## Signal Generation Rules
- BUY signal: RSI < 30, MACD crossover, price above 200 SMA
- SELL signal: RSI > 70, MACD crossunder, price below 200 SMA
- HOLD: No clear signal or conflicting indicators
- Confidence: 0.0-1.0 based on indicator alignment

## Output Format
Always produce a structured analysis:
```json
{
  "symbol": "<BASE/QUOTE>",
  "timeframe": "4h",
  "trend": "bullish|bearish|sideways",
  "signals": [
    {"type": "BUY|SELL|HOLD", "confidence": 0.85, "indicators": ["RSI", "MACD"]}
  ],
  "key_levels": {
    "support": [42000, 41500],
    "resistance": [44000, 45000]
  },
  "summary": "Brief analysis summary"
}
```

## Constraints
- Never execute trades directly
- Always provide confidence scores
- Document all indicator calculations
- Flag conflicting signals explicitly
