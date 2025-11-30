#!/usr/bin/env node
/**
 * Minimal CLI for svc-registry
 *
 * Commands:
 *   svc-registry start
 *   svc-registry stop
 *   svc-registry list
 *   svc-registry register <name> <port> [host]
 *   svc-registry unregister <name> [id]
 *   svc-registry resolve <name>
 *
 * This CLI uses the client above.
 */

import client from '../lib/client.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TMP_FILE = path.join(os.tmpdir(), 'svc-registry.json');

async function run() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  try {
    if (!cmd || cmd === 'help') {
      console.log('svc-registry CLI\n\nCommands:\n  start\n  stop\n  list\n  register <name> <port> [host]\n  unregister <name> [id]\n  resolve <name>');
      process.exit(0);
    }

    if (cmd === 'start') {
      await client.startDaemonIfNeeded();
      console.log('svc-registry daemon is running.');
      process.exit(0);
    }

    if (cmd === 'stop') {
      // attempt to kill daemon based on discovery file
      const info = client.discoveryInfo();
      if (!info || !info.pid) {
        console.log('No daemon discovered.');
        process.exit(1);
      }
      try {
        process.kill(info.pid, 'SIGTERM');
        console.log(`requested shutdown of daemon pid=${info.pid}`);
        // remove file if still present and it's ours
        try { fs.unlinkSync(TMP_FILE); } catch (e) {}
        process.exit(0);
      } catch (e) {
        console.error('failed to stop daemon', e.message);
        process.exit(1);
      }
    }

    if (cmd === 'list') {
      const resp = await client.list();
      console.log(JSON.stringify(resp.services || resp, null, 2));
      process.exit(0);
    }

    if (cmd === 'register') {
      const name = argv[1];
      const port = Number(argv[2]);
      const host = argv[3] || '127.0.0.1';
      if (!name || !port) {
        console.error('usage: register <name> <port> [host]');
        process.exit(1);
      }
      const resp = await client.register({ name, port, host, pid: process.pid });
      console.log(JSON.stringify(resp, null, 2));
      process.exit(0);
    }

    if (cmd === 'unregister') {
      const name = argv[1];
      const id = argv[2];
      if (!name) {
        console.error('usage: unregister <name> [id]');
        process.exit(1);
      }
      const resp = await client.unregister({ name, id });
      console.log(JSON.stringify(resp, null, 2));
      process.exit(0);
    }

    if (cmd === 'resolve') {
      const name = argv[1];
      if (!name) {
        console.error('usage: resolve <name>');
        process.exit(1);
      }
      const resp = await client.resolve(name);
      console.log(JSON.stringify(resp, null, 2));
      process.exit(0);
    }

    console.error('unknown command');
    process.exit(1);
  } catch (err) {
    console.error('error:', err.message || err);
    process.exit(1);
  }
}

run();
