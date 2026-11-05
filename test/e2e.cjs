// End-to-end check with two simulated phones. Needs a running server with
// SMS_PROVIDER=console whose log is passed as the first argument.
//   node test/e2e.cjs <server.log> <screenshot dir>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const LOG = process.argv[2];
const SHOTS = process.argv[3];
const BASE = process.env.BASE || 'http://localhost:8080';
fs.mkdirSync(SHOTS, { recursive: true });

function codeFor(phone) {
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes(`verification code for ${phone}`));
  const m = lines.at(-1)?.match(/: (\d{6})/);
  if (!m) throw new Error(`no code for ${phone}`);
  return m[1];
}

const errors = [];
async function phone(browser, label, scheme = 'light') {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: 'de-DE', colorScheme: scheme,
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(page, national, e164, name, prefix) {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Get started' }).click();
  await sleep(500);
  if (prefix) await shot(page, `${prefix}-02-phone`);
  await page.getByLabel('Phone number').fill(national);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Verification code').waitFor();
  await sleep(500);
  if (prefix) await shot(page, `${prefix}-03-code`);
  await page.getByLabel('Verification code').pressSequentially(codeFor(e164), { delay: 30 });
  await page.getByLabel('Your name').waitFor({ timeout: 10000 });
  if (prefix) await shot(page, `${prefix}-04-profile`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor();
  await sleep(400);
}

(async () => {
  const browser = await chromium.launch();
  const a = await phone(browser, 'A');
  const b = await phone(browser, 'B', 'dark');

  await a.goto(BASE);
  await sleep(600);
  await shot(a, 'a-01-welcome');
  await register(a, '0151 11111111', '+4915111111111', 'Anna Berger', 'a');
  await shot(a, 'a-05-empty');
  await register(b, '0151 22222222', '+4915122222222', 'Ben Okafor');

  // A starts a chat with B by number
  await a.getByRole('button', { name: 'New chat' }).click();
  await sleep(500);
  await a.getByLabel('Phone number').fill('015122222222');
  await a.getByRole('button', { name: 'Find' }).click();
  await a.getByText('Ben Okafor').first().waitFor();
  await shot(a, 'a-06-newchat-found');
  await a.getByText('Ben Okafor').first().click();
  await a.getByLabel('Message').waitFor();
  await sleep(500);
  await a.getByLabel('Message').fill('Hi Ben! This is end-to-end encrypted 🔒');
  await a.getByRole('button', { name: 'Send' }).click();
  await a.getByLabel('Message').fill('Can you read this?');
  await a.getByRole('button', { name: 'Send' }).click();
  await sleep(800);

  // B receives
  await b.getByText('Anna Berger').waitFor({ timeout: 10000 });
  await sleep(300);
  await shot(b, 'b-01-list-unread');
  await b.getByText('Anna Berger').click();
  await b.getByText('Can you read this?').waitFor();
  await b.getByLabel('Message').fill('Loud and clear. Only we can read this.');
  await b.getByRole('button', { name: 'Send' }).click();
  await sleep(300);
  await b.getByLabel('Message').fill('https://example.com is a link');
  await b.getByRole('button', { name: 'Send' }).click();
  await sleep(1200);
  await shot(b, 'b-02-chat');
  await a.getByText('Loud and clear. Only we can read this.').waitFor({ timeout: 10000 });
  await sleep(300);
  await shot(a, 'a-07-chat');

  // Edge swipe from the left goes back to the chat list
  await a.mouse.move(4, 420);
  await a.mouse.down();
  for (let x = 20; x <= 300; x += 40) await a.mouse.move(x, 424, { steps: 2 });
  await a.mouse.up();
  await sleep(700);
  await a.getByRole('heading', { name: 'Chats', exact: true }).waitFor();
  if (await a.locator('.stack-item').count() !== 1) throw new Error('swipe back did not pop the screen');
  await a.locator('.chat-row', { hasText: 'Ben Okafor' }).click();
  await sleep(600);

  // A: contact info + safety number
  await a.getByRole('button', { name: /Ben Okafor, show info/ }).click();
  await sleep(600);
  await shot(a, 'a-08-contact-info');
  await a.getByText('Safety number').first().click();
  await a.locator('.safety-grid').waitFor();
  await sleep(500);
  await shot(a, 'a-09-safety');
  const numA = await a.locator('.safety-grid').innerText();
  await a.getByRole('button', { name: 'Back' }).click();
  await sleep(500);
  await a.getByRole('button', { name: 'Back' }).click();
  await sleep(500);
  await a.getByRole('button', { name: 'Back' }).click();
  await sleep(600);

  // B's safety number must match A's
  await b.getByRole('button', { name: /Anna Berger, show info/ }).click();
  await sleep(500);
  await b.getByText('Safety number').first().click();
  await b.locator('.safety-grid').waitFor();
  const numB = await b.locator('.safety-grid').innerText();
  if (numA !== numB) throw new Error(`safety numbers differ:\n${numA}\n${numB}`);
  await b.getByRole('button', { name: 'Back' }).click();
  await sleep(450);
  await b.getByRole('button', { name: 'Back' }).click();
  await sleep(450);
  await b.getByRole('button', { name: 'Back' }).click();
  await sleep(450);

  // Unregistered number -> invite
  await a.getByRole('button', { name: 'New chat' }).click();
  await sleep(500);
  await a.getByLabel('Phone number').fill('0151 33333333');
  await a.getByRole('button', { name: 'Find' }).click();
  await a.getByText('isn’t on Haven yet').waitFor();
  await shot(a, 'a-10-invite');

  // Group
  await a.getByText('New group').click();
  await sleep(400);
  await a.getByRole('checkbox', { name: /Ben Okafor/ }).click();
  await shot(a, 'a-11-group-pick');
  await a.getByRole('button', { name: 'Next' }).click();
  await a.getByLabel('Group name').fill('Weekend trip');
  await sleep(300);
  await shot(a, 'a-12-group-name');
  await a.getByRole('button', { name: 'Create' }).click();
  await a.getByLabel('Message').waitFor();
  await a.getByLabel('Message').fill('Who is in for Saturday?');
  await a.getByRole('button', { name: 'Send' }).click();
  await sleep(1000);
  await b.getByText('Weekend trip').waitFor({ timeout: 10000 });
  await b.getByText('Weekend trip').click();
  await b.getByText('Who is in for Saturday?').waitFor();
  await b.getByLabel('Message').fill('Me! 🙋');
  await b.getByRole('button', { name: 'Send' }).click();
  await sleep(1200);
  await shot(b, 'b-03-group');
  await a.locator('.stack-item.top .bubble-text', { hasText: 'Me! 🙋' }).waitFor({ timeout: 10000 });
  await shot(a, 'a-13-group');

  // Group info
  await a.getByRole('button', { name: /Weekend trip, show info/ }).click();
  await sleep(600);
  await shot(a, 'a-14-group-info');
  await a.getByRole('button', { name: 'Back' }).click();
  await sleep(450);
  await a.getByRole('button', { name: 'Back' }).click();
  await sleep(600);
  await shot(a, 'a-15-list');

  // Settings
  await a.getByRole('button', { name: 'Settings' }).click();
  await sleep(400);
  await shot(a, 'a-16-settings');
  await b.getByRole('button', { name: 'Back' }).click();
  await sleep(500);
  await b.getByRole('button', { name: 'Settings' }).click();
  await sleep(400);
  await shot(b, 'b-04-settings-dark');

  // Registration lock
  await a.getByText('Registration lock').click();
  await sleep(500);
  await a.getByLabel('New PIN').fill('482915');
  await a.getByLabel('Repeat PIN').fill('482915');
  await a.getByRole('button', { name: 'Turn on' }).click();
  await a.getByText('Registration lock is on').first().waitFor();
  await shot(a, 'a-17-reglock');
  await a.getByRole('button', { name: 'Back' }).click();
  await sleep(500);

  // Long-press action sheet in chat (context menu)
  await a.getByRole('button', { name: 'Chats' }).click();
  await sleep(300);

  // ---- B moves to a new device: A must see a safety number notice, and new
  // messages must be readable on B's new device.
  const b2 = await phone(browser, 'B2');
  await sleep(31000); // per-number resend limit
  await b2.goto(BASE);
  await b2.getByRole('button', { name: 'Get started' }).click();
  await b2.getByLabel('Phone number').fill('0151 22222222');
  await b2.getByRole('button', { name: 'Continue' }).click();
  await b2.getByLabel('Verification code').waitFor();
  await b2.getByLabel('Verification code').pressSequentially(codeFor('+4915122222222'), { delay: 30 });
  await b2.getByRole('heading', { name: 'Chats', exact: true }).waitFor({ timeout: 10000 });
  await sleep(1500);

  await a.locator('.chat-row', { hasText: 'Ben Okafor' }).click();
  await a.locator('.stack-item.top .system-line.notice').waitFor({ timeout: 10000 });
  await a.getByLabel('Message').fill('Welcome to your new phone');
  await a.getByRole('button', { name: 'Send' }).click();
  await sleep(1500);
  await shot(a, 'a-18-key-changed');
  await b2.locator('.chat-row', { hasText: 'Anna Berger' }).click();
  await b2.locator('.bubble-text', { hasText: 'Welcome to your new phone' }).waitFor({ timeout: 10000 });
  await shot(b2, 'b2-01-new-device');

  // The old device B was signed out by the new sign-in.
  await b.getByRole('button', { name: /Continue as/ }).waitFor({ timeout: 10000 });
  await shot(b, 'b-05-signed-out');

  // ---- Android back button closes the top screen
  await a.goBack();
  await sleep(600);
  await a.getByRole('heading', { name: 'Chats', exact: true }).waitFor();

  // ---- Registration lock: signing in to A's number elsewhere needs the PIN
  const a2 = await phone(browser, 'A2');
  await a2.goto(BASE);
  await a2.getByRole('button', { name: 'Get started' }).click();
  await a2.getByLabel('Phone number').fill('0151 11111111');
  await a2.getByRole('button', { name: 'Continue' }).click();
  await a2.getByLabel('Verification code').waitFor();
  await a2.getByLabel('Verification code').pressSequentially(codeFor('+4915111111111'), { delay: 30 });
  await a2.getByLabel('PIN').waitFor({ timeout: 10000 });
  await a2.getByLabel('PIN').fill('111111');
  await a2.getByRole('button', { name: 'Continue' }).click();
  await a2.getByText(/Wrong PIN/).waitFor();
  await shot(a2, 'a2-01-pin-wrong');
  await a2.getByLabel('PIN').fill('482915');
  await a2.getByRole('button', { name: 'Continue' }).click();
  await a2.getByRole('heading', { name: 'Chats', exact: true }).waitFor({ timeout: 10000 });

  console.log('safety number', numA.replace(/\s+/g, ' '));
  console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
  await browser.close();
})().catch(async (e) => {
  console.error('FAILED', e);
  console.log(errors.join('\n'));
  process.exit(1);
});
