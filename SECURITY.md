# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in DynaTrader, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

1. **Email:** Send details to security@dynamind.ai
2. **GitHub Security Advisories:** Use [GitHub's private vulnerability reporting](https://github.com/dynamind-network/dynatrader/security/advisories/new)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment:** Within 48 hours
- **Initial assessment:** Within 1 week
- **Fix or mitigation:** Within 30 days for critical issues

We will coordinate disclosure with you before making any public announcement.

## Security Considerations

### API Keys and Secrets

DynaTrader handles sensitive credentials for exchanges, LLM providers, and messaging platforms. Key security properties:

- **Never logged:** API keys are never written to log files
- **Environment variables:** All secrets loaded from env vars, not config files
- **No hardcoded values:** Source code contains no hardcoded API keys
- **Local storage only:** Credentials stored locally, never sent to external services

### Trading Safety

- **Paper mode by default:** All trading starts in paper mode
- **Approval gates:** Live and micro-live orders require a valid, unexpired approval token; strict mode cannot disable this gate
- **Circuit breakers:** Automatic halt on anomalous behavior
- **Position limits:** Configurable maximum position notional as a fraction of account equity
- **Live risk snapshots:** Live and micro-live orders require a fresh exchange equity, daily-PnL, and open-position snapshot; unsupported or stale snapshots fail closed
- **Drawdown protection:** Paper and supported live venues reject orders at the configured daily loss limit

### Node and Python REPLs

- **Code execution:** REPL source runs in persistent child processes as the current OS user. Treat every REPL call as arbitrary code execution with that user's filesystem and network access.
- **Approval:** REPL tools are critical-risk operations and must pass the normal tool approval flow. Automatic approval removes that per-call gate.
- **Process isolation only:** The child process has a minimal environment and is terminated on cancellation or timeout, but Windows does not restrict its user permissions, filesystem access, network access, or child-process creation. Do not treat it as a sandbox; use a restricted OS account or container before enabling automatic approval for untrusted code.
- **Session state:** Each conversation gets persistent Node and Python state for the life of the runtime. Runtime shutdown terminates the workers.

### Network Security

- **HTTPS only:** All API communications use TLS
- **No telemetry:** No usage data sent to external servers
- **Local gateway:** Telegram/Discord gateway runs locally

### Data Privacy

- **Local memory:** All memory stored in local SQLite database
- **No cloud sync:** No automatic data synchronization
- **User control:** Users own and control all their data

## Scope

### In Scope

- Remote code execution
- Credential exposure
- Authentication bypass
- Data exfiltration
- Trading manipulation
- Dependency vulnerabilities

### Out of Scope

- Social engineering
- Physical attacks
- Denial of service
- Issues in third-party dependencies (report upstream)

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |

## Best Practices

### For Users

1. **Use environment variables** for all API keys
2. **Enable paper mode** before live trading
3. **Set conservative risk limits** initially
4. **Review approval gates** configuration
5. **Keep DynaTrader updated** to the latest version

### For Contributors

1. **Never commit secrets** - use `.env.example` with empty values
2. **Validate inputs** - sanitize all user-provided data
3. **Use parameterized queries** - prevent SQL injection
4. **Handle errors gracefully** - don't leak stack traces
5. **Follow dependency hygiene** - keep packages updated

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Checklist](https://blog.risingstack.com/node-js-security-checklist/)
- [Conventional Commits](https://www.conventionalcommits.org/)
