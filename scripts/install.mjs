#!/usr/bin/env node
/**
 * 把本插件装进 DSH profile。
 *
 * 做三件事（与 DSH 实际的本地插件安装方式一致）：
 *   1. profile/package.json 里加依赖 "@local/dsh-memory": "link:<本目录>"
 *   2. profile/package.json 的 dsh.profile.bundles 里登记该包名
 *   3. 把该包链到 profile/node_modules/@local/dsh-memory（有 pnpm 就交给它，没有就建 junction）
 *
 * 用法：
 *   node scripts/install.mjs                     # 自动找默认 profile
 *   node scripts/install.mjs --profile <dir>     # 指定 profile
 *   node scripts/install.mjs --dry-run           # 只打印要做什么
 *   node scripts/install.mjs --uninstall         # 从 profile 移除
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const PKG = '@local/dsh-memory';
const here = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

function defaultProfile() {
  const home = process.env.DSH_HOME || join(os.homedir(), '.dsh');
  return join(home, 'profiles', 'desktop');
}

const profile = resolve(value('--profile') || defaultProfile());
const pluginDir = resolve(value('--link') || here);
const dryRun = flag('--dry-run');
const uninstall = flag('--uninstall');

function fail(message) {
  console.error(`错误：${message}`);
  process.exit(1);
}

if (!existsSync(pluginDir)) fail(`插件目录不存在：${pluginDir}`);
for (const file of ['index.js', 'client.js', 'coordinator.mjs', 'migrate-core.mjs', 'cordis.patch.yml']) {
  if (!existsSync(join(pluginDir, file))) fail(`插件目录缺少 ${file}（请确认拿到的是完整仓库）`);
}
if (!existsSync(profile)) fail(`profile 目录不存在：${profile}\n用 --profile 指定，例如：node scripts/install.mjs --profile "D:\\path\\profiles\\desktop"`);

const pkgPath = join(profile, 'package.json');
if (!existsSync(pkgPath)) fail(`profile 里没有 package.json：${pkgPath}`);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));

pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];

const linked = join(profile, 'node_modules', '@local', 'dsh-memory');
const hadDep = Boolean(pkg.dependencies[PKG]);
const hadBundle = pkg.dsh.profile.bundles.includes(PKG);

if (uninstall) {
  delete pkg.dependencies[PKG];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((name) => name !== PKG);
  if (existsSync(linked)) rmSync(linked, { recursive: true, force: true });
  if (!dryRun) writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`已从 ${profile} 移除 ${PKG}。重启 DSH 后生效。`);
  process.exit(0);
}

pkg.dependencies[PKG] = `link:${pluginDir.replace(/\\/g, '/')}`;
if (!pkg.dsh.profile.bundles.includes(PKG)) pkg.dsh.profile.bundles.push(PKG);

console.log(`profile : ${profile}`);
console.log(`插件目录: ${pluginDir}`);
console.log(`依赖    : ${PKG} = link:${pluginDir.replace(/\\/g, '/')}${hadDep ? '（已存在，覆盖）' : ''}`);
console.log(`bundles : ${hadBundle ? '已登记' : '追加登记'}`);

if (dryRun) {
  console.log('\n--dry-run：未写入任何文件。');
  process.exit(0);
}

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

// 有 pnpm 就让它写 lock，没有就手工建链接（DSH 的 nodeLinker 是 hoisted）
let installedWith = 'junction';
try {
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install'], {
    cwd: profile, stdio: 'pipe', timeout: 180_000,
  });
  installedWith = 'pnpm';
} catch {
  const parent = dirname(linked);
  mkdirSync(parent, { recursive: true });
  if (existsSync(linked)) {
    try {
      if (lstatSync(linked).isSymbolicLink() || lstatSync(linked).isDirectory()) rmSync(linked, { recursive: true, force: true });
    } catch {
      /* 保留原样，下面会报错 */
    }
  }
  symlinkSync(pluginDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
}

// 验证：文件真的能解析到，且四个模块都在（防止 files 字段漏项那类问题）
const checks = ['index.js', 'client.js', 'coordinator.mjs', 'migrate-core.mjs'];
for (const file of checks) {
  const target = join(linked, file);
  if (!existsSync(target)) fail(`安装后校验失败：${target} 不存在（链接方式：${installedWith}）`);
}
console.log(`\n链接方式：${installedWith}`);
console.log('校验通过：index.js / client.js / coordinator.mjs / migrate-core.mjs 均可解析。');
console.log('\n下一步：完全退出并重新打开 DSH，然后到 设置 → 记忆存储 确认页面能打开。');
