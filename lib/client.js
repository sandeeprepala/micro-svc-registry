/**
 * svc-registry client
 *
 * Usage:
 * import client from 'micro-svc-registry';
 * await client.startDaemonIfNeeded(); // optional
 * const { instance } = await client.register({ name: 'auth', port: 3001 });
 * await client.heartbeat({ name: 'auth', id: instance.id });
 * const resolved = await client.resolve('auth');
 *
 * This client will:
 * - read discovery file from os.tmpdir()
 * - if missing or stale, optionally spawn the daemon (fork)
 * - provide helper functions for register/unregister/heartbeat/resolve/list
 *
 * Note: startDaemonIfNeeded uses child_process.spawn on this package; packaging must ensure lib/daemon.js is present.
 */

import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_FILE = path.join(os.tmpdir(), 'svc-registry.json');
const DAEMON_PATH = path.join(__dirname, 'daemon.js');
const STARTUP_TIMEOUT = Number(process.env.SVC_STARTUP_TIMEOUT) || 3000; // ms

// Read and parse the daemon discovery file from temp directory
function readDiscoveryFile() {
  try {
    const raw = fs.readFileSync(TMP_FILE, 'utf8');
    const info = JSON.parse(raw);
    if (!info.host || !info.port) throw new Error('invalid discovery file');
    return info;
  } catch (e) {
    return null;
  }
}

// Check if a process is alive by sending signal 0
function pidIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// Make HTTP request to daemon using axios with error handling
async function requestJson(host, port, method, pathname, body = null) {
  try {
    const url = `http://${host}:${port}${pathname}`;
    const response = await axios({
      method,
      url,
      data: body,
      timeout: 2000,
      validateStatus: () => true // don't throw on any status code
    });
    return response.data;
  } catch (err) {
    throw new Error(`Request failed: ${err.message}`);
  }
}

// Spawn daemon process in background and wait for discovery file and health check
function spawnDaemon() {
  return new Promise((resolve, reject) => {
    const node = process.execPath;
    const child = spawn(node, [DAEMON_PATH], {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env)
    });
    child.unref();

    // wait for discovery file + health check
    const start = Date.now();
    (function waitLoop() {
      const info = readDiscoveryFile();
      if (info && pidIsAlive(info.pid)) {
        // quick health check
        requestJson(info.host, info.port, 'GET', '/health').then(() => {
          resolve(info);
        }).catch(() => {
          if (Date.now() - start > STARTUP_TIMEOUT) {
            reject(new Error('daemon did not respond to health check in time'));
          } else {
            setTimeout(waitLoop, 100);
          }
        });
        return;
      }
      if (Date.now() - start > STARTUP_TIMEOUT) {
        reject(new Error('daemon discovery file not created in time'));
        return;
      }
      setTimeout(waitLoop, 100);
    })();
  });
}

// Ensure daemon is running by checking discovery file or spawning if needed
async function ensureDaemonRunning() {
  const info = readDiscoveryFile();
  if (info && pidIsAlive(info.pid)) {
    try {
      await requestJson(info.host, info.port, 'GET', '/health');
      return info;
    } catch (e) {
      // fall through and try spawn if stale
    }
  }
  try {
    const newInfo = await spawnDaemon();
    return newInfo;
  } catch (err) {
    throw err;
  }
}

// exported API
export default {
  // Start daemon if not already running and return daemon info
  async startDaemonIfNeeded() {
    return ensureDaemonRunning();
  },

  // Register a service instance with name, port, and optional metadata
  async register({ name, port, host = '127.0.0.1', pid = null, id = null, meta = {} }) {
    if (!name || typeof name !== 'string') throw new Error('name required');
    if (!port || typeof port !== 'number') throw new Error('port required as number');
    
    const info = await ensureDaemonRunning();
    return requestJson(info.host, info.port, 'POST', '/register', { name, port, host, pid, id, meta });
  },

  // Send heartbeat to keep service instance alive in registry
  async heartbeat({ name, id }) {
    if (!name || !id) throw new Error('name and id required');
    
    const info = await ensureDaemonRunning();
    return requestJson(info.host, info.port, 'POST', '/heartbeat', { name, id });
  },

  // Remove a service instance from registry by id
  async unregister({ name, id, host, port }) {
    if (!name) throw new Error('name required');
    
    const info = await ensureDaemonRunning();
    return requestJson(info.host, info.port, 'POST', '/unregister', { name, id, host, port });
  },

  // Find most recently active instance of a service by name
  async resolve(name) {
    if (!name) throw new Error('name required');
    
    const info = await ensureDaemonRunning();
    return requestJson(info.host, info.port, 'GET', `/resolve/${encodeURIComponent(name)}`);
  },

  // Get all registered services and their instances from registry
  async list() {
    const info = await ensureDaemonRunning();
    return requestJson(info.host, info.port, 'GET', '/list');
  },

  // Read and return daemon discovery info from file (null if not available)
  discoveryInfo() {
    return readDiscoveryFile();
  }
};
