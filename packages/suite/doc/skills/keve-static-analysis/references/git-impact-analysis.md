# Git 变更影响分析方法

> AI 使用 git 命令进行变更分析时的参考

---

## 当前变更范围

### 查看本次提交修改了哪些文件

```bash
# 最近一次提交
git diff --name-only HEAD~1

# 暂存区（未提交）
git diff --name-only --cached

# 工作区（未暂存）
git diff --name-only

# 所有未推送的变更
git diff --name-only origin/main...HEAD
```

### 查看修改了哪些函数

```bash
# 按函数级别查看改动
git diff --stat HEAD~1
```

---

## 变更影响范围

### 结合 Code-Graph 计算影响

```
1. 从 git diff 获取修改的文件和函数列表
2. 对每个修改的函数调用 codegraph_impact(symbol, depth=2)
3. 汇总所有受影响的调用者
```

### 手动计算（无 Code-Graph 时）

```bash
# 查看修改文件被哪些文件引用
grep -rn "import.*from.*修改的文件" src/
```

---

## 热点文件分析

### 最近 30 天高频变更文件

```bash
git log --format="%H" --since="30 days ago" \
  | xargs git diff-tree --no-commit-id --name-only -r \
  | sort | uniq -c | sort -rn | head -20
```

→ 变更次数 > 5 的文件 = 不稳定区域，需要更多测试覆盖

### 最近新增的文件（可能缺少测试）

```bash
git log --diff-filter=A --name-only --pretty=format: --since="30 days ago" \
  | grep -v "^$" | sort -u
```

---

## 风险评估规则

| 风险等级 | 条件 | 建议 |
|---------|------|------|
| 🔴 高 | 文件被 > 10 个模块依赖 + 本次有改动 | 重点回归测试 |
| 🟡 中 | 文件被 5-10 个模块依赖 | 补充单元测试 |
| 🟢 低 | 文件被 < 5 个模块依赖 | 常规测试即可 |
| 🔵 新增 | 新文件无历史测试 | 至少覆盖核心路径 |
