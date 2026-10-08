/**
 * Cypress TypeScript 预处理器（静态模板）
 *
 * esbuild 由 eve-backend 声明并安装，通过 KEVE_ESBUILD_MODULE 指向其入口，
 * 避免任务目录再生成配置文件或软链依赖。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuildEntry = process.env.KEVE_ESBUILD_MODULE;
if (!esbuildEntry) {
  throw new Error('缺少 KEVE_ESBUILD_MODULE，无法定位 esbuild 入口');
}
const esbuild = require(esbuildEntry);

export async function preprocess(file) {
  await esbuild.build({
    entryPoints: [file.filePath],
    outfile: file.outputPath,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome100',
    sourcemap: 'inline',
    logLevel: 'warning',
    // 任务目录位于 eve-backend/ 下，esbuild 会自动继承后端的 tsconfig.json，
    // 而那里开了 experimentalDecorators: true —— 会把 keveScene/keveModel 降级成
    // 旧式 (target, key, descriptor) 调用，但装饰器实现走的是 TC39 标准签名
    // (value, context)，运行期直接报 context.addInitializer is not a function。
    // 这里显式覆盖，保证与 suite 自身 tsconfig 的装饰器语义一致。
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: false,
        useDefineForClassFields: false,
      },
    },
    define: {
      'process.env.KEVE_ENV': JSON.stringify(process.env.KEVE_ENV || 'test'),
      'process.env.KEVE_CY_TEST_TIMEOUT': JSON.stringify(process.env.KEVE_CY_TEST_TIMEOUT || ''),
      'process.env.KEVE_TARGET_URL': JSON.stringify(process.env.KEVE_TARGET_URL || ''),
    },
  });
  return file.outputPath;
}
