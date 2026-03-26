/**
 * Smoke tests for src/server.js — Express API endpoints.
 * Starts the server as a child process to avoid ESM/CJS conflicts with Lighthouse.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

let serverProcess;
const port = 30000 + Math.floor(Math.random() * 10000);

function fetchUrl(urlPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: 'localhost',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

function waitForServer(maxWaitMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > maxWaitMs) {
        return reject(new Error('Server did not start within timeout'));
      }
      fetchUrl('/').then(() => resolve()).catch(() => setTimeout(check, 500));
    };
    setTimeout(check, 1000);
  });
}

beforeAll(async () => {
  const serverPath = path.resolve(__dirname, '../../src/server.js');
  serverProcess = spawn('node', [serverPath], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'pipe',
  });

  // Capture stderr for debugging
  let stderr = '';
  serverProcess.stderr.on('data', (data) => { stderr += data.toString(); });

  await waitForServer();
}, 20000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    try { serverProcess.kill('SIGKILL'); } catch { /* already dead */ }
  }
});

describe('Server smoke tests', () => {
  test('GET / serves HTML landing page', async () => {
    const res = await fetchUrl('/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<!DOCTYPE html>');
  });

  test('landing page contains scan URL input', async () => {
    const res = await fetchUrl('/');
    expect(res.body).toContain('urlInput');
  });

  test('landing page contains dashboard tab keywords', async () => {
    const res = await fetchUrl('/');
    const body = res.body;
    expect(body).toContain('Overview');
    expect(body).toContain('Violations');
    expect(body).toContain('Exports');
  });

  test('POST /api/scan rejects invalid URL with 400', async () => {
    const res = await postJson('/api/scan', { url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  test('POST /api/scan accepts valid URL and returns scanId', async () => {
    const res = await postJson('/api/scan', { url: 'https://example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('scanId');
    expect(typeof res.body.scanId).toBe('string');
  });

  test('GET /api/data/remediation returns valid JSON', async () => {
    const res = await fetchUrl('/api/data/remediation');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(typeof data).toBe('object');
  });

  test('GET /api/data/wcag-map returns valid JSON with WCAG criteria', async () => {
    const res = await fetchUrl('/api/data/wcag-map');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(typeof data).toBe('object');
    expect(data['1.1.1']).toBeDefined();
  });

  test('GET /api/scan/:id/export/json returns 404 for nonexistent scan', async () => {
    const res = await fetchUrl('/api/scan/nonexistent/export/json');
    expect(res.status).toBe(404);
  });

  test('POST /api/seo-scan rejects invalid URL with 400', async () => {
    const res = await postJson('/api/seo-scan', { url: 'not-a-url' });
    expect(res.status).toBe(400);
  });
});
