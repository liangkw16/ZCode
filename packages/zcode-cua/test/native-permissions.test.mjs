import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const exec = promisify(execFile);
test(
  "fresh preflight reports OS facts without starting a broker or capturing pixels",
  { skip: process.platform !== "darwin" },
  async () => {
    const binary = resolve(
      import.meta.dirname,
      "../dist/native/darwin-arm64/KCode Computer Use.app/Contents/MacOS/KCode Computer Use",
    );
    const { stdout } = await exec(binary, ["--permission-preflight", "all"], { timeout: 3000 });
    const report = JSON.parse(stdout);
    assert.equal(report.grant_owner, "dev.zcode.cua-helper.kcode");
    assert.ok(["granted", "denied", "unknown"].includes(report.accessibility));
    assert.ok(["granted", "denied", "unknown"].includes(report.screen_recording));
    assert.equal(report.prompted, false);
    assert.equal(report.capture_probe_ran, false);
    assert.ok(["unlocked", "locked", "unknown"].includes(report.desktop_availability));
  },
);
