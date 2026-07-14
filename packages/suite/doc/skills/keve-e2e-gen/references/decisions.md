# 关键决策索引 (Key Decisions)

> 本文档集中管理 keve-e2e-gen 的所有关键决策，便于查阅和引用。

---

## 决策列表

| ID | 决策 | 说明 | 关联文档 |
|----|------|------|----------|
| D01 | 独立配置文件 | `--config=keve_test_spec/keve-test.config.ts` | - |
| D05 | 环境数据集中定义 | `fixtures/test-data.ts` 导入，不硬编码 | [script-generation-guide](script-generation-guide.md) |
| D06 | 保障进程完整执行 | `2>&1 \| tee` 确保 JSON reporter 写入不受影响 | - |
| D07 | Auth 自动 | `globalSetup` 自动注入登录态 | - |
| D08 | 多轮结果隔离 | `KEVE_TASK_DIR` + `KEVE_ROUND` 指定每轮输出 | - |
| D09 | 路由对照源代码 | POM 中 `page.goto()` 路由必须从源代码 router 配置提取 | [code-analysis-guide](code-analysis-guide.md) |
| D10 | waitForReady 等 API | 代码分析阶段扫描 API 依赖，waitForReady 中增加 waitForResponse | [code-analysis-guide](code-analysis-guide.md) |
| D11 | 关键步骤视觉断言 | keveAssert + 页面 console.error 采集 | [script-generation-guide](script-generation-guide.md) |
| D12 | keveAssert 数量约束 | 每测试上限 5 次（建议 2-3 次） | [script-generation-guide](script-generation-guide.md) |
| D13 | 超时 60s | 适应 AI 视觉断言 API 耗时 | - |
| D14 | 用例步骤绑定 | `keveGoal({ precondition?, step, expected }, fn)` 函数调用，步骤元数据与执行代码绑定，与 YAML 一一对应 | [script-generation-guide](script-generation-guide.md) |
| D15 | 装饰器写法（统一标准） | @keveModel/@keveScene 装饰器 + keveGoal() 函数调用，TC39 Stage 3，sceneCodeMap 供 Reporter 校验 | [script-generation-guide](script-generation-guide.md) |

---

## D 类修复方法速查

> 详细分类和修复流程见 [fix-loop-guide](fix-loop-guide.md)

| D 子类型 | 修复方法 |
|----------|----------|
| D-1 定位器不匹配 | 更新 POM 定位器 |
| D-2 硬编码路径 | 从 router 配置提取路由，改用 test-data |
| D-3 断言逻辑错误 | 修正断言匹配页面实际行为 |
| D-4 组件渲染不匹配 | 处理条件渲染/动态组件 |
| D-5 等待策略不足 | 增加 waitFor / waitForResponse |
