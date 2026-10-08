/**
 * screenshotDiff — 截图基线对比（平台「截图基线」断言的引擎侧实现）
 *
 * 判定语义（对齐《keve 统一用例工作台与场景插件完整方案》§2 视觉优先修正 + §9.5 首跑闭环）：
 *   无基线            → status 'baseline_required'：保存候选基线（state=candidate），
 *                        首跑**不算通过**，差异率为 null，需人工审核转正后再次运行才做正式比对
 *   表里已有候选      → status 'baseline_required'：未审核候选不得作为正式有效基线，
 *                        不做像素比对、不判 matched/exceeded（差异率 null）
 *   截图尺寸变化      → status 'size_mismatch'：不得因 viewport 变化自动重新自举来掩盖变化；
 *                        按原 key+env 定位既有基线并明确报告尺寸差异
 *   diffRatio ≤ 阈值  → status 'matched'：静默通过，仅记录证据（仅对 state=active 的基线）
 *   diffRatio > 阈值  → status 'exceeded'：抛 ScreenshotDiffError（确定性事实，AI 不可翻案；
 *                        keveGoal 对该错误短路跳过 Agent Re-Act —— diff 不是探索能修复的）
 *
 * 基线存储：<KEVE_BASELINE_DIR|cwd/baselines>/{key}.{env}.{w}x{h}.png + .meta.json
 *   meta: { version, state: 'candidate'|'active', sourceType, threshold, masks, updatedAt }
 *   key 建议沿用老平台基线 id（如 step-24497），可回溯迁移来源。
 *
 * 证据产物：actual 截图与 diff 热区图落盘 test-artifacts，路径写入结果，
 * 由 keveGoalResult attachment 流到平台 stepsDetail 回收（evidence.screenshotDiff）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodePng, encodePng, type RawImage } from './pngCodec.js';

// ─── Types ─────────────────────────────────────────────────────────

export interface ShotDiffRect { x: number; y: number; w: number; h: number; }

export interface ShotDiffRegion extends ShotDiffRect {
    /** 区块内差异像素占区块像素比例（%） */
    ratio: number;
}

export interface ShotDiffResult {
    key: string;
    /** matched=比对一致（active 基线）｜exceeded=超阈值（抛错）｜baseline_required=无基线/候选未审核（不算通过）｜size_mismatch=尺寸变化不自举 */
    status: 'matched' | 'exceeded' | 'baseline_required' | 'size_mismatch';
    /** 差异率（%，全图像素口径）；baseline_required / size_mismatch 时为 null（不是 0） */
    diffRatio: number | null;
    threshold: number;
    baselineVersion: number;
    baselineState?: 'candidate' | 'active';
    baselinePath: string;
    /** 当前实际截图（绝对路径） */
    actualPath: string;
    /** 差异热区图（绝对路径，status=created 时与 actualPath 相同） */
    diffPath: string;
    env: string;
    viewport: string;
    regions: ShotDiffRegion[];
    /** 供报告/AI 复核的一句话结论 */
    message: string;
    comparedAt: string;
}

export interface ExpectScreenshotOptions {
    /** 差异率阈值（%），缺省取 KEVE_SHOT_DIFF_THRESHOLD（默认 1.0） */
    threshold?: number;
    /** 全页截图（默认视口截图） */
    fullPage?: boolean;
    /** 临时掩码（本次生效；持久掩码在基线 meta.masks） */
    mask?: ShotDiffRect[];
}

/** 超阈值错误：携带完整对比结果，keveGoal 据此短路并透传 attachment */
export class ScreenshotDiffError extends Error {
    shotDiff: ShotDiffResult;
    constructor(result: ShotDiffResult) {
        super(result.message);
        this.name = 'ScreenshotDiffError';
        this.shotDiff = result;
    }
}

// ─── Env / Path ────────────────────────────────────────────────────

const ENV = (['online', 'pre', 'rc', 'test'].includes(process.env.KEVE_ENV || '') ? process.env.KEVE_ENV : 'test') as string;

function taskDir(): string {
    return path.resolve(process.env.KEVE_TASK_DIR || '.keve');
}

export function baselineDir(): string {
    return process.env.KEVE_BASELINE_DIR || path.join(process.cwd(), 'baselines');
}

function sanitizeKey(key: string): string {
    // 保留 - 和 .：老平台基线 id 形如 step-24497，需原样保留以回溯来源
    return String(key || 'shot').replace(/[^a-zA-Z0-9一-鿿.-]/g, '_').slice(0, 60);
}

