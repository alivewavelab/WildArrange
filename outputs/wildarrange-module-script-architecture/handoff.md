# Handoff

## 打开

直接打开 `doc/plans/2026-09-01-module-and-script-architecture.html`。文件为单 HTML，无网络依赖。

## 更新事实

1. 新增、删除或移动运行时文件时，先更新 `tooling/arch-module-graph/module-file-map.json` 与官方产品总图。
2. 在最终 HTML 的 `modules` 数组中更新职责簇和 `files`。
3. 同步 `moduleContracts` 中对应模块的 inputs / process / outputs；如果宿主 Hook 变化，同时更新 Adapter 的 matrix 与 fileRoles。
4. 同步区标题中的 file count，以及脚本区的测试/Skill 数量。
5. 运行 `npm.cmd run check:arch`，并重新做 74/74 一类的实际文件覆盖比对。

## 修改视觉

主要 token 位于 HTML 顶部 `:root`。不要新增散落颜色、字号或圆角；先修改 token，再运行两项 Omni 门。

模块板保持“Zone 横向泳道”结构：`.zone-column` 左侧是 Zone 语义栏，右侧 `.module-list` 使用 `auto-fit`。不要重新改回五个窄列，也不要给 `.zone-head` 添加 `sticky top`；精确文件路径只放在抽屉。

抽屉保持一套交互，但允许模块添加专属矩阵。输入/输出项必须明确载体是文件、CLI 参数、宿主 JSON 还是函数返回；写文件时必须给真实路径、内容和使用方。事件矩阵只在 `.matrix-scroll` 内横向滚动，不能让整个页面横向溢出。

## 验证命令

```powershell
node C:\Users\Administrator\.agents\skills\omni-design\scripts\style-redline-check.mjs doc\plans\2026-09-01-module-and-script-architecture.html
node C:\Users\Administrator\.agents\skills\omni-design\scripts\spec-quality-gate-check.mjs doc\plans\2026-09-01-module-and-script-architecture.html
npm.cmd run check:arch
```

Python Playwright 未安装；本次使用 Codex 已有 Node Playwright 与 Microsoft Edge 做渲染验证，未修改环境依赖。
