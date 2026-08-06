#!/usr/bin/env node
/**
 * Asserts that the sign-in page fits one viewport with no page scroll.
 *
 *   node scripts/check-viewport-fit.mjs [url]
 *
 * Why this exists as a script rather than a one-off eyeball: "looks fine on my
 * monitor" is not a check. A 1366x768 laptop is still the most common machine
 * at an Indian clinic front desk, and that is the size that grows a scrollbar
 * first. Anything added to the sign-in page — a field, a notice, a link — pushes
 * against this, and the regression is invisible on a large display.
 *
 * Requires the app to be running. Not part of `pnpm verify` yet, because that
 * would mean starting a server inside the gate; run it after changing the auth
 * screens.
 */

import { chromium } from 'playwright';

const URL = process.argv[2] ?? process.env.LOGIN_URL ?? 'http://localhost:3000/login';

const VIEWPORTS = [
  { name: '1920x1080  desktop', width: 1920, height: 1080 },
  { name: '1536x864   laptop', width: 1536, height: 864 },
  { name: '1366x768   laptop', width: 1366, height: 768 },
  { name: '1280x720   small', width: 1280, height: 720 },
  { name: '390x844    mobile', width: 390, height: 844 },
  { name: '360x640    small mobile', width: 360, height: 640 },
];

const browser = await chromium.launch();
let failures = 0;

console.log(`\nChecking ${URL}\n`);

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });

  // A page whose stylesheet failed to load has NO layout, so everything fits
  // and this check passes while telling you nothing. That is not hypothetical —
  // it happened, against a dev server whose chunks were 404ing. Track resource
  // failures and treat them as a hard failure.
  // Only STATIC assets count. An API call may legitimately fail here — the
  // page is often loaded from a scratch port that the API's CORS allow-list
  // does not include — and that says nothing about whether the layout fits.
  const isAsset = (url) => /\.(css|js|woff2?|ttf|png|jpe?g|svg|webp)(\?|$)/i.test(url);

  const brokenResources = [];
  page.on('requestfailed', (r) => {
    if (isAsset(r.url())) brokenResources.push(r.url());
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && isAsset(r.url())) brokenResources.push(r.url());
  });

  try {
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 20000 });

    const m = await page.evaluate(() => {
      const doc = document.documentElement;
      const submit = document.querySelector('button[type=submit]');
      const rect = submit?.getBoundingClientRect();

      return {
        scrollH: doc.scrollHeight,
        clientH: doc.clientHeight,
        // 1px of slack: sub-pixel rounding on fractional device ratios can
        // otherwise report a scrollbar no user can actually see.
        scrolls: doc.scrollHeight > doc.clientHeight + 1,
        submitBelowFold: rect ? rect.bottom > window.innerHeight : null,
        // Proof the design tokens are actually applied: the warm paper page
        // background. If this is transparent/white, no stylesheet loaded.
        bodyBg: getComputedStyle(document.body).backgroundColor,
        styleSheets: document.styleSheets.length,
      };
    });

    const styled = m.styleSheets > 0 && !/rgba\(0, 0, 0, 0\)|^$/.test(m.bodyBg);
    const ok = styled && brokenResources.length === 0 && !m.scrolls && m.submitBelowFold !== true;
    if (!ok) failures++;

    console.log(
      `  ${ok ? '✓' : '✗'} ${vp.name.padEnd(24)} ` +
        `content ${String(m.scrollH).padStart(4)} / viewport ${String(m.clientH).padStart(4)}` +
        (!styled ? '   UNSTYLED — measurement meaningless' : '') +
        (brokenResources.length ? `   ${brokenResources.length} BROKEN RESOURCE(S)` : '') +
        (m.scrolls ? '   PAGE SCROLLS' : '') +
        (m.submitBelowFold === true ? '   SUBMIT BELOW FOLD' : ''),
    );
  } catch (err) {
    failures++;
    console.log(`  ✗ ${vp.name.padEnd(24)} ${err.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();

if (failures === 0) {
  console.log('\nFits every viewport.\n');
  process.exit(0);
}

console.error(`\n${failures} viewport(s) do not fit.\n`);
process.exit(1);
