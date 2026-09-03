# publish

WildArrange 发布 skill。用于把本地已验证版本发布到 npm 或准备 GitHub release。

## 前置条件

- `pre-publish-review` 通过。
- `get-unpublished-changes` 已生成发布摘要。
- `npm test` 通过。
- `npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache` 通过。
- `git status --short` 中没有意外改动。

## npm 发布路径

1. 确认包名与版本：

```bash
node -e "const p=require('./package.json'); console.log(p.name, p.version)"
```

2. 确认 npm 登录状态：

```bash
npm whoami
```

3. dry-run：

```bash
npm publish --dry-run
```

4. 正式发布：

```bash
npm publish
```

scope 包需要按 npm 组织策略决定是否加：

```bash
npm publish --access public
```

## 阻断条件

- 包名/组织未确认。
- 版本号未 bump。
- 许可证与商业发布边界未确认。
- dry-run 包含不该发布的文件。
- CI 或本地测试失败。

## 输出

- 发布版本。
- npm 包链接。
- Git tag 建议。
- release notes 摘要。
