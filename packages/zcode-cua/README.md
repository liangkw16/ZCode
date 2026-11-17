# @zcode/zcode-cua

Source-built KCode Computer Use for macOS 13+, compatible with zcode-cua IPC3.
The twelve public export paths and fourteen model tools remain the integration
surface. The Host runtime owns logical sessions, observations and exact-raster
frames; the Objective-C++ Helper owns AX, capture, scoped input and cleanup.

From the repository root (Node and pnpm versions in `mise.toml`):

```sh
pnpm --filter @zcode/zcode-cua build
pnpm --filter @zcode/zcode-cua typecheck
pnpm --filter @zcode/zcode-cua test
node packages/zcode-cua/scripts/build-native.mjs --arch arm64 --identity 'SIGNING IDENTITY'
node packages/zcode-cua/scripts/build-native.mjs --arch x64
```

Native builds require Xcode command-line tools and use only repository source
and system frameworks. Build provenance is emitted in the signed app resource
`source-manifest.json` and adjacent `build-manifest.json`. Default ad-hoc builds
are development artifacts; production launch requires a verified signed Helper.
The native app is `KCode Computer Use.app` (`dev.zcode.cua-helper.kcode`).

Cancellation drains native work before allowing continuation and requires a new
observation. Stop stays latched for that logical session. Input is never replayed
after uncertain delivery. Locking suspends input; unlock requires fresh state.
Normal permission queries do not request grants or capture pixels.

Engineering regressions are separate from installed Release acceptance. The
M2 GUI, permission, cancellation, lock and real-model gate is specified in
`docs/superpowers/specs/2026-11-17-kcode-cua-macos-replacement-design.md`.
Compilation or protocol fixtures alone do not establish GUI readiness.

License: Apache-2.0. Scoped macOS ABI documentation credits are retained in
`native/THIRD_PARTY_NOTICES.md`.
