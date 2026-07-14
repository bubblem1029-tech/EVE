# 修复闭环指南 (Fix Loop Guide)

> test-eval 执行用例后，读 confidence-data.jsonl 按 errorCategory 分流，对 script 类自行修复。

---

## 脚本缺陷子类型（errorCategory=script 时自行修复）

| 子类型 | 说明 | 修复方式 |
|--------|------|----------|
| 定位器不匹配 | 页面有替代元素 | 更新 POM 定位器 |
| 硬编码路径/ID/路由 | 路由格式错误 | 对照源代码 router 配置验证，严禁猜测 |
| 断言逻辑错误 | 页面显示正确但断言写错 | 调整断言 |
| 渲染类型不匹配 | 条件渲染/动态组件 | 改用正确的定位策略 |
| 等待策略不足 | 元素渲染时机不对 | 增加 waitFor 或调整 timeout |

> errorCategory=env/visual/assert 时不自修，用 `ask_user_questions` 确认或按 [common-fix-guide](./common-fix-guide.md) 排查。

---

## 修复流程

单次修复闭环（test-eval 内部）：

```
1. 读 confidence-data.jsonl → 按 errorCategory 分流
2. errorCategory=script → 定位失败用例 → 修复 POM 或 spec
3. 重跑失败用例：KEVE_TASK_DIR=.keve/mr-868-temp npx keve run --config=keve_test_spec/keve-test.config.ts --last-failed
4. 读新一轮 confidence-data.jsonl → 重新评估修复效果
```

---

## 每轮执行结果天然隔离（KEVE_TASK_DIR）

每轮 round 独立输出到 `$KEVE_TASK_DIR/test-artifacts/round-N/`，`latest` 符号链接始终指向最新轮次：

```
.keve/mr-868-temp/test-artifacts/
  ├── round-1/
  │   ├── test-results.json
  │   └── confidence-data.jsonl
  ├── round-2/
  └── latest → round-2/
```

每轮修复后在 `run-state.yaml` 中记录修复内容，编排层读取轮次进度：

```yaml
current_round: 3
rounds:
  1:
    status: completed
    passed: 14
    failed: 5
    fixes: ["AG-01: strict mode → .first()", "KB tooltip: broader popper locator"]
  2:
    status: completed
    passed: 16
    failed: 3
    fixes: ["WW: scope to 欢迎语容器", "REG-01: add NotAvailable分支"]
  3:
    status: completed
    passed: 19
    failed: 0
    fixes: []
```