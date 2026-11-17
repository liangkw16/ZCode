import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readComputerUseProducer,
  isRealComputerUseProducerInstalled,
} from "../../packages/desktop/scripts/computer-use-producer.mjs";
import { resolveCuaOsSupport } from "../../packages/desktop/src/main/cuaOsSupport.ts";
test("source producer declares platform capability rather than enabling a Windows private runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcua-producer-"));
  try {
    const install = join(root, "node_modules/@zcode/zcode-cua");
    await mkdir(install, { recursive: true });
    await writeFile(
      join(install, "package.json"),
      JSON.stringify({
        name: "@zcode/zcode-cua",
        zcodeCuaProducer: {
          kind: "source",
          protocol: 3,
          platforms: ["darwin"],
          nativeBuild: "scripts/build-native.mjs",
        },
      }),
    );
    assert.equal(
      isRealComputerUseProducerInstalled({ desktopPackageRoot: root, platform: "darwin" }),
      true,
    );
    assert.equal(
      isRealComputerUseProducerInstalled({ desktopPackageRoot: root, platform: "win32" }),
      false,
    );
    const source = readComputerUseProducer({ desktopPackageRoot: root });
    assert.equal(source.manifest.zcodeCuaProducer.kind, "source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("desktop OS gate matches the source Helper ScreenCaptureKit13 floor", () => {
  assert.equal(resolveCuaOsSupport("darwin", "21.6.0").kind, "macos-below-minimum");
  assert.equal(resolveCuaOsSupport("darwin", "22.0.0").kind, "supported");
  assert.equal(resolveCuaOsSupport("win32", "10.0").kind, "not-applicable");
});
