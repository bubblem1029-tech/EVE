# eslint-plugin-security 规则完整列表

> AI 执行安全扫描时的规则参考

---

## 高优先级规则

| 规则 | 检测 | 风险 |
|------|------|------|
| `detect-eval-with-expression` | `eval(userInput)`, `new Function(str)` | 🔴 代码注入 |
| `detect-unsafe-regex` | `/(a+)+/`, `/(a\|a)*$/` | 🟠 ReDoS |
| `detect-non-literal-regexp` | `new RegExp(userInput)` | 🟠 ReDoS |
| `detect-object-injection` | `obj[userInput]` | 🟡 属性注入 |
| `detect-xss` | `innerHTML = userInput`, `v-html` | 🔴 XSS |

## 中优先级规则

| 规则 | 检测 | 风险 |
|------|------|------|
| `detect-non-literal-fs-filename` | `fs.readFile(userInput)` | 🟠 路径遍历 |
| `detect-pseudoRandomBytes` | `Math.random()` 用于安全场景 | 🟡 弱随机 |
| `detect-possible-timing-attacks` | `password === input` | 🟡 时序攻击 |
| `detect-buffer-usage` | `new Buffer(userInput)` | 🟡 内存泄露 |

## Vue 专项

| 规则 | 检测 | 风险 |
|------|------|------|
| `vue/no-v-html` | `<div v-html="userContent">` | 🔴 XSS |
| `vue/require-v-for-key` | `<div v-for="item in list">` | 🟡 性能/DOM |
| `vue/no-mutating-props` | `props.data = newValue` | 🟡 数据流 |
