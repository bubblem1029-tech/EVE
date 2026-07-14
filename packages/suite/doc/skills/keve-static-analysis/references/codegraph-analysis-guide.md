# Code-Graph 检测模式和查询策略

> AI 使用 Code-Graph MCP 工具时的查询指南

---

## 前置条件

```bash
# 如果项目没有 .codegraph/ 索引
codegraph init -i
```

---

## 检测模式

### 循环依赖

```
查询: codegraph_explore("import cycle circular dependency")
解读: 返回模块间的调用链，识别 A→B→C→A 环路
输出格式: ["src/utils/a.ts → src/store/b.ts → src/utils/a.ts"]
```

### 幽灵依赖

```
查询: codegraph_callees("模块名")
解读: 函数/模块调用的外部依赖，对比 package.json 的 dependencies
输出格式: 未在 package.json 中声明的导入
```

### 死代码

```
查询: codegraph_callers("函数名")
解读: 非导出函数且无调用者 = 死代码
注意: exclude export 的函数（可能被外部使用）
```

### 架构层级违规

```
查询: codegraph_explore("utils import component")
解读: utils/ 不应导入 components/，违反分层架构
输出格式: ["src/utils/request.ts imports src/components/Modal.vue"]
```

### 变更影响范围

```
查询: codegraph_impact("函数名", depth=2)
解读: 改了某函数，影响哪些调用者（2 层深度）
输出格式: 直接调用者 + 间接调用者
```

### 圈复杂度计算

```
步骤:
  1. codegraph_search("函数名")  → 找到符号位置
  2. codegraph_node("函数名", includeCode=true)  → 获取函数体完整源码
  3. AI 分析源码计算决策点:
     圈复杂度 = 1 + if数 + else if数 + for数 + while数 + case数 + catch数
              + &&数 + ||数 + 三元表达式数

阈值:
  ≤ 10  ✅ 正常
  11-20 ⚠️ 偏高，建议拆分
  > 20  🔴 过高，必须重构
```

### 代码克隆检测

```
步骤:
  1. codegraph_files(format="flat")  → 获取所有文件列表
  2. codegraph_node("相似函数", includeCode=true)  → 获取函数体
  3. AI 比对不同函数的 AST 结构相似度:
     - 变量名不同但结构相同 = Type-2 克隆
     - 部分 结构相同 = Type-3 克隆
  4. 相似度 > 70% → 标记为潜在克隆
```

---

## 查询策略

### 从全局到局部

```
1. codegraph_files()         → 项目结构概览
2. codegraph_search("模块")  → 定位符号
3. codegraph_explore()       → 查看源码 + 关系
4. codegraph_callers/callees → 深入依赖
5. codegraph_impact()        → 计算影响
```

### 按分析维度选择工具

| 分析目标 | 工具 | 参数 |
|---------|------|------|
| 找符号 | `codegraph_search` | query="函数名" |
| 看源码 | `codegraph_explore` | query="模块名 文件名" |
| 谁调它 | `codegraph_callers` | symbol="函数名" |
| 它调谁 | `codegraph_callees` | symbol="函数名" |
| 改它影响谁 | `codegraph_impact` | symbol="函数名", depth=2 |
