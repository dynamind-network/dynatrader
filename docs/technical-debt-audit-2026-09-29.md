# DynaTrader Technical Debt Audit

**Date:** 2026-09-29  
**Scope:** Deeper read-only review of production TypeScript/TSX in `src/`, `packages/`, and `ui/src/`, plus runtime security paths, package/release wiring, CI, tests, naming, and representative type-safety hotspots. This is an audit, not an implementation or exhaustive line-by-line certification.

## Summary

- No convincing `new`/`New` version-label identifiers were found. Most matches are ordinary prose, variable names, or JavaScript constructors.
- Several concrete “enhanced” labels look stale or version-oriented and can be reviewed for plain domain names.
- Release readiness has a confirmed CI gap: the job named **Lint** runs the same typecheck command as the typecheck job, and the repository has no lint script/configuration found in the inspected manifests/workflows.
- Unsafe `any` use is widespread enough to merit subsystem-by-subsystem review. Large modules and duplicated provider request helpers are refactoring candidates, but size or repetition alone does not prove a defect.
- The working tree contains unrelated tracked edits and untracked files. No source, configuration, or test files were changed by this audit; only this report was updated.

## Deeper audit findings

### High priority: production safety and security

1. **Live trading can bypass the documented approval gate through the daemon.** `src/daemon.ts:149,153` sets `strictMode` only when `DYNA_STRICT=true`, while `DYNA_LIVE=true` independently enables live trading. `src/orchestration/workspace/runtime-setup.ts:386` passes `config.strictMode ?? true` as `requireApprovalForLive`; explicit `false` therefore disables the router's approval-token check (`src/runtime/execution/execution-router.ts:394-410`). The daemon startup banner also states that live orders run with no human confirmation (`src/daemon.ts:161-176`), while `SECURITY.md:42-43` says live trades require explicit approval. Impact is conditional on enabling live mode, but this is a fail-open default against the documented safety guarantee. The runtime setup file has unrelated local edits; the approval wiring was unchanged in the local diff. **Needs owner decision:** should live execution always require an approval token, independently of strict mode?

2. **Webhook SSRF filtering misses IPv6 loopback and unique-local addresses.** `ui/src/async/webhook-server.ts:191` and `ui/src/async/notification-service.ts` use a hostname regex to reject private targets. Node normalizes `http://[::1]/` to hostname `[::1]` and `[fd00::1]` to `[fd00::1]`; the regex does not match the leading bracket. The callback is then fetched by the server (`webhook-server.ts:342+`), so a caller able to submit a task can target local services. DNS names resolving to private IPs also bypass the string-only check. Validate protocol, resolve/check destination addresses, and enforce the restriction at connection time to prevent rebinding.

3. **Webhook server authorization fails open when no API key is configured, and reset has a known default key.** `ui/src/async/webhook-server.ts:59-71` defaults the API key to an empty string and only installs authentication middleware when one exists; it logs a warning but continues. The server binds to `localhost` by default (`:59`), but accepts a configurable host. The `/reset` route at `:319-324` accepts `ADMIN_RESET_KEY` or the literal `admin-reset-key`. If this service is enabled on a reachable interface without an API key, its task-management routes are unauthenticated and the reset key is guessable. Require explicit credentials before binding beyond loopback and remove the hard-coded reset fallback.

4. **Invalid webhook URL can still enqueue work.** In `ui/src/async/webhook-server.ts:177-200`, `/tasks/execute` enqueues the task before parsing and validating `webhookUrl`. A malformed or rejected URL returns HTTP 400 after the task has entered the queue; clients retrying the failed request may submit duplicate work. Validate the entire request, including callback URL, before enqueueing.

5. **Daemon logs retain raw inbound chat content.** `src/daemon.ts:503,655` write Telegram `msg.text` and Discord `msg.content` directly to `{workspace}/logs/daemon.log` (`:112-117`). `SECURITY.md:31-38` says keys are never logged and credentials remain local; raw chat can include pasted secrets or personal data. Decide the intended diagnostic detail, then redact or omit message bodies and set a retention expectation.

### High priority: release correctness and gates

