# KCode CUA macOS Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. User has selected native execution and authorized implementation.

**Goal:** Replace the CUA placeholder with a source-built macOS Helper and pass installed Release acceptance on M2.

**Architecture:** TypeScript runtime owns logical sessions and model observations. An independent Objective-C++ Cocoa Helper owns OS facts, AX references, serialized native mutations, cancellation and cleanup. Existing Host admission, SDK and permission services stay the product entry points.

**Tech Stack:** Node 24, TypeScript, Unix JSONL zcode-cua IPC3, Objective-C++/C++17, AppKit, ApplicationServices, ScreenCaptureKit, Security; xcrun clang++ and codesign.

**Spec:** `docs/superpowers/specs/2026-11-17-kcode-cua-macos-replacement-design.md`

## Global Constraints

- macOS minimum 13.0; arm64 and x64 build entries; mandatory runtime M2 arm64.
- Package `@zcode/zcode-cua`, directory `packages/zcode-cua`; retain 12 public exports, 14 model tools and 43 legacy broker methods.
- Helper `KCode Computer Use.app`, bundle `dev.zcode.cua-helper.kcode`; main `dev.zcode.app.kcode`.
- Ordinary cancellation permits continuation after native cleanup and new observation. Stop is latched per logical session.
- No replay of possibly-sent input; no automatic foreground fallback or automatic unlock.
- No recovered binary/private package/recovery-directory build dependency. Preserve unrelated edits.
- Tests are CUA/native/CLI/engineering/E2E; no App business unit tests or contract.test.ts.

## Review Focus

- A disconnected caller may have dispatched input: its next mutation must wait for cleanup and reobserve (Tasks 2, 4).
- An unresponsive target must not block AppKit or the cancel/health control path (Tasks 2, 3).
- Permission grants can change while a resident process caches facts: preflight failure must become unknown (Task 5).
- A window/PID/index can be reused: native identity checks and Host generation invalidate old observations (Tasks 3, 4).
- Model-generated strings may contain isolated surrogates, malformed selectors or boundary coordinates: reject malformed requests, preserve valid Unicode (Tasks 1, 4).

---

### Task 1: Public contracts, governance and source build

**Files:** `packages/zcode-cua/{CONTRACT.md,package.json,tsconfig.json}`, `src/{contract.ts,module.ts,contract.example.ts}`, `src/contract/*`, `scripts/{build.mjs,build-native.mjs}`, `native/macos/*`, `test/source-build.test.mjs`, `architecture-policy.yaml`.

**Interfaces:** Produces zcode-cua IPC3 request/response types, manifest arrays, build metadata, `build --arch arm64|x64` and `build:native`. Existing 12 exports remain renderer-safe or Node-only as declared.

- [x] Write source-build regression assertions for no placeholder capability, 12 exports, 14 tools, 43 legacy methods, source manifest and native build entry; run and observe failure.
- [x] Register managed CUA module, document ownership and implement contracts and asynchronous build scripts. Emit JS/declarations to dist; compile only repository native source with xcrun. Keep existing pure export paths.
- [x] Build TypeScript and arm64 Helper; run CUA contract suite and architecture check. Cross-compile x64 without claiming Intel runtime coverage.
- [x] Commit this slice and record exact command/results in the ledger.

### Task 2: Native service, lease, control and cancellation

**Files:** `native/macos/{main.mm,server.mm,coordinator.mm,protocol.h}`, `src/adapters/{broker-client.ts,helper-host.ts}`, `test/{broker-transport.test.ts,native-lifecycle.mjs}`.

**Interfaces:** `callBrokerMethod({socketPath,method,params,timeoutMs})`, `createProductCuaHelperHost(options)`, IPC handshake carrying version/build/generation/process/signing identity. Control methods `operation_cancel`, `operation_status`, `session_release` are not model tools.

- [x] Write transport tests for version mismatch, malformed/oversize JSON, deadline, disconnect without replay, cancellation cleanup acknowledgement and same-session continuation; observe failure.
- [x] Implement live Cocoa main loop, private socket and verified peers; one cross-connection mutation scheduler and independent control path. Persist exact owner lease and input-safety record; never reclaim a live foreign owner by timeout.
- [x] Implement operation states, receipts, cancellation tokens, cleanup fence, scoped session release and bounded failure recovery. Health includes main-run-loop roundtrip.
- [x] Run transport suite and source-built native lifecycle fixture (including control while stalled). Commit and ledger.

### Task 3: AX, capture, input and presentation

**Files:** `native/macos/{observation.mm,capture.mm,input.mm,presentation.mm}`, `test/{native-fixture.mm,native-acceptance.mjs}`.

