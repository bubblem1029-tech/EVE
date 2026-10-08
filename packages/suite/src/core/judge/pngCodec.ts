/**
 * pngCodec — 纯 Node PNG 编解码（零依赖，zlib 内置）
 *
 * 为什么不用 pngjs/pixelmatch：@kkeve/suite 依赖树里没有这两个包，
 * 执行环境（keve-wiki / 调度节点）也不保证能现场安装 —— 而引擎侧截图对比
 * 是核心链路，不能带可选依赖。Playwright 截图恒为 8-bit、非交错、
 * colorType 2(RGB)/6(RGBA)，覆盖这两类 + 灰度(0/4)即可覆盖全部引擎产物。
 *
 * 支持范围（超出范围抛错，不静默出错误结果）：
 *   - bitDepth: 8
 *   - colorType: 0(灰度) / 2(RGB) / 4(灰+A) / 6(RGBA)
 *   - interlace: 0（Progressive PNG 抛错）
 */

import * as zlib from 'node:zlib';

// ── CRC32 ──

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// ── Decode ──

export interface RawImage {
    width: number;
    height: number;
    /** RGBA，4 通道，每像素 4 字节 */
    data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Paeth 预测器（PNG 规范 §6.4） */
function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 解码 PNG → RGBA。仅支持 8-bit / colorType 0,2,4,6 / 非交错 */
export function decodePng(buf: Buffer): RawImage {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('pngCodec: 不是合法的 PNG 文件（签名不符）');
    }
    let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
    const idatParts: Buffer[] = [];
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        pos += 12 + len; // length + type + data + crc
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idatParts.push(Buffer.from(data));
        } else if (type === 'IEND') {
            break;
        }
    }
    if (!width || !height) throw new Error('pngCodec: IHDR 缺失或非法');
    if (bitDepth !== 8) throw new Error(`pngCodec: 不支持 bitDepth=${bitDepth}（仅支持 8，Playwright 截图恒为 8）`);
    if (interlace !== 0) throw new Error('pngCodec: 不支持交错 PNG（Progressive）');
    const channelsByColor: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
    const channels = channelsByColor[colorType];
    if (!channels) throw new Error(`pngCodec: 不支持 colorType=${colorType}（仅支持 0/2/4/6）`);

    const raw = zlib.inflateSync(Buffer.concat(idatParts));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) {
        throw new Error(`pngCodec: IDAT 数据不足（期望 ${(stride + 1) * height} 字节，实际 ${raw.length}）`);
    }

    // 反滤波（逐扫描线）
    const out = new Uint8Array(width * height * 4);
    const prev = new Uint8Array(stride);
    const cur = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        const filter = raw[rowStart];
        for (let i = 0; i < stride; i++) {
            const x = raw[rowStart + 1 + i];
            const a = i >= channels ? cur[i - channels] : 0;
            const b = prev[i];
            const c = i >= channels ? prev[i - channels] : 0;
            let v: number;
            switch (filter) {
                case 0: v = x; break;
                case 1: v = x + a; break;
                case 2: v = x + b; break;
                case 3: v = x + ((a + b) >> 1); break;
                case 4: v = x + paeth(a, b, c); break;
                default: throw new Error(`pngCodec: 非法滤波类型 ${filter}（行 ${y}）`);
            }
            cur[i] = v & 0xff;
        }
        // 展开为 RGBA
        const o = y * width * 4;
        for (let x = 0; x < width; x++) {
            const s = x * channels;
            if (colorType === 6) {
                out[o + x * 4] = cur[s]; out[o + x * 4 + 1] = cur[s + 1];
                out[o + x * 4 + 2] = cur[s + 2]; out[o + x * 4 + 3] = cur[s + 3];
            } else if (colorType === 2) {
                out[o + x * 4] = cur[s]; out[o + x * 4 + 1] = cur[s + 1];
                out[o + x * 4 + 2] = cur[s + 2]; out[o + x * 4 + 3] = 255;
            } else if (colorType === 0) {
                out[o + x * 4] = out[o + x * 4 + 1] = out[o + x * 4 + 2] = cur[s];
                out[o + x * 4 + 3] = 255;
            } else { // 4: 灰+alpha
                out[o + x * 4] = out[o + x * 4 + 1] = out[o + x * 4 + 2] = cur[s];
                out[o + x * 4 + 3] = cur[s + 1];
            }
        }
        prev.set(cur);
    }
    return { width, height, data: out };
}

// ── Encode ──

function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA → PNG（colorType 6，filter 0）。data 长度必须为 w*h*4 */
export function encodePng(width: number, height: number, data: Uint8Array): Buffer {
    if (data.length !== width * height * 4) {
        throw new Error(`pngCodec: encodePng 数据长度不符（期望 ${width * height * 4}，实际 ${data.length}）`);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bitDepth
    ihdr[9] = 6;   // colorType RGBA
    ihdr[10] = 0;  // compression
    ihdr[11] = 0;  // filter
    ihdr[12] = 0;  // interlace
    // filter 0 逐行打包
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;
        Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4)
            .copy(raw, y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
