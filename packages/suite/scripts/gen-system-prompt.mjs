/**
 * 把 page-agent 的 system_prompt.md 编译成浏览器安全的 TS 模块。
 *
 * 为什么需要：Cypress 引擎会把 page-agent 打进浏览器 bundle，运行时用
 * `node:fs` 读 md 文件会让 esbuild 直接失败。这里在构建期把文本内联为
 * 一个普通字符串常量，两个引擎共用同一份 prompt，避免出现两套文案漂移。
 *
 * 用法：node scripts/gen-system-prompt.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'page-agent', 'system_prompt.md');
const out = path.join(here, '..', 'src', 'page-agent', 'system-prompt.ts');

const text = fs.readFileSync(src, 'utf8');

fs.writeFileSync(
  out,
  `/**
 * system-prompt — 由 scripts/gen-system-prompt.mjs 从 system_prompt.md 生成，请勿手改。
 *
 * 生成物是纯字符串常量，不含任何 Node 运行时依赖，因此可以被 Cypress 的浏览器
 * bundle 安全地打包。修改 prompt 请改 system_prompt.md 后重新生成本文件。
 */

export const SYSTEM_PROMPT: string = ${JSON.stringify(text)};
`,
  'utf8',
);

console.log(
  `[gen-system-prompt] ${path.relative(process.cwd(), src)} → ${path.relative(process.cwd(), out)} (${text.length} chars)`,
);