export interface BaselinePaths {
    pngPath: string;
    metaPath: string;
    env: string;
    viewport: string;
    width: number;
    height: number;
}

/** 基线路径 = {safeKey}.{env}.{w}x{h} —— env×viewport 进 key，避免跨环境/跨视口假差异 */
export function resolveBaselinePaths(key: string, width: number, height: number): BaselinePaths {
    const safe = sanitizeKey(key);
    const viewport = `${width}x${height}`;
    const base = path.join(baselineDir(), `${safe}.${ENV}.${viewport}`);
    return { pngPath: `${base}.png`, metaPath: `${base}.json`, env: ENV, viewport, width, height };
}

/**
 * 按 key+env 查找已存在基线（任意视口）。
 * 命中表示「该目标曾建档」——此时若精确视口不存在，属于**截图尺寸变化**，
 * 不允许重新自举成新候选来掩盖变化（方案 §9.4 / A20）。
 */
export function findBaselineByKeyEnv(key: string, preferWidth?: number, preferHeight?: number): BaselinePaths | null {
    const safe = sanitizeKey(key);
    const prefix = `${safe}.${ENV}.`;
    const dir = baselineDir();
    if (!fs.existsSync(dir)) return null;
    let candidates: string[] = [];
    try { candidates = fs.readdirSync(dir).filter((f: string) => f.startsWith(prefix) && f.endsWith('.png')); } catch { return null; }
    if (candidates.length === 0) return null;
    const exact = preferWidth && preferHeight
        ? candidates.find((f: string) => f === `${prefix}${preferWidth}x${preferHeight}.png`)
        : undefined;
    const file = exact || candidates.sort().pop()!; // 无精确视口 → 取任一既有基线（尺寸变化分支用）
    const base = path.join(dir, file.replace(/\.png$/, ''));
    const viewport = file.slice(prefix.length, -4);
    const [w, h] = viewport.split('x').map((x: string) => Number(x));
    return { pngPath: `${base}.png`, metaPath: `${base}.json`, env: ENV, viewport, width: w || 0, height: h || 0 };
}

// ─── Baseline meta ─────────────────────────────────────────────────

export interface BaselineMeta {
    version: number;
    state: 'candidate' | 'active';
    sourceType?: 'first-run' | 'imported' | 'manual';
    sourceUrl?: string;
    threshold: number;
    masks: ShotDiffRect[];
    updatedAt: string;
}

function readMeta(p: string): BaselineMeta | null {
    try {
        const m = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (m && typeof m.version === 'number') return { masks: [], threshold: 1, ...m };
    } catch { /* 无 meta 或损坏 → 视为无 meta */ }
    return null;
}

function writeMeta(p: string, meta: BaselineMeta): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(meta, null, 2));
}

// ─── Pixel compare ─────────────────────────────────────────────────

/** 像素容差（单通道最大差值），容忍抗锯齿/渲染抖动 */
const PIXEL_TOLERANCE = Number(process.env.KEVE_SHOT_DIFF_PIXEL_TOLERANCE ?? 24);
/** 差异区块聚类的网格边长（px） */
const REGION_BLOCK = 16;
/** 最多返回的差异区块数（超出部分合并提示） */
const MAX_REGIONS = 8;

interface CompareOutput {
    diffMask: Uint8Array;
    diffPixels: number;
    totalPixels: number;
    regions: ShotDiffRegion[];
    overlapWidth: number;
    overlapHeight: number;
}

function pixelMask(baseline: RawImage, actual: RawImage, masks: ShotDiffRect[]): boolean[] {
    const w = Math.min(baseline.width, actual.width);
    const h = Math.min(baseline.height, actual.height);
    const masked = new Array<boolean>(w * h).fill(false);
    for (const m of masks || []) {
        const x0 = Math.max(0, Math.floor(m.x)), y0 = Math.max(0, Math.floor(m.y));
        const x1 = Math.min(w, Math.ceil(m.x + m.w)), y1 = Math.min(h, Math.ceil(m.y + m.h));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) masked[y * w + x] = true;
    }
    return masked;
}

