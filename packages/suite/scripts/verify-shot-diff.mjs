/**
 * verify-shot-diff — 截图基线对比核心逻辑验证（零浏览器、零外部依赖）
 *
 * 前置：EVE/packages/suite 已构建（npm run build，产物 dist/core/*.js）。
 * 运行：cd EVE/packages/suite && node scripts/verify-shot-diff.mjs
 *
 * 覆盖（对齐设计方案 §3 判定语义）：
 *   1. pngCodec 编解码往返（RGB/RGBA）
 *   2. 解码器对 PNG 全部 4 种行滤波（Sub/Up/Average/Paeth）的正确性
 *      —— Playwright 截图会用任意滤波，必须都能解
 *   3. 基线生命周期：无基线 → baseline_required（候选基线，不判通过）→ 模拟审核转正
 *      → 二跑 identical → matched；未审核再跑仍 baseline_required（候选门控 / A06）
 *   4. 超阈值 → 抛 ScreenshotDiffError（exceeded），差异区块/差异图/meta 齐全
 *   5. 掩码生效：把差异区写进 meta.masks → matched（动态区域治理闭环）
 *   6. 视口变化：同 key 其它视口基线存在 → size_mismatch（不自举新基线 / A20）
 *   7. goal 捕获缓冲：begin → record → drain 语义
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

// ── 隔离环境：基线/产物写进临时目录，绝不污染真实 baselines ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keve-shotdiff-verify-'));
process.env.KEVE_BASELINE_DIR = path.join(tmp, 'baselines');
process.env.KEVE_TASK_DIR = path.join(tmp, 'task');
delete process.env.KEVE_ENV; // 默认 test
process.env.KEVE_SHOT_DIFF_THRESHOLD = '1.0';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist/core');
let decodePng, encodePng, screenshotDiff;
try {
    ({ decodePng, encodePng } = await import(`${dist}/pngCodec.js`));
    screenshotDiff = await import(`${dist}/screenshotDiff.js`);
} catch (err) {
    console.error('✗ 无法加载 dist 产物 —— 请先构建：cd EVE/packages/suite && npm run build');
    console.error(`  (${err.message})`);
    process.exit(2);
}

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ── 造图工具 ──

const W = 96, H = 64;
function fillImage(w, h, fn) {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const [r, g, b, a = 255] = fn(x, y);
        const i = (y * w + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
    return data;
}
const solid = (r, g, b) => fillImage(W, H, () => [r, g, b]);
function withSquare(base, x0, y0, size, [r, g, b]) {
    const out = Uint8Array.from(base);
    for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) {
        const i = (y * W + x) * 4;
        out[i] = r; out[i + 1] = g; out[i + 2] = b;
    }
    return out;
}

// ── 手工组 PNG（验证解码器对滤波 1-4 的支持；encodePng 只产滤波 0） ──

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
}
/** raw RGBA + 每行滤波类型 → 合法 PNG Buffer（colorType 6, 8bit） */
function craftPng(w, h, raw, filters) {
    const bpp = 4, stride = w * bpp;
    const body = Buffer.alloc((stride + 1) * h);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
        const f = filters[y % filters.length];
        body[y * (stride + 1)] = f;
        for (let i = 0; i < stride; i++) {
            const x = raw[y * stride + i];
            const a = i >= bpp ? raw[y * stride + i - bpp] : 0;
            const b = prev[i];
            const c = i >= bpp ? prev[i - bpp] : 0;
            let v;
            if (f === 0) v = x;
            else if (f === 1) v = x - a;
            else if (f === 2) v = x - b;
            else if (f === 3) v = x - ((a + b) >> 1);
            else v = x - paeth(a, b, c);
            body[y * (stride + 1) + 1 + i] = v & 0xff;
        }
        prev = raw.slice(y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(body)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ═══ 1. 编解码往返 ═══
console.log('\n[1] pngCodec 往返');
{
    const img = solid(200, 30, 90);
    const dec = decodePng(encodePng(W, H, img));
    ok('RGBA 往返像素一致', Buffer.compare(Buffer.from(dec.data), Buffer.from(img)) === 0);
    const rgb = fillImage(W, H, (x) => [x & 0xff, (x * 3) & 0xff, 7]); // 非纯色
    const dec2 = decodePng(encodePng(W, H, rgb));
    ok('非纯色往返像素一致', Buffer.compare(Buffer.from(dec2.data), Buffer.from(rgb)) === 0);
    let threw = false;
    try { decodePng(Buffer.from('not a png')); } catch { threw = true; }
    ok('非 PNG 输入抛错', threw);
}

// ═══ 2. 滤波 1-4 解码 ═══
console.log('\n[2] 解码器滤波支持（Playwright 截图会用任意滤波）');
{
    const raw = fillImage(W, H, (x, y) => [(x * 2) & 0xff, (y * 3) & 0xff, (x + y) & 0xff]);
    const filters = [1, 2, 3, 4]; // Sub / Up / Average / Paeth 逐行轮换
    const dec = decodePng(craftPng(W, H, raw, filters));
    ok('滤波 1-4 混合解码像素一致', Buffer.compare(Buffer.from(dec.data), Buffer.from(raw)) === 0);
}

// ═══ 3-5. 基线生命周期 ═══
const { createBaseline, compareWithBaseline, ScreenshotDiffError, beginGoalShotDiffCapture, drainGoalShotDiff, resolveBaselinePaths } = screenshotDiff;
const KEY = 'step-24497';
const baselinePng = () => encodePng(W, H, solid(200, 30, 90));
const samePng = () => encodePng(W, H, solid(200, 30, 90));

console.log('\n[3] 首跑：无基线 → baseline_required（候选基线落盘，不判通过）');
let created;
{
    beginGoalShotDiffCapture();
    created = createBaseline(KEY, baselinePng());
    ok('status=baseline_required', created.status === 'baseline_required', `实际 ${created.status}`);
    ok('diffRatio=null（无差异率可言）', created.diffRatio === null, `实际 ${created.diffRatio}`);
    ok('基线文件已写盘', fs.existsSync(created.baselinePath));
    const meta = JSON.parse(fs.readFileSync(created.baselinePath.replace(/\.png$/, '.json'), 'utf-8'));
    ok('meta：v1 / candidate / first-run', meta.version === 1 && meta.state === 'candidate' && meta.sourceType === 'first-run');
    const paths = resolveBaselinePaths(KEY, W, H);
    ok('key+env+viewport 进基线文件名', paths.pngPath.endsWith(`step-24497.test.${W}x${H}.png`));
}

console.log('\n[4] 候选门控：未审核再跑 → 仍 baseline_required（不比对不判过 / A06）');
{
    const r = compareWithBaseline(KEY, samePng());
    ok('status=baseline_required', r.status === 'baseline_required', `实际 ${r.status}`);
    ok('diffRatio=null', r.diffRatio === null, `实际 ${r.diffRatio}`);
    ok('基线版本未推进（v1）', r.baselineVersion === 1, `实际 v${r.baselineVersion}`);
}

console.log('\n[5] 模拟基线审核转正（meta.state candidate → active）');
{
    const metaPath = resolveBaselinePaths(KEY, W, H).metaPath;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.state = 'active';
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    ok('meta.state 已置为 active', true);
}

console.log('\n[6] 转正后二跑 identical → matched');
{
    beginGoalShotDiffCapture();
    const r = compareWithBaseline(KEY, samePng());
    ok('status=matched', r.status === 'matched');
    ok('message 含差异率与阈值', /差异率.*阈值/.test(r.message));
    ok('基线状态 active', r.baselineState === 'active', `实际 ${r.baselineState}`);
    const drained = drainGoalShotDiff();
    ok('goal 缓冲收集到 1 条', drained.length === 1 && drained[0].status === 'matched');
}

console.log('\n[7] 超阈值 → ScreenshotDiffError（确定性 fail）');
let diffResult;
{
    const changed = encodePng(W, H, withSquare(solid(200, 30, 90), 8, 8, 24, [20, 90, 230]));
    beginGoalShotDiffCapture();
    let threw = false;
    try { compareWithBaseline(KEY, changed); } catch (e) {
        threw = e instanceof ScreenshotDiffError;
        diffResult = e.shotDiff;
    }
    ok('抛 ScreenshotDiffError', threw);
    ok('status=exceeded 且携带差异结果', diffResult?.status === 'exceeded');
    ok('差异区块 ≥1 且坐标在图内', (diffResult?.regions?.length ?? 0) >= 1
        && diffResult.regions.every(rg => rg.x >= 0 && rg.y >= 0 && rg.x + rg.w <= W && rg.y + rg.h <= H));
    ok('差异图已落盘', diffResult?.diffPath && fs.existsSync(diffResult.diffPath) && diffResult.diffPath !== diffResult.actualPath);
    ok('diffRatio 在 (1, 100] 区间', diffResult?.diffRatio > 1 && diffResult.diffRatio <= 100);
    const drained = drainGoalShotDiff();
    ok('异常路径下 goal 缓冲仍收集到', drained.length === 1 && drained[0].status === 'exceeded');
}

console.log('\n[8] 掩码生效：差异区写进 meta.masks → matched');
{
    // 把 [5] 的主差异区写回 meta（模拟「忽略此区域」闭环）
    const metaPath = resolveBaselinePaths(KEY, W, H).metaPath;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const rg = diffResult.regions[0];
    meta.masks = [{ x: rg.x, y: rg.y, w: rg.w, h: rg.h }];
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const changed = encodePng(W, H, withSquare(solid(200, 30, 90), 8, 8, 24, [20, 90, 230]));
    const r = compareWithBaseline(KEY, changed);
    ok('掩码覆盖差异区后 matched', r.status === 'matched', `实际 status=${r.status} ratio=${r.diffRatio}`);
}

console.log('\n[9] 视口变化：同 key 其它视口基线存在 → size_mismatch（不自举，杜绝掩盖变化 / A20）');
{
    const other = encodePng(W, H + 16, fillImage(W, H + 16, () => [200, 30, 90]));
    beginGoalShotDiffCapture();
    const r = compareWithBaseline(KEY, other);
    ok('不同视口 → size_mismatch', r.status === 'size_mismatch', `实际 ${r.status}`);
    ok('diffRatio=null（无差异率可言）', r.diffRatio === null, `实际 ${r.diffRatio}`);
    ok('未自举新视口基线（96x80 文件不存在）', !fs.existsSync(resolveBaselinePaths(KEY, W, H + 16).pngPath));
    const drained = drainGoalShotDiff();
    ok('goal 缓冲收集到 size_mismatch', drained.length === 1 && drained[0].status === 'size_mismatch');
    // 原视口基线不受影响：同尺寸二跑仍 matched
    const r2 = compareWithBaseline(KEY, samePng());
    ok('原视口基线不受污染（仍 matched）', r2.status === 'matched');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
console.log(`（临时目录：${tmp}，验证后保留供人工查看）`);
process.exit(failed ? 1 : 0);
