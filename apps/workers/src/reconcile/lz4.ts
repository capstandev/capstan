// LZ4 frame decoder (format 1.6.x), streaming one block at a time, with XXH32 header, block and content checksums.
// Written here so the reconciler needs no native module. It handles independent and linked blocks, uncompressed
// blocks, skippable frames and several frames in a row. Every loop step reads or writes at least one byte, so the
// work is linear in input plus output; a caller stops it with the `onBytes` budget.

export class Lz4Error extends Error {
  constructor(message: string) {
    super(`lz4: ${message}`);
    this.name = "Lz4Error";
  }
}

// ---------------------------------------------------------------- XXH32
const P1 = 2654435761;
const P2 = 2246822519;
const P3 = 3266489917;
const P4 = 668265263;
const P5 = 374761393;
const rotl = (x: number, r: number) => ((x << r) | (x >>> (32 - r))) >>> 0;
const mul = (a: number, b: number) => Math.imul(a, b) >>> 0;
const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

/** Incremental XXH32 (initial value 0 unless given). */
export class Xxh32 {
  private v = [0, 0, 0, 0];
  private buf = new Uint8Array(16);
  private bufLen = 0;
  private total = 0;
  constructor(private readonly init = 0) {
    this.v = [(init + P1 + P2) >>> 0, (init + P2) >>> 0, init >>> 0, (init - P1) >>> 0];
  }
  private round(i: number, lane: number): void {
    this.v[i] = mul(rotl((this.v[i]! + mul(lane, P2)) >>> 0, 13), P1);
  }
  update(data: Uint8Array): this {
    this.total += data.length;
    let p = 0;
    if (this.bufLen > 0) {
      const take = Math.min(16 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      p = take;
      if (this.bufLen < 16) return this;
      for (let i = 0; i < 4; i++) this.round(i, u32(this.buf, i * 4));
      this.bufLen = 0;
    }
    for (; p + 16 <= data.length; p += 16) for (let i = 0; i < 4; i++) this.round(i, u32(data, p + i * 4));
    if (p < data.length) {
      this.buf.set(data.subarray(p), 0);
      this.bufLen = data.length - p;
    }
    return this;
  }
  digest(): number {
    let h: number;
    if (this.total >= 16) h = (rotl(this.v[0]!, 1) + rotl(this.v[1]!, 7) + rotl(this.v[2]!, 12) + rotl(this.v[3]!, 18)) >>> 0;
    else h = (this.init + P5) >>> 0;
    h = (h + this.total) >>> 0;
    let i = 0;
    for (; i + 4 <= this.bufLen; i += 4) h = mul(rotl((h + mul(u32(this.buf, i), P3)) >>> 0, 17), P4);
    for (; i < this.bufLen; i++) h = mul(rotl((h + mul(this.buf[i]!, P5)) >>> 0, 11), P1);
    h ^= h >>> 15;
    h = mul(h, P2);
    h ^= h >>> 13;
    h = mul(h, P3);
    h ^= h >>> 16;
    return h >>> 0;
  }
}

export const xxh32 = (data: Uint8Array, init = 0): number => new Xxh32(init).update(data).digest();

// ---------------------------------------------------------------- block
/**
 * Decode one LZ4 block from src[s0, s1) into dst starting at d0. Matches may reach back into dst[0, d0) (the
 * previous block's tail for linked blocks). Returns the new end of dst.
 */
export function decodeBlock(src: Uint8Array, s0: number, s1: number, dst: Uint8Array, d0: number): number {
  let s = s0;
  let d = d0;
  const dEnd = dst.length;
  while (s < s1) {
    const token = src[s++]!;
    let lit = token >>> 4;
    if (lit === 15) {
      let b: number;
      do {
        if (s >= s1) throw new Lz4Error("truncated literal length");
        b = src[s++]!;
        lit += b;
      } while (b === 255);
    }
    if (s + lit > s1) throw new Lz4Error("literals run past the block");
    if (d + lit > dEnd) throw new Lz4Error("block decodes past its maximum size");
    dst.set(src.subarray(s, s + lit), d);
    s += lit;
    d += lit;
    if (s >= s1) break; // the last sequence has literals only
    if (s + 2 > s1) throw new Lz4Error("truncated match offset");
    const off = src[s]! | (src[s + 1]! << 8);
    s += 2;
    if (off === 0 || off > d) throw new Lz4Error("match offset out of range");
    let ml = token & 15;
    if (ml === 15) {
      let b: number;
      do {
        if (s >= s1) throw new Lz4Error("truncated match length");
        b = src[s++]!;
        ml += b;
      } while (b === 255);
    }
    ml += 4;
    if (d + ml > dEnd) throw new Lz4Error("block decodes past its maximum size");
    let m = d - off;
    if (off >= ml) {
      dst.copyWithin(d, m, m + ml);
      d += ml;
    } else {
      for (let k = 0; k < ml; k++) dst[d++] = dst[m++]!;
    }
  }
  return d;
}

// ---------------------------------------------------------------- frame
const MAGIC = 0x184d2204;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE = 0x184d2a50;
const BLOCK_MAX: Record<number, number> = { 4: 64 * 1024, 5: 256 * 1024, 6: 1024 * 1024, 7: 4 * 1024 * 1024 };
const WINDOW = 64 * 1024;

/**
 * Decode an LZ4 frame stream block by block. `onBytes(total)` is called after each block with the decompressed total
 * so far; it throws to stop (size caps).
 */
export function* lz4Frames(src: Uint8Array, onBytes?: (total: number) => void): Generator<Uint8Array> {
  let p = 0;
  let total = 0;
  if (src.length < 4) throw new Lz4Error("input is too short for a frame");
  while (p < src.length) {
    if (p + 4 > src.length) throw new Lz4Error("trailing bytes after the last frame");
    const magic = u32(src, p);
    if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE) {
      if (p + 8 > src.length) throw new Lz4Error("truncated skippable frame");
      p += 8 + u32(src, p + 4);
      continue;
    }
    if (magic !== MAGIC) throw new Lz4Error("bad frame magic");
    p += 4;
    const descStart = p;
    if (p + 3 > src.length) throw new Lz4Error("truncated frame header");
    const flg = src[p++]!;
    const bd = src[p++]!;
    if (flg >>> 6 !== 1) throw new Lz4Error("unsupported frame version");
    if (flg & 0x02 || bd & 0x8f) throw new Lz4Error("reserved header bits set");
    const independent = (flg & 0x20) !== 0;
    const blockChecksum = (flg & 0x10) !== 0;
    const hasSize = (flg & 0x08) !== 0;
    const contentChecksum = (flg & 0x04) !== 0;
    const hasDict = (flg & 0x01) !== 0;
    const blockMax = BLOCK_MAX[(bd >>> 4) & 7];
    if (!blockMax) throw new Lz4Error("bad block size code");
    if (hasSize) p += 8;
    if (hasDict) throw new Lz4Error("dictionaries are not supported");
    if (p + 1 > src.length) throw new Lz4Error("truncated frame header");
    const hc = src[p++]!;
    if (((xxh32(src.subarray(descStart, p - 1)) >>> 8) & 0xff) !== hc) throw new Lz4Error("header checksum mismatch");

    const content = contentChecksum ? new Xxh32() : null;
    let window = new Uint8Array(0);
    for (;;) {
      if (p + 4 > src.length) throw new Lz4Error("truncated block size");
      const word = u32(src, p);
      p += 4;
      if (word === 0) break; // end mark
      const raw = (word & 0x80000000) !== 0;
      const size = word & 0x7fffffff;
      if (size > blockMax) throw new Lz4Error("block larger than the frame's maximum");
      if (p + size + (blockChecksum ? 4 : 0) > src.length) throw new Lz4Error("truncated block");
      if (blockChecksum && xxh32(src.subarray(p, p + size)) !== u32(src, p + size)) throw new Lz4Error("block checksum mismatch");
      let out: Uint8Array;
      if (raw) {
        out = src.slice(p, p + size);
      } else if (independent) {
        const dst = new Uint8Array(blockMax);
        out = dst.subarray(0, decodeBlock(src, p, p + size, dst, 0));
      } else {
        const dst = new Uint8Array(window.length + blockMax);
        dst.set(window, 0);
        const end = decodeBlock(src, p, p + size, dst, window.length);
        out = dst.slice(window.length, end);
      }
      p += size + (blockChecksum ? 4 : 0);
      if (!independent) {
        const joined = new Uint8Array(Math.min(WINDOW, window.length + out.length));
        const fromOut = Math.min(out.length, joined.length);
        const fromWin = joined.length - fromOut;
        joined.set(window.subarray(window.length - fromWin), 0);
        joined.set(out.subarray(out.length - fromOut), fromWin);
        window = joined;
      }
      content?.update(out);
      total += out.length;
      onBytes?.(total);
      yield out;
    }
    if (contentChecksum) {
      if (p + 4 > src.length) throw new Lz4Error("truncated content checksum");
      if (content!.digest() !== u32(src, p)) throw new Lz4Error("content checksum mismatch");
      p += 4;
    }
  }
}
