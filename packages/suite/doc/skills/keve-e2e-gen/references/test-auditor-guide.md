# 测试审计员指南 (Subagent: Test Auditor)

## 使命

测试审计员是**一致性守卫者**。它确保生成的 Playwright 测试脚本与原始测试用例描述一一对应，防止出现"浅层测试"（只验证页面可见，不验证业务功能）。

> 核心洞察：如果测试用例描述"筛选只显示用户自建"，但生成的脚本只调用 `assertPageVisible()`，这就是**一致性违规**。

---

## 问题定义

### 测试深度等级

> 详细的等级定义、适用场景和反例参见 [Fix Loop Guide](fix-loop-guide.md)。

| 等级 | 名称 | 最低要求 | 示例 |
|------|------|----------|------|
| L0 | 无断言 | ❌ 不允许 | 点击按钮但不检查结果 |
| L1 | 页面可见 | 导航测试可接受 | `expect(container).toBeVisible()` |
| L2 | 元素可见 | 最低要求 | `expect(button).toBeVisible()` |
| L3 | 业务断言 | 功能测试必须达到 | `expect(filterOptions).toEqual([...])` |
| L4 | 状态断言 | 交互/数据变更测试 | `expect(countAfter).toBeLessThan(countBefore)` |

**最低要求**：每个测试用例的脚本至少达到 **L2 级别**。如果原始用例描述包含业务功能验证（如"筛选只显示"、"按钮禁用"），脚本应达到 **L3 级别**。

> 详细的断言策略、时序等待方法和反模式参见 [Fix Loop Guide](fix-loop-guide.md)。

---

## 一致性校验规则

### 规则 1：用例ID-脚本对应

每个测试用例 ID 必须在生成的脚本中找到对应的 `test()` 块。

```
用例: AG-01 类型筛选只显示用户自建
  → 必须存在 test('AG-01: ...', ...) 
  → test 内必须包含与"筛选只显示用户自建"相关的断言
```

### 规则 2：预期结果-断言对应

每个用例的"预期结果"必须在脚本中有对应的断言。

| 预期结果关键词 | 应有的断言类型 |
|----------------|----------------|
| "只显示" / "不显示" | 数量断言、内容断言、可见性断言 |
| "禁用" / "disabled" | `expect(element).toBeDisabled()` |
| "可见" / "可见性" | `expect(element).toBeVisible()` |
| "文案为" / "显示" | `expect(element).toHaveText()` |
| "排序" / "排在前面" | 顺序断言、索引断言 |
| "自动截断" | 长度断言 |
| "字数" / "计数" | 文本长度断言 |

### 规则 3：禁止降级断言

如果原始用例描述了具体的业务功能验证，生成的脚本**不允许降级为 L1（页面可见）断言**。

```
❌ 错误示例:
  用例: AG-01 筛选只显示用户自建
  脚本: expect(agentListPage.getContainer()).toBeVisible()  // L1 断言，与用例不匹配

✅ 正确示例:
  用例: AG-01 筛选只显示用户自建
  脚本: 
    const options = agentListPage.getFilterOptions();
    await expect(options).toHaveLength(3);
    await expect(options.nth(0)).toHaveText('全部');
    await expect(options.nth(1)).toHaveText('我创建的');
    await expect(options.nth(2)).toHaveText('可编辑的');
    // 不包含 '天策门户' 和 '数据集'
```

---

## 校验流程

### Step 1: 读取测试用例文档

从以下来源获取原始测试用例描述：
- `.codeflicker/discuss/*/notes/test-cases.md`
- PRD 文档中的测试用例表格
- 用户提供的用例列表

### Step 2: 解析每个用例的 ID、描述、预期结果

```json
{
  "id": "AG-01",
  "description": "类型筛选只显示用户自建",
  "expectedResult": "只显示'全部/我创建的/可编辑的'筛选，天策门户/数据集单选项不显示"
}
```

### Step 3: 扫描生成的测试脚本

遍历所有 `.spec.ts` 文件，提取每个 `test()` 块的：
- 用例 ID（从 test title 中提取）
- 实际断言列表（从 `expect()` 调用中提取）
- 断言深度等级（L0~L4）

### Step 4: 逐一对比

对每个用例，对比"预期结果关键词"和"实际断言"：

```
用例 AG-01:
  预期关键词: ["只显示", "不显示", "筛选"]
  实际断言:   [expect(container).toBeVisible()]  // L1
  匹配结果:   ❌ 一致性违规
  原因:       "只显示" 需要 L3 级别的数量/内容断言，但脚本只有 L1 级别的可见性断言
  建议:       补充 getFilterOptions() 断言
```

### Step 5: 生成审计报告

输出格式：

```json
{
  "auditId": "audit-2026-05-28",
  "totalCases": 38,
  "consistentCases": 15,
  "violations": [
    {
      "caseId": "AG-01",
      "expectedDepth": "L3",
      "actualDepth": "L1",
      "expectedKeywords": ["只显示", "筛选"],
      "missingAssertions": ["getFilterOptions数量断言", "getFilterOptions内容断言"],
      "suggestion": "补充: await expect(filterOptions).toHaveLength(3)"
    }
  ],
  "coverageRate": "39.5%"
}
```

### Step 6: 自动补充断言（可选）

对于一致性违规的用例，自动补充深层断言：

1. 分析用例的预期结果关键词
2. 确定需要的断言类型和等级
3. 查找 POM 中是否有对应的方法
4. 如果有 → 直接补充调用
5. 如果没有 → 触发 Agent 4 重新生成 POM 方法（如 `assertFilterOptions`）

---

## 与 Subagent 的集成方式

测试审计员作为一个独立 subagent 运行，在 Agent 6 生成测试脚本之后、Agent 7 执行测试之前触发：

```
Agent 5 (choreographer) → 生成 journeys.json
    ↓
Agent 6 (assistant-director) → 生成测试脚本 (*.spec.ts)
    ↓
【在这里触发 Subagent: test-auditor】
    ↓
    ├─ 如果有违规 → 自动补充断言 / 重新生成部分脚本
    └─ 如果全部一致 → 继续执行
    ↓
Agent 7 (continuity-lead) → 执行测试
```

### Subagent 配置

在 `.codeflicker/agents/` 中创建 `test-auditor.md`：

```yaml
---
name: test-auditor
description: Validate consistency between test case descriptions and generated Playwright scripts
---
```

---

## 关键原则

1. **预期结果驱动断言** — 用例的"预期结果"决定脚本应有的断言深度
2. **禁止降级** — 有业务功能描述的用例不允许降级为 L1 断言
3. **关键词-断言映射** — 预期结果中的关键词必须有对应的断言类型
4. **审计覆盖率** — 目标 ≥ 80% 的用例达到 L2+ 级别
5. **自动补充优先** — 尽量自动补充断言，减少人工干预