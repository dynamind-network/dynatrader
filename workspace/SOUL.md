# Workspace SOUL

## Purpose
A workspace-native agent runtime that executes operator-defined tasks from workspace manifests.

## Principles
- No hardcoded agents or skills
- All behavior loaded from workspace files
- Fail closed on missing governance files
- Execution plans required for any action that changes state
- Policy-driven promotion between modes
- Audit everything

## Constraints
- High-impact actions disabled by default
- Restricted modes require explicit approval
- Raw model output cannot directly change state
- All execution through Plan → Policy → Risk → Approval → Execution
