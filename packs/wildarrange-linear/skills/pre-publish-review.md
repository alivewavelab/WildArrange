# pre-publish-review

发布前复核 skill。用于 npm/npx 包发布、版本变更、公开仓库交付前的最后检查。

## 目标

确认即将发布的包可以被用户安装、运行、撤销，并且不会携带内部文件、密钥、临时产物或受限许可证内容。

## 必跑检查

1. 运行测试：

```bash
npm test
```

2. 检查真实包体清单：

```bash
npm pack --dry-run --json --cache /private/tmp/helix-npm-cache
```

输出中的 `files[].path` 是复核边界的唯一事实源；不要根据 `package.json.files` 或手写目录猜测最终包体。

3. 检查 Git 状态：

```bash
git status --short
```

4. 检查敏感内容：

```bash
rg -n "API_KEY|SECRET|TOKEN|PRIVATE KEY|BEGIN .* KEY" .
```

5. 对真实 pack 清单执行商业发布隔离与相对链接检查：

```bash
node --test test/package-boundary.test.mjs
```

该测试必须真实调用 `npm pack --dry-run --json`，只允许命名白名单中的小白手册进入 `doc/plans/`，拒绝其余历史方案、受限 Prompt、运行态和临时产物，并逐一校验包内 Markdown 的相对链接目标仍在包中。

## 阻断条件

- 测试失败。
- 真实 pack 清单包含未列入命名白名单的 `doc/plans/` 文件、`.external/`、`.helix/`、`.tmp/`、密钥、临时报告或本机路径。
- README 中的安装命令不可执行。
- 发布包包含受限第三方源码或未确认可商业分发的文本资产。
- `package.json` 的 `files` 遗漏 README、bin、src、packs、配置样例。

## 输出

返回：

- `PASS` / `FAIL`
- 包名、版本、包体文件数。
- 必须修复项。
- 可发布命令。