6. **The bundled API plugin is not built or included by the root release path.** `src/plugins/composition.ts:103-116` adds `bundled:dynamind-api` when API environment settings are present; its resolver searches `packages/dynamind-api-plugin/dist/index.js` or an installed `@dyna/plugin-dynamind-api` (`:187-202`). The plugin manifest says it ships with DynaTrader (`packages/dynamind-api-plugin/src/index.ts:4-6`). However, root `build:release` and `release:check` omit `build:plugins` (`package.json:30,35`), root package dependencies omit this plugin, and root package `files` only includes `dist/**/*` (`package.json:11-18`). In a clean published install with the API configured, the resolver may not find the plugin. Either include/build it in the root artifact or define and test it as a separately installed/published dependency. Existing package smoke does not exercise configured bundled-plugin resolution.

7. **The published Git tag is not checked against `package.json` version.** `.github/workflows/publish.yml:5` accepts any `v*.*.*` tag and publishes the checked-out manifest at `:33-39`; no step compares the tag with the package version. A mismatched tag can trigger publication of an unexpected version. Add a pre-publish equality check.

8. **The CI “Lint” job is duplicate work and is not a required aggregate check.** `.github/workflows/ci.yml:26-35` runs only `bun run typecheck`, already done in the typecheck job. The `all-checks-pass` job's `needs` list at `:72` excludes `lint`. Root package scripts define no lint command. As configured, CI gives a green “All Checks Pass” without any linting.

9. **A deterministic pipeline test is excluded from all default runs.** `src/e2e/paper-mode.test.ts` contains a deterministic paper-pipeline test as well as LM Studio integration tests, but `vitest.config.ts:11-12` excludes all `src/e2e/**`; root test/release commands use default Vitest. The deterministic case therefore does not run in CI. Split it into the normal test tree and retain the LM Studio checks behind an explicit opt-in command/environment gate.

### Medium priority: concrete correctness and maintainability

10. **API client timeout ends before the response body is consumed.** `ui/src/tools/api-client-base.ts:31-45` clears the abort timer after `fetch()` resolves headers and before `response.json()` reads the body. A stalled body can exceed the advertised timeout. `fetchWithRetry()` (`:55-68`) retries every error without considering HTTP status or method, which can duplicate non-idempotent requests if future callers use it. Search found no current subclasses/callers of `ApiClientTool`; verify whether this module is dead code before repairing or deleting it.

11. **Manifest YAML parsing assumes an object and assigns a bogus filename.** `src/orchestration/manifest/loader.ts:115-120` casts `yaml.load()` to `any`, assigns fields without checking for null/scalar values, and sets `filename` using `path.basename(content)` instead of the source path. Also, the Zod result is reduced to an error list and the original unparsed value is returned (`:93-100`), so schema defaults/transforms would not reach consumers. Guard the parsed value and decide whether callers require the validated/normalized object.

12. **A duplicate legacy MCP stdio transport appears unused.** `src/runtime/mcp/stdio-transport.ts` defines another `StdioTransport`, while runtime, barrel exports, and tests reference `mcp-stdio-transport.ts`; repo-wide source search found no import/reference to the former file. Check direct-path consumer compatibility and then remove or archive the duplicate.

13. **Version labels remain in names.** In addition to “enhanced” names described below, `src/agent/core/memory-fabric-v25.ts` is imported and publicly re-exported as `MemoryFabric`; its file header labels the implementation v2.5. The version suffix is not a useful domain name; rename it after updating references and checking consumer deep imports.

14. **Coverage is not measured or gated.** Root/UI test scripts run Vitest without coverage output, thresholds, or a coverage gate. The source/test file ratio is not a coverage estimate. Establish per-critical-subsystem coverage signals instead of inferring quality from test-file counts.

15. **Compiler dead-code checks are disabled in both TypeScript projects.** Root `tsconfig.json` disables `noUnusedLocals` and `noUnusedParameters`; UI config does not enable them either. Measure the current error backlog before adopting these as staged CI gates.

