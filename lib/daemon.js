#!/usr/bin/env node
/**
 * svc-registry daemon (Express-based)
 *
 * Exposes HTTP endpoints:
 * POST /register      { name, host, port, pid, id?, meta? }
 * POST /unregister    { name, id? , host?, port? }
 * POST /heartbeat     { name, id }
 * GET  /resolve/:name
 * GET  /list
 *
 * Writes discovery file to os.tmpdir()/svc-registry.json with { host, port, pid, startedAt }
 *
 * Heartbeat TTL: 15s by default (configurable with SVC_TTL env).
 */

import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_FILE = path.join(os.tmpdir(), 'svc-registry.json');
const HOST = '127.0.0.1';
const DEFAULT_TTL = Number(process.env.SVC_TTL) || 15000; // ms
const HEARTBEAT_CLEAN_INTERVAL = 5000; // ms

// Atomically write JSON to file using temp-rename pattern to prevent corruption
function safeJsonWrite(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

class Registry {
  constructor(ttl = DEFAULT_TTL) {
    // Map: name -> Map(instanceId -> instance)
    this.services = new Map();
    this.ttl = ttl;
  }

  // Get current timestamp in milliseconds
  _now() { return Date.now(); }

  // Create empty Map for service name if it doesn't exist
  _ensureServiceMap(name) {
    if (!this.services.has(name)) this.services.set(name, new Map());
  }

  // Register a service instance with name, port, and optional metadata
  register({ name, host = HOST, port, pid = null, id = null, meta = {} }) {
    if (!name || typeof name !== 'string') throw new Error('name required');
    if (!port || typeof port !== 'number') throw new Error('port required as number');

    this._ensureServiceMap(name);
    const map = this.services.get(name);

    const instanceId = id || `${host}:${port}:${Math.floor(Math.random() * 1e6)}`;
    map.set(instanceId, {
      id: instanceId,
      name,
      host,
      port,
      pid,
      meta,
      lastSeen: this._now()
    });
    return map.get(instanceId);
  }

  // Update instance's last seen timestamp to keep it alive
  heartbeat({ name, id }) {
    if (!name || !id) throw new Error('name and id required for heartbeat');
    const map = this.services.get(name);
    if (!map) return null;
    const inst = map.get(id);
    if (!inst) return null;
    inst.lastSeen = this._now();
    return inst;
  }

  // Remove service instance by id or by host:port combination
  unregister({ name, id, host, port }) {
    if (!name) throw new Error('name required');
    const map = this.services.get(name);
    if (!map) return false;
    if (id) {
      const removed = map.delete(id);
      if (map.size === 0) this.services.delete(name);
      return removed;
    }
    // fallback: remove by host+port
    for (const [iid, inst] of map.entries()) {
      if ((host && inst.host === host) || (port && inst.port === port)) {
        map.delete(iid);
      }
    }
    if (map.size === 0) this.services.delete(name);
    return true;
  }

  // Find most recently active instance of a service by name
  resolve(name) {
    const map = this.services.get(name);
    if (!map || map.size === 0) return null;
    // prefer most recently seen instance
    let chosen = null;
    for (const inst of map.values()) {
      if (!chosen || inst.lastSeen > chosen.lastSeen) chosen = inst;
    }
    return chosen;
  }

  // Return all registered services and their instances
  list() {
    const out = {};
    for (const [name, map] of this.services.entries()) {
      out[name] = Array.from(map.values()).map(i => ({
        id: i.id,
        host: i.host,
        port: i.port,
        pid: i.pid,
        meta: i.meta,
        lastSeen: i.lastSeen
      }));
    }
    return out;
  }

  // Remove instances that haven't sent heartbeat within TTL period
  cleanupExpired() {
    const now = this._now();
    for (const [name, map] of Array.from(this.services.entries())) {
      for (const [id, inst] of Array.from(map.entries())) {
        if ((now - inst.lastSeen) > this.ttl) {
          map.delete(id);
        }
      }
      if (map.size === 0) this.services.delete(name);
    }
  }
}

const registry = new Registry();
const app = express();

// Middleware
app.use(express.json({ limit: '1mb' }));

// Error handler for JSON parsing
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    res.status(400).json({ ok: false, error: 'Invalid JSON' });
    return;
  }
  next();
});

