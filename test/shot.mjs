import { chromium } from 'playwright';
const B = 'http://localhost:8788';
const OUT = '/var/lib/freelancer/projects/40589043';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
// Pre-seed the admin token so the dashboard connects without manual entry.
await page.goto(B + '/dashboard');
await page.evaluate(() => localStorage.setItem('mmx_token', 'dev-admin-token-change-me'));
await page.reload();
await page.waitForTimeout(800);
await page.screenshot({ path: OUT + '/dash-customers.png' });

for (const [tab, file] of [['mo','dash-mo'],['dr','dash-dr'],['retry','dash-retry'],['logs','dash-logs']]) {
  await page.click(`nav a[data-tab="${tab}"]`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${file}.png` });
}
console.log('screenshots done');
await browser.close();