16. **Several files concentrate unrelated responsibilities.** Current checkout line counts include `src/agent/core/agent-core.ts` (2,855), `src/orchestration/workspace/runtime-setup.ts` (1,986), and `ui/src/tools/trading.ts` (1,323). `src/state-db/state-db.ts` and `ui/src/ui/App.tsx` are also large. Size is a prompt to map responsibilities and dependency seams, not proof that a split is beneficial. `agent-core.ts` and `runtime-setup.ts` have pre-existing local edits, so reassess them against a clean baseline before refactoring.

17. **The UI package `./cli` export may point at the wrong artifact.** `ui/package.json` declares the executable as `dist/cli.js` but maps the `./cli` subpath to `dist/index.js`. Confirm whether consumers are meant to import the library from `@dynatrader/ui/cli` or execute the CLI; correct the export contract if it is intended to expose the CLI module.

## Naming signals

- No convincing `new`/`New` version-label function or type names were found; ordinary constructors/prose are false positives.
- `src/agent/dream/dream-enhanced-types.ts` contains ordinary domain types and is re-exported/imported by Dream Cycle modules; consider `dream-knowledge-types.ts`.
- `ui/src/services/hook-loader.ts` exports `EnhancedHookLoader` and `getEnhancedHookLoader`, used by `ui/src/core/agent-loop.ts`; the adjective has no corresponding base loader.
- `ui/src/ui/screens/ModelsScreenEnhanced.tsx` exports a component with no in-repo imports found and is not exported by the UI package barrel. Confirm external/dynamic usage before removal.
- `ui/src/ui/common/ThinkingAnimation.enhanced.test.ts` and stale “Enhanced” comments in `src/wallet/tx-pipeline.ts`, `ui/src/mcp/client.ts`, `ui/src/services/ToolStateManager.ts`, and UI renderers are candidates for neutral wording.
- Long names such as `validateGatewayLaunchRequirements` are semantically precise and publicly/repeatedly used; do not shorten identifiers by character count alone.

## Additional technical-debt candidates

- **Unsafe types:** a scan found 316 production-source lines containing `any` or `as any` across `src/`, `packages/`, and `ui/src/` (tests excluded). Concentrations include `src/agent/core/slash-commands.ts`, `src/monitoring/performance/optimizations.ts`, `src/orchestration/manifest/{index,loader}.ts`, `src/daemon.ts`, and `ui/src/ui/common/TimelineSidebar.tsx`. Prioritize unvalidated external JSON and core event/domain contracts. The API plugin also casts decoded JSON to generic `T` without runtime validation.
- **Repeated provider client code:** the API plugin's `market-data.ts` and `news.ts` repeat auth-header construction, a 10-second timeout, HTTP error handling, and JSON decoding. Compare endpoint/method/error requirements before extracting a shared client.
- **Large modules:** current counts include `src/agent/core/agent-core.ts` (2,855 lines), `src/orchestration/workspace/runtime-setup.ts` (1,986), and `ui/src/tools/trading.ts` (1,323). Map responsibilities and dependencies before splitting. `agent-core.ts` and `runtime-setup.ts` contain pre-existing local edits; assess against a clean baseline.
- **Lint suppressions:** `src/wallet/tx-pipeline.ts:685` suppresses `no-constant-condition`, and `src/runtime/webhooks/webhook-runtime.ts:314` suppresses `no-await-in-loop`. Validate their necessity once a real lint policy exists.
- **Unused checks:** root `tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters` to `false`; UI config does not enable them either. Measure the compiler backlog before staged adoption.
## Recommended order

1. Resolve live approval semantics and secure the webhook server/callback address validation before any broad cleanup.
2. Correct release artifact/plugin wiring and tag/version verification; add a configured-plugin smoke path and make lint/test gates reflect actual checks.
3. Fix manifest parsing and API response boundary validation; inventory `any` by subsystem rather than mass-replacing it.
4. Confirm dead-code candidates and stale names through import/export and external-consumer checks, then remove or rename safely.
5. Map responsibilities before decomposing large modules; establish measurable coverage and staged compiler checks.

## Validation boundary

No source, configuration, or test files were changed. No tests, typechecks, builds, or release checks were run. The existing release script is `bun run release:check` in `package.json`; it runs builds, typechecks, test suites, and the package smoke check when a later implementation is undertaken. Findings are based on source/config inspection; conditional security paths and clean-package behavior were not exercised at runtime.
