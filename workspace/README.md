# DynaTrader Workspace

A structured runtime environment for AI agents. The workspace defines agents,
skills, policies, and governance rules that together form a safe, auditable system.

## Workspace Structure

```
workspace/
├── profiles.yaml              # Main agent + optional persistent subagents
├── agents/                    # Agent definitions (*.agent.md)
│   ├── <agent-name>.agent.md
│   ├── <agent-name>.agent.md
│   ├── <agent-name>.agent.md
│   └── <agent-name>.agent.md
├── plugins/                   # Optional plugins/extensions
│   ├── <plugin-name>/
│   │   ├── plugin.json
│   │   └── index.ts
├── skills/                    # Reusable skill modules
│   ├── technical-analysis/
│   │   ├── skill.json
│   │   └── SKILL.md
│   ├── risk-assessment/
│   │   ├── skill.json
│   │   └── SKILL.md
│   └── portfolio-rebalancing/
│       ├── skill.json
│       └── SKILL.md
├── policies/                  # Governance rules (*.policy.json)
│   ├── auth-governance.policy.json
│   ├── risk-management.policy.json
│   └── trading-safety.policy.json
├── commands/                  # Runnable commands (*.command.json)
├── runs/                      # Completed run cards (*.md)
├── adapters/                  # Exchange/protocol adapters
├── tools/                     # Shared tooling
├── compressed-memory/         # Long-term memory store
├── daily-memory/              # Rolling daily context
├── vector-memory/             # Semantic search index
├── config.yaml                # Runtime configuration
├── auth.json                  # API keys and credentials
├── SOUL.md                    # Core identity and purpose
├── IDENTITY.md                # System manifest
├── USER.md                    # User profile and preferences
├── MEMORY.md                  # Active memory state
└── audit.jsonl                # Append-only audit log
```

## How Agents Work

Each agent is defined in `agents/<name>.agent.md` using a YAML frontmatter + Markdown body format.

**Frontmatter fields:**
- `name` - unique identifier chosen by the workspace author
- `version` - semver string
- `description` - what the agent does
- `allowed_modes` - which operational modes the agent can run in (`research`, `backtest`, `paper`, `live`)
- `permissions` - `allow`/`deny` lists for system capabilities
- `tools` - `allow`/`deny` lists for tool access
- `skills` - `allow`/`deny` lists for skill access
- `memory` - `read`/`write` lists specifying which memory namespaces the agent can access
- `outputs` - which artifact types the agent can produce
- `approval_required_for` - actions that need human or multi-agent approval
- `risk_level` - `low`, `medium`, or `high`

**Markdown body** contains the agent's instructions, constraints, and behavioral rules.

**Example agent workflow:**
1. The configured analysis agent fetches data and produces an `Observation` artifact
2. A specialist agent evaluates the result and produces a `Hypothesis`
3. A synthesis agent combines the inputs into a reviewable plan or task artifact
4. The configured policy or risk agent evaluates the proposal and produces an assessment
5. If approved, the action proceeds to execution mode

## How Skills Are Loaded

Skills live in `skills/<name>/` and consist of two files:

**`skill.json`** - The manifest:
- `name`, `version`, `description` - metadata
- `category` - grouping for discovery (`analysis`, `risk`, `portfolio`, `execution`)
- `allowed_modes` - which modes this skill operates in
- `permissions` - what the skill can access when active
- `tools_required` - tools the skill needs to function
- `risk_level` - risk classification

**`SKILL.md`** - The instructions:
- Purpose and scope
- Available methods and formulas
- Workflow steps
- Output format (JSON schema)
- Constraints

Skills are loaded into agents via the agent's `skills.allow` list. When an agent activates a skill, the skill's instructions are injected into the agent's context. The agent then follows the skill's workflow and output format.

**To add a new skill:**
1. Create `skills/<name>/skill.json` with the manifest
2. Create `skills/<name>/SKILL.md` with instructions
3. Add the skill name to relevant agents' `skills.allow` list
4. Test in `research` mode before enabling in higher-risk modes

## How Policies Enforce Governance

Policies live in `policies/<name>.policy.json` and define rules that the runtime evaluates before any action is taken.

**Policy structure:**
```json
{
  "name": "Policy Name",
  "version": "1.0.0",
  "description": "What this policy controls",
  "rules": [
    {
      "name": "Rule Name",
      "condition": "boolean expression to evaluate",
      "action": "deny | require_approval",
      "requiredApprovals": ["agent_names"],
      "auditLevel": "low | medium | high | critical"
    }
  ]
}
```

**Policy evaluation flow:**
1. An agent attempts an action
2. The runtime checks all loaded policies against the action
3. If any policy matches with `action: deny` - the action is blocked
4. If any policy matches with `action: require_approval` - the action pauses until approvals are collected
5. All evaluations are logged to `audit.jsonl`

**Built-in policies:**
- `auth-governance` - controls agent authentication and access
- `risk-management` - enforces position limits, loss limits, and circuit breakers
- `trading-safety` - prevents harmful trading actions

## How to Add New Agents

1. Create `agents/<name>.agent.md` with frontmatter and instructions
2. Define permissions, tools, and skills in frontmatter
3. Add to `config.yaml` if needed
4. Test in `research` mode

## How to Add New Skills

1. Create `skills/<name>/skill.json` with manifest
2. Create `skills/<name>/SKILL.md` with detailed instructions
3. Reference the skill in agent frontmatter under `skills.allow`
4. Verify the skill's `allowed_modes` matches the agent's modes

## How to Add New Policies

1. Create `policies/<name>.policy.json` with rules
2. Rules are evaluated automatically by the runtime
3. Use `auditLevel: critical` for rules that must never be bypassed
4. Test policies in `paper` mode before enforcing in `live`

## Example Workflow: Configured Market Research Run

```
1. User triggers a research run for the configured workspace on a chosen timeframe

2. The configured market analysis agent activates its analysis skill
   - Fetches the configured data for the selected target
   - Calculates RSI, MACD, Bollinger Bands
   - Produces Observation artifact with bullish signal

3. A specialist sentiment agent evaluates sentiment
   - Checks social media, news, fear/greed index
   - Produces Hypothesis artifact

4. A synthesis agent combines signals
   - Merges the available analyses
   - Produces a reviewable plan or task record

5. The configured risk manager activates its risk-assessment skill
   - Evaluates position size against portfolio limits
   - Calculates risk/reward ratio
   - Produces RiskAssessment: APPROVED

6. Runtime logs the run to runs/run-001.md
   - All steps audited in audit.jsonl
```

## Operational Modes

| Mode | Capital at Risk | Oversight | Typical Users |
|------|----------------|-----------|---------------|
| `research` | None | Self-supervised | Agents exploring ideas |
| `backtest` | None (historical) | Self-supervised | Strategy validation |
| `paper` | Simulated | Light review | Performance evaluation |
| `live` | Real | Strict approval | Production trading |

Agents progress through modes as they demonstrate competence and reliability.
