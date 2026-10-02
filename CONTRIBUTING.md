# Contributing to DynaTrader

Thanks for your interest in contributing to DynaTrader! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)

## Code of Conduct

We expect all contributors to be respectful and constructive. Harassment, discrimination, and bad-faith behavior are not tolerated.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Create a branch for your changes
4. Make your changes
5. Test your changes
6. Submit a pull request

## Development Setup

### Prerequisites

- **Node.js >= 22.19.0**
- **Bun** (recommended) or npm

### Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/dynatrader.git
cd dynatrader

# Install dependencies
bun install

# Build the project
bun run build

# Run tests
bun run test

# Type check
bun run typecheck
```

### Project Structure

```
dynatrader/
  packages/core/                 # @dyna/core runtime and SDK
  packages/cli/                  # dynatrader CLI and daemon
  packages/ui/                   # @dynatrader/ui
  packages/dynamind-api-plugin/  # Independently released API plugin
  templates/workspace/           # Safe workspace setup guidance
  evals/                         # Behavior checks and benchmarks
  docs/architecture/             # Package and data-boundary documentation
```

## How to Contribute

### Bug Fixes

- Check [existing issues](https://github.com/dynamind-network/dynatrader/issues) first
- Comment on the issue to claim it
- Create a branch named `fix/description`
- Include a test that reproduces the bug if possible

### New Features

- Open an issue first to discuss the feature
- Ensure it aligns with the project's goals
- Create a branch named `feat/description`
- Include tests for new functionality

### Skills

Skills are learned trading strategies stored in `workspace/skills/`. To contribute a skill:

1. Create a new directory in `workspace/skills/`
2. Include a `SKILL.md` file with the skill description
3. Include a `skill.json` manifest
4. Ensure the skill works with paper trading

### Documentation

- Fix typos, improve clarity, add examples
- Ensure code examples work and are up to date

## Pull Request Process

1. **Update your fork** to the latest upstream
2. **Create a descriptive branch** following naming conventions
3. **Make focused changes** - one PR per feature/fix
4. **Write or update tests** for your changes
5. **Ensure all checks pass:**
   ```bash
   bun run release:check  # typecheck + build + test
   ```
6. **Fill out the PR template** completely
7. **Request review** from maintainers

### PR Title Format

```
type(scope): description

Examples:
fix(exchange): handle Binance rate limiting correctly
feat(risk): add max drawdown circuit breaker
docs(readme): add installation troubleshooting
```

## Coding Standards

### TypeScript

- Use strict TypeScript (`strict: true`)
- Prefer explicit types over `any`
- Use `interface` for object shapes, `type` for unions/intersections
- Export types alongside their implementations

### File Organization

- One primary export per file
- Co-locate tests with their source files (`.test.ts`)
- Use index files for barrel exports

### Naming Conventions

- `camelCase` for variables and functions
- `PascalCase` for classes, interfaces, and types
- `SCREAMING_SNAKE_CASE` for constants
- Descriptive names over abbreviated ones

### Error Handling

- Use custom error classes where appropriate
- Always handle errors in async code
- Log errors with context for debugging

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks
- `perf`: Performance improvements

### Examples

```
fix(memory): prevent SQLite FTS5 query injection
feat(cron): add support for complex cron expressions
docs(readme): add Hyperliquid setup guide
test(exchange): add CCXT adapter unit tests
```

## Reporting Bugs

1. **Check existing issues** to avoid duplicates
2. **Use the bug report template** when creating a new issue
3. **Include reproduction steps** - the more detail the better
4. **Include environment info** (OS, Node version, DynaTrader version)
5. **Attach logs** if relevant (use `dynatrader logs`)

## Requesting Features

1. **Open an issue** with the feature request template
2. **Describe the use case** - why is this needed?
3. **Propose a solution** if you have one in mind
4. **Indicate willingness** to contribute the feature

## Questions?

- Open a [GitHub Discussion](https://github.com/dynamind-network/dynatrader/discussions)
- Check the [README](README.md) for documentation
