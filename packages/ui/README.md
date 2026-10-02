# `@dynatrader/ui`

The DynaTrader terminal UI package. It provides the Ink-based TUI, terminal screens, and UI-facing agent and tool integrations.

Most users should install the `dynatrader` CLI, which starts this interface with `dynatrader --no-daemon --tui`. The UI package also publishes a standalone `dynamind` executable and can be installed directly by applications that need its exported UI APIs.

```sh
npm install @dynatrader/ui
```

The package exports its main API from `@dynatrader/ui`, with additional agent and tool APIs at `@dynatrader/ui/agents` and `@dynatrader/ui/tools`. The `@dyna/core` package owns the trading runtime and domain services.
