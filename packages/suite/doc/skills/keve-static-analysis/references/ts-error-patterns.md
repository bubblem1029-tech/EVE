# TypeScript 常见错误码及修复模式

> AI 修复 TS 类型错误时的参考手册

---

## 高频错误码

### TS2322: 类型不匹配

```typescript
// ❌ 错误
const name: string = 123;

// ✅ 修复：修正类型标注或转换值
const name: string = '123';
// 或
const name: number = 123;
```

### TS2339: 属性不存在

```typescript
// ❌ 错误
interface User { name: string; }
const user: User = { name: 'Alice' };
console.log(user.age); // Property 'age' does not exist

// ✅ 修复：扩展接口或使用可选链
interface User { name: string; age?: number; }
console.log(user.age?.toString());
```

### TS2304: 找不到名称

```typescript
// ❌ 错误
const result = someFunction(); // Cannot find name 'someFunction'

// ✅ 修复：补充 import
import { someFunction } from './utils';
```

### TS2307: 找不到模块

```typescript
// ❌ 错误
import { foo } from './nonexistent'; // Cannot find module

// ✅ 修复：检查路径、补充 .vue 后缀、或创建声明文件
import { foo } from './existent';
```

### TS2769: 函数参数类型不匹配

```typescript
// ❌ 错误
function greet(name: string) { ... }
greet(123); // Argument of type 'number' is not assignable

// ✅ 修复：传入正确类型
greet('Alice');
// 或
greet(String(123));
```

### TS7053: 索引签名缺失

```typescript
// ❌ 错误
const obj: Record<string, string> = { a: '1' };
obj['b']; // Element implicitly has an 'any' type

// ✅ 修复：添加索引签名或类型断言
const obj: Record<string, string> = { a: '1' };
obj['b'] as string | undefined;
```

---

## 修复原则

1. **优先修正类型标注**，而不是用 `as any` 绕过
2. **检查 import 路径**，确认文件存在且大小写正确
3. **检查 `.vue` 文件导入**，可能需要 `shims-vue.d.ts`
4. **检查泛型约束**，可能需要补充 `extends` 条件
5. **检查响应式类型**，`Ref<T>` vs `T` 需要 `.value`

---

## 禁止做法

| 禁止 | 原因 |
|------|------|
| `@ts-ignore` | 掩盖错误，不解决问题 |
| `@ts-nocheck` | 整个文件跳过检查 |
| `as any` | 丢失类型安全 |
| 删除文件 | 不是修复，是逃避 |
