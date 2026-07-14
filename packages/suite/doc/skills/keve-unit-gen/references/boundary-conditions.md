# 边界条件识别规则

> AI 分析函数签名时识别边界条件的参考

---

## 按参数类型的边界条件

### number

| 边界值 | 示例 |
|--------|------|
| 0 | `calculate(0)` |
| -1 | `calculate(-1)` |
| NaN | `calculate(NaN)` |
| Infinity | `calculate(Infinity)` |
| 超大数值 | `calculate(Number.MAX_VALUE)` |
| 小数精度 | `calculate(0.1 + 0.2)` |

### string

| 边界值 | 示例 |
|--------|------|
| 空字符串 | `parse('')` |
| 超长字符串 | `parse('a'.repeat(10000))` |
| 特殊字符 | `parse('<script>alert("xss")</script>')` |
| Unicode | `parse('你好世界🎉')` |
| null 字符 | `parse('\0')` |

### Array

| 边界值 | 示例 |
|--------|------|
| 空数组 | `filter([])` |
| 单元素 | `filter([1])` |
| 重复元素 | `filter([1, 1, 1])` |
| 混合类型 | `filter([1, 'a', null])` |

### Object

| 边界值 | 示例 |
|--------|------|
| 空对象 | `merge({})` |
| 嵌套深对象 | `merge({ a: { b: { c: 1 } } })` |
| 含 undefined 属性 | `merge({ a: undefined })` |

### null / undefined

| 边界值 | 示例 |
|--------|------|
| null | `parse(null)` |
| undefined | `parse(undefined)` |

---

## 按返回类型的边界条件

| 返回类型 | 应验证 |
|---------|--------|
| string | 空字符串、非空字符串 |
| number | 0、正数、负数 |
| boolean | true、false |
| Array | 空数组、非空数组 |
| Promise | resolve、reject |
| void | 函数执行无异常 |

---

## 特殊场景

| 场景 | 识别方式 | 测试 |
|------|---------|------|
| 必填参数缺失 | 无默认值 | 缺失时是否抛错 |
| 可选参数 | `param?: T` | 有/无各 1 test |
| 函数重载 | 多个签名 | 每个重载 1 test |
| 泛型函数 | `<T>(x: T)` | 不同类型参数各 1 test |
| 抛出异常 | `throw new Error()` | 异常类型 + 消息 |
| 异步拒绝 | `reject()` | `await expect(fn()).rejects.toThrow()` |
