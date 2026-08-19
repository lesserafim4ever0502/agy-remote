import path from "node:path";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const artifactDir = "C:/Users/ljr13/.gemini/antigravity/brain/fdf60586-ca07-4bdd-98a4-eca84f483a63";

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true
});

const page = await context.newPage();
const token = "3dcf18543d15be3120ac5cdcc32652a796e4fe3c0d5d4cb6f9afee68cfef8b99";

await page.goto(`http://127.0.0.1:7317/#token=${token}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// 1. Capture Agent Tab
await page.screenshot({ path: path.join(artifactDir, "mobile_ui_agent.png") });
console.log("Captured mobile_ui_agent.png");

// 2. Open Drawer and Capture
await page.click("#drawerBtn");
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(artifactDir, "mobile_ui_drawer.png") });
console.log("Captured mobile_ui_drawer.png");

// Close drawer
await page.click("#closeDrawerBtn");
await page.waitForTimeout(300);

// 3. Switch to Terminal Tab
await page.click('[data-tab="terminal"]');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(artifactDir, "mobile_ui_terminal.png") });
console.log("Captured mobile_ui_terminal.png");

// 4. Switch to Browser Tab
await page.click('[data-tab="browser"]');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(artifactDir, "mobile_ui_browser.png") });
console.log("Captured mobile_ui_browser.png");

await browser.close();
console.log("All screenshots captured successfully.");
