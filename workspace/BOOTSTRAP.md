# Workspace BOOTSTRAP

## First-Time Setup

When running DynaTrader for the first time in a new workspace:

### 1. Initialize State Database
The state database is automatically created on first run. No manual setup required.

### 2. Configure Exchange Credentials
Add exchange API keys to `workspace/credentials.yaml`:
```yaml
exchanges:
  binance:
    api_key: YOUR_API_KEY
    api_secret: YOUR_API_SECRET
  # Add other exchanges as needed
```

### 3. Set Up Cron Jobs
Configure automated tasks in `workspace/cron/jobs/`:
- `market-analysis.job.json` - Periodic market analysis
- `portfolio-rebalance.job.json` - Portfolio rebalancing

### 4. Review Trading Policies
Edit `workspace/policies/risk-management.md` to configure:
- Maximum position size
- Daily loss limits
- Risk/reward requirements

### 5. Start the Agent
```bash
dynatrader
```

The agent will automatically:
- Load all workspace files (SOUL, IDENTITY, USER, MEMORY)
- Initialize the memory system
- Start the dream engine for background reflection
- Begin monitoring market data and executing configured strategies

## Workspace Structure

```
workspace/
├── SOUL.md              # Agent identity and principles
├── IDENTITY.md          # Agent name and role
├── USER.md              # User preferences and constraints
├── MEMORY.md            # Persistent memory
├── BOOTSTRAP.md         # This file
├── config.yaml          # Runtime configuration
├── profiles.yaml        # User profiles
├── agents/              # Agent definitions
├── commands/            # Available commands
├── cron/                # Scheduled tasks
│   ├── jobs/            # Job definitions
│   ├── output/          # Job outputs
│   └── state/           # Job state
├── skills/              # Trading strategies
├── state/               # Runtime state
├── tools/               # Available tools
├── policies/            # Governance policies
└── logs/                # Audit logs
```

## Recovery

If the agent crashes or encounters errors:

1. Check `workspace/logs/` for error details
2. Review `workspace/state/` for partial progress
3. Restart the agent - it will automatically resume from last known good state
4. Use `/status` command to check current system state

## Memory Management

- **MEMORY.md**: Hot memory (working set), flushed to DB during compaction
- **state.db**: Cold storage (long-term persistence)
- **Dream Engine**: Periodic background reflection for memory consolidation

## Key Commands

- `/status` - Show current system state
- `/memory` - Manage memory entries
- `/cron` - Manage scheduled tasks
- `/skills` - List available trading strategies
- `/compact` - Force manual context compaction

## Troubleshooting

### Agent won't start
- Check `workspace/config.yaml` for syntax errors
- Verify exchange credentials in `workspace/credentials.yaml`
- Ensure SQLite database is not locked by another process

### Context window errors
- Run `/compact` to force compaction
- Check `MEMORY.md` size - trim if too large
- Review cron job outputs in `workspace/cron/output/`

### Memory issues
- Use `MemoryWriter.writeOutcome()` to persist trade results
- Dream engine runs automatically to consolidate memory
- Check `state.db` size and prune old entries if needed