function comparePixels(baseline: RawImage, actual: RawImage, masks: ShotDiffRect[]): CompareOutput {
    const w = Math.min(baseline.width, actual.width);
    const h = Math.min(baseline.height, actual.height);
    const masked = pixelMask(baseline, actual, masks);
    const diffMask = new Uint8Array(w * h);
    let diffPixels = 0;
    const bd = baseline.data, ad = actual.data;
    const bStride = baseline.width * 4, aStride = actual.width * 4;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            if (masked[idx]) continue;
            const bi = y * bStride + x * 4, ai = y * aStride + x * 4;
            const dr = Math.abs(bd[bi] - ad[ai]);
            const dg = Math.abs(bd[bi + 1] - ad[ai + 1]);
            const db = Math.abs(bd[bi + 2] - ad[ai + 2]);
            if (Math.max(dr, dg, db) > PIXEL_TOLERANCE) {
                diffMask[idx] = 1;
                diffPixels++;
            }
        }
    }
    // 差异区块聚类：16px 网格 → 相邻块 BFS 合并
    const gx = Math.ceil(w / REGION_BLOCK), gy = Math.ceil(h / REGION_BLOCK);
    const blockCount = new Int32Array(gx * gy);
    for (let y = 0; y < h; y++) {
        const by = (y / REGION_BLOCK) | 0;
        for (let x = 0; x < w; x++) {
            if (diffMask[y * w + x]) blockCount[by * gx + ((x / REGION_BLOCK) | 0)]++;
        }
    }
    const visited = new Uint8Array(gx * gy);
    const regions: ShotDiffRegion[] = [];
    const blockTotal = REGION_BLOCK * REGION_BLOCK;
    for (let start = 0; start < gx * gy; start++) {
        if (visited[start] || blockCount[start] === 0) continue;
        // BFS
        const queue = [start];
        visited[start] = 1;
        let minX = gx, minY = gy, maxX = -1, maxY = -1, pixels = 0;
        while (queue.length) {
            const cur = queue.pop()!;
            const bx = cur % gx, by = (cur / gx) | 0;
            minX = Math.min(minX, bx); maxX = Math.max(maxX, bx);
            minY = Math.min(minY, by); maxY = Math.max(maxY, by);
            pixels += blockCount[cur];
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                const nx = bx + dx, ny = by + dy;
                if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) continue;
                const ni = ny * gx + nx;
                if (visited[ni] || blockCount[ni] === 0) continue;
                visited[ni] = 1;
                queue.push(ni);
            }
        }
        const rx = minX * REGION_BLOCK, ry = minY * REGION_BLOCK;
        const rw = Math.min(w, (maxX + 1) * REGION_BLOCK) - rx;
        const rh = Math.min(h, (maxY + 1) * REGION_BLOCK) - ry;
        regions.push({ x: rx, y: ry, w: rw, h: rh, ratio: Math.round((pixels / (rw * rh)) * 1000) / 10 });
    }
    regions.sort((a, b) => b.ratio - a.ratio);
    return { diffMask, diffPixels, totalPixels: w * h, regions, overlapWidth: w, overlapHeight: h };
}

/** 差异热区图：实际截图为底，非差异像素压暗 35%，差异像素标红 */
function renderDiffImage(baseline: RawImage, actual: RawImage, cmp: CompareOutput): Buffer {
    const { overlapWidth: w, overlapHeight: h, diffMask } = cmp;
    const out = new Uint8Array(w * h * 4);
    const aStride = actual.width * 4;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            const ai = y * aStride + x * 4;
            const o = idx * 4;
            if (diffMask[idx]) {
                out[o] = 233; out[o + 1] = 42; out[o + 2] = 27; out[o + 3] = 255; // #E92A1B
            } else {
                out[o] = (actual.data[ai] * 0.65) | 0;
                out[o + 1] = (actual.data[ai + 1] * 0.65) | 0;
                out[o + 2] = (actual.data[ai + 2] * 0.65) | 0;
                out[o + 3] = 255;
            }
        }
    }
    return encodePng(w, h, out);
}

// ─── Artifacts ─────────────────────────────────────────────────────

function artifactsDir(): string {
    // 优先与当前报告轮次同目录；缺失时回退旧布局，兼容历史执行环境。
    if (process.env.KEVE_RESULT_DIR) {
        return path.join(path.resolve(process.env.KEVE_RESULT_DIR), 'shotdiff');
    }
    const round = process.env.KEVE_ROUND || 'latest';
    return path.join(taskDir(), 'test-artifacts', `round-${round}`, 'shotdiff');
}

