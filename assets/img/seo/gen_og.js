#!/usr/bin/env node
// Generates 1200x630 branded OG PNG images for each page.
// Uses only Node.js stdlib — no external deps.
// Usage: node gen_og.js

'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── PNG parser (minimal — returns flat RGBA Uint8Array) ─────────────────────
function parsePNG(buf) {
  let pos = 8; // skip signature
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  let idatChunks = [];
  let palette = null;

  while (pos < buf.length) {
    const len  = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4); pos += 4;
    const data = buf.slice(pos, pos + len); pos += len + 4; // +4 crc
    if (type === 'IHDR') {
      width     = data.readUInt32BE(0);
      height    = data.readUInt32BE(4);
      bitDepth  = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') break;
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp = (colorType === 2) ? 3 : (colorType === 6) ? 4 : (colorType === 3) ? 1 : (colorType === 4) ? 2 : 1;
  const stride = 1 + width * bpp;
  const pixels = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * stride];
    const row        = raw.slice(y * stride + 1, y * stride + 1 + width * bpp);
    const prev        = y === 0 ? new Uint8Array(row.length) : raw.slice((y-1)*stride+1, (y-1)*stride+1+width*bpp);
    const recon = refilter(row, prev, bpp, filterType);
    for (let x = 0; x < width; x++) {
      const pi = (y * width + x) * 4;
      if (colorType === 6) { // RGBA
        pixels[pi]   = recon[x*4];
        pixels[pi+1] = recon[x*4+1];
        pixels[pi+2] = recon[x*4+2];
        pixels[pi+3] = recon[x*4+3];
      } else if (colorType === 2) { // RGB
        pixels[pi]   = recon[x*3];
        pixels[pi+1] = recon[x*3+1];
        pixels[pi+2] = recon[x*3+2];
        pixels[pi+3] = 255;
      } else if (colorType === 3 && palette) { // Indexed
        const idx = recon[x] * 3;
        pixels[pi]   = palette[idx];
        pixels[pi+1] = palette[idx+1];
        pixels[pi+2] = palette[idx+2];
        pixels[pi+3] = 255;
      } else {
        pixels[pi] = pixels[pi+1] = pixels[pi+2] = recon[x]; pixels[pi+3] = 255;
      }
    }
  }
  return { width, height, pixels };
}

function refilter(row, prev, bpp, filter) {
  const out = Buffer.from(row);
  if (filter === 0) return out;
  if (filter === 1) { for (let i=bpp;i<out.length;i++) out[i]=(out[i]+out[i-bpp])&0xff; return out; }
  if (filter === 2) { for (let i=0;i<out.length;i++) out[i]=(out[i]+prev[i])&0xff; return out; }
  if (filter === 3) { for (let i=0;i<out.length;i++) { const a=i>=bpp?out[i-bpp]:0; out[i]=(out[i]+Math.floor((a+prev[i])/2))&0xff; } return out; }
  if (filter === 4) { // Paeth
    for (let i=0;i<out.length;i++) {
      const a=i>=bpp?out[i-bpp]:0, b=prev[i], c=i>=bpp?prev[i-bpp]:0;
      const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c);
      out[i]=(out[i]+(pa<=pb&&pa<=pc?a:pb<=pc?b:c))&0xff;
    }
    return out;
  }
  return out;
}

// ─── PNG writer ──────────────────────────────────────────────────────────────
function writePNG(width, height, pixels) {
  const crc32 = (() => {
    const t = new Int32Array(256);
    for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?(0xEDB88320^(c>>>1)):c>>>1;t[i]=c;}
    return (buf,start,end,prev=0)=>{let c=prev^-1;for(let i=start;i<end;i++)c=(c>>>8)^t[(c^buf[i])&0xff];return (c^-1)>>>0;};
  })();

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf  = Buffer.allocUnsafe(4); lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf  = Buffer.allocUnsafe(4);
    const crcVal  = crc32(Buffer.concat([typeBuf, data]), 0, 4 + data.length, crc32(typeBuf, 0, 4));
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data]), 0, typeBuf.length + data.length), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(height,4);
  ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0; // 8-bit RGBA

  const rawRows = [];
  for (let y=0;y<height;y++) {
    rawRows.push(Buffer.from([0])); // filter None
    const row = Buffer.allocUnsafe(width*4);
    for (let x=0;x<width;x++) {
      const pi=(y*width+x)*4;
      row[x*4]=pixels[pi]; row[x*4+1]=pixels[pi+1]; row[x*4+2]=pixels[pi+2]; row[x*4+3]=pixels[pi+3];
    }
    rawRows.push(row);
  }
  const compressed = zlib.deflateSync(Buffer.concat(rawRows), {level:6});
  return Buffer.concat([sig, chunk('IHDR',ihdr), chunk('IDAT',compressed), chunk('IEND',Buffer.alloc(0))]);
}

