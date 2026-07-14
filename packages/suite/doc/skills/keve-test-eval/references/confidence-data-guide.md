# confidence-data.jsonl 解读指南

> 每次执行后 Reporter 写入 `$KEVE_TASK_DIR/test-artifacts/latest/confidence-data.jsonl`，每行一条用例的评估结果。

## 文件位置

```
.keve/mr-868-temp/test-artifacts/latest/confidence-data.jsonl
                                           ↑ 符号链接，指向当前 round-N/
```

## 格式

每行一个 JSON 对象：

```json
{"title":"AG-01: 筛选区域不显示天策门户","data":"通过","confidence":95,"thought":"DOM断言通过 + keveAssert视觉验证通过","errorCategory":"pass","keveScreenshots":["keveAssert-筛选区域验证"]}
```

## 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 用例标题（@keveScene 的 title） |
| `data` | string | 最终结论：通过 / 不通过 / 跳过 / 待确认 |
| `confidence` | number | AI 评估置信度 0-100（跳过时为 0） |
| `thought` | string | AI 分析推理过程（跳过时为短路原因） |
| `errorCategory` | string | 错误分类：pass / script / env / visual / assert / unknown |
| `keveScreenshots` | string[] | keveAssert 截图 attachment 名称列表 |

## data + errorCategory 组合解读

| data | errorCategory | 含义 | 行动 |
|------|--------------|------|------|
| 通过 | pass | 可信通过（confidence >= 80） | 无需处理 |
| 通过 | pass | 有保留的通过（confidence < 80） | 可人工抽检 |
| 跳过 | env | 环境异常导致未执行 | [common-fix-guide 第2节](./common-fix-guide.md) |
| 跳过 | script | 测试代码本身有错导致未执行 | [common-fix-guide 第3节](./common-fix-guide.md) |
| 跳过 | visual | keveAssert 异常导致跳过 | [common-fix-guide 第4节](./common-fix-guide.md) |
| 不通过 | script | 脚本缺陷 | 自修 POM/spec → --last-failed 重跑 |
| 不通过 | assert | 断言失败（经 AI 评估仍不通过） | 读 thought 判断根因 → 修脚本/报Bug/问用户 |
| 不通过 | visual | 视觉断言失败 | 查截图判断 |
| 待确认 | * | AI 证据不足无法判定 | ask_user_questions |

## thought 字段解读

`thought` 是 AI 的推理过程，包含具体的错误描述和判断依据。重点关键词：

| thought 关键词 | 可能根因 | 行动 |
|---------------|---------|------|
| "locator not found" / "element not found" | 定位器找不到元素 | 检查 POM 定位器是否匹配源码 |
| "timeout" / "wait" | 等待策略不足 | 调整 waitFor/timeout |
| "text mismatch" | 预期与实际文本不符 | 检查 MR diff 是否有需求变更 |
| "keveAssert failed but DOM passed" | 假阳性 | 查 keveScreenshots 截图 |
| "redirect" / "auth" | 认证/重定向问题 | 检查 Auth 状态 |
| "ERR_CONNECTION" | 网络问题 | 检查 dev server 和网络 |

## 示例

**通过**：
```json
{"title":"AG-01: 类型筛选只显示用户自建","data":"通过","confidence":95,"thought":"DOM断言通过 + keveAssert视觉验证通过","errorCategory":"pass","keveScreenshots":["keveAssert-AG01-Step1"]}
```

**跳过（环境异常）**：
```json
{"title":"AG-02: 搜索功能","data":"跳过","confidence":0,"thought":"短路: navigation timeout, page.goto 超时, 可能 dev server 未启动","errorCategory":"env","keveScreenshots":[]}
```

**不通过（脚本缺陷）**：
```json
{"title":"AG-03: 创建Agent","data":"不通过","confidence":88,"thought":"locator('[data-e2e-name=创建按钮]') not found, 源码中该元素使用 aria-label 而非 data-e2e-name","errorCategory":"script","keveScreenshots":["keveAssert-AG03-Step1"]}
```

**不通过（断言失败，需人工判断）**：
```json
{"title":"AG-04: 删除Agent","data":"不通过","confidence":72,"thought":"点击删除后页面仍显示该Agent, 但MR diff 显示删除逻辑已改为软删除(标记而非移除)","errorCategory":"assert","keveScreenshots":["keveAssert-AG04-Step2"]}
```
