#!/bin/bash
# inject-testids.sh — 扫描源代码 Vue/React 组件，注入缺失的标识符
#
# 注入策略（最小侵入，优先可访问性）：
#   - 交互元素（button/input/link/radio）：优先注入 aria-label，绝不注入 data-e2e-name
#   - 非交互元素（container/text/status）：不得已时注入 data-e2e-name
#   - 旧属性共存，不删除
#   - 命名规范：
#     aria-label: 简洁动作描述（如 "新建智能应用"）
#     data-e2e-name: 组件名-区域描述（如 "智能应用详情-置灰遮罩"）
#
# 输出：
#   .keve/testid-injections.json — 注入记录
#   源代码文件 — 直接修改（git diff 可查看变更）

set -e

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${PROJECT_ROOT}/.keve"
COMPONENT_REGISTRY="${OUTPUT_DIR}/component-registry.json"
INJECTIONS_FILE="${OUTPUT_DIR}/testid-injections.json"

mkdir -p "$OUTPUT_DIR"

echo "[inject] 正在扫描组件并注入 data-testid / aria-label..."

# 如果没有 component-registry.json，先运行 extract-components.sh
if [ ! -f "$COMPONENT_REGISTRY" ]; then
    echo "[inject] 未找到 component-registry.json，请先运行 extract-components.sh"
    exit 1
fi

# 扫描需要注入的组件文件
COMPONENT_FILES=$(cat "$COMPONENT_REGISTRY" | python3 -c "
import json, sys
registry = json.load(sys.stdin)
files = set()
for component in registry.get('components', []):
    f = component.get('filePath', '')
    if f and f.endswith('.vue'):
        files.add(f)
print('\n'.join(sorted(files)))
" 2>/dev/null)

if [ -z "$COMPONENT_FILES" ]; then
    echo "[inject] 未找到需要处理的组件文件"
    exit 0
fi

INJECTIONS=()

for FILE in $COMPONENT_FILES; do
    FULL_PATH="${PROJECT_ROOT}/${FILE}"
    if [ ! -f "$FULL_PATH" ]; then
        echo "[inject] 跳过不存在的文件: $FILE"
        continue
    fi

    echo "[inject] 处理: $FILE"

    # 注入规则：使用 sed 进行源代码修改
    # 规则1: <button> 没有 aria-label 且没有可见文本 → 注入 aria-label
    # 规则2: 容器元素没有 data-testid → 注入 data-testid
    # 规则3: 旧 data-e2e-name 共存

    # 这些规则需要根据具体项目调整
    # 以下是通用模板，实际注入由 Agent 2 (Stage Manager) 在分析后精确执行

    # 检查文件中是否有 data-testid
    TESTID_COUNT=$(grep -c 'data-testid' "$FULL_PATH" 2>/dev/null || echo "0")
    echo "[inject]   已有 data-testid: $TESTID_COUNT 个"

    if [ "$TESTID_COUNT" -eq "0" ]; then
        echo "[inject]   ⚠️ 该文件缺少 data-testid，需要人工或 Agent 2 注入"
        INJECTIONS+=("{\"file\":\"$FILE\",\"status\":\"needs_injection\",\"existing_testid_count\":$TESTID_COUNT}")
    else
        INJECTIONS+=("{\"file\":\"$FILE\",\"status\":\"partial\",\"existing_testid_count\":$TESTID_COUNT}")
    fi
done

# 生成 injections 文件
echo "[" > "$INJECTIONS_FILE"
for i in "${!INJECTIONS[@]}"; do
    if [ $i -gt 0 ]; then echo "," >> "$INJECTIONS_FILE"; fi
    echo "${INJECTIONS[$i]}" >> "$INJECTIONS_FILE"
done
echo "]" >> "$INJECTIONS_FILE"

echo "[inject] 注入扫描完成！"
echo "[inject] 输出: $INJECTIONS_FILE"
echo "[inject] 下一步："
echo "  1. 使用 Agent 2 (Stage Manager) 分析每个组件，确定需要注入的具体元素"
echo "  2. 根据分析结果修改源代码，注入 data-testid 和 aria-label"
echo "  3. 运行 generate-locators.sh 生成 locator-catalog.json"
echo "  4. 运行 generate-poms.sh 生成 POM 类"