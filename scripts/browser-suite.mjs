#!/usr/bin/env node
// Run `packages/lean-wasm/test/page.html` against a mirror, without Playwright or Puppeteer.
//
//   node scripts/browser-suite.mjs [--assets <dir>] [--chrome <path>] [--timeout <ms>] [--headed]
//
// It starts two static servers (the mirror and the package directory), launches Chrome with the DevTools
// protocol, opens the suite, polls its `dataset.done`, and prints the result. The suite takes `?assets=`, so
// this is the same test that was run by hand against `wasm-build/out/mirror-upstream`: ESM entry, IIFE in a
// worker, Std on demand, and the syntax probe.
//
// Chrome is located from `CHROME_PATH` or the usual install paths. Node 22+ is required for the global
// WebSocket the protocol connection uses; there are no npm dependencies.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const assets = resolve(flag('--assets') ?? join(root, 'wasm-build/out/mirror-upstream'));
const timeout = Number(flag('--timeout') ?? 300000);
const headed = args.includes('--headed');
const chromePath = flag('--chrome');

if (typeof WebSocket !== 'function') {
	console.error('Node 22+ is required: this runner uses the global WebSocket for the DevTools protocol.');
	process.exit(2);
}
if (!existsSync(join(assets, 'lean-wasm', 'lean.js'))) {
	console.error(`no Lean mirror at ${assets} — pass --assets, or build/serve one (HANDOVER.md §2).`);
	process.exit(2);
}

const CHROME_CANDIDATES = [
	chromePath,
	process.env.CHROME_PATH,
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const executable = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!executable) {
	console.error('Chrome not found. Set CHROME_PATH or pass --chrome <path>.');
	process.exit(2);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
	return new Promise((done, fail) => {
		const server = createServer();
		server.on('error', fail);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => done(port));
		});
	});
}

async function waitFor(check, label, limit = 30000) {
	const deadline = Date.now() + limit;
	for (;;) {
		try {
			const value = await check();
			if (value) return value;
		} catch {
			/* not yet */
		}
		if (Date.now() > deadline) throw new Error(`${label} did not become ready within ${limit / 1000}s`);
		await sleep(250);
	}
}

function startServer(rootDir, port) {
	// serve.js prints to stdout; keep stderr so a port clash is visible if the wait times out.
	const child = spawn(process.execPath, ['serve.js', String(port), rootDir], {
		cwd: root,
		stdio: ['ignore', 'ignore', 'pipe']
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});
	child.on('exit', (code) => {
		if (code && code !== 0) console.error(`serve.js (${rootDir}) exited ${code}: ${stderr.trim()}`);
	});
	return child;
}

const userData = mkdtempSync(join(tmpdir(), 'lean-browser-suite-'));
const children = [];
let chrome = null;
let socket = null;

async function cleanup() {
	try {
		socket?.close();
	} catch {
		/* ignore */
	}
	for (const child of children) {
		try {
			child.kill();
		} catch {
			/* ignore */
		}
	}
	try {
		if (chrome) {
			const exited = new Promise((done) => {
				chrome.once('exit', done);
				setTimeout(done, 2000);
			});
			chrome.kill();
			await exited;
		}
	} catch {
		/* ignore */
	}
	// Windows keeps the profile directory locked for a moment after Chrome exits; retry, and never let a
	// temporary directory turn a passing suite into a failure.
	try {
		rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		/* the OS will clean its temp directory */
	}
}
process.on('SIGINT', () => {
	void cleanup().finally(() => process.exit(130));
});

try {
	const assetsPort = await freePort();
	const pagePort = await freePort();
	const cdpPort = await freePort();

	children.push(startServer(assets, assetsPort));
	children.push(startServer(join(root, 'packages/lean-wasm'), pagePort));

	await waitFor(
		async () => (await fetch(`http://127.0.0.1:${pagePort}/test/page.html`)).ok,
		'the package server'
	);
	await waitFor(async () => (await fetch(`http://127.0.0.1:${assetsPort}/lean-wasm/lean.js`)).ok, 'the asset server');

	chrome = spawn(
		executable,
		[
			...(headed ? [] : ['--headless=new']),
			'--disable-gpu',
			'--disable-dev-shm-usage',
			'--no-first-run',
			'--no-default-browser-check',
			'--no-sandbox',
			'--remote-allow-origins=*',
			`--user-data-dir=${userData}`,
			`--remote-debugging-port=${cdpPort}`,
			'--window-size=1280,900',
			'about:blank'
		],
		{ stdio: ['ignore', 'ignore', 'pipe'] }
	);
	let chromeErr = '';
	chrome.stderr.on('data', (chunk) => {
		chromeErr += chunk;
	});

	const target = await waitFor(async () => {
		const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
		const targets = await response.json();
		return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
	}, 'Chrome DevTools');
	if (!target) throw new Error(`Chrome started without a page target: ${chromeErr.slice(0, 400)}`);

	socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((done, fail) => {
		socket.addEventListener('open', done, { once: true });
		socket.addEventListener('error', () => fail(new Error('DevTools socket failed')), { once: true });
	});

	let nextId = 1;
	const pending = new Map();
	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	});
	const send = (method, params = {}) => {
		const id = nextId++;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((done) => pending.set(id, done));
	};
	const evaluate = async (expression) => {
		const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
		if (reply.error) throw new Error(reply.error.message);
		if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.text);
		return reply.result?.result?.value;
	};

	await send('Page.enable');
	await send('Runtime.enable');
	const suiteUrl = `http://127.0.0.1:${pagePort}/test/page.html?assets=${encodeURIComponent(
		`http://127.0.0.1:${assetsPort}/`
	)}`;
	await send('Page.navigate', { url: suiteUrl });

	let snapshot = null;
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			snapshot = await evaluate(`(() => {
				const ds = document.documentElement.dataset;
				if (ds.done !== 'true') return null;
				return JSON.stringify({
					status: ds.status,
					results: JSON.parse(ds.results || '{}'),
					out: document.getElementById('out')?.textContent || ''
				});
			})()`);
		} catch {
			/* the page is navigating or the context is not ready */
		}
		if (snapshot) break;
		await sleep(500);
	}
	if (!snapshot) throw new Error(`the suite did not finish within ${Math.round(timeout / 1000)}s`);

	const report = JSON.parse(snapshot);
	console.log(`browser suite: ${report.status?.toUpperCase() ?? 'UNKNOWN'} (${suiteUrl})`);
	for (const [label, result] of Object.entries(report.results)) {
		console.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${label}: ${result.value}`);
	}
	if (report.status !== 'pass') {
		console.log('\n--- suite output ---');
		console.log(report.out);
		process.exitCode = 1;
	}
} catch (error) {
	console.error(`browser suite failed: ${error.message}`);
	process.exitCode = 1;
} finally {
	await cleanup();
}
