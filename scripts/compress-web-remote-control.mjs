#!/usr/bin/env node
/**
 * 自托管远控页预压缩（spec 追记三 §3.2）：对构建产物白名单扩展生成 .br/.gz sidecar，
 * 供 self-host-relay 按 Accept-Encoding 协商返回。原文件保留；幂等（重跑先清旧 sidecar）。
 * 用法：node scripts/compress-web-remote-control.mjs [distDir=packages/web/dist]
 */
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".xml",
]);
const CONCURRENCY = 8;

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function main() {
  const distDir = process.argv[2] ?? "packages/web/dist";
  const all = await listFiles(distDir);
  // 先清旧 sidecar，保证与当前构建一一对应（原文件与 sidecar 必须同批）。
  await Promise.all(
    all.filter((f) => f.endsWith(".br") || f.endsWith(".gz")).map((f) => rm(f, { force: true })),
  );
  const targets = all.filter((file) => {
    if (file.endsWith(".br") || file.endsWith(".gz") || file.endsWith(".map")) return false;
    const dot = file.lastIndexOf(".");
    if (dot < 0) return false;
    return COMPRESSIBLE_EXTENSIONS.has(file.slice(dot).toLowerCase());
  });
  let originalBytes = 0;
  let brotliBytes = 0;
  let gzipBytes = 0;
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      const [buffer, { size }] = await Promise.all([readFile(file), stat(file)]);
      const [br, gz] = await Promise.all([
        brotliCompressAsync(buffer, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
        }),
        gzipAsync(buffer, { level: 9 }),
      ]);
      await Promise.all([writeFile(`${file}.br`, br), writeFile(`${file}.gz`, gz)]);
      originalBytes += size;
      brotliBytes += br.length;
      gzipBytes += gz.length;
    }
  });
  await Promise.all(workers);
  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(
    `[compress] files=${targets.length} original=${mb(originalBytes)}MB brotli=${mb(brotliBytes)}MB gzip=${mb(gzipBytes)}MB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
