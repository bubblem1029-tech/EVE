# 单元测试生成模板

> AI 生成 Vitest 单元测试时的参考模板

---

## 基本结构

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { functionName } from '@/utils/module';

describe('module', () => {
  describe('functionName', () => {
    it('正常路径描述', () => {
      // Arrange
      const input = validInput;
      // Act
      const result = functionName(input);
      // Assert
      expect(result).toBe(expectedValue);
    });

    it('边界条件描述', () => {
      expect(functionName(boundaryInput)).toBe(expectedValue);
    });

    it('异常路径描述', () => {
      expect(() => functionName(invalidInput)).toThrow(ErrorType);
    });
  });
});
```

---

## 纯函数模板

```typescript
describe('format', () => {
  describe('truncate', () => {
    it('短字符串不截断', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });
    it('长字符串截断加省略号', () => {
      expect(truncate('hello world', 5)).toBe('he...');
    });
    it('空字符串', () => {
      expect(truncate('', 5)).toBe('');
    });
  });
});
```

---

## Composable Hook 模板

```typescript
import { describe, it, expect, vi } from 'vitest';
import { useSearch } from '@/hooks/useSearch';

// 需要 @vue/test-utils 的 mountWithVitest 或 @vueuse/core 的试用
describe('useSearch', () => {
  it('初始化状态', () => {
    // composable 测试需要在 setup 上下文中调用
    // 方案1: 使用 @vue/test-utils 的 mount
    // 方案2: 使用 vitest 的 withSetup helper
  });
});
```

---

## 异步函数模板

```typescript
describe('fetchData', () => {
  it('成功返回数据', async () => {
    const mockData = { id: 1, name: 'test' };
    vi.mock('@/api/client', () => ({
      get: vi.fn().mockResolvedValue(mockData),
    }));
    const result = await fetchData(1);
    expect(result).toEqual(mockData);
  });

  it('网络错误抛出异常', async () => {
    vi.mock('@/api/client', () => ({
      get: vi.fn().mockRejectedValue(new Error('Network error')),
    }));
    await expect(fetchData(1)).rejects.toThrow('Network error');
  });
});
```

---

## 失败用例处理

```typescript
// 修复 2 轮后仍失败 → 改为 it.todo
it.todo('NaN输入时的行为');
it.todo('超大数值溢出');
```
