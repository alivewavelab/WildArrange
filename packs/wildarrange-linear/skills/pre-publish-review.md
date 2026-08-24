# pre-publish-review

发布前复核 skill。用于 npm/npx 包发布、版本变更、公开仓库交付前的最后检查。

## 目标

确认即将发布的包可以被用户安装、运行、撤销，并且不会携带内部文件、密钥、临时产物或受限许可证内容。

## 必跑检查

1. 运行测试：

```bash
npm test
```

2. 检查包体：

```bash
npm pack --dry-run --cache /private/tmp/helix-npm-cache
```

3. 检查 Git 状态：

```bash
git status --short
```

4. 检查敏感内容：

```bash
rg -n "API_KEY|SECRET|TOKEN|PRIVATE KEY|BEGIN .* KEY" .
```

5. 检查商业发布隔离：

```bash
rg -n "SUL|copied from|verbatim|restricted source|third-party prompt" README.md src package.json packs --glob '!**/pre-publish-review.md'
```

## 阻断条件

- 测试失败。
- `npm pack --dry-run` 包含 `.external/`、`.helix/`、`.tmp/`、密钥、临时报告或本机路径。
- README 中的安装命令不可执行。
- 发布包包含受限第三方源码或未确认可商业分发的文本资产。
- `package.json` 的 `files` 遗漏 README、bin、src、packs、配置样例。

## 输出

返回：

- `PASS` / `FAIL`
- 包名、版本、包体文件数。
- 必须修复项。
- 可发布命令。
