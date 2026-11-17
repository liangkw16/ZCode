import { expect, it } from "vitest";
import { writeFile, access } from "node:fs/promises";
import { readFreshHelperPermissions } from "../src/adapters/permission-launch.js";
it("uses LaunchServices with the canonical bundle and removes its private reply directory", async () => {
  let path = "";
  const report = await readFreshHelperPermissions({
    appPath: "/fixture/KCode Computer Use.app",
    launch: async (command, args) => {
      expect(command).toBe("/usr/bin/open");
      expect(args).toEqual(
        expect.arrayContaining([
          "-g",
          "-n",
          "-a",
          "/fixture/KCode Computer Use.app",
          "--permission-preflight",
          "all",
        ]),
      );
      path = args[args.indexOf("--permission-preflight-result-file") + 1];
      await writeFile(
        path,
        JSON.stringify({
          grant_owner: "dev.zcode.cua-helper.kcode",
          accessibility: "granted",
          screen_recording: "denied",
          desktop_availability: "unlocked",
        }),
      );
    },
  });
  expect(report.screen_recording).toBe("denied");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("fails the fresh sample instead of fabricating granted facts on a malformed reply", async () => {
  await expect(
    readFreshHelperPermissions({
      appPath: "/fixture/KCode Computer Use.app",
      launch: async (_command, args) => {
        await writeFile(
          args[args.indexOf("--permission-preflight-result-file") + 1],
          JSON.stringify({
            grant_owner: "wrong",
            accessibility: "granted",
            screen_recording: "granted",
          }),
        );
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_response" });
});
