"use strict";

// Shared test utilities: boot an in-process server on an ephemeral port,
// create guest sessions over HTTP, and open Socket.IO client connections.
//
// NOTE: test files MUST set env vars (NODE_ENV=test, DATA_DIR, SESSION_SECRET,
// REVEAL_SECONDS) BEFORE requiring this module's startTestServer(), because the
// app reads config at require time. startTestServer requires the app lazily so
// those env vars are already in place.

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("node:http");
const { io: ioClient } = require("socket.io-client");

// One-off POST with keep-alive disabled — avoids the global fetch/undici
// connection pool holding the process open after tests finish.
function postJson(port, urlPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const headers = { "Content-Type": "application/json", "Content-Length": data.length, Connection: "close" };
    if (cookie) headers.Cookie = cookie;
    const req = http.request(
      {
        host: "localhost",
        port,
        path: urlPath,
        method: "POST",
        agent: false,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
        );
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

// GET with the same keep-alive-disabled treatment as postJson.
function get(port, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { Connection: "close" };
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: "localhost", port, path: urlPath, method: "GET", agent: false, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function tempDataDir() {
  const dir = path.join(os.tmpdir(), "wiki-guesser-test-" + crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function startTestServer(overrides = {}) {
  const { buildServer } = require("../server/app"); // lazy: env must be set first
  const { server, io, manager } = buildServer(overrides);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return {
    port,
    server,
    io,
    manager,
    close: () => {
      manager.shutdown(); // clear room timers so the process can exit
      return new Promise((resolve) => io.close(resolve));
    },
  };
}

async function guestSession(port, name) {
  const res = await postJson(port, "/auth/guest", { name });
  const cookie = (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  const user = JSON.parse(res.body).user;
  return { cookie, user };
}

function connect(port, cookie) {
  // forceNew so each client is its own connection (socket.io-client caches by URL).
  return ioClient(`http://localhost:${port}`, {
    extraHeaders: { Cookie: cookie },
    transports: ["websocket", "polling"],
    forceNew: true,
  });
}

function once(sock, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), ms);
    sock.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

// Resolve when an event arrives whose payload satisfies `pred`.
function waitFor(sock, event, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(event, handler); reject(new Error(`timeout waiting for "${event}"`)); }, ms);
    const handler = (data) => {
      if (pred(data)) { clearTimeout(t); sock.off(event, handler); resolve(data); }
    };
    sock.on(event, handler);
  });
}

// postJson exposed so tests can drive endpoints directly (e.g. rate limits).
module.exports = { tempDataDir, startTestServer, guestSession, connect, once, waitFor, get, postJson };
