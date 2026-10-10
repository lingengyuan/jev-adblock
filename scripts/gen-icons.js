#!/usr/bin/env node
// 生成扩展图标（16/48/128 PNG）。纯 Node 实现，无外部依赖：
// 粉色底 + 白色粗体 "J"，位图放大并居中。
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0; // filter: none
    p += 1;
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      raw[p] = rgba[idx];
      raw[p + 1] = rgba[idx + 1];
      raw[p + 2] = rgba[idx + 2];
      raw[p + 3] = rgba[idx + 3];
      p += 4;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 7x9 "J" 位图
const GLYPH = [
  ".XXXXX.",
  ".XXXXX.",
  "...XX..",
  "...XX..",
  "...XX..",
  "...XX..",
  "X..XX..",
  ".XXXX..",
  "..XX...",
];

const BG = [0xe5, 0x51, 0xba, 0xff];
const FG = [0xff, 0xff, 0xff, 0xff];

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = BG[0];
    rgba[i * 4 + 1] = BG[1];
    rgba[i * 4 + 2] = BG[2];
    rgba[i * 4 + 3] = BG[3];
  }
  const cols = GLYPH[0].length;
  const rows = GLYPH.length;
  const cell = Math.max(1, Math.floor(size / (rows + 1)));
  const drawnW = cols * cell;
  const drawnH = rows * cell;
  const offX = Math.floor((size - drawnW) / 2);
  const offY = Math.floor((size - drawnH) / 2);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (GLYPH[r][c] !== "X") continue;
      for (let dy = 0; dy < cell; dy += 1) {
        for (let dx = 0; dx < cell; dx += 1) {
          const x = offX + c * cell + dx;
          const y = offY + r * cell + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const idx = (y * size + x) * 4;
          rgba[idx] = FG[0];
          rgba[idx + 1] = FG[1];
          rgba[idx + 2] = FG[2];
          rgba[idx + 3] = FG[3];
        }
      }
    }
  }
  return rgba;
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePng(size, size, render(size));
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png (${png.length} bytes)`);
}
