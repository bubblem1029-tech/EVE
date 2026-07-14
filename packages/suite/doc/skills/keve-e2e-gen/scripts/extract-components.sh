#!/bin/bash
# extract-components.sh — 从源代码自动扫描并提取组件注册表
#
# 自动扫描 src/ 目录下的 Vue/React 组件文件，提取组件名称和文件路径，
# 生成 component-registry.json 供后续 Agent 使用。
#
# 使用方式：
#   bash scripts/extract-components.sh [项目根目录路径]
#
# 输出: .keve/component-registry.json

set -e

PROJECT_ROOT="${1:-.}"
OUTPUT_DIR="${PROJECT_ROOT}/.keve"
mkdir -p "$OUTPUT_DIR"

echo "[extract] 正在扫描项目源码提取组件..."

# 自动扫描 src/ 下的 .vue / .tsx 组件文件，生成组件注册表
node -e "
const fs = require('fs');
const path = require('path');

const projectRoot = '$PROJECT_ROOT';
const srcDir = path.join(projectRoot, 'src');

if (!fs.existsSync(srcDir)) {
  console.error('[extract] src/ 目录不存在，请确认项目结构');
  process.exit(1);
}

// 扫描所有 .vue 和 .tsx 文件
const components = [];
const extensions = ['.vue', '.tsx'];

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过 node_modules、test、__tests__、mock 等目录
      if (['node_modules', 'test', '__tests__', '__test__', 'mock', 'mocks', 'stories'].includes(entry.name)) continue;
      scanDir(fullPath);
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      // 跳过测试文件和 Storybook 文件
      if (entry.name.includes('.test.') || entry.name.includes('.spec.') || entry.name.includes('.stories.')) continue;

      const filePath = path.relative(projectRoot, fullPath);
      // 从文件名推断组件名（去掉扩展名）
      let componentName = entry.name.replace(/\.vue$|\.tsx$/, '');
      // 处理 index 文件 — 用父目录名作为组件名
      if (componentName === 'index') {
        componentName = path.basename(dir);
      }

      components.push({
        name: componentName,
        filePath: filePath,
      });
    }
  }
}

scanDir(srcDir);

// 排序：按文件路径排列，便于阅读
components.sort((a, b) => a.filePath.localeCompare(b.filePath));

const registry = {
  components,
  metadata: {
    project: path.basename(projectRoot),
    totalComponents: components.length,
    extractedAt: new Date().toISOString(),
  }
};

const outputPath = path.join('$OUTPUT_DIR', 'component-registry.json');
fs.writeFileSync(outputPath, JSON.stringify(registry, null, 2));
console.log('[extract] 找到 ' + components.length + ' 个组件');
console.log('[extract] 组件注册表已生成: ' + outputPath);
console.log('[extract] 下一步: 运行 inject-testids.sh 进行打标注入');
"