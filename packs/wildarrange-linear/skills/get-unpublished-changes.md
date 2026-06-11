# get-unpublished-changes

找出尚未发布的本地改动。用于 release notes、版本 bump、发布前复核。

## 输入

- 当前 Git 工作区。
- 上一个 tag 或发布 commit。
- `package.json` 的当前版本。

## 流程

1. 看工作区是否干净：

```bash
git status --short
```

2. 找最近 tag：

```bash
git tag --sort=-creatordate
```

3. 如果有 tag，对比：

```bash
git log --oneline <tag>..HEAD
git diff --stat <tag>..HEAD
```

4. 如果没有 tag，对比初始发布范围：

```bash
git log --oneline
git diff --stat
```

5. 对 npm 包体做确认：

```bash
npm pack --dry-run --cache /private/tmp/helix-npm-cache
```

## 输出

- `changedFiles`
- `commitsSinceLastRelease`
- `releaseNotesDraft`
- `riskFlags`
- `recommendedVersionBump`: `patch` / `minor` / `major`

## 规则

- 不把未提交改动当作已发布内容。
- 不把测试文件、文档、运行时文件混成一类；分别列出。
- 如果存在许可证隔离风险，必须标为 `P0`。
