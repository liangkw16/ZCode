# KCode Computer Use

The package supplies the existing twelve public exports and an independently source-built macOS Helper. No private/recovered producer is a build input. Source and acceptance specification: docs/superpowers/specs/2026-11-17-kcode-cua-macos-replacement-design.md.

## Ownership

Host call ledger owns admission and trusted session context. Runtime owns logical sessions, stop latch and model observations/frames. Services own installation and one Helper start/connection lifecycle. Native owns controller lease, global mutation queue, live AX references, input holds, clipboard transactions, OS facts and lock availability. Presentation only projects events.

## Interfaces and ordering

`createComputerUseRuntime` implements execute/closeSession/dispose. Broker facades use authenticated zcode-cua IPC3; native operation IDs are idempotency keys, never input replay keys. Cancellation travels on an independent control request and completes only after cleanup acknowledgement. Disconnect after dispatch reports uncertain effects and requires a fresh observation. A generation change invalidates native handles and model observations; it does not recreate the logical session or clear stop.

Agent MCP transport injection preserves protocol `env: {name,value}[]`, caller configuration and arguments after `--`. Only the official shared `node_repl` with the current Host's matching opaque plugin authority receives transport settings; a copied name or command is insufficient. Generic MCP servers remain unchanged and retired standalone CUA servers are not launched.

Native checks same UID, executable/signing identity and Host capability. Peer policy is fixed by build metadata; development allowances cannot enable unsigned callers in packaged production. Lease reclamation requires exact prior process death, never a TTL. Unknown permissions/desktop availability fail closed. Manual unlock resumes through fresh observation; no automatic unlock or foreground fallback.

Public pure frame/display/request-access/ports modules must remain browser safe. Node adapters may import platform IO; runtime orchestration depends on contract ports rather than adapter implementation. Native sources are system-framework-only Objective-C++.
