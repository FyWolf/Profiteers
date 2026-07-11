// Shared store-image saving used by the admin image manager (and available to
// any route that needs to persist an uploaded image into the store gallery).
// Normalizes whatever it's given (PNG/JPG) to PNG in public/images/store/items.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const STORE_IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'store', 'items');
if (!fs.existsSync(STORE_IMAGES_DIR)) fs.mkdirSync(STORE_IMAGES_DIR, { recursive: true });

let sharp;
async function ensureSharp() {
    if (!sharp) {
        sharp = (await import('sharp')).default;
        sharp.cache(false);
        sharp.concurrency(1);
    }
    return sharp;
}

// Save an image buffer to the store images dir as PNG; returns the public URL.
async function saveImageBuffer(buffer, baseName) {
    const s = await ensureSharp();
    const safe = String(baseName || 'image').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'image';
    const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 8);
    const filename = `${safe}_${hash}.png`;
    const outPath = path.join(STORE_IMAGES_DIR, filename);
    await s(buffer).png().toFile(outPath);
    return `/images/store/items/${filename}`;
}

module.exports = { saveImageBuffer, STORE_IMAGES_DIR };
