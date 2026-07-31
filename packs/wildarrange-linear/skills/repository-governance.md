# repository-governance

## 用途

审计目录规则、分层 AGENTS、README/架构文档同步、命名、文件归属和代码注释规范。

## 流程

1. 运行 `wildarrange governance audit` 获取确定性报告。
2. 读取每条 finding 的 ruleId、路径、行号和证据。
3. 合并同一根因产生的重复项，给出最小修复任务。
4. 需要改文件时交给 Jiuwei 创建任务或 ChangeRequest。
5. 修复完成后复扫；未经 verifier/review/checkpoint 不宣称完成。

## 边界

- 不直接编辑、移动、重命名或删除项目文件。
- 不把语义偏好升级为阻断规则。
- 不为了 PASS 放宽机器可读 policy。
