import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Source capability is declared by the installed workspace producer. Build configs
// evaluate synchronously, so this bounded manifest read is intentionally synchronous.
export function readComputerUseProducer({ desktopPackageRoot }) {
  // 从桌面包向上查找最近的安装：闭源 hoisted 布局在仓库根，开源占位包链接在桌面包下。
  for (let dir = resolve(desktopPackageRoot); ; dir = dirname(dir)) {
    const manifestPath = resolve(dir, "node_modules", "@zcode", "zcode-cua", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return {
        installed: true,
        placeholder: manifest.zcodeCuaPlaceholder === true,
        manifest,
        packageRoot: dirname(manifestPath),
      };
    }
    if (dirname(dir) === dir) return { installed: false, placeholder: false };
  }
}

export function isRealComputerUseProducerInstalled({ desktopPackageRoot, platform }) {
  const producer = readComputerUseProducer({ desktopPackageRoot });
  if (!producer.installed || producer.placeholder) return false;
  const source = producer.manifest.zcodeCuaProducer;
  return (
    source?.kind === "source" &&
    source.protocol === 3 &&
    Array.isArray(source.platforms) &&
    (platform === undefined || source.platforms.includes(platform))
  );
}
