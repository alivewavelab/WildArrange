# run-linear-delivery

## 用途

让 Jiuwei 按任务状态推进线性交付，不亲手实现代码。

## 循环

1. 读取计划并选择依赖已完成的 runnable task。
2. 构建任务上下文并派发 ZhuRong。
3. 收集 DoneClaim，但只推进到 `verifying`。
4. 依次运行 verifier、scope、review、acceptance proof、checkpoint。
5. 任一 gate FAIL 时带证据重试或进入 ChangeRequest。
6. 每次状态转换写入 ledger，直到完成或真实阻塞。

## 不变量

- Jiuwei 不写实现代码。
- ZhuRong 不能自证完成。
- 不得删除或削弱 verifier、review、standards 或 success criteria。
- 范围漂移必须先走 ChangeRequest。
