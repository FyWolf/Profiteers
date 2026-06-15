#!/usr/bin/env node
//
// Generate a 1200×630 Open Graph image (public/images/og-image.png) from
// public/logo.png on a branded olive-camo background. Run once, or whenever
// the logo changes:
//
//     node scripts/generate-og-image.js
//
// Requires sharp (devDependency).

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const ROOT     = path.join(__dirname, '..');
const LOGO     = path.join(ROOT, 'public', 'logo.png');
const OUT_DIR  = path.join(ROOT, 'public', 'images');
const OUT_PNG  = path.join(OUT_DIR, 'og-image.png');

const W = 1200, H = 630;
const BG_TOP    = '#1a2a1a';
const BG_BOTTOM = '#2e3b2e';
const ACCENT    = '#fcb00d';
const SAND      = '#f4f3e8';

(async () => {
    if (!fs.existsSync(LOGO)) {
        console.error('Missing source logo:', LOGO);
        process.exit(1);
    }
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    // Background SVG: gradient + a subtle accent bar at the bottom + brand text.
    const backgroundSvg = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"  stop-color="${BG_TOP}"/>
      <stop offset="100%" stop-color="${BG_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="0" y="${H - 6}" width="${W}" height="6" fill="${ACCENT}"/>
  <g font-family="Orbitron, 'Trebuchet MS', sans-serif" fill="${SAND}">
    <text x="${W / 2}" y="${H - 110}" font-size="56" font-weight="700"
          text-anchor="middle" letter-spacing="6">PROFITEERS PMC</text>
    <text x="${W / 2}" y="${H - 60}" font-size="22" font-weight="400"
          fill="#b2b27d" text-anchor="middle" letter-spacing="3">
      LGBTQ+ ARMA 3 TACTICAL UNIT
    </text>
  </g>
</svg>`;

    // Resize the logo to fit comfortably above the text.
    const logoBuf = await sharp(LOGO)
        .resize({ width: 320, height: 320, fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } })
        .png()
        .toBuffer();

    await sharp(Buffer.from(backgroundSvg))
        .composite([
            { input: logoBuf, top: 80, left: Math.round((W - 320) / 2) }
        ])
        .png({ compressionLevel: 9 })
        .toFile(OUT_PNG);

    console.log('Wrote', path.relative(ROOT, OUT_PNG), `(${W}×${H})`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
