# ESLint 修复指南

> AI 修复 ESLint 错误时的参考手册

---

## 修复策略

### 1. 自动修复（首选）

```bash
npx eslint src/ --fix
```

可自动修复的规则（常见）：
- `indent` — 缩进
- `semi` — 分号
- `quotes` — 引号风格
- `comma-dangle` — 尾逗号
- `no-extra-semi` — 多余分号
- `no-multiple-empty-lines` — 多余空行
- `eol-last` — 文件末尾换行
- `no-trailing-spaces` — 行尾空格
- `arrow-parens` — 箭头函数参数括号
- `object-curly-spacing` — 花括号空格

### 2. 手动修复

自动修复无法处理的规则（需理解上下文）：

| 规则 | 常见原因 | 修复方式 |
|------|---------|---------|
| `no-unused-vars` | 声明但未使用 | 删除未使用变量，或加 `_` 前缀 |
| `no-undef` | 使用未定义变量 | 补充 import 或全局声明 |
| `no-console` | console.log | 替换为 logger 或删除 |
| `no-redeclare` | 重复声明 | 合并声明或重命名 |
| `no-shadow` | 变量名遮蔽 | 重命名内层变量 |
| `@typescript-eslint/no-explicit-any` | 使用 any | 改为具体类型 |
| `@typescript-eslint/explicit-function-return-type` | 缺少返回类型 | 补充 `: ReturnType` |
| `vue/require-default-prop` | Props 缺少 default | 添加 `default` 属性 |
| `vue/no-mutating-props` | 直接修改 Props | 改用 emit 或本地副本 |

### 3. 禁止修复

以下情况**不应修复**，应报告给用户：
- 规则涉及业务逻辑变更
- 修复可能改变运行行为
- 不确定修复是否安全的

---

## 修复原则

1. **先自动修复，再手动修复**，减少工作量
2. **error 必须修复，warning 可选修复**
3. **每轮修复后重新验证**，确认不引入新问题
4. **同一规则的多处错误**，一次性全部修复
5. **修复后运行 `tsc --noEmit`**，确认类型不冲突

---

## 修复优先级

```
P0: TS 类型错误（阻塞一切）
P1: ESLint error（阻塞 CI）
P2: ESLint warning（不阻塞，可选修复）
P3: ESLint 建议（可忽略）
```
