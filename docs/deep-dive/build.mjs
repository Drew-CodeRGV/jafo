// Render the WLPC Deep Dive HTML sources to PDF with headless Chromium (Playwright).
// Called by build.sh. Footer (title + page number) comes from Playwright's
// footerTemplate because Chromium print does not support @page margin boxes.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_CORE || '/usr/lib/node_modules/n8n/node_modules/playwright-core';
const CHROME = process.env.CHROME_BIN ||
  '/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell';
const { chromium } = require(PW);

const here = path.dirname(fileURLToPath(import.meta.url));
const MONO = "'DejaVu Sans Mono', monospace";

const footer = (left, right, pad) => `
<div style="width:100%;font-family:${MONO};font-size:7px;color:#8a94a6;letter-spacing:.04em;
  padding:0 ${pad};display:flex;justify-content:space-between;-webkit-print-color-adjust:exact">
  <span>${left}</span><span>${right}</span></div>`;

const DOCS = [
  { src: 'student-guide.html', out: 'jafo-deep-dive-student-guide.pdf',
    footer: footer('JAFO Deep Dive · Student Guide · WLPC 2027 Phoenix',
                   '<span class="pageNumber"></span>', '0.75in') },
  { src: 'proposal.html', out: 'jafo-deep-dive-proposal.pdf',
    footer: footer('JAFO Deep Dive Proposal · WLPC 2027 Phoenix',
                   'Drew Lentz · KE5ZJO · jafo.live', '0.5in') },
  { src: 'bom.html', out: 'jafo-deep-dive-bom.pdf',
    footer: footer('JAFO Deep Dive · Student Kit BOM · WLPC 2027 Phoenix',
                   'Drew Lentz · KE5ZJO · jafo.live', '0.5in') },
];

const only = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: CHROME });
try {
  for (const d of DOCS) {
    if (only.length && !only.some((o) => d.src.startsWith(o))) continue;
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(here, d.src)).href, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({
      path: path.join(here, d.out),
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: d.footer,
    });
    await page.close();
    console.log('wrote', d.out);
  }
} finally {
  await browser.close();
}
