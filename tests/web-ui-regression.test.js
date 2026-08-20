import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'apps/web/public/app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'apps/web/public/styles.css'), 'utf8');

test('timeline updates preserve existing DOM and user scroll position', () => {
  assert.doesNotMatch(appSource, /root\.innerHTML\s*=\s*events\.map/);
  assert.match(appSource, /isNearTimelineBottom\(root\)/);
  assert.match(appSource, /node\.dataset\.eventKey=key/);
  assert.match(appSource, /if\(shouldStick\)requestAnimationFrame/);
  assert.match(cssSource, /\.timeline-item-new\s*\{\s*animation:/);
  assert.doesNotMatch(appSource, /Math\.random\(\)/);
});

test('conversation titles and model retry state are wired into the PWA', () => {
  assert.match(appSource, /conversationTitles\.set\(conversation\.id,conversation\.title/);
  assert.match(appSource, /state\.conversationTitle=listedTitle\|\|id\.slice/);
  assert.match(appSource, /modelsLoaded:false/);
  assert.match(appSource, /retryModels/);
  assert.match(appSource, /if\(!state\.modelsLoaded&&!state\.modelsLoading\)loadModels\(\)/);
  assert.match(cssSource, /\.model-retry\[hidden\]\s*\{\s*display:\s*none;/);
});

test('activity rows remain readable without native details rendering', () => {
  assert.doesNotMatch(appSource, /<details class="activity-row/);
  assert.match(appSource, /<button type="button" class="activity-summary" aria-expanded="false">/);
  assert.match(appSource, /shorten\(e\.command,55\)\|\|'Preparing command…'/);
  assert.match(appSource, /class="step-verb"/);
  assert.match(cssSource, /\.activity-summary\s*\{[\s\S]*?width:\s*100%;/);
});
