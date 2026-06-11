# lsp-setup

## 用途

配置或诊断 LSP，用于 diagnostics、go to definition、references、rename、type-aware checks。

## 检查项

- 项目语言和 package manager。
- 是否已有 LSP 配置。
- LSP server 是否安装。
- 根目录识别是否正确。
- diagnostics 是否能跑。
- monorepo 子包是否需要独立 root。

## 规则

- 优先使用项目已有配置。
- 不全局安装除非必要。
- 不引入大依赖只为一次查询。
- 配置后必须跑一次 diagnostics 验证。

## 输出

报告：

- 使用的 LSP。
- 配置文件。
- 验证命令。
- 当前 diagnostics 结果。
