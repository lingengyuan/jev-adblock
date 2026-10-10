#!/usr/bin/env node
// 构建：把项目拷贝到 dist/，并按 run_at 把 manifest 中列出的内容脚本
// 各自合并为单包（document_start → early-bundle.js，document_idle →
// bundle.js），减少每帧的脚本注入开销（配合 all_frames 时每个 iframe
// 都会注入）。
// 用法：node scripts/build.js（npm run build）
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");

// run_at → 产物文件名。新增带 js 的 content_scripts 条目需在此登记。
const BUNDLE_BY_RUN_AT = {
  document_start: "src/content/early-bundle.js",
  document_idle: "src/content/bundle.js",
};

const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "_metadata",
  "dist",
  "tests",
  "scripts",
  ".workbuddy",
]);
const EXCLUDE_FILES = new Set([
  "package.json",
  "package-lock.json",
  ".gitignore",
  "README.md",
]);

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // 点目录（.workbuddy 开发笔记、.git 等）一律不进扩展包；
      // 显式列表之外再加一道，避免新增点目录时静默泄漏。
      if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      copyTree(path.join(src, entry.name), path.join(dest, entry.name));
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
    }
  }
}

function concatContentScripts(files, bundleName) {
  const header = [
    "// Jev Ad Block — 内容脚本包（自动生成）",
    "// 由 scripts/build.js 按 manifest 顺序拼接，请勿直接编辑。",
    "// 修改源文件后运行 npm run build 重新生成。",
    `// 产物：${bundleName}`,
    `// 源文件（${files.length} 个，按加载顺序）：`,
    ...files.map((f) => `//   - ${f}`),
    "",
  ].join("\n");
  const parts = files.map((rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`内容脚本不存在: ${rel}`);
    }
    const code = fs.readFileSync(abs, "utf8");
    return `// ===== ${rel} =====\n${code}`;
  });
  return header + parts.join("\n\n");
}

function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  copyTree(root, dist);

  const manifestPath = path.join(dist, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  for (const cs of manifest.content_scripts || []) {
    if (!cs.js || !cs.js.length) continue;
    const bundleName = BUNDLE_BY_RUN_AT[cs.run_at || "document_idle"];
    if (!bundleName) {
      throw new Error(`未登记的内容脚本 run_at: ${cs.run_at}`);
    }
    const files = cs.js.slice();
    const bundlePath = path.join(dist, bundleName);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, concatContentScripts(files, bundleName));
    cs.js = [bundleName];
    const size = (fs.statSync(bundlePath).size / 1024).toFixed(1);
    console.log(`  ${bundleName} ← ${files.length} 个文件（${size} KB）`);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`dist/ 构建完成`);
}

main();
