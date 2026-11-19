#!/usr/bin/env bun
// Draws the macOS menu bar icon (a template image: black on transparent, macOS tints it for light and dark menu
// bars) into src-tauri/icons/tray.png. Run it again only when the shape changes; the PNG is committed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const SIZE = 44; // 22 pt at 2x
const SAMPLES = 4; // per axis, for anti-aliasing

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundedRectDistance(px: number, py: number, cx: number, cy: number, half: number, r: number): number {
  const qx = Math.abs(px - cx) - (half - r);
  const qy = Math.abs(py - cy) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function inside(x: number, y: number): boolean {
  const frame = Math.abs(roundedRectDistance(x, y, 22, 22, 18, 9)) < 1.7;
  const check = Math.min(segmentDistance(x, y, 13.5, 22.5, 19.5, 28.5), segmentDistance(x, y, 19.5, 28.5, 30.5, 15.5)) < 2.1;
  return frame || check;
}

const rows: Buffer[] = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4); // filter byte 0, then RGBA
  for (let x = 0; x < SIZE; x++) {
    let hits = 0;
    for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) if (inside(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES)) hits++;
    row[1 + x * 4 + 3] = Math.round((255 * hits) / (SAMPLES * SAMPLES));
  }
  rows.push(row);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = join(import.meta.dir, "..", "src-tauri", "icons", "tray.png");
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
