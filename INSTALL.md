# 安装

本插件是 DSH 桌面端的**本地插件**，不是 npm 上的包。装法是把仓库目录链接进 DSH 的 profile。

支持：Windows 上的 DSH 0.2.1-rc.3。其他版本可能因为宿主接口不同而无法加载。

## 一、准备

```bash
git clone https://github.com/Elysia-Eden-A/dsh-memory-s.git
cd dsh-memory-s
node --version   # 需要 Node 22+（插件用 node:sqlite）
```

## 二、安装（脚本，推荐）

```bash
node scripts/install.mjs
```

它会：

1. 在 `%DSH_HOME%\profiles\desktop\package.json` 里加依赖 `"@local/dsh-memory": "link:<仓库路径>"`
2. 在 `dsh.profile.bundles` 里登记 `@local/dsh-memory`
3. 把包链到 profile 的 `node_modules/@local/dsh-memory`（有 pnpm 就用 pnpm，没有就建 junction）
4. 校验 `index.js`、`client.js`、`coordinator.mjs`、`migrate-core.mjs` 都能解析到

`DSH_HOME` 默认是 `%USERPROFILE%\.dsh`。如果 profile 在别处：

```bash
node scripts/install.mjs --profile "D:\path\to\profiles\desktop"
```

先看它要做什么、不写文件：

```bash
node scripts/install.mjs --dry-run
```

移除：

```bash
node scripts/install.mjs --uninstall
```

## 三、安装（手动，等价操作）

1. 编辑 `<profile>\package.json`：
   - `dependencies` 加 `"@local/dsh-memory": "link:<仓库绝对路径>"`
   - `dsh.profile.bundles` 数组里加 `"@local/dsh-memory"`
2. 在 profile 目录执行 `pnpm install`（没有 pnpm 时，手工建 `node_modules\@local\dsh-memory` 指向仓库目录的链接）
3. 完全退出并重开 DSH

## 四、装完检查

重启 DSH 后：

1. 打开 **设置 → 记忆存储**，页面能打开、能看到对话列表
2. 问一句"你还记得我们之前在做什么吗"，模型应能调用 `memory` 工具
3. 数据目录默认为**插件目录下的 `data/`**；可在设置页迁移到别处

如果设置页打不开：看 DSH 日志里有没有 `@local/dsh-memory` 的加载错误，通常是包名写错或链接没建成。

## 卸载

```bash
node scripts/install.mjs --uninstall
```

或手动从 profile `package.json` 删掉依赖和 bundle 条目，并删除 `node_modules/@local/dsh-memory`。

**删代码前先备份 `data/`**（如果数据放在插件目录下）。

## 验证范围说明

- 脚本在作者的机器上按同样结构安装过（profile 里就是 junction + bundles 登记），并在一个临时 profile 上验证了文件操作和校验逻辑
- **没有**在全新的 DSH 安装上做过端到端验证；宿主版本不同时的兼容性未测试
- `pnpm install` 分支未在本机执行（本机 pnpm 不在 PATH，走的是 junction 分支）
