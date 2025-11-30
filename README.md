# micro-svc-registry

A **zero-config local service discovery layer** powered by an **Express-based daemon**.  
Designed for Node.js microservices running locally — especially Express apps.

No hardcoded ports, no .env syncing, no local DNS hacks, no Docker overhead.

## Why this exists

Local microservice development usually means:

- Random port conflicts (`3001`? `5173`? `8080`?)
- Hardcoded URLs inside services
- Registrations that break every time you restart a service
- Gateways that fail with ECONNREFUSED during restarts
- No lightweight service discovery unless you run Kubernetes or Docker

`micro-svc-registry` solves all this with a tiny local daemon that:

- Runs automatically
- Listens on `127.0.0.1:<random-port>`
- Tracks live services
- Cleans up stale ones automatically
- Lets services find each other *by name*

## Features

- **Express-based daemon** (clean routing, JSON body parsing, extensible)
- **Automatic daemon boot** (client forks it if missing)
- **Register / heartbeat / resolve / list / unregister** APIs
- **TTL-based cleanup**
- **Zero configuration**
- **No dependencies required in your services**
- **Purely development-focused**

## Installation

```bash
npm install micro-svc-registry
```

## Quick Start

### 1. Register your service

```js
import registry from "micro-svc-registry";

const { instance } = await registry.register({
  name: "auth-service",
  port: 3001,
  pid: process.pid
});

console.log("Registered:", instance.id);
```

### 2. Send heartbeats

```js
setInterval(() => {
  registry.heartbeat({
    name: "auth-service",
    id: instance.id
  });
}, 5000);
```

### 3. Resolve a service

```js
const resp = await registry.resolve("auth-service");

if (resp.instance) {
  const { host, port } = resp.instance;
  console.log("Auth at:", `http://${host}:${port}`);
}
```

---

# API Reference

### `register({ name, port, host?, pid?, id?, meta? })`
Registers a service instance in the daemon.

### `heartbeat({ name, id })`
Refreshes the lastSeen timestamp so the instance stays alive.

### `resolve(name)`
Returns the most recently active instance for that service.

### `list()`
Returns **all** services + all currently alive instances.

### `unregister({ name, id })`
Stops tracking this instance.

### `startDaemonIfNeeded()`
Starts the Express daemon if it doesn’t exist yet.

### `discoveryInfo()`
Returns `{ host, port, pid }` of the running daemon.

---

# Express-Based Daemon Endpoints

Your daemon now exposes:

- `POST /register`
- `POST /heartbeat`
- `POST /unregister`
- `GET  /resolve/:name`
- `GET  /list`
- `GET  /health`

The body is always JSON.

Example:

```bash
POST /register
{
  "name": "auth-service",
  "port": 3001,
  "pid": 12345
}
```

Response:

```json
{
  "ok": true,
  "instance": {
    "id": "127.0.0.1:3001:839212",
    "host": "127.0.0.1",
    "port": 3001,
    "lastSeen": 1735820123912
  }
}
```

---

# Example: Local Microservices

## Auth Service (Express)

```js
import express from "express";
import registry from "micro-svc-registry";

const app = express();
const PORT = 3001;

app.get("/authenticate", (req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  const { instance } = await registry.register({
    name: "auth-service",
    port: PORT,
    pid: process.pid
  });

  setInterval(() => {
    registry.heartbeat({ name: "auth-service", id: instance.id });
  }, 5000);
});
```

## Gateway

```js
import express from "express";
import axios from "axios";
import registry from "micro-svc-registry";

const app = express();
const PORT = 3000;

app.get("/auth/authenticate", async (req, res) => {
  const resp = await registry.resolve("auth-service");

  if (!resp.instance) return res.status(503).json({ error: "auth down" });

  const { host, port } = resp.instance;
  const result = await axios.get(`http://${host}:${port}/authenticate`);
  res.json(result.data);
});

app.listen(PORT, () =>
  console.log("Gateway on 3000")
);
```

---

# How It Works (Express Version)

### 1. Daemon Startup
- Client forks an Express-based server from `daemon.js`
- Daemon picks a random open port using Express
- Writes discovery file → `/tmp/svc-registry.json`

### 2. Registration
- Service sends POST `/register`
- Daemon creates instance entry
- Returns generated instance ID

### 3. Heartbeats
- Services send POST `/heartbeat`
- Daemon updates `lastSeen`

### 4. Auto Cleanup
Every 5s daemon removes instances where:

```
now - lastSeen > TTL (default 15000 ms)
```

### 5. Resolution
- `/resolve/:name`
- Returns the most recently active instance

---

# Configuration

```bash
SVC_TTL=20000   # override TTL (ms)
```

---

# Limitations

- Only works on 127.0.0.1 (local machine)
- In-memory only (daemon restart = registry reset)
- No SSL/TLS
- No auth
- NOT for production use

## License

MIT
