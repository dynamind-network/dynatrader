# Changelog

## 3.0.0 - 2026-09-16

### Added

- Declarative builtin exchange and wallet capability plugins with layered overrides.
- MCP stdio and HTTP transports with tool discovery and registry proxies.
- Provider-configurable `web_search` tool (Tavily, Brave, or SearXNG).
- Financial reporting, web research, spreadsheet, and secure tool-use eval families.
- Benchmark matrix runner, plugin CLI commands, and release documentation.

### Changed

- Runtime trading and wallet components resolve through the plugin registry.
- A2A availability announcements use the local agent bus.

### Compatibility

- Paper mode remains offline-capable when no paid market-data credentials are configured.
