# visual-qa

## 用途

视觉 QA。任何 Web UI、页面、组件、TUI/终端 UI 变更后，完成前必须视觉验证。

## 适用场景

- 页面或组件是否符合设计意图。
- 截图 diff / pixel diff。
- 响应式布局。
- CJK 文本截断、换行、列宽问题。
- TUI 边框错位、宽字符漂移。
- 怀疑 design system 只是图片或 mock。

## 流程

### 1. 判断表面

- Web/page UI：浏览器截图。
- TUI/terminal UI：终端 capture。
- 两者都涉及时，两条线都跑。

### 2. 捕获证据

Web：

- 参考图或 baseline。
- 实际渲染截图。
- 统一 viewport。
- 记录差异区域。

TUI：

- plain text capture。
- ANSI-preserving capture。
- 真实终端宽度。
- 检查 overflow、border、wide char。

### 3. 双路只读审核

- A：设计系统和功能完整性。
- B：视觉保真和 CJK 精度。

### 4. 综合 verdict

输出 PASS / REVISE / FAIL，带具体位置和修复建议。

## 禁止

- 没看渲染结果就说完成。
- 只看源码判断视觉。
- 忽略移动端或窄屏。
- 忽略 CJK 文本。
