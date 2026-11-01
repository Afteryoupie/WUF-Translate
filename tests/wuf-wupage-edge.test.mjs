import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { DEFAULT_SETTINGS } from '../dist/wuf/index.js';

const edge = process.env.EDGE_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(80); }
  throw new Error(`Timed out: ${description}`);
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let id = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  return { close: () => socket.close(), send: (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
  }) };
}
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

const readme = `<!doctype html><meta charset="utf-8"><style>
body { background:#0d1117;color:#f0f6fc;font:18px/1.6 system-ui;margin:32px auto;max-width:1000px } a{color:#4493f8} code{background:#252a32;padding:2px 5px;border-radius:4px} blockquote{border-left:5px solid #3d444d;padding-left:22px;color:#9198a1} h3{line-height:1.4}
</style><article class="markdown-body"><p id="first">Distant opening paragraph.</p><div style="height:1200px"></div>
<h3 id="release"><strong>[2026.10.28]</strong> <a href="#release"><code>v1.7.0</code></a> — Modular installation, a refreshed learning workspace, block notebooks with Dito, narrated video lessons, resumable embedding checkpoints, and more reliable tutoring.</h3>
<blockquote><p id="quoted">[2026.10.28] <a href="#release">v1.7.0</a> — Modular installation and a refreshed learning workspace.</p></blockquote>
<details><summary>Past releases (more than 1 week ago)</summary><p>Older release notes.</p></details>
<p id="rich">Read <a id="guide" href="#guide"><strong>the contribution guide</strong></a> and run <code>fetch()</code> carefully.</p>
<p id="dynamic" hidden>Newly revealed paragraph.</p><div id="prose">Readable prose in a div.</div>
<div style="height:1800px"></div><p id="last">Background conclusion paragraph.</p></article>`;

