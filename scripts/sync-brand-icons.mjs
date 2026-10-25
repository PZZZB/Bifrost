import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Inline original assets so existing installations can refresh their HTML without
// adding routes, requesting third-party images, or weakening the page CSP.
const root = new URL('../public/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('brand-icons/manifest.json', root), 'utf8'));
const files = { codex: 'codex.png', claude: 'claude.png', codebuddy: 'codebuddy.png', workbuddy: 'workbuddy.webp', cursor: 'cursor.svg' };
const icons = new Map();
for (const [id, file] of Object.entries(files)) {
  const bytes = await readFile(new URL(`brand-icons/${file}`, root));
  const entry = manifest.files.find(value => value.id === id && value.file === file);
  if (!entry || entry.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error(`Unverified brand asset: ${id}`);
  if (file.endsWith('.svg')) {
    let svg = bytes.toString('utf8').trim();
    if (!/^<svg\b/.test(svg) || /<(?:script|foreignObject|image|use)\b|\bon\w+\s*=|\bhref\s*=|<!DOCTYPE|<!ENTITY/i.test(svg)) throw new Error(`Unsafe inline SVG: ${id}`);
    // Scope the original internal IDs; paths, colors and other artwork stay intact.
    for (const [, original] of [...svg.matchAll(/\bid="([^"]+)"/g)]) {
      svg = svg.replaceAll(`id="${original}"`, `id="brand-${id}-${original}"`).replaceAll(`url(#${original})`, `url(#brand-${id}-${original})`);
    }
    icons.set(id, svg.replace('<svg ', '<svg class="official-brand-vector" aria-hidden="true" '));
  } else {
    const mime = file.endsWith('.webp') ? 'image/webp' : 'image/png';
    icons.set(id, `<canvas class="official-brand-icon" aria-hidden="true" width="64" height="64" data-brand-mime="${mime}" data-brand-image="${bytes.toString('base64')}"></canvas>`);
  }
}
for (const [file, prefix] of [['index.html', 'world-node-'], ['portal.html', 'portal-node-']]) {
  let html = await readFile(new URL(file, root), 'utf8');
  for (const [id, icon] of icons) {
    const node = new RegExp(`(<button[^>]*id="${prefix}${id}"[^>]*>\\s*<span)([^>]*>)`);
    html = html.replace(node, (match, start, attributes) => attributes.includes('data-brand=') ? match : `${start} data-brand="${id}"${attributes}`);
    const wrapper = new RegExp(`(<span\\b[^>]*data-brand="${id}"[^>]*>)[\\s\\S]*?(</span>)`);
    if (!wrapper.test(html)) throw new Error(`Missing ${id} icon slot in ${file}`);
    html = html.replace(wrapper, (_, start, end) => `${start}${icon}${end}`);
  }
  await writeFile(new URL(file, root), html);
  console.log(`Updated verified official icons in ${file}`);
}
