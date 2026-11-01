// Opt-in, isolated Edge comparison using the user's running Watchdog endpoint.
// This fixture has no credentials or personal page content.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../dist/wuf/index.js';

const edge = process.env.EDGE_BIN || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const original = resolve(process.env.WUPAGE_SOURCE || '../wupage-1.5.5', 'dist');
const output = resolve('outputs/wupage-live');
const endpoint = 'http://127.0.0.1:8080/v1';
const model = 'apple-intelligence-translation';
const fixture = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Release Notes</title>
<style>body{background:#0d1117;color:#f0f6fc;font:18px/1.6 system-ui;margin:36px auto;max-width:920px}a{color:#4493f8}code{background:#252a32;padding:2px 5px;border-radius:4px}blockquote{border-left:5px solid #3d444d;padding-left:22px;color:#9198a1}</style>
<article><h2 id="release"><strong>Release notes</strong> <a href="#v1"><code>v1.7.0</code></a> — A refreshed learning workspace.</h2>
<blockquote><p id="quote">A new release improves installation and makes lessons easier to follow.</p></blockquote>
<p id="rich">Read the <a href="#guide">contribution guide</a> and run <code>fetch()</code> carefully.</p>
<details open><summary id="past">Past releases</summary><p id="older">Older versions include more reliable tutoring.</p></details></article></html>`;
const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(fixture); });
await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
const url = `http://127.0.0.1:${server.address().port}/readme`;
await mkdir(output, { recursive: true });
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function connect(url, onEvent = () => {}) {
  const socket = new WebSocket(url);
  await new Promise((resolvePromise, reject) => { socket.addEventListener('open', resolvePromise, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let id = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) { onEvent(message); return; }
    const task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  return { close: () => socket.close(), send(method, params = {}) {
    return new Promise((resolvePromise, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timed out: ${method}`)); }, 180000);
      pending.set(requestId, { resolve: resolvePromise, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  } };
}
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed');
  return result.result.value;
}
async function run(label, extension) {
  const profile = await mkdtemp(join(tmpdir(), `wupage-live-${label}-`));
  const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--no-proxy-server', `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, 'about:blank'], { stdio: 'ignore' });
  const clients = []; const requests = []; let page;
  try {
    const portFile = await until(() => readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => ''), 'Edge debugging port');
    const port = portFile.split('\n')[0];
    const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = await until(async () => (await targets()).find(item => item.type === 'service_worker' && item.url.endsWith('/background.js')), 'extension worker');
    const worker = await connect(target.webSocketDebuggerUrl, message => {
      const request = message.params?.request;
      if (message.method === 'Network.requestWillBeSent' && request?.url === `${endpoint}/chat/completions` && request.postData) {
        requests.push({ url: request.url, body: JSON.parse(request.postData) });
      }
    }); clients.push(worker);
    await worker.send('Runtime.enable'); await worker.send('Network.enable');
    await until(() => evaluate(worker, `typeof chrome !== 'undefined' && !!chrome.storage?.sync`), 'extension worker APIs');
    const browser = await connect(`ws://127.0.0.1:${port}${portFile.split('\n')[1]}`); clients.push(browser);
    if (label === 'original') {
      const id = new URL(target.url).host;
      const controlTarget = await browser.send('Target.createTarget', { url: `chrome-extension://${id}/options.html` });
      const info = await until(async () => (await targets()).find(item => item.id === controlTarget.targetId), 'original settings page');
      const control = await connect(info.webSocketDebuggerUrl); clients.push(control);
      await until(() => evaluate(control, `document.readyState==='complete' && !!chrome.runtime`), 'original settings loaded');
      const saved = await evaluate(control, `(async()=>{const r=await chrome.runtime.sendMessage({type:'GET_SETTINGS'}); const s=r.data;
        const p=s.providers.find(x=>x.id==='openai-compatible'); Object.assign(p,{baseURL:${JSON.stringify(endpoint)},model:${JSON.stringify(model)},apiKey:'',ollamaCompatibility:false});
        Object.assign(s,{activeProviderId:p.id,sourceLang:'auto',targetLang:'zh-TW',translationDisplayMode:'bilingual',cacheEnabled:false});
        return chrome.runtime.sendMessage({type:'SAVE_SETTINGS',settings:s});})()`);
      assert.equal(saved.ok, true, JSON.stringify(saved));
    } else {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.providers.local.baseUrl = endpoint; settings.providers.local.model = model;
      settings.webpage.engine = 'openai-compat-local'; settings.webpage.targetLanguage = 'zh-TW'; settings.webpage.displayMode = 'bilingual';
      await evaluate(worker, `chrome.storage.sync.set({wufSettings:${JSON.stringify(settings)}})`);
    }
    const created = await browser.send('Target.createTarget', { url });
    const pageTarget = await until(async () => (await targets()).find(item => item.id === created.targetId), 'test page');
    page = await connect(pageTarget.webSocketDebuggerUrl); clients.push(page);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate(page, `document.readyState==='complete' && !!document.querySelector('article')`), 'fixture loaded');
    const originalText = await evaluate(page, `document.querySelector('article').textContent`);
    const tabId = await until(() => evaluate(worker, `chrome.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url===${JSON.stringify(url)})?.id)`), 'test tab');
    const command = label === 'original' ? { type: 'TRANSLATE_PAGE' } : { type: 'wuf:translate-page', payload: { translateOnly: true, force: true } };
    const message = await evaluate(worker, `chrome.tabs.sendMessage(${tabId},${JSON.stringify(command)},{frameId:0})`);
    await delay(1000);
    const state = await evaluate(page, `({translations:document.querySelectorAll('.wupage-translation').length, text:document.querySelector('article').textContent,
      markerLeak:/⟪WUPAGE\\d+⟫|<<<WUF_/.test(document.querySelector('article').textContent), codes:[...document.querySelectorAll('.wupage-translation code')].map(x=>x.textContent),
      counts:['#release','#quote','#rich','#past','#older'].map(selector=>document.querySelector(selector).querySelectorAll('.wupage-translation').length)})`);
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(output, `${label}.png`), Buffer.from(image.data, 'base64'));
    const restore = label === 'original' ? { type: 'CLEAR_TRANSLATION' } : { type: 'wuf:restore-page' };
    await evaluate(worker, `chrome.tabs.sendMessage(${tabId},${JSON.stringify(restore)},{frameId:0})`);
    await until(() => evaluate(page, `document.querySelectorAll('.wupage-translation').length===0`), 'restore original');
    assert.equal(await evaluate(page, `document.querySelector('article').textContent`), originalText, 'Restored text must match the original');
    return { requests, message, state };
  } finally {
    if (page) await page.send('Page.captureScreenshot', { format: 'png' }).then(image => writeFile(join(output, `${label}-final.png`), Buffer.from(image.data, 'base64'))).catch(() => {});
    for (const client of clients) client.close();
    child.kill('SIGTERM'); await until(() => child.exitCode !== null || child.signalCode !== null, 'Edge shutdown', 5000).catch(() => child.kill('SIGKILL'));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
try {
  const upstream = await run('original', original);
  await writeFile(join(output, 'original-result.json'), JSON.stringify(upstream, null, 2) + '\n');
  const wuf = await run('wuf', resolve('dist/wuf'));
  await writeFile(join(output, 'requests-and-results.json'), JSON.stringify({ upstream, wuf }, null, 2) + '\n');
  assert.deepEqual(wuf.requests, upstream.requests, 'Watchdog requests differ from WuPage');
  assert.equal(upstream.message.ok, true, JSON.stringify(upstream.message));
  assert.equal(wuf.message.ok, true, JSON.stringify(wuf.message));
  assert.ok(upstream.state.translations > 0 && wuf.state.translations > 0, 'No rendered translations');
  // WuPage renders this rich paragraph's translation beside its source node,
  // whereas the other four fixtures contain their output nodes.
  assert.equal(upstream.state.translations, 5);
  assert.deepEqual(upstream.state.counts, [1, 1, 0, 1, 1]);
  assert.deepEqual(wuf.state.counts, upstream.state.counts, 'Missing or duplicate translations');
  assert.deepEqual(wuf.state.codes, ['v1.7.0', 'fetch()']);
  assert.equal(upstream.state.markerLeak || wuf.state.markerLeak, false, 'Internal marker leaked');
  console.log(JSON.stringify({ original: upstream.state, wuf: wuf.state, requests: upstream.requests.length }, null, 2));
} finally { server.close(); }
