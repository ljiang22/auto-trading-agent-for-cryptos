const { chromium } = require('playwright');
const fs = require('fs');

const BASE_URL  = process.env.STAGING_URL || 'https://staging.sentiedge.ai';
const EMAIL     = process.env.TEST_EMAIL;
const PASSWORD  = process.env.TEST_PASSWORD;

const QUESTIONS = [
  'What is the current price and 24h change for Bitcoin?',
  'Give me a technical analysis of Ethereum with support and resistance levels.',
  "What's the sentiment analysis for Solana based on recent news?",
  'Show me a price chart for BTC over the last 30 days.',
  'What are the on-chain metrics for Ethereum right now?',
  'Compare the performance of BTC, ETH, and SOL over the past week.',
  "What's the fear and greed index for crypto today?",
  'Generate a comprehensive market analysis report for Bitcoin.',
  'What are the latest news headlines for Dogecoin?',
  "What's your trading signal recommendation for Ethereum?",
];

const FALLBACK_PATTERNS = /\b(sorry|error|couldn't|unable to|something went wrong|please try again|let me check|I encountered|unavailable)\b/i;

fs.mkdirSync('screenshots', { recursive: true });

function slug(i, text) {
  return 'q' + String(i + 1).padStart(2, '0') + '_' + text.slice(0, 30).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

function classifyText(text) {
  var str = (text === null || text === undefined) ? '' : (typeof text === 'string' ? text : JSON.stringify(text));
  var trimmed = str.trim();
  if (!trimmed || trimmed.length < 20) return { type: 'error', text: trimmed };
  if (FALLBACK_PATTERNS.test(trimmed)) return { type: 'fallback', text: trimmed };
  return { type: 'good', text: trimmed };
}

async function getAgentMemoryCount(page, agentId, roomId) {
  return page.evaluate(async (args) => {
    try {
      var r = await fetch('/agents/' + args.aid + '/' + args.rid + '/memories', { credentials: 'include' });
      var data = await r.json();
      return (data.memories || []).filter((m) => m.userId === args.aid).length;
    } catch(e) { return -1; }
  }, { aid: agentId, rid: roomId });
}

async function getLatestAgentMemory(page, agentId, roomId) {
  return page.evaluate(async (args) => {
    try {
      var r = await fetch('/agents/' + args.aid + '/' + args.rid + '/memories', { credentials: 'include' });
      var data = await r.json();
      var agentMems = (data.memories || []).filter((m) => m.userId === args.aid);
      return agentMems.length > 0 ? agentMems[agentMems.length - 1] : null;
    } catch(e) { return null; }
  }, { aid: agentId, rid: roomId });
}

async function waitForNewAgentMemory(page, agentId, roomId, countBefore, maxWaitMs) {
  if (!maxWaitMs) maxWaitMs = 480000; // 8 minutes
  var start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(10000);
    var count = await getAgentMemoryCount(page, agentId, roomId);
    if (count > countBefore) return true;
  }
  return false;
}

(async () => {
  var report = { sidebar_chat_count: 0, questions: [], login_ok: false, error: null };

  // Pre-check: verify credentials work against the Django auth API before launching browser
  if (EMAIL && PASSWORD) {
    try {
      var https = require('https');
      var loginCheck = await new Promise((resolve, reject) => {
        var body = JSON.stringify({ email: EMAIL, password: PASSWORD });
        var req = https.request('https://api.sentiedge.ai/api/authentication/validation/', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
          var data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => { resolve({ status: res.statusCode, body: data.slice(0, 200) }); });
        });
        req.on('error', (e) => { reject(e); });
        req.write(body);
        req.end();
      });
      console.log('[CRED-CHECK] API status:', loginCheck.status, '| body:', loginCheck.body);
      if (loginCheck.status !== 200 && loginCheck.status !== 201) {
        report.error = 'Credential pre-check failed: HTTP ' + loginCheck.status + ' — ' + loginCheck.body;
        fs.writeFileSync('e2e-report.json', JSON.stringify(report, null, 2));
        console.log('Aborted: test credentials rejected by API. Update STAGING_TEST_EMAIL / STAGING_TEST_PASSWORD secrets.');
        process.exit(1);
      }
      console.log('[CRED-CHECK] Credentials valid — proceeding to browser test.');
    } catch (credErr) {
      console.log('[CRED-CHECK] Error:', credErr.message, '— skipping pre-check');
    }
  }
  var browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  var context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  var page = await context.newPage();

  var consoleErrors = [];
  var failedRequests = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('requestfailed', (req) => { failedRequests.push(req.failure().errorText + ' ' + req.url()); });

  // Intercept asset responses to capture full diagnostic info
  // Log API responses (login, billing, etc.) for diagnostics
  page.on('response', (apiResp) => {
    var apiUrl = apiResp.url();
    if (apiUrl.indexOf('sentiedge.ai') !== -1 && apiUrl.indexOf('/assets/') === -1) {
      var s = apiResp.status();
      apiResp.text().then((body) => {
        console.log('[API] ' + s + ' ' + apiUrl.replace(/https?:\/\/[^/]+/, '') + ' body=' + body.slice(0, 150));
      }).catch(() => {});
    }
  });

  page.on('response', (resp) => {
    var url = resp.url();
    if (url.indexOf('/assets/') !== -1 && (url.slice(-3) === '.js' || url.slice(-4) === '.css')) {
      var status = resp.status();
      var respHdrs = resp.headers();
      resp.request().allHeaders().then((reqHdrs) => {
        resp.body().then((buf) => {
          var body = buf.toString('utf8').slice(0, 100);
          console.log('[ASSET] status=' + status + ' ct=' + (respHdrs['content-type'] || 'none') + ' file=' + url.split('/').pop());
          console.log('[ASSET-REQ] sec-fetch-dest=' + reqHdrs['sec-fetch-dest'] + ' sec-fetch-site=' + reqHdrs['sec-fetch-site'] + ' accept=' + reqHdrs['accept']);
          console.log('[ASSET-BODY] ' + body);
        }).catch(() => {});
      }).catch(() => {});
    }
  });

  try {
    console.log('[1] Navigating to', BASE_URL);
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30000 });
    console.log('  URL after load:', page.url());

    var title = await page.title();
    var bodyLen = await page.evaluate(() => document.body ? document.body.innerHTML.length : -1);
    var bodySnippet = await page.evaluate(() => document.body ? document.body.innerHTML.slice(0, 200) : 'NO BODY');
    console.log('  Title:', title, '| body HTML length:', bodyLen);
    console.log('  Body snippet:', bodySnippet);
    if (consoleErrors.length) console.log('  JS errors:', consoleErrors.slice(0, 3).join(' | '));
    if (failedRequests.length) console.log('  Failed requests:', failedRequests.slice(0, 3).join(' | '));

    await page.screenshot({ path: 'screenshots/00_landing.png', fullPage: true });

    await page.goto(BASE_URL + '/signin', { waitUntil: 'load', timeout: 20000 });
    console.log('  /signin URL:', page.url());
    if (consoleErrors.length) console.log('  JS errors:', consoleErrors.slice(0, 3).join(' | '));

    await page.screenshot({ path: 'screenshots/01_signin_page.png', fullPage: true });

    await page.locator('input[type="email"], input[name="email"], input[id="email"]').first().waitFor({ timeout: 20000 });
    await page.locator('input[type="email"], input[name="email"], input[id="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD);
    await page.screenshot({ path: 'screenshots/02_signin_filled.png', fullPage: true });

    await Promise.all([
      page.waitForURL((url) => url.toString().indexOf('signin') === -1 && url.toString().indexOf('login') === -1, { timeout: 25000 }).catch(() => {}),
      page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")').first().click(),
    ]);

    await page.screenshot({ path: 'screenshots/03_post_login.png', fullPage: true });
    console.log('[2] Post-login URL:', page.url());

    // Capture any visible error on the signin page
    if (page.url().indexOf('signin') !== -1 || page.url().indexOf('login') !== -1) {
      var errorText = await page.locator('[class*="toast"], [class*="error"], [role="alert"], [class*="alert"]').first().textContent().catch(() => '');
      var jsErrs = consoleErrors.slice(-3).join(' | ');
      console.log('  Login error on page:', errorText || '(no toast/alert found)');
      if (jsErrs) console.log('  Console errors:', jsErrs);
      throw new Error('Login failed — still on auth page. Page error: ' + (errorText || 'unknown'));
    }
    report.login_ok = true;

    // Navigate to /agents and try to click the Chat button (UI-based flow)
    await page.goto(BASE_URL + '/agents', { waitUntil: 'load', timeout: 25000 });
    // Wait for the agents API response to populate the React card list
    await page.waitForResponse((resp) => resp.url().indexOf('/agents') !== -1 && resp.status() === 200, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/04_agents_page.png', fullPage: true });
    console.log('[3] /agents URL:', page.url());

    // Dump DOM to debug what buttons are present
    var btnDump = await page.evaluate(() => {
      var btns = Array.from(document.querySelectorAll('button'));
      return btns.slice(0, 20).map((b) => {
        var rect = b.getBoundingClientRect();
        return b.textContent.trim().slice(0, 40) + '|cls=' + b.className.slice(0, 60) + '|vis=' + (rect.width > 0 && rect.height > 0);
      });
    });
    console.log('[3-debug] Buttons on page:', JSON.stringify(btnDump));

    // Try clicking the Chat button (attached state = in DOM, even if scrolled off screen)
    var chatClicked = false;
    try {
      var chatBtnLocator = page.locator('button.grow').or(page.getByRole('button', { name: 'Chat', exact: true })).first();
      await chatBtnLocator.waitFor({ state: 'attached', timeout: 8000 });
      await chatBtnLocator.scrollIntoViewIfNeeded();
      await chatBtnLocator.click({ force: true, timeout: 5000 });
      await page.waitForURL((url) => url.toString().indexOf('/chat/') !== -1, { timeout: 12000 });
      chatClicked = true;
      console.log('[3b] Chat button clicked — navigated to:', page.url());
    } catch (btnErr) {
      console.log('[3b] Chat button click failed (' + btnErr.message.slice(0, 80) + ') — falling back to API navigation');
    }

    // API fallback: if Chat button click did not navigate us to a chat room
    if (!chatClicked) {
      var agentsData = await page.evaluate(async () => {
        var r = await fetch('/agents', { credentials: 'include' });
        return r.json();
      });
      var agentId = agentsData.agents && agentsData.agents[0] ? agentsData.agents[0].id : null;
      if (!agentId) { throw new Error('No agents returned from /agents API'); }
      console.log('[3a] AgentId (API fallback):', agentId);

      var roomsData = await page.evaluate(async (aid) => {
        var r = await fetch('/agents/' + aid + '/rooms', { credentials: 'include' });
        return r.json();
      }, agentId);
      var roomId = null;
      if (roomsData.rooms && roomsData.rooms.length > 0) {
        roomId = roomsData.rooms[0].id;
        report.sidebar_chat_count = roomsData.rooms.length;
        console.log('[3b] Using existing room:', roomId, '(' + roomsData.rooms.length + ' total)');
      } else {
        var newRoom = await page.evaluate(async (aid) => {
          var r = await fetch('/agents/' + aid + '/rooms', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'E2E Test Room' })
          });
          return r.json();
        }, agentId);
        roomId = newRoom.room ? newRoom.room.id : null;
        console.log('[3b] Created new room:', roomId);
      }
      if (!roomId) { throw new Error('Could not get or create a room'); }

      // Navigate directly to chat room
      await page.goto(BASE_URL + '/chat/' + agentId + '/' + roomId, { waitUntil: 'load', timeout: 25000 });
      await page.waitForTimeout(3000);
    } else {
      // Extract agentId/roomId from URL after button-click navigation
      var chatPath = page.url().replace(/.*\/chat\//, '');
      var chatParts = chatPath.split('/');
      var agentId = chatParts[0] || null;
      var roomId = chatParts[1] || null;
      if (!agentId || !roomId) { throw new Error('URL extraction failed: ' + page.url()); }
      console.log('[3c] Extracted agentId:', agentId, '| roomId:', roomId);
    }
    await page.screenshot({ path: 'screenshots/05_chat_page.png', fullPage: true });
    console.log('[4] Chat URL:', page.url());

    var inputSel = 'textarea[placeholder], textarea[class*="input"], textarea[class*="message"], [contenteditable="true"]';

    for (var i = 0; i < QUESTIONS.length; i++) {
      var q = QUESTIONS[i];
      console.log('[Q' + (i + 1) + '] ' + q);

      var input = page.locator(inputSel).first();
      await input.fill(q);

      // Count agent memories BEFORE sending (via API — DOM selectors don't match this app's components)
      var memCountBefore = await getAgentMemoryCount(page, agentId, roomId);

      var t0 = Date.now();
      await input.press('Enter');

      // Poll memories API (up to 8 min) for a new agent memory
      var responded = await waitForNewAgentMemory(page, agentId, roomId, memCountBefore, 480000);
      var responseMs = Date.now() - t0;

      // Get response text from API
      var latestMem = await getLatestAgentMemory(page, agentId, roomId);
      var rawText = latestMem ? ((latestMem.content && latestMem.content.text) || '') : '';
      var classified = classifyText(responded ? rawText : '');
      var responseType = classified.type;
      var responseText = classified.text;

      // Check for chart elements in DOM
      var hasChart = await page.locator('canvas, [class*="chart"], [class*="Chart"], img[src*="chart"]').count() > 0;

      var screenshotName = 'screenshots/' + slug(i, q) + '.png';
      await page.screenshot({ path: screenshotName, fullPage: true });
      console.log('  type=' + responseType + '  time=' + responseMs + 'ms  chart=' + hasChart + '  len=' + responseText.length);

      report.questions.push({
        question: q,
        response_type: responseType,
        response_time_ms: responseMs,
        has_chart: hasChart,
        response_preview: responseText.slice(0, 200),
        screenshot: screenshotName,
      });

      if (i < QUESTIONS.length - 1) {
        console.log('  ... waiting 15s before next question');
        await page.waitForTimeout(15000);
      }
    }
  } catch (err) {
    console.error('E2E ERROR:', err.message);
    report.error = err.message;
    await page.screenshot({ path: 'screenshots/error_state.png', fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
    fs.writeFileSync('e2e-report.json', JSON.stringify(report, null, 2));
    console.log('\nReport written to e2e-report.json');

    if (report.questions.length) {
      console.log('=== E2E Summary ===');
      console.log('Login OK:', report.login_ok);
      report.questions.forEach((q, idx) => {
        var icon = q.response_type === 'good' ? 'PASS' : q.response_type === 'fallback' ? 'WARN' : 'FAIL';
        console.log(icon, 'Q' + (idx + 1), '|', q.response_type.toUpperCase().padEnd(8), '|', String(q.response_time_ms).padStart(6) + 'ms', '|', q.has_chart ? '[chart]' : '       ', '|', q.question.slice(0, 55));
      });
    }

    if (report.error) process.exit(1);
  }
})();