test('Edge loads the complete extension: WuPage engine through real content/background messages', { skip: !existsSync(edge), timeout: 60000 }, async t => {
  const requests = []; let dropMarkers = true; let pendingResponse; let forceServiceError = false;
  const handler = async (request, response) => {
    if (request.url === '/v1/chat/completions') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); const userContent = body.messages.at(-1).content;
      let input; try { input = JSON.parse(userContent); } catch { input = null; }
      const structured = Array.isArray(input?.texts);
      const source = structured ? input.texts.join('\n') : userContent;
      requests.push({ source, prompt: body.messages[0].content });
      if (forceServiceError) { response.writeHead(401).end('test failure'); return; }
      if (source.includes('Service failure after scrolling')) { response.writeHead(401).end('test failure'); return; }
      if (source.includes('Hold this request')) { pendingResponse = response; return; }
      const output = (structured ? input.texts : source.split('\n---WUF-SEG---\n')).map(text => {
        if (dropMarkers && text.includes('⟪WUPAGE')) return '服務漏掉了保護標記';
        return '譯文：' + text.replace('Modular installation', '模組化安裝').replace('a refreshed learning workspace', '更新的學習工作區')
          .replace('block notebooks with Dito', '搭配 Dito 的區塊筆記本').replace('narrated video lessons', '旁白影片課程')
          .replace('resumable embedding checkpoints', '可續傳的嵌入檢查點').replace('and more reliable tutoring.', '以及更可靠的輔導。');
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: structured ? JSON.stringify(output) : output.join('\n---WUF-SEG---\n') } }] })); return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url?.startsWith('/watch')) response.end('<!doctype html><meta charset="utf-8"><ytd-watch-flexy><div id="primary"><ytd-watch-metadata><h1><yt-formatted-string>Fixture video title</yt-formatted-string></h1></ytd-watch-metadata><ytd-comment-renderer><yt-attributed-string id="content-text"><span>Legacy comment body.</span></yt-attributed-string></ytd-comment-renderer><ytd-comment-view-model><yt-attributed-string id="content-text"><span>Current comment body.</span></yt-attributed-string></ytd-comment-view-model></div></ytd-watch-flexy>');
    else if (request.url === '/empty') response.end('<!doctype html><meta charset="utf-8"><main></main>');
    else if (request.url === '/frame') response.end('<!doctype html><meta charset="utf-8"><main><p>Embedded frame paragraph.</p></main>');
    else if (request.url === '/hidden-frame') response.end('<!doctype html><meta charset="utf-8"><main><p>Previously hidden iframe paragraph.</p></main>');
    else response.end(readme);
  };
  const server = createServer((...args) => { void handler(...args); });
  const frameServer = createServer((...args) => { void handler(...args); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => frameServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'wuf-wupage-edge-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=www.youtube.com',
    '-keyout', join(profile, 'key.pem'), '-out', join(profile, 'cert.pem')], { stdio: 'ignore' });
  const youtubeServer = createHttpsServer({ key: await readFile(join(profile, 'key.pem')), cert: await readFile(join(profile, 'cert.pem')) }, (...args) => { void handler(...args); });
  await new Promise(resolve => youtubeServer.listen(0, '127.0.0.1', resolve));
  const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--no-proxy-server', '--ignore-certificate-errors', '--host-resolver-rules=MAP www.youtube.com 127.0.0.1',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--load-extension=${resolve('dist/wuf')}`, `--disable-extensions-except=${resolve('dist/wuf')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; });
  const clients = [];
  try {
    const portFile = await until(async () => readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => ''), 'Edge debugging endpoint');
    const port = portFile.split('\n')[0];
    const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const workerTarget = await until(async () => (await targets()).find(target => target.type === 'service_worker' && target.url.endsWith('/background.js')), 'unpacked extension worker');
    const worker = await connect(workerTarget.webSocketDebuggerUrl); clients.push(worker);
    await worker.send('Runtime.enable');
    await until(() => evaluate(worker, `typeof chrome !== 'undefined' && !!chrome.storage?.sync`), 'extension worker APIs');
    const settings = structuredClone(DEFAULT_SETTINGS); settings.openccEnabled = false;
    settings.webpage.engine = 'openai-compat-online'; settings.providers.online.baseUrl = origin + '/v1'; settings.providers.online.model = 'fixture-model';
    settings.providers.online.webBatchUnits = 1; settings.providers.online.webBatchChars = 1200; settings.providers.online.webConcurrency = 1;
    const saveSettings = () => evaluate(worker, `chrome.storage.sync.set({wufSettings:${JSON.stringify(settings)}})`);
    await saveSettings();
    const browser = await connect(`ws://127.0.0.1:${port}${portFile.split('\n')[1]}`); clients.push(browser);
    const optionsTarget = await browser.send('Target.createTarget', { url: `chrome-extension://${new URL(workerTarget.url).host}/options.html`, background: true });
    const optionsInfo = await until(async () => (await targets()).find(item => item.id === optionsTarget.targetId), 'options tab');
    const options = await connect(optionsInfo.webSocketDebuggerUrl); clients.push(options);
    await until(() => evaluate(options, `document.readyState==='complete' && !!document.querySelector('#wuf-tab-btn-webpage')`), 'options loaded');
    assert.equal(await evaluate(options, `!!document.querySelector('#wuf-webpage-auto-hosts') && !!document.querySelector('#wuf-webpage-test')`), true, 'Webpage settings must manage existing auto-translate sites and test the selected service');
    await evaluate(options, `document.querySelector('#wuf-tab-btn-webpage').click();document.querySelector('#wuf-webpage-auto-hosts').value=${JSON.stringify('Example.COM\nhttps://docs.example.org/path')};document.querySelector('#wuf-webpage-auto-hosts-save').click()`);
    await until(() => evaluate(worker, `chrome.storage.sync.get('wufSettings').then(x=>JSON.stringify(x.wufSettings.webpage.autoTranslateHosts)===JSON.stringify(['example.com','docs.example.org']))`), 'auto-translate sites saved');
    await until(() => evaluate(options, `document.querySelector('#wuf-webpage-auto-hosts-feedback').dataset.state==='success' && !document.querySelector('#wuf-webpage-auto-hosts-save').disabled`), 'save confirmation');
    await options.send('Page.reload');
    await until(() => evaluate(options, `document.querySelector('#wuf-webpage-auto-hosts')?.value===${JSON.stringify('example.com\ndocs.example.org')}`), 'saved site list reloaded');
    const invalid = await evaluate(options, `(()=>{document.querySelector('#wuf-webpage-auto-hosts').value='bad host !';document.querySelector('#wuf-webpage-auto-hosts-save').click();return {state:document.querySelector('#wuf-webpage-auto-hosts-feedback').dataset.state}})()`);
    assert.equal(invalid.state, 'error', JSON.stringify(invalid));
    assert.deepEqual(await evaluate(worker, `chrome.storage.sync.get('wufSettings').then(x=>x.wufSettings.webpage.autoTranslateHosts)`), ['example.com', 'docs.example.org']);
    await evaluate(worker, `(async()=>{const x=await chrome.storage.sync.get('wufSettings');x.wufSettings.webpage.autoTranslateHosts=['other.example'];await chrome.storage.sync.set(x)})()`);
    await until(() => evaluate(options, `document.querySelector('#wuf-webpage-auto-hosts').value==='other.example'`), 'site changes from another extension view');
    await evaluate(options, `document.querySelector('#wuf-webpage-auto-hosts').value='draft.example';document.querySelector('#wuf-webpage-auto-hosts').dispatchEvent(new Event('input',{bubbles:true}))`);
    await evaluate(worker, `(async()=>{const x=await chrome.storage.sync.get('wufSettings');x.wufSettings.webpage.autoTranslateHosts=['third.example'];await chrome.storage.sync.set(x)})()`);
    await sleep(150);
    assert.equal(await evaluate(options, `document.querySelector('#wuf-webpage-auto-hosts').value`), 'draft.example', 'Unsaved site edits must remain visible');
    await evaluate(options, `document.querySelector('#wuf-webpage-target-lang').value='fr';document.querySelector('#wuf-webpage-target-lang').dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(() => evaluate(worker, `chrome.storage.sync.get('wufSettings').then(x=>x.wufSettings.webpage.targetLanguage==='fr')`), 'other setting saved');
    assert.deepEqual(await evaluate(worker, `chrome.storage.sync.get('wufSettings').then(x=>x.wufSettings.webpage.autoTranslateHosts)`), ['third.example']);
    await evaluate(options, `document.querySelector('#wuf-webpage-target-lang').value='zh-TW';document.querySelector('#wuf-webpage-target-lang').dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(() => evaluate(worker, `chrome.storage.sync.get('wufSettings').then(x=>x.wufSettings.webpage.targetLanguage==='zh-TW')`), 'target language restored');
    await evaluate(options, `document.querySelector('#wuf-webpage-auto-hosts').value='';document.querySelector('#wuf-webpage-auto-hosts-save').click()`);
    await until(() => evaluate(worker, `chrome.storage.sync.get('wufSettings').then(x=>x.wufSettings.webpage.autoTranslateHosts.length===0)`), 'auto-translate sites cleared');
    await until(() => evaluate(options, `!document.querySelector('#wuf-webpage-auto-hosts-save').disabled`), 'cleared sites confirmation');
    await evaluate(worker, `chrome.storage.local.set({wufSecrets:{providerApiKeys:{local:'local-test-key',online:'online-test-key'}}})`);
    const beforeTests = requests.length;
    for (let i = 0; i < 2; i++) {
      await evaluate(options, `document.querySelector('#wuf-webpage-test').click()`);
      await until(() => evaluate(options, `document.querySelector('#wuf-webpage-test-result').classList.contains('success')`), 'selected service test result');
    }
    assert.equal(requests.length - beforeTests, 2, 'Service test must contact provider each time');
    assert.deepEqual(await evaluate(worker, `chrome.storage.local.get('wufSecrets').then(x=>x.wufSecrets.providerApiKeys)`), { local: 'local-test-key', online: 'online-test-key' }, 'Testing a service must not overwrite credentials');
    forceServiceError = true;
    await evaluate(options, `document.querySelector('#wuf-webpage-test').click()`);
    await until(() => evaluate(options, `document.querySelector('#wuf-webpage-test-result').classList.contains('error')`), 'selected service failure displayed');
    assert.match(await evaluate(options, `document.querySelector('#wuf-webpage-test-result').textContent`), /401/);
    forceServiceError = false;
    await evaluate(options, `document.querySelector('#wuf-webpage-open-local').click()`);
    assert.equal(await evaluate(options, `document.querySelector('#wuf-tab-btn-local').getAttribute('aria-selected')`), 'true');
    await evaluate(options, `document.querySelector('#wuf-tab-btn-webpage').click()`);
    await mkdir('outputs/webpage-settings', { recursive: true });
    for (const width of [1200, 430]) {
      await options.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate(options, `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`), true, `Settings overflow at width ${width}`);
      const image = await options.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(`outputs/webpage-settings/${width}.png`, Buffer.from(image.data, 'base64'));
    }
    requests.length = 0;
    const created = await browser.send('Target.createTarget', { url: origin + '/readme' });
    const pageTarget = await until(async () => (await targets()).find(target => target.id === created.targetId), 'fixture tab');
    const page = await connect(pageTarget.webSocketDebuggerUrl); clients.push(page);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate(page, `document.readyState === 'complete' && !!document.querySelector('#release')`), 'README load');
    const tabId = await until(() => evaluate(worker, `chrome.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url===${JSON.stringify(origin + '/readme')})?.id)`), 'extension tab identity');
    const message = request => evaluate(worker, `chrome.tabs.sendMessage(${tabId},${JSON.stringify(request)},{frameId:0})`);
    const state = () => message({ type: 'wuf:get-state' });
    await until(async () => { try { return await state(); } catch { return false; } }, 'content script registration');
    const drain = async () => until(async () => { const value = await state(); return value.translated && !value.translating && value; }, 'page translation queue');
    await evaluate(page, `window.savedGuide = document.querySelector('#guide'); window.guideClicks=0; savedGuide.addEventListener('click',event=>{event.preventDefault();guideClicks++}); document.querySelector('#release').scrollIntoView();`);
    assert.equal((await message({ type: 'wuf:translate-page', payload: { translateOnly: true, force: true } })).ok, true);
    await drain();
    const output = await evaluate(page, `({headings:document.querySelectorAll('#release .wupage-translation').length,text:document.querySelector('#release').textContent,far:!!document.querySelector('#last .wupage-translation'),legacy:document.querySelectorAll('.wuf-bilingual-translation').length,code:document.querySelector('#release .wupage-translation code')?.textContent})`);
    assert.equal(output.headings, 1, JSON.stringify(output)); assert.equal(output.far, false, 'Offscreen content translated before scrolling');
    assert.equal(output.legacy, 0, 'Production still uses the WUF DOM renderer');
    assert.equal(output.code, 'v1.7.0'); assert.doesNotMatch(output.text, /<<<WUF_|⟪WUPAGE\d+⟫/);
    assert.ok(requests[0].source.includes('Modular installation'), 'Current viewport was not prioritized');
    assert.match(requests[0].prompt, /into zh-TW/);
    await mkdir('outputs/wupage-edge', { recursive: true });
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile('outputs/wupage-edge/readme-bilingual.png', Buffer.from(screenshot.data, 'base64'));
    await evaluate(page, `document.querySelector('#last').scrollIntoView()`);
    await until(() => evaluate(page, `!!document.querySelector('#last .wupage-translation')`), 'scroll translates nearby content');
    await evaluate(page, `document.querySelector('#release').scrollIntoView()`);
    assert.equal(requests.some(item => item.source.includes('Older release notes.')), false, 'Collapsed text must wait until revealed');
    await evaluate(page, `document.querySelector('details').open=true;document.querySelector('details').scrollIntoView()`);
    await until(() => evaluate(page, `!!document.querySelector('details p .wupage-translation')`), 'expanded details translation');
    t.diagnostic('Real extension: GitHub-style headings, protected-code recovery and viewport scheduling passed.');

    dropMarkers = false;
    await evaluate(page, `document.querySelector('#dynamic').hidden=false;document.querySelector('#prose').firstChild.data='Updated prose in a div.'`);
    await until(() => evaluate(page, `!!document.querySelector('#dynamic .wupage-translation') && document.querySelector('#prose .wupage-translation')?.textContent.includes('Updated prose')`), 'dynamic source and visibility updates');

    await evaluate(page, `const frame=document.createElement('iframe');frame.id='embedded';frame.style.cssText='width:800px;height:200px';frame.src=${JSON.stringify(`http://127.0.0.1:${frameServer.address().port}/frame`)};document.querySelector('#release').after(frame);frame.scrollIntoView()`);
    await until(() => evaluate(page, `performance.getEntriesByType('resource').some(entry=>entry.name.endsWith('/frame'))`), 'cross-origin frame load');
    await until(async () => requests.some(item => item.source.includes('Embedded frame paragraph')), 'new iframe joined the active translation session');
    const frames = await evaluate(worker, `chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
    assert.ok(frames.some(frame => frame.frameId !== 0), 'Embedded frame was not registered');
    await evaluate(page, `const hidden=document.createElement('iframe');hidden.id='hidden-frame';hidden.style.cssText='display:none;width:800px;height:200px';hidden.src=${JSON.stringify(`http://127.0.0.1:${frameServer.address().port}/hidden-frame`)};document.querySelector('#release').after(hidden)`);
    await until(() => evaluate(page, `performance.getEntriesByType('resource').some(entry=>entry.name.endsWith('/hidden-frame'))`), 'hidden frame load');
    await sleep(500);
    assert.equal(requests.some(item => item.source.includes('Previously hidden iframe paragraph')), false, 'Hidden iframe must not translate');
    await evaluate(page, `document.querySelector('#hidden-frame').style.display='block';document.querySelector('#hidden-frame').scrollIntoView()`);
    await until(async () => requests.some(item => item.source.includes('Previously hidden iframe paragraph')), 'newly visible iframe joins translation');
    t.diagnostic('Real extension: dynamic content and a newly inserted cross-origin iframe passed.');

    await message({ type: 'wuf:restore-page' });
    await until(() => evaluate(page, `document.querySelectorAll('.wupage-translation,.wupage-translation-pending').length === 0`), 'restore original');
    const restored = await evaluate(page, `savedGuide.click();({identity:document.querySelector('#guide')===savedGuide,clicks:guideClicks,code:document.querySelector('#rich code').textContent,markers:/<<<WUF_|⟪WUPAGE\d+⟫/.test(document.querySelector('article').textContent)})`);
    assert.deepEqual(restored, { identity: true, clicks: 1, code: 'fetch()', markers: false });

    settings.webpage.displayMode = 'monolingual'; await saveSettings();
    await message({ type: 'wuf:translate-page', payload: { translateOnly: true, force: true } }); await drain();
    assert.equal(await evaluate(page, `document.querySelector('#rich').textContent.includes('<<<WUF_')`), false);
    await message({ type: 'wuf:restore-page' });
    await until(() => evaluate(page, `document.querySelectorAll('.wupage-translation').length === 0 && document.querySelector('#rich').textContent.includes('Read')`), 'monolingual restoration');

    settings.webpage.displayMode = 'bilingual'; await saveSettings();
    await evaluate(page, `const paragraph=document.createElement('p');paragraph.id='held';paragraph.textContent='Hold this request';document.querySelector('article').prepend(paragraph);paragraph.scrollIntoView()`);
    const starting = message({ type: 'wuf:translate-page', payload: { translateOnly: true, force: true } });
    await until(() => pendingResponse, 'delayed provider request');
    const spinner = await evaluate(page, `(()=>{const s=getComputedStyle(document.querySelector('.wupage-translation-pending > span'));return {top:s.borderTopColor,track:s.borderRightColor}})()`);
    assert.deepEqual(spinner, { top: 'rgb(180, 61, 29)', track: 'rgba(180, 61, 29, 0.22)' });
    const spinnerImage = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile('outputs/webpage-settings/loading-indicator.png', Buffer.from(spinnerImage.data, 'base64'));
    const popupTarget = await browser.send('Target.createTarget', { url: `chrome-extension://${new URL(workerTarget.url).host}/popup.html`, background: true });
    const popupInfo = await until(async () => (await targets()).find(item => item.id === popupTarget.targetId), 'WUF popup');
    const popup = await connect(popupInfo.webSocketDebuggerUrl); clients.push(popup);
    await evaluate(worker, `chrome.tabs.update(${tabId},{active:true})`);
    await until(() => evaluate(popup, `document.readyState==='complete' && !!document.querySelector('#wuf-engine-select')`), 'popup loaded');
    assert.equal(await evaluate(popup, `!!document.querySelector('#wuf-engine-select option[value="microsoft-translate"]')`), true);
    await until(() => evaluate(popup, `document.querySelector('#wuf-btn-translate-webpage')?.dataset.mode==='restore'`), 'popup shows translation in progress');
    assert.equal(await evaluate(popup, `document.querySelector('#wuf-btn-translate-webpage').disabled`), false, 'WUF popup must allow cancel while translating');
    await evaluate(popup, `document.querySelector('#wuf-btn-translate-webpage').click()`);
    await until(async () => !(await state()).translated, 'popup cancel restores page');
    pendingResponse.end(JSON.stringify({ choices: [{ message: { content: '遲到的譯文' } }] }));
    await starting; await sleep(150);
    assert.equal(await evaluate(page, `document.querySelectorAll('.wupage-translation,.wupage-translation-pending').length`), 0);
    t.diagnostic('Real extension: bilingual/monolingual restoration, original listener identity and stop/late-response isolation passed.');

    await page.send('Page.navigate', { url: origin + '/empty' });
    await until(() => evaluate(page, `location.pathname === '/empty' && document.readyState === 'complete'`), 'empty page load');
    await until(async () => { try { return await state(); } catch { return false; } }, 'empty page content script');
    await message({ type: 'wuf:translate-page', payload: { translateOnly: true, force: true } });
    await evaluate(page, `document.querySelector('main').innerHTML='<p>Asynchronously loaded article.</p>'`);
    await until(() => evaluate(page, `!!document.querySelector('main .wupage-translation')`), 'empty-page translation intent');
    await evaluate(page, `document.querySelector('main').insertAdjacentHTML('beforeend','<p>Service failure after scrolling</p>')`);
    const failure = await until(async () => { const value = await state(); return value.error && value; }, 'late error delivered to WUF state', 2500);
    assert.match(failure.error, /401/);
    await message({ type: 'wuf:restore-page' });
    t.diagnostic('Real extension: initially empty SPA content passed.');

    settings.webpage.crossTabSticky = true; await saveSettings();
    await evaluate(page, `document.querySelector('main').innerHTML='<p>Sticky original paragraph.</p>'`);
    await message({ type: 'wuf:translate-page', payload: { translateOnly: true, force: true } });
    await until(() => evaluate(worker, `chrome.storage.session.get('wuf:stickyTabs').then(x=>(x['wuf:stickyTabs']||[]).includes(${tabId}))`), 'sticky state saved');
    await page.send('Page.navigate', { url: origin + '/readme' });
    await until(() => evaluate(page, `location.pathname==='/readme' && document.readyState==='complete'`), 'sticky destination');
    await until(() => evaluate(page, `!!document.querySelector('.wupage-translation')`), 'sticky translation after ordinary page navigation', 3500);
    await message({ type: 'wuf:restore-page' });
    settings.webpage.crossTabSticky = false; await saveSettings();

    const youtubeUrl = `https://www.youtube.com:${youtubeServer.address().port}/watch?v=wuf-fixture`;
    await page.send('Page.navigate', { url: youtubeUrl });
    await until(() => evaluate(page, `location.hostname === 'www.youtube.com' && document.readyState === 'complete' && document.querySelectorAll('#content-text').length === 2`), 'YouTube fixture');
    await until(async () => { try { return await state(); } catch { return false; } }, 'YouTube content script');
    await evaluate(page, `window.commentWrappers=[...document.querySelectorAll('#content-text')].map(el=>el.firstChild)`);
    await message({ type: 'wuf:translate-page', payload: { translateOnly: true, force: true } });
    await drain();
    const youtube = await evaluate(page, `({comments:[...document.querySelectorAll('#content-text')].map((el,index)=>({same:el.firstChild===commentWrappers[index],translation:el.querySelector('.wuf-bilingual-translation')?.textContent})),ported:document.querySelectorAll('.wupage-translation').length})`);
    assert.equal(youtube.ported, 0, 'YouTube comments must keep their existing WUF path');
    assert.ok(youtube.comments.every(comment => comment.same && comment.translation?.startsWith('譯文：')), JSON.stringify(youtube));
    await message({ type: 'wuf:restore-page' });
    assert.equal(await evaluate(page, `[...document.querySelectorAll('#content-text')].every((el,index)=>el.firstChild===commentWrappers[index]&&!el.querySelector('.wuf-bilingual-translation'))`), true);
    t.diagnostic('Real extension: both YouTube comment layouts use the existing WUF path and retain original wrappers.');
  } catch (error) {
    error.message += '\nEdge diagnostics:\n' + diagnostics.slice(-1200); throw error;
  } finally {
    if (pendingResponse && !pendingResponse.writableEnded) pendingResponse.end();
    for (const client of clients) client.close();
    child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'Edge shutdown', 5000).catch(() => child.kill('SIGKILL'));
    server.closeAllConnections(); server.close(); frameServer.closeAllConnections(); frameServer.close();
    youtubeServer.closeAllConnections(); youtubeServer.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
