// Genera build/icon.png (512×512) sin dependencias: la grilla 3×2 de BridgeEditor.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const BG = hex('#161b22')
const CELLS = ['#d97757', '#4ec9b0', '#58a6ff', '#e3b341', '#bc8cff', '#3fb950'].map(hex)

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.max(x0 + r, Math.min(x, x1 - r))
  const cy = Math.max(y0 + r, Math.min(y, y1 - r))
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r)
}

// Geometría: marco redondeado + 6 celdas (3 columnas × 2 filas)
const M = 28 // margen exterior
const P = 36 // padding interno
const G = 18 // separación entre celdas
const cw = (SIZE - 2 * (M + P) - 2 * G) / 3
const ch = (SIZE - 2 * (M + P) - G) / 2

const rects = []
for (let row = 0; row < 2; row++) {
  for (let col = 0; col < 3; col++) {
    const x0 = M + P + col * (cw + G)
    const y0 = M + P + row * (ch + G)
    rects.push({ x0, y0, x1: x0 + cw, y1: y0 + ch, color: CELLS[row * 3 + col] })
  }
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4))
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 4)] = 0 // filtro 0 por scanline
  for (let x = 0; x < SIZE; x++) {
    const off = y * (1 + SIZE * 4) + 1 + x * 4
    let rgba = [0, 0, 0, 0]
    if (inRoundRect(x, y, M, M, SIZE - M, SIZE - M, 90)) {
      rgba = [...BG, 255]
      for (const r of rects) {
        if (inRoundRect(x, y, r.x0, r.y0, r.x1, r.y1, 16)) {
          rgba = [...r.color, 255]
          break
        }
      }
    }
    raw[off] = rgba[0]
    raw[off + 1] = rgba[1]
    raw[off + 2] = rgba[2]
    raw[off + 3] = rgba[3]
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build/icon.png'), png)
console.log(`build/icon.png generado (${png.length} bytes)`)
