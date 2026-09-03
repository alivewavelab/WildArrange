# Component Style Sheet

## Token Source

- CSS：`tokens/design-tokens.css`
- JSON：`tokens/design-tokens.json`
- Review：`tokens/design-tokens.html`
- Grid：`--space-unit`，4px
- Font：`--font-label` + `--font-body`

## Patterns Used

- Fathom semantic lane：颜色只表示物理分区。
- Border-led surface：容器靠边线与底色分层，不靠大圆角和重阴影。
- Single detail drawer：所有模块详情共用一个抽屉。

---

## Components

### Top Bar

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| background | `--color-void` | `#0b0f14` | 透明混合仍以此为基底 |
| color | `--color-ink` | `#edf2f7` | wordmark |
| font-family | `--font-label` | Cascadia / JetBrains Mono | 技术标识 |
| min-height | `--h-control` | 44px+ | 不低于交互下限 |

### Filter Button

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| min-height | `--h-control` | 44px | 点击目标 |
| border-radius | `--radius-restrained` | 4px | 普通控件上限 |
| border | `--color-line` | 1px | 默认态 |
| active color | `--color-interface` | `#66a7ff` | 全局 filter accent |

**States:** default=neutral border；hover=accent border；active=accent border + dim fill；active+hover 保持 active。

### Search Field

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| min-height | `--h-control` | 44px | 输入目标 |
| background | `--color-surface` | `#111821` | 无材质叠加 |
| color | `--color-ink` | `#edf2f7` | 输入文字 |
| border-radius | `--radius-restrained` | 4px | 与 filter 一致 |

### Zone Responsibility Lane

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| background | `--color-surface` | `#111821` | 整条泳道 |
| border | `--color-line` | 1px | 区域边界 |
| gap | `--space-lg` | 16px | 泳道间距 |
| header width | `--zone-rail-width` | 188–220px | 桌面；移动端 100% |
| zone color | `--color-zone-*` | 五区语义色 | 左侧 3px 色标 |

### Zone Header

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| padding | `--space-xl` / `--space-lg` | 24px / 16px | 4px 网格 |
| background | `--color-surface-2` | `#17212d` | 与模块区区分 |
| label font | `--font-label` | mono | ZONE 01 与依赖规则 |
| position | `--position-flow` | static/relative | 禁止 sticky top |

### Module Card

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| min-width | `--module-min-width` | 260px | auto-fit 下限 |
| min-height | `--module-min-height` | 172px | 桌面信息容量 |
| padding | `--density-pad` | 12/16/24px | Tweaks 控制 |
| background | `--color-surface` | `#111821` | 纯色 |
| border-radius | `--radius-restrained` | 4px | 最大普通半径 |
| summary color | `--color-muted` | `#94a3b8` | 可任意断行 |
| footer font | `--font-label` | mono | 仅文件数量，不列路径 |

**States:** default=neutral；hover=上移 3px + zone border；active=3px zone bar + dim fill；active+hover 保持 active。

### Flow Tabs and Panels

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| control height | `--h-control` | 44px | 与 Filter 同体系 |
| transition | `--motion-panel` | 250ms ease-out | 切换面板 |
| panel background | `--color-surface` | `#111821` | 边框分层 |

### Script Lane

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| background | `--color-surface` | `#111821` | 四类脚本并列 |
| separator | `--color-line` | 1px | 不使用阴影 |
| code font | `--font-label` | mono | 路径与命令 |

### Detail Drawer

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| background | `--color-void` | `#0b0f14` 97% | 全页唯一抽屉 |
| active border | `--color-zone-*` | 当前 Zone 色 | 跟随模块 |
| transition | `--motion-panel` | 250ms ease-out | translateY |
| max-height | `--drawer-max-height` | min(84vh, 920px) | 长契约内部滚动 |
| file font | `--font-label` | mono | 精确物理路径只在此出现 |

### Contract Wiring Board

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| layout | `--contract-layout` | input → process → output | 桌面三栏；移动端单列 |
| process min-width | `--contract-process-min` | 220px | 保证步骤可读 |
| arrow column | `--contract-arrow-width` | 32px | 只表达数据方向 |
| background | `--color-surface` | `#111821` | 内容卡片 |
| label color | `--color-zone-*` | 当前 Zone 色 | 载体与分区联动 |

### Host Event Matrix

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| min-width | `--matrix-min-width` | 980px | 六列事件契约可读下限 |
| overflow | `--overflow-local` | auto | 只允许矩阵自身横向滚动 |
| separator | `--color-line` | 1px | 表格不使用凹陷阴影 |
| header font | `--font-label` | mono | 宿主 / 事件 / 结果标签 |

### Physical Owner Item

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| layout | `--owner-grid` | two columns / mobile one column | 每项一个源码 owner |
| border | `--color-line` | 1px dashed | 区分物理文件与数据制品 |
| path font | `--font-label` | mono | 允许任意断行 |

### Tweaks Host

| Property | Token | Value | Notes |
| --- | --- | --- | --- |
| control height | `--h-control` | 44px | 浮动入口 |
| radius | `--radius-status-pill` | 999px | 唯一功能性 pill |
| panel radius | `--radius-restrained` | 4px | 普通面板 |
| persistence | `--tweak-storage-key` | `wildarrange-module-map-tweaks` | 项目专用 key |

**States:** launcher default/hover；panel closed/open；reset 恢复 STYLE_CONTRACT 默认值。
