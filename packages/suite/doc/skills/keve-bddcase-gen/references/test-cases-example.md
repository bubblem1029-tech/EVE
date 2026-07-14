# MR !868 测试用例示例（YAML格式）

## 完整示例

```yaml
version: "1.0"
mr_id: "!868"
title: "SDD 测试case1-应用后台_测试计划"
description: "智能应用管理页去掉门户&数据集筛选、数据知识库管理页禁用门户&数据集、欢迎语字符限制从80改为200"
docs_url: "https://xxx/d/home/fcAB5rrt6h8XwxRiB30uc6tnS"
generated_at: "2026-05-30"
principle: "打开 https://localhost:3000"

modules:
  - name: "WM"
    description: "欢迎语字符限制"
    priority: "P0"
    files:
      - "src/pages/agent/AgentEdit.vue"
      - "src/components/WelcomeMessageInput.vue"
    cases:
      - id: "WM-01"
        title: "欢迎语输入框字符限制为 300"
        priority: "P0"
        type: "ui"
        precondition:
          - "进入智能应用编辑页"
        steps:
          - step: "定位到欢迎语输入框"
            expected: "输入框可见，placeholder 显示默认文案"
          - step: "查看字数统计"
            expected: "初始显示 0/300"
          - step: "输入 300 个普通字符"
            expected: "输入成功，字数统计显示 300/300"
          - step: "继续输入第 301 个字符"
            expected: "无法输入，字数统计保持 300/300"

      - id: "WM-02"
        title: "欢迎语 Emoji 等特殊字符按 Grapheme Cluster 计数"
        priority: "P0"
        type: "ui"
        precondition:
          - "进入智能应用编辑页"
        steps:
          - step: "输入包含 Emoji 的文本（如 5 个 Emoji + 295 个普通字符）"
            expected: "字数统计显示 '300/300'，每个 Emoji 计为 1 个字符"
          - step: "输入包含组合字符的文本（如带变音符号的字母）"
            expected: "组合字符按 Grapheme Cluster 计数，不超出 300 限制"

      - id: "WM-03"
        title: "欢迎语保存和回显正常"
        priority: "P0"
        type: "ui"
        precondition:
          - "进入智能应用编辑页"
        steps:
          - step: "输入 300 字符的欢迎语"
            expected: "输入正常，字数统计正确"
          - step: "触发保存（如 blur 或点击保存）"
            expected: "保存成功，页面刷新后欢迎语正确回显"
          - step: "清空欢迎语"
            expected: "字数统计显示 '0/300'"
```

## 格式说明

### 头部字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `version` | ✅ | YAML 格式版本 |
| `mr_id` | ✅ | MR 编号 |
| `description` | ✅ | 需求标题（从PRD提取） |
| `docs_url` | ✅ | 需求文档链接 |
| `generated_at` | ✅ | 生成时间 |
| `principle` | ✅ | 测试原则 |

### 模块字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 模块前缀（2-3个大写字母） |
| `description` | ✅ | 功能模块描述 |
| `priority` | ✅ | 优先级（P0/P1/P2） |
| `files` | ✅ | 涉及文件列表 |
| `cases` | ✅ | 测试用例列表 |

### 用例字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 用例ID（模块前缀-序号） |
| `title` | ✅ | 用例标题 |
| `priority` | ✅ | 优先级 |
| `type` | ✅ | 类型（ui/component/regression） |
| `precondition` | ❌ | 前置条件列表 |
| `steps` | ✅ | 步骤列表（每个步骤包含 step 和 expected） |


**description 规范**：
- 必须从 PRD/需求文档中提取**需求标题**
- 禁止写"MR !XXX 测试用例"这类描述
- 示例："智能应用管理页去掉门户&数据集筛选、数据知识库管理页禁用门户&数据集、欢迎语字符限制从80改为200"