function saveArtifact(buf: Buffer, name: string): string {
    const dir = artifactsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}-${Date.now()}.png`);
    fs.writeFileSync(file, buf);
    return file;
}

// ─── Public API ────────────────────────────────────────────────────

function fmtPct(n: number): string {
    return `${Math.round(n * 100) / 100}%`;
}

/** 无基线：保存候选基线，返回 created（判 PASS） */
export function createBaseline(key: string, png: Buffer, opts?: { sourceUrl?: string; threshold?: number }): ShotDiffResult {
    // 视口尺寸从 PNG 头解析（decode 校验合法性）
    const img = decodePng(png);
    const paths = resolveBaselinePaths(key, img.width, img.height);
    fs.mkdirSync(baselineDir(), { recursive: true });
    fs.writeFileSync(paths.pngPath, png);
    const threshold = opts?.threshold ?? defaultThreshold();
    writeMeta(paths.metaPath, {
        version: 1,
        state: 'candidate',
        sourceType: opts?.sourceUrl ? 'imported' : 'first-run',
        sourceUrl: opts?.sourceUrl,
        threshold,
        masks: [],
        updatedAt: new Date().toISOString(),
    });
    const actualPath = saveArtifact(png, sanitizeKey(key));
    const result: ShotDiffResult = {
        key, status: 'baseline_required', diffRatio: null, threshold,
        baselineVersion: 1, baselineState: 'candidate',
        baselinePath: paths.pngPath, actualPath, diffPath: actualPath,
        env: paths.env, viewport: paths.viewport, regions: [],
        message: `基线不存在：已保存候选基线 v1（${paths.pngPath}）。首跑不判通过（差异率 null）——需到「基线审核」确认转正后再次运行完成正式比对。`,
        comparedAt: new Date().toISOString(),
    };
    recordShotDiff(result);
    return result;
}

function defaultThreshold(): number {
    const t = Number(process.env.KEVE_SHOT_DIFF_THRESHOLD);
    return Number.isFinite(t) && t >= 0 ? t : 1.0;
}

/** 候选未审核：不做像素比对，返回 baseline_required（差异率 null，不算通过） */
function candidatePendingResult(key: string, png: Buffer, paths: BaselinePaths, meta: BaselineMeta, opts?: { threshold?: number }): ShotDiffResult {
    const actualPath = saveArtifact(png, sanitizeKey(key));
    const result: ShotDiffResult = {
        key, status: 'baseline_required', diffRatio: null,
        threshold: opts?.threshold ?? meta.threshold ?? defaultThreshold(),
        baselineVersion: meta.version ?? 1, baselineState: 'candidate',
        baselinePath: paths.pngPath, actualPath, diffPath: actualPath,
        env: paths.env, viewport: paths.viewport, regions: [],
        message: `候选基线 v${meta.version ?? 1}（${paths.pngPath}）尚未审核，本次执行不比对、不判通过（差异率 null）。请到「基线审核」确认转正后再次运行。`,
        comparedAt: new Date().toISOString(),
    };
    recordShotDiff(result);
    return result;
}

/** 尺寸变化：同 key+env 已存在其它视口基线 → 不自动自举（A20，防止掩盖变化） */
function sizeMismatchResult(key: string, png: Buffer, paths: BaselinePaths, sibling: BaselinePaths): ShotDiffResult {
    const actualPath = saveArtifact(png, sanitizeKey(key));
    const sMeta = readMeta(sibling.metaPath);
    const result: ShotDiffResult = {
        key, status: 'size_mismatch', diffRatio: null,
        threshold: sMeta?.threshold ?? defaultThreshold(),
        baselineVersion: sMeta?.version ?? 1, baselineState: sMeta?.state,
        baselinePath: sibling.pngPath, actualPath, diffPath: actualPath,
        env: paths.env, viewport: paths.viewport, regions: [],
        message: `截图尺寸变化：当前 ${paths.width}x${paths.height}，既有基线为 ${sibling.viewport}（${sibling.pngPath}）。尺寸变化不自动重建基线，请核对目标或按新尺寸显式重建。`,
        comparedAt: new Date().toISOString(),
    };
    recordShotDiff(result);
    return result;
}

/**
 * 有基线：像素对比 → matched（≤阈值，pass）/ exceeded（>阈值，抛 ScreenshotDiffError）。
 * 尺寸不一致按重叠区对比并在 message 中注明（视口不变的常规场景不受影响）。
 */
export function compareWithBaseline(key: string, png: Buffer, opts?: { threshold?: number; mask?: ShotDiffRect[] }): ShotDiffResult {
    const actualImg = decodePng(png);
    const paths = resolveBaselinePaths(key, actualImg.width, actualImg.height);
    if (!fs.existsSync(paths.pngPath)) {
        // 尺寸变化（同 key+env 已有其它视口基线）→ 不自动自举成新候选掩盖差异
        const sibling = findBaselineByKeyEnv(key, actualImg.width, actualImg.height);
        if (sibling) return sizeMismatchResult(key, png, paths, sibling);
        // 真·首跑：保存候选基线，不算通过（差异率 null）
        return createBaseline(key, png, { threshold: opts?.threshold });
    }
    const baselineImg = decodePng(fs.readFileSync(paths.pngPath));
    const meta = readMeta(paths.metaPath);
    // 未审核候选不得作为正式有效基线：不做像素比对、不判 matched/exceeded（§2 / §9.5）
    if (meta && meta.state === 'candidate') return candidatePendingResult(key, png, paths, meta, opts);
    const threshold = opts?.threshold ?? meta?.threshold ?? defaultThreshold();
    const masks = [...(meta?.masks || []), ...(opts?.mask || [])];

    const sizeMismatch = baselineImg.width !== actualImg.width || baselineImg.height !== actualImg.height;
    const cmp = comparePixels(baselineImg, actualImg, masks);
    const diffRatio = cmp.totalPixels > 0 ? (cmp.diffPixels / cmp.totalPixels) * 100 : 0;

    const actualPath = saveArtifact(png, sanitizeKey(key));
    const diffPath = cmp.diffPixels > 0
        ? saveArtifact(renderDiffImage(baselineImg, actualImg, cmp), `${sanitizeKey(key)}-diff`)
        : actualPath;

    const baseNote = sizeMismatch
        ? `（注意：基线 ${baselineImg.width}x${baselineImg.height} 与实际 ${actualImg.width}x${actualImg.height} 尺寸不一致，按重叠区 ${cmp.overlapWidth}x${cmp.overlapHeight} 对比）`
        : '';
    const regionNote = cmp.regions.length
        ? `，${cmp.regions.length} 个差异区块${cmp.regions.length > MAX_REGIONS ? '（仅列出前 8 个）' : ''}`
        : '';

    const result: ShotDiffResult = {
        key, status: diffRatio <= threshold ? 'matched' : 'exceeded',
        diffRatio: Math.round(diffRatio * 100) / 100,
        threshold,
        baselineVersion: meta?.version ?? 1,
        baselineState: meta?.state,
        baselinePath: paths.pngPath,
        actualPath, diffPath,
        env: paths.env, viewport: paths.viewport,
        regions: cmp.regions.slice(0, MAX_REGIONS),
        message: '',
        comparedAt: new Date().toISOString(),
    };
    if (result.status === 'matched') {
        result.message = `截图对比一致：差异率 ${fmtPct(diffRatio)} ≤ 阈值 ${fmtPct(threshold)}（基线 v${result.baselineVersion}，key=${key}）`;
    } else {
        result.message = `截图对比不一致：差异率 ${fmtPct(diffRatio)} 超过阈值 ${fmtPct(threshold)}（基线 v${result.baselineVersion}，key=${key}${regionNote}）${baseNote}`;
        recordShotDiff(result); // 抛错前记录：exceeded 证据也必须进 goal 缓冲 → attachment
        throw new ScreenshotDiffError(result);
    }
    recordShotDiff(result);
    return result;
}

// ─── Goal 捕获缓冲（engine 写入 → keveGoal 组装 attachment 时读取） ──

let goalBuffer: ShotDiffResult[] | null = null;

/** keveGoal 执行 fn 前调用：开始收集本 goal 内的对比结果 */
export function beginGoalShotDiffCapture(): void {
    goalBuffer = [];
}

/** 当前是否处于 goal 收集期（engine 判断是否需要自开临时缓冲） */
export function isGoalShotDiffCaptureActive(): boolean {
    return goalBuffer !== null;
}

/** keveGoal fn 结束（无论成败）后调用：取出本 goal 的全部对比结果 */
export function drainGoalShotDiff(): ShotDiffResult[] {
    const out = goalBuffer || [];
    goalBuffer = null;
    return out;
}

/** engine.expectScreenshot 内部调用：记录到当前 goal 缓冲（若在收集期） */
export function recordShotDiff(r: ShotDiffResult): void {
    if (goalBuffer) goalBuffer.push(r);
}