// Routes
app.post('/register', (req, res) => {
  try {
    const body = req.body || {};
    const inst = registry.register(body);
    res.json({ ok: true, instance: inst });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/heartbeat', (req, res) => {
  try {
    const body = req.body || {};
    const inst = registry.heartbeat(body);
    res.json({ ok: true, instance: inst || null });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/unregister', (req, res) => {
  try {
    const body = req.body || {};
    const ok = registry.unregister(body);
    res.json({ ok });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/resolve/:name', (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const inst = registry.resolve(name);
    if (!inst) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, instance: inst });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/list', (req, res) => {
  try {
    res.json({ ok: true, services: registry.list() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, pid: process.pid });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

// Write daemon location and PID to discovery file for clients to find
function writeDiscoveryFile(host, port) {
  const info = {
    host,
    port,
    pid: process.pid,
    startedAt: new Date().toISOString()
  };
  try {
    safeJsonWrite(TMP_FILE, info);
  } catch (err) {
    console.error('failed to write discovery file', err);
  }
}

// Check if discovery file exists and if the daemon PID is still alive
function discoveryFileIsStale() {
  try {
    const raw = fs.readFileSync(TMP_FILE, 'utf8');
    const info = JSON.parse(raw);
    if (!info || !info.pid) return true;
    try {
      process.kill(info.pid, 0); // throws on unix if not exists
      return false; // process exists -> not stale
    } catch (e) {
      return true;
    }
  } catch (e) {
    return true;
  }
}

// Remove discovery file if it belongs to current daemon process
function removeDiscoveryFileIfMine() {
  try {
    if (!fs.existsSync(TMP_FILE)) return;
    const raw = fs.readFileSync(TMP_FILE, 'utf8');
    const info = JSON.parse(raw);
    if (info.pid === process.pid) {
      fs.unlinkSync(TMP_FILE);
    }
  } catch (e) {
    // ignore
  }
}

// Main entry point: start Express server, initialize cleanup intervals, setup signal handlers
(async function main() {
  // guard: if discovery file exists and pid alive, exit to avoid dup daemons
  try {
    if (!discoveryFileIsStale()) {
      const raw = fs.readFileSync(TMP_FILE, 'utf8');
      const info = JSON.parse(raw);
      console.error(`svc-registry daemon already running at ${info.host}:${info.port} pid=${info.pid}`);
      process.exit(1);
    }
  } catch (e) {
    // continue
  }

  const server = app.listen(0, HOST, () => {
    const addr = server.address();
    writeDiscoveryFile(addr.address, addr.port);
    console.log(`svc-registry daemon started on ${addr.address}:${addr.port} pid=${process.pid}`);
  });

  // periodic cleanup
  const cleaner = setInterval(() => {
    try {
      registry.cleanupExpired();
    } catch (e) {
      // ignore
    }
  }, HEARTBEAT_CLEAN_INTERVAL);

  // write discovery periodically (in case of restarts or to update startedAt)
  const writer = setInterval(() => {
    try {
      const addr = server.address();
      if (addr && addr.port) writeDiscoveryFile(addr.address, addr.port);
    } catch (e) {}
  }, 5000);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', err => {
    console.error('uncaughtException in svc-registry', err);
    shutdown();
  });

  // Gracefully shutdown daemon: stop intervals, close server, clean up discovery file
  function shutdown() {
    try {
      clearInterval(cleaner);
      clearInterval(writer);
      server.close(() => {
        removeDiscoveryFileIfMine();
        process.exit(0);
      });
      // in case close hangs
      setTimeout(() => {
        removeDiscoveryFileIfMine();
        process.exit(0);
      }, 2000).unref();
    } catch (e) {
      process.exit(1);
    }
  }
})();
