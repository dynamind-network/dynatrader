# Harness decision models

DynaTrader can call a typed decision provider at a small set of harness boundaries: failed tool batches, task completion, and ambiguous shell commands. Jev is the first adapter; the provider interface can be extended without coupling the agent loop to Jev's HTTP contract.

Decision models are disabled by default. Enable them in the workspace `config.yaml`:

```yaml
decisionModels:
  enabled: true
  provider: typesafe
  model: jev-latest
  apiKeyEnv: TYPESAFE_API_KEY
  features:
    recovery: true
    completion: true
    commandRisk: true
```

Set the API key in the runtime environment. Never put it in `config.yaml` or a prompt. The endpoint can be overridden with `baseUrl` for a compatible provider deployment.

The decisions guide the coding model. They never grant a tool, bypass an approval, or override deterministic command policy. Provider errors fall back to the existing harness path. The agent stops after three consecutive tool batches with failures so a broken call cannot burn the task budget indefinitely.

Full tool output remains available through the existing UUID artifact and read-tool path. The decision call gets a short redacted error/command trace. Relevant memory is retrieved once per prompt, preferring the active memory recall path and falling back to the context engine; this avoids injecting the same memory twice.

Use `/decisions` to inspect in-process call counts, failures, latency, token usage, and outcomes. Metrics reset when the runtime process exits. Use `/memory`, `/memory search <query>`, `/memory search --scope <scope> <query>`, and `/memory add <scope> <kind> <text>` to access the same persistent memory store as the agent's memory tools.
