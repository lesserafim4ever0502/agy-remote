import path from "node:path";
import { chromium } from "playwright-core";
import { createPairingSecret } from "../apps/bridge/src/auth.js";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const artifactDir = "C:/Users/ljr13/.gemini/antigravity/brain/fdf60586-ca07-4bdd-98a4-eca84f483a63";

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true
});

const viewports = [
  { name: "small_android_360", width: 360, height: 740 },
  { name: "iphone14_390", width: 390, height: 844 },
  { name: "pixel7_412", width: 412, height: 915 }
];

for (const vp of viewports) {
  console.log(`\n=== Auditing Viewport: ${vp.name} (${vp.width}x${vp.height}) ===`);
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });

  const page = await context.newPage();
  const { secret } = createPairingSecret();
  await page.goto(`http://127.0.0.1:7317/#pair=${secret}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  // 1. Inject Rich Conversation Data
  await page.evaluate(() => {
    const timeline = document.querySelector("#timeline");
    timeline.className = "timeline";
    timeline.innerHTML = `
      <article class="event user">
        <div class="meta">user · step 0</div>
        <div>Please write a comprehensive Python script, ask a question, and request approval to run a command.</div>
      </article>

      <article class="event assistant">
        <div class="meta">assistant · step 1</div>
        <div class="markdown-body">
          <h3>Implementation Plan & Code</h3>
          <p>Here is the optimized data pipeline implementation in <strong>Python 3.12</strong>:</p>
          <div class="code-block">
            <div class="code-header"><span class="code-lang">python</span><button type="button" class="copy-btn" onclick="copyCode(this)">Copy</button></div>
            <pre><code>import os
import sys
import json

def process_large_dataset(filepath: str, batch_size: int = 1000) -> dict:
    """Processes large dataset with streaming generator to conserve memory."""
    print(f"Loading data from {filepath} with batch_size={batch_size}...")
    return {"status": "success", "processed_records": 150000}

if __name__ == "__main__":
    result = process_large_dataset("data/large_stream_input_2026.jsonl")
    print(json.dumps(result, indent=2))</code></pre>
          </div>
          <p>Key highlights of this approach:</p>
          <ul>
            <li>Memory footprint stays under <code>50MB</code> even with gigabytes of data.</li>
            <li>Fully compliant with <em>RFC 8292</em> standards.</li>
            <li>Supports automatic retry on network disconnects.</li>
          </ul>
        </div>
      </article>

      <!-- Run Command Approval Card -->
      <article class="event approval">
        <div class="meta">command execution approval · step 2</div>
        <div class="approval-card">
          <div><strong>Proposed Command:</strong></div>
          <pre>$ python scripts/process_data.py --input-dir=/var/log/antigravity --verbose --output-format=json</pre>
          <div><label><small>Edit Command before running:</small></label><input id="cmd_input_test" value="python scripts/process_data.py --input-dir=/var/log/antigravity --verbose" /></div>
          <div class="actions-wrap">
            <button class="primary-btn" data-act="cmd">Run Command</button>
            <button class="danger-btn" data-act="cmd">Reject</button>
          </div>
        </div>
      </article>

      <!-- Ask Question Card -->
      <article class="event approval">
        <div class="meta">question from agent · step 3</div>
        <div class="approval-card">
          <div class="question-item">
            <span class="question-label">Which optimization strategy would you like to apply to the database indexing?</span>
            <div class="options-group">
              <label class="option-label"><input type="radio" name="opt_strategy" value="A" checked /> <span>Option A: Composite B-Tree Index on (tenant_id, created_at)</span></label>
              <label class="option-label"><input type="radio" name="opt_strategy" value="B" /> <span>Option B: Partial GIN Index with JSONB path expressions</span></label>
            </div>
            <input placeholder="Optional extra instructions or notes…" />
          </div>
          <div class="actions-wrap">
            <button class="primary-btn">Submit Answer</button>
            <button class="ghost-btn">Cancel</button>
          </div>
        </div>
      </article>

      <!-- File Permission Card -->
      <article class="event approval">
        <div class="meta">file permission required · step 4</div>
        <div class="approval-card">
          <div><strong>File:</strong> <code>E:/antigravity_projs/agy-remote/src/critical/config.secret.json</code></div>
          <div><small>Reason: Updating database connection string for staging</small></div>
          <div class="actions-wrap">
            <button class="primary-btn">Allow Once</button>
            <button class="ghost-btn">Allow Session</button>
            <button class="ghost-btn">Allow Workspace</button>
            <button class="danger-btn">Reject</button>
          </div>
        </div>
      </article>
    `;
  });

  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(artifactDir, `audit_${vp.name}_conv_top.png`) });

  // Scroll down to check approval cards
  await page.evaluate(() => {
    const timeline = document.querySelector("#timeline");
    timeline.scrollTop = timeline.scrollHeight;
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(artifactDir, `audit_${vp.name}_conv_bottom.png`) });
  console.log(`Saved audit_${vp.name}_conv_top.png & bottom.png`);

  // 2. Audit Drawer
  await page.click("#drawerBtn");
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(artifactDir, `audit_${vp.name}_drawer.png`) });
  await page.click("#closeDrawerBtn");
  await page.waitForTimeout(200);

  // 3. Audit Terminal
  await page.click('[data-tab="terminal"]');
  await page.evaluate(() => {
    const list = document.querySelector("#terminalList");
    list.innerHTML = `
      <button class="chip active">cmd.exe [1]</button>
      <button class="chip">powershell.exe [2]</button>
      <button class="chip">bash.exe [3]</button>
      <button class="chip">node repl [4]</button>
    `;
    const out = document.querySelector("#terminalOutput");
    out.textContent = `Microsoft Windows [Version 10.0.22631.4890]\n(c) Microsoft Corp.\n\nC:\\Users\\ljr13\\agy-remote> npm test\nℹ pass 25\nℹ duration_ms 737.2431\n\nC:\\Users\\ljr13\\agy-remote> _`;
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(artifactDir, `audit_${vp.name}_terminal.png`) });

  // 4. Audit Browser
  await page.click('[data-tab="browser"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(artifactDir, `audit_${vp.name}_browser.png`) });

  await context.close();
}

await browser.close();
console.log("\nFull 360-degree UI/UX audit finished successfully!");
