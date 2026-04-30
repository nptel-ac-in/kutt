// Phase-7 manual spot-check spec for the per-URL cache_ttl feature.
// Runs against a local kutt instance (default: http://localhost:3000) with
// admin user admin@local.test / localpass1!.
//
// Boot the stack first:
//   docker compose -f docker-compose.sqlite-redis.yml \
//     -f docker-compose.override.yml up -d --build
//   curl -X POST -H 'Content-Type: application/json' \
//     -d '{"email":"admin@local.test","password":"localpass1!"}' \
//     http://localhost:3000/api/v2/auth/create-admin
//
// Then run:
//   docker run --rm --network host -v "$PWD:/work" -w /work \
//     mcr.microsoft.com/playwright:v1.58.0-noble \
//     sh -c 'npm i -D @playwright/test@1.58.0 && npx playwright test server/tests/playwright-smoke.spec.js --reporter=list'

const { test, expect } = require("@playwright/test");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = "admin@local.test";
const PASSWORD = "localpass1!";

async function login(page) {
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/$/, { timeout: 10000 });
}

async function openAdvanced(page) {
  const cb = page.locator('input[name="show_advanced"]');
  if (!(await cb.isChecked())) await cb.check();
  await expect(page.locator('input[name="cache_ttl"]')).toBeVisible();
}

async function submitShorten(page) {
  await page.locator('#shortener-form button.submit').click();
  await page.waitForLoadState("networkidle");
}

test.describe("cache_ttl manual spot-checks", () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test("1. shortener form has cache_ttl input with min/max", async ({ page }) => {
    await page.goto(BASE + "/");
    const input = page.locator('input[name="cache_ttl"]');
    await expect(input).toHaveCount(1);
    await expect(input).toHaveAttribute("type", "number");
    await expect(input).toHaveAttribute("min", "0");
    await expect(input).toHaveAttribute("max", "604800");
  });

  test("2. cache_ttl placeholder mentions default 300 and disabling", async ({ page }) => {
    await page.goto(BASE + "/");
    const ph = await page.locator('input[name="cache_ttl"]').getAttribute("placeholder");
    expect(ph).toContain("300");
    expect(ph).toContain("0 disables");
  });

  test("3. cache_ttl input is hidden by default; visible after toggling 'Show advanced'", async ({ page }) => {
    await page.goto(BASE + "/");
    await expect(page.locator('input[name="cache_ttl"]')).not.toBeVisible();
    await page.locator('input[name="show_advanced"]').check();
    await expect(page.locator('input[name="cache_ttl"]')).toBeVisible();
  });

  test("4. create link with cache_ttl=120 via UI persists in API", async ({ page }) => {
    await page.goto(BASE + "/");
    await openAdvanced(page);
    await page.fill('input[name="target"]', "https://playwright.test/four");
    await page.fill('input[name="cache_ttl"]', "120");
    await submitShorten(page);
    const body = await (await page.request.get(BASE + "/api/v2/links?limit=20", {
      headers: { Accept: "application/json" } })).json();
    const match = body.data.find(l => l.target === "https://playwright.test/four");
    expect(match).toBeTruthy();
    expect(match.cache_ttl).toBe(120);
  });

  test("5. row badge shows 'Cache: 120s' in HTML list", async ({ page }) => {
    const html = await (await page.request.get(BASE + "/api/v2/links?limit=20", {
      headers: { Accept: "text/html" } })).text();
    expect(html).toContain("Cache: 120s");
  });

  test("6. create link without cache_ttl → API returns null", async ({ page }) => {
    await page.goto(BASE + "/");
    await page.fill('input[name="target"]', "https://playwright.test/null-ttl");
    await submitShorten(page);
    const body = await (await page.request.get(BASE + "/api/v2/links?limit=20", {
      headers: { Accept: "application/json" } })).json();
    const match = body.data.find(l => l.target === "https://playwright.test/null-ttl");
    expect(match).toBeTruthy();
    expect(match.cache_ttl).toBeNull();
  });

  test("7. cache_ttl=0 produces 'Cache: off' badge", async ({ page }) => {
    await page.goto(BASE + "/");
    await openAdvanced(page);
    await page.fill('input[name="target"]', "https://playwright.test/zero");
    await page.fill('input[name="cache_ttl"]', "0");
    await submitShorten(page);
    const html = await (await page.request.get(BASE + "/api/v2/links?limit=20", {
      headers: { Accept: "text/html" } })).text();
    expect(html).toContain("Cache: off");
  });

  test("8. invalid value 999999 does not create the link", async ({ page }) => {
    await page.goto(BASE + "/");
    await openAdvanced(page);
    await page.fill('input[name="target"]', "https://playwright.test/bad");
    await page.fill('input[name="cache_ttl"]', "999999");
    await submitShorten(page);
    const body = await (await page.request.get(BASE + "/api/v2/links?limit=50", {
      headers: { Accept: "application/json" } })).json();
    const match = body.data.find(l => l.target === "https://playwright.test/bad");
    expect(match).toBeUndefined();
  });

  test("9. redirect of cache_ttl=120 link emits matching Cache-Control", async ({ page }) => {
    const body = await (await page.request.get(BASE + "/api/v2/links?limit=20", {
      headers: { Accept: "application/json" } })).json();
    const match = body.data.find(l => l.cache_ttl === 120);
    expect(match).toBeTruthy();
    const r = await page.request.get(BASE + "/" + match.address, { maxRedirects: 0 });
    const cc = r.headers()["cache-control"];
    expect(cc).toBe("public, max-age=120, s-maxage=120");
  });

  test("10. redirect of cache_ttl=0 link emits no-store", async ({ page }) => {
    const body = await (await page.request.get(BASE + "/api/v2/links?limit=20", {
      headers: { Accept: "application/json" } })).json();
    const match = body.data.find(l => l.cache_ttl === 0);
    expect(match).toBeTruthy();
    const r = await page.request.get(BASE + "/" + match.address, { maxRedirects: 0 });
    const cc = r.headers()["cache-control"];
    expect(cc).toBe("no-store, max-age=0");
  });
});
