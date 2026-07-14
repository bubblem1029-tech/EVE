# 单元测试 Mock 策略

> AI 生成单元测试时的 vi.mock 使用指南

---

## Mock 优先级

| 优先级 | 方式 | 适用场景 |
|--------|------|---------|
| 1 | `vi.mock` 整个模块 | 外部依赖（API、Store、第三方库） |
| 2 | `vi.fn` 创建假函数 | 回调函数、事件处理器 |
| 3 | `vi.spyOn` 监视真实方法 | 需要保留部分真实行为时 |
| 4 | 传入测试数据 | 无外部依赖的纯函数（不需要 mock） |

---

## 常见 Mock 场景

### Mock API 模块

```typescript
vi.mock('@/api/client', () => ({
  get: vi.fn().mockResolvedValue({ data: [] }),
  post: vi.fn().mockResolvedValue({ success: true }),
}));
```

### Mock Store

```typescript
vi.mock('@/store/user', () => ({
  useUserStore: vi.fn(() => ({
    userInfo: { name: 'test' },
    isLoggedIn: true,
    login: vi.fn(),
    logout: vi.fn(),
  })),
}));
```

### Mock 第三方库

```typescript
vi.mock('lodash/debounce', () => ({
  default: (fn: Function) => fn,  // debounce 立即执行
}));

vi.mock('dayjs', () => ({
  default: (date?: string) => ({
    format: (fmt: string) => '2026-01-01',
  }),
}));
```

### Mock 环境变量

```typescript
vi.stubEnv('VITE_API_URL', 'http://localhost:3000');
```

---

## 禁止做法

| 禁止 | 原因 |
|------|------|
| Mock 被测函数本身 | 失去测试意义 |
| Mock 纯函数 | 纯函数无副作用，直接调用 |
| `vi.spyOn` 后 `mockRestore` 不调用 | 影响其他测试 |
| 在 describe 顶层写 `vi.mock` 外的副作用 | 执行顺序不确定 |