// ─── Composite logo (RGBA src) onto dest pixels at (dx,dy) scaled to maxW ───
function compositeLogo(dest, dw, dh, logo, maxW) {
  const scale = Math.min(maxW / logo.width, 120 / logo.height);
  const sw = Math.round(logo.width * scale);
  const sh = Math.round(logo.height * scale);
  const dx = 72;
  const dy = Math.round((dh - sh) / 2);

  for (let sy=0;sy<sh;sy++) {
    for (let sx=0;sx<sw;sx++) {
      const lx = Math.round(sx / scale);
      const ly = Math.round(sy / scale);
      if (lx >= logo.width || ly >= logo.height) continue;
      const li  = (ly * logo.width + lx) * 4;
      const di  = ((dy+sy) * dw + (dx+sx)) * 4;
      const sa  = logo.pixels[li+3] / 255;
      const isa = 1 - sa;
      dest[di]   = Math.round(logo.pixels[li]   * sa + dest[di]   * isa);
      dest[di+1] = Math.round(logo.pixels[li+1] * sa + dest[di+1] * isa);
      dest[di+2] = Math.round(logo.pixels[li+2] * sa + dest[di+2] * isa);
      dest[di+3] = 255;
    }
  }
}

// ─── Draw a filled rect ───────────────────────────────────────────────────────
function rect(pixels, w, x0, y0, rw, rh, r, g, b, a=255) {
  for (let y=y0;y<y0+rh;y++) for (let x=x0;x<x0+rw;x++) {
    const i=(y*w+x)*4; pixels[i]=r; pixels[i+1]=g; pixels[i+2]=b; pixels[i+3]=a;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const W=1200, H=630;
const outDir = path.join(__dirname);
const logoPath = path.join(__dirname, '../logo.png');

let logo = null;
try { logo = parsePNG(fs.readFileSync(logoPath)); } catch(e) { console.warn('logo not found'); }

// Page configs
const pages = [
  { name:'home',        accentR:14, accentG:165, accentB:233 },
  { name:'about',       accentR:14, accentG:165, accentB:233 },
  { name:'services',    accentR:16, accentG:185, accentB:129 },
  { name:'clients',     accentR:251,accentG:146, accentB:60  },
  { name:'outsourcing', accentR:139,accentG:92,  accentB:246 },
  { name:'products',    accentR:14, accentG:165, accentB:233 },
  { name:'sehatlo',     accentR:16, accentG:185, accentB:129 },
  { name:'progrow',     accentR:99, accentG:102, accentB:241 },
  { name:'contact',     accentR:14, accentG:165, accentB:233 },
];

for (const page of pages) {
  const pixels = new Uint8Array(W * H * 4);

  // Background: dark navy gradient top→bottom
  for (let y=0;y<H;y++) {
    const t = y/H;
    const bg_r = Math.round(15  + (22  - 15)  * t);
    const bg_g = Math.round(23  + (30  - 23)  * t);
    const bg_b = Math.round(42  + (58  - 42)  * t);
    for (let x=0;x<W;x++) {
      const i=(y*W+x)*4; pixels[i]=bg_r; pixels[i+1]=bg_g; pixels[i+2]=bg_b; pixels[i+3]=255;
    }
  }

  // Diagonal accent mesh (subtle)
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const d = (x+y)%120;
    if (d < 1) {
      const i=(y*W+x)*4;
      pixels[i]  =Math.min(255,pixels[i]  +page.accentR*0.08|0);
      pixels[i+1]=Math.min(255,pixels[i+1]+page.accentG*0.08|0);
      pixels[i+2]=Math.min(255,pixels[i+2]+page.accentB*0.08|0);
    }
  }

  // Bottom accent band
  rect(pixels, W, 0, H-8, W, 8, page.accentR, page.accentG, page.accentB);

  // Right-side accent circle (decorative)
  const cx=980, cy=315, cr=260;
  for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
    const dist=Math.sqrt((x-cx)**2+(y-cy)**2);
    if (dist < cr) {
      const alpha = Math.max(0, (1-dist/cr)*0.12);
      const i=(y*W+x)*4;
      pixels[i]  =Math.min(255,pixels[i]  +(page.accentR*alpha)|0);
      pixels[i+1]=Math.min(255,pixels[i+1]+(page.accentG*alpha)|0);
      pixels[i+2]=Math.min(255,pixels[i+2]+(page.accentB*alpha)|0);
    }
  }

  // Logo
  if (logo) compositeLogo(pixels, W, H, logo, 360);

  // Horizontal divider line
  rect(pixels, W, 72, H-80, W-144, 1, page.accentR, page.accentG, page.accentB, 80);

  const outPath = path.join(outDir, page.name + '.png');
  fs.writeFileSync(outPath, writePNG(W, H, pixels));
  console.log('wrote', path.basename(outPath));
}
console.log('Done.');
