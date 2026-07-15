/**
 * keve init - Initialize .keve/ directory and inject Skills
 *
 * Creates the .keve/ workspace, Playwright infrastructure,
 * and copies keve skills into .codeflicker/skills/.
 *
 * Note: keveAssert is exported directly from @kkeve/suite (import { keveAssert } from '@kkeve/suite')
 * — no file needs to be written to the project.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { generatePwConfig, type PwConfigOptions } from '../core/pw-config';

// Skills bundled in this package — copied to global ~/.codeflicker/skills/
const KEVE_SKILLS = [
  'keve-bddcase-gen',
  'keve-e2e-gen',
  'keve-test-eval',
  'keve-static-analysis',
  'keve-unit-gen',
  'keve-component-gen',
];

// Agents bundled in this package — copied to global ~/.codeflicker/agents/
const KEVE_AGENTS = [
  'keve-test-agent',
  'keve-dev-test-agent',
];

const KEVE_YAML_TEMPLATE = `# ━━━ 目录结构规范（Single Source of Truth）━━━━━━━━━━━━━━━━━
# 输入端 → keve_test_spec/（跨 MR 共享，项目长期资产，git tracked）
#   keve.yaml              ← 本文件（全局配置 + 目录约定）
#   keve-test.config.ts    ← Playwright 配置
#   vitest.config.ts       ← Vitest 配置
#   e2e/poms/              ← POM 类
#   e2e/locator-catalog.json ← 定位器目录
#   e2e/__test__/           ← E2E 测试脚本 *.spec.ts
#   component/models/       ← 组件行为模型 *.model.ts（场景+Props+断言，即组件 fixture）
#   component/__test__/     ← 组件测试脚本 *.test.ts（引用 model）
#   component/registry.json ← 组件注册表
#   component/coverage.yaml ← 组件测试覆盖索引
#   util/__test__/          ← 单元测试脚本 *.test.ts
# 输出端 → .keve/（执行产物，gitignored）
#   coverage/              ← vitest --coverage 报告（HTML/JSON）
#   analysis-report.yaml    ← 静态分析结果
#   analysis-report.html    ← 静态分析可视化报告
#   test-plan.yaml          ← 全流程进度追踪
# MR 级模块 → .keve/{branch}/
#   test-cases.yaml        ← BDD 用例定义
#   test-artifacts/        ← E2E 执行产物（round-N/, latest/, confidence-data.jsonl）
# {MR_ID} 替换规则：KEVE_TASK_DIR=.keve/MR123 或默认 .keve/current
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

project:
  name: ''              # 项目名称

state:
  current_round: 0
  # last_run_at: auto

llm:
  model: app-xxx
  base_url: https://xxx
  # api_key: from env KEVE_LLM_API_KEY

keveAPI: https://xxx
openAPI: https://xxx

execution:
  timeout_ms: 1200000
  retries: 0
  reporter: json
  screenshot: only-on-failure
`;

const VITEST_CONFIG_TEMPLATE = `import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import * as path from 'node:path';

const projectRoot = path.resolve(__dirname, '..');

// Shared resolve config — applied to all projects
const sharedResolve = {
  alias: {
    '@': path.resolve(projectRoot, 'src'),
    '@/keve_test_spec': path.resolve(projectRoot, 'keve_test_spec'),
  },
};

export default defineConfig({
  plugins: [vue()],
  resolve: sharedResolve,
  test: {
    // Multi-project: unit (node) + component (jsdom)
    projects: [
      {
        resolve: sharedResolve,
        plugins: [vue()],
        test: {
          name: 'unit',
          environment: 'node',
          include: ['keve_test_spec/util/__test__/**/*.test.ts'],
        },
      },
      {
        resolve: sharedResolve,
        plugins: [vue()],
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['keve_test_spec/component/__test__/**/*.test.ts'],
          setupFiles: [],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['json', 'text', 'html'],
      reportsDirectory: path.join(projectRoot, '.keve', 'coverage'),
      include: ['src/utils/**', 'src/hooks/**', 'src/composables/**', 'src/components/**'],
    },
  },
});
`;

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export interface InitOptions {
  force?: boolean;
  cdp?: boolean;
  baseUrl?: string;
}

export async function init(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const keveDir = path.join(cwd, '.keve');

  console.log(chalk.cyan('\n🔧 keve init\n'));

  // Check if .keve already exists
  if (fs.existsSync(keveDir) && !options.force) {
    console.log(chalk.yellow('  ⚠ .keve/ already exists. Use --force to overwrite.'));
    console.log(chalk.gray('    Existing config preserved.'));
  }

  // Create directories — shared modules in project root, MR-specific under .keve/
  const dirs = [
    keveDir,
    // Shared: keve_test_spec/ (cross-MR, long-term assets)
    path.join(cwd, 'keve_test_spec'),
    // E2E
    path.join(cwd, 'keve_test_spec', 'e2e', 'poms'),
    path.join(cwd, 'keve_test_spec', 'e2e', '__test__'),
    // Component
    path.join(cwd, 'keve_test_spec', 'component', 'models'),
    path.join(cwd, 'keve_test_spec', 'component', '__test__'),
    // Unit
    path.join(cwd, 'keve_test_spec', 'util', '__test__'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(chalk.gray(`  Created: ${path.relative(cwd, dir)}`));
    } else {
      console.log(chalk.gray(`  Exists:  ${path.relative(cwd, dir)}`));
    }
  }

  // Copy keve skills into global ~/.codeflicker/skills/
  // Skills live in <package-root>/doc/skills/ (sibling of dist/)
  // __dirname points to dist/commands/, so go up 2 levels to package root
  const packageRoot = path.resolve(
    __dirname,
    '..',
    '..'
  );
  const skillsSourceDir = path.join(packageRoot, 'doc/skills');
  const skillsTargetDir = path.join(cwd, '.codeflicker', 'skills');

  for (const skillName of KEVE_SKILLS) {
    const srcDir = path.join(skillsSourceDir, skillName);
    const destDir = path.join(skillsTargetDir, skillName);

    if (!fs.existsSync(srcDir)) {
      console.log(chalk.yellow(`  ⚠ Skill source not found: ${skillName} (skipping)`));
      continue;
    }

    // Copy entire skill directory recursively
    copyDirRecursive(srcDir, destDir);
    console.log(chalk.green(`  ✓ Installed Skill: ${skillName}`));
  }

  // Copy keve agents into global ~/.codeflicker/agents/
  const agentsSourceDir = path.join(packageRoot, 'doc/agents');
  const agentsTargetDir = path.join(os.homedir(), '.codeflicker', 'agents');

  for (const agentName of KEVE_AGENTS) {
    const srcFile = path.join(agentsSourceDir, `${agentName}.md`);
    const destFile = path.join(agentsTargetDir, `${agentName}.md`);

    if (!fs.existsSync(srcFile)) {
      console.log(chalk.yellow(`  ⚠ Agent source not found: ${agentName} (skipping)`));
      continue;
    }

    fs.mkdirSync(agentsTargetDir, { recursive: true });
    fs.copyFileSync(srcFile, destFile);
    console.log(chalk.green(`  ✓ Installed Agent: ${agentName}`));
  }

  // Write keve.yaml(with directory spec comments)
  const keveYamlPath = path.join(cwd, 'keve_test_spec', 'keve.yaml');
  if (!fs.existsSync(keveYamlPath) || options.force) {
    fs.writeFileSync(keveYamlPath, KEVE_YAML_TEMPLATE, 'utf-8');
    console.log(chalk.green('  ✓ Created keve.yaml (with directory spec)'));
  } else {
    console.log(chalk.gray('  Exists:  keve.yaml (preserved)'));
  }

  // Write Playwright config
  const pwConfigPath = path.join(cwd, 'keve_test_spec', 'keve-test.config.ts');
  const pwOptions: PwConfigOptions = {
    baseUrl: options.baseUrl || process.env.BASE_URL || process.env.PWGEN_TARGET_URL,
    cdp: options.cdp,
    webServer: !options.cdp,
  };
  if (!fs.existsSync(pwConfigPath) || options.force) {
    fs.writeFileSync(pwConfigPath, generatePwConfig(pwOptions), 'utf-8');
    console.log(chalk.green('  ✓ Created keve-test.config.ts'));
    console.log(chalk.gray(`    baseURL: ${pwOptions.baseUrl || '(from env)'}`));
    console.log(chalk.gray(`    CDP:     ${pwOptions.cdp ? 'enabled' : 'disabled'}`));
  } else {
    const existingContent = fs.readFileSync(pwConfigPath, 'utf-8');
    if (!existingContent.includes('keve-report') && !existingContent.includes('KeveReporter')) {
      console.log(chalk.yellow('  ⚠ keve-test.config.ts exists but missing KeveReporter'));
      console.log(chalk.gray('    Run: keve config --force  to regenerate'));
    } else {
      console.log(chalk.gray('  Exists:  keve-test.config.ts (preserved)'));
    }
  }

  // Write Vitest config
  const vitestConfigPath = path.join(cwd, 'keve_test_spec', 'vitest.config.ts');
  if (!fs.existsSync(vitestConfigPath) || options.force) {
    fs.writeFileSync(vitestConfigPath, VITEST_CONFIG_TEMPLATE, 'utf-8');
    console.log(chalk.green('  ✓ Created vitest.config.ts'));
  } else {
    console.log(chalk.gray('  Exists:  vitest.config.ts (preserved)'));
  }

  // Note: keveAssert is exported from @kkeve/suite directly
  // No file needs to be written — users import it:
  //   import { keveAssert } from '@kkeve/suite';
  console.log(chalk.gray('  ⓘ keveAssert available via: import { keveAssert } from "@kkeve/suite"'));

  console.log(chalk.green('\n  ✓ keve init complete'));
  console.log(chalk.gray('\n  Next steps:'));
  console.log(chalk.gray('    1. keve dev-test    — 静态分析 + 单测 + 组件测试（开发阶段）'));
  console.log(chalk.gray('    2. keve bddcase     — 生成 BDD 测试用例'));
  console.log(chalk.gray('    3. keve e2e-gen     — 生成 Playwright E2E 脚本'));
  console.log(chalk.gray('    4. keve run         — 执行 E2E + 评估 + 报告'));
  console.log(chalk.gray('    5. npx playwright install  — 安装 Playwright 浏览器（首次）\n'));
}
