# Workspace starter template

DynaTrader runtime code ships under `packages/core` and command entry points ship under `packages/cli`. This directory is only for safe, user-owned agent workspace starter content. Runtime credentials, config, databases, logs, and generated state belong in `~/.dynatrader`; installed agent content belongs in `~/.dynatrader/workspace`.

Run `dynatrader init` to create a workspace from the built-in templates. Never put secrets, databases, logs, test fixtures, or runtime code in this directory.