**Interfaces:** All 43 broker methods return typed results or explicit capability errors. Native handles bind session/generation/PID birth/window/observation; captures include exact raster and surface identity. No fake success.

- [ ] Write native fixture scenarios for AX traversal/refetch, stale handles, locked admission, clipboard ownership/Unicode, cancel drag/scroll/holds and actual run-loop liveness; observe missing behavior.
- [ ] Implement bounded AX traversal and semantic actions, ScreenCaptureKit 13+ capture with cancellable lifecycle, scoped input backend with segmented cancellation and held-input cleanup. Check lock/epoch/target before each dispatch.
- [ ] Implement text/md/html paste transaction with changeCount guarded restoration; permission preflight and explicit requests; PiP event projection/ghost overlay on AppKit.
- [ ] Compile both architectures and run native fixture suite. Record capability limitations as failures, not passing placeholder methods. Commit and ledger.

### Task 4: Runtime and existing SDK integration

**Files:** `src/app/{runtime.ts,session.ts}`, `src/domain/*`, `src/adapters/*`, root facade files, `test/{runtime.test.ts,frame-contract.test.ts}`, existing node-repl-host CUA regression tests.

**Interfaces:** `createComputerUseRuntime(options): ComputerUseRuntime`; `execute({toolName,arguments,context,signal})`, `closeSession(context)`, `dispose()`. AppState/state_id and frame envelopes conform to current SDK; preserve display meta and exact-raster authority.

- [ ] Add tests using a deterministic native protocol fixture for all tool mappings, malformed arguments, Unicode repair, cancellation/timeout/reconnect, stop latch, same-path different identity, subagent denial and stale generations/frames. Observe failure.
- [ ] Implement Host-owned sessions, strict selectors and native mappings, generation/epoch invalidation, structured state and frame signing. Bind observations to session/app/window and prevent generic images granting coordinates.
- [ ] Preserve 12 public facades and remove audited unused native-only APIs; verify fresh SDK Workers bind the same logical session. Replace root package symlink deliberately with workspace implementation.
- [ ] Run CUA suite and existing node-repl-host regression suite. Commit and ledger.

### Task 5: Permission UI and source-only packaging

**Files:** services CUA lifecycle/permission paths; UI permission cache; desktop producer/build/helper installer paths; existing permission E2E; source package README and build docs.

**Interfaces:** Native permission facts are authoritative; background query never prompts/captures. Installed Helper identity and source manifest are verified before launch; transport ownership stays in services.

- [ ] Maintain permission E2E scenarios for denied/unknown/locked/probe pending before UI implementation. Add engineering packaging checks against private recovery dependencies.
- [ ] Wire source Helper build into Release packaging, remove obsolete recovered-binary patching and placeholder-only gates; preserve Windows isolation. Fix stale permission ready projection and fresh preflight failure mapping.
- [ ] Run `pnpm typecheck`, `pnpm lint`, related CUA/engineering checks, format and architecture checks. Review hooks warnings if React changed. Build signed Release from source and record provenance.
- [ ] Commit and ledger, keeping baseline failures explicit.

### Task 6: M2 installed Release acceptance and final review

**Files:** `docs/cua/validation/2026-11-17-kcode-cua-m2.md`, reproducible native/browser/model acceptance scripts under CUA test, evidence in ignored task workspace.

**Interfaces:** M01–M11 in the spec are the completion gate. SSH alias `m2`; install canonical apps in `~/Applications` after checking existing installations. Use M2 signing identity locally; never transfer signing keys or silently copy account secrets.

- [ ] Inspect M2 toolchain/session/configuration and provision missing public build tools. Source-only build on clean inputs, verify 12/14/43 contracts and signatures (M01).
- [ ] Install Release and run real-config cold starts x3, cancellation and recovery/lock matrix, actual permission facts, all tools and browser oracle (M02–M08). Manual unlock is an explicit user action; no automatic unlock.
- [ ] Run three real-model rounds via installed KCode (ordinary/cancel-resume/lock-unlock-resume); record nonce oracle, calls/tokens/time/receipt evidence (M09).
- [ ] Run identity/attachment/frame isolation plus 30-minute liveness and 20 cancellations; capture real AppKit roundtrip and process samples (M10–M11). Fix any failures with regression evidence and rebuild/reinstall.
- [ ] Dispatch one fresh whole-branch review, address important findings, rerun necessary checks. Commit acceptance report. Only mark complete when mandatory scenarios truly pass; list physical/account/environment blocks explicitly.
