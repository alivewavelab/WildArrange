# debugging

## 用途

真实运行时调试：崩溃、静默失败、错误响应、卡死、内存泄漏、异步异常、时序问题、二进制/逆向问题。

## 核心纪律

1. 运行时真相比代码阅读更可信。所有根因判断必须来自观察到的状态。
2. 调试会产生临时产物，必须登记并清理。
3. 至少提出 3 个互斥假设，并用证据区分。
4. 两轮失败后，必须请 BaiZe 从不同角度复核。

## 流程

1. 环境评估：运行时、端口、进程、日志、配置、复现命令。
2. 建立 `.debug-journal.md`：记录命令、文件、临时 patch、截图、日志。
3. 形成至少 3 个假设。
4. 并行调查：每个假设对应不同证据。
5. 确认根因：切换 suspected cause 时，bug 必须随之开/关。
6. 写失败用例或最小复现。
7. 最小修复。
8. 通过真实表面 QA。
9. 清理所有调试产物。
10. 输出根因、证据、修复和验证。

## 工具选择

- Web UI：必须用浏览器/Playwright 类工具。
- API：真实服务 + curl/driver。
- CLI/TUI：真实终端运行。
- Node/Python/Go/Rust/Native：使用对应调试器或 runtime 观测工具。

## 输出合同

```json
{
  "rootCause": "",
  "hypothesesTested": [],
  "evidence": [],
  "fix": "",
  "verification": [],
  "artifactsCleaned": []
}
```
