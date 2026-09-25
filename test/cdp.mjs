/**
 * test/cdp.mjs — chạy Chrome/Edge headless và điều khiển bằng DevTools Protocol.
 *
 * Không cần puppeteer: dùng WebSocket của Node 22+ và fetch của Node 18+.
 * Chỉ phục vụ kiểm tra giao diện khi phát triển (không chạy trong production).
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.DSH_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

export function findBrowser() {
  for (const c of CANDIDATES) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* chưa lên */
    }
    await sleep(120);
  }
  throw new Error(`Chrome không mở cổng ${port}`);
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const list = this.listeners.get(msg.method);
        if (list) for (const fn of list) fn(msg.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 30000);
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const fn = (params) => {
        const list = this.listeners.get(method) || [];
        this.listeners.set(
          method,
          list.filter((f) => f !== fn),
        );
        resolve(params);
      };
      const list = this.listeners.get(method) || [];
      list.push(fn);
      this.listeners.set(method, list);
    });
  }

  /** Chạy biểu thức trong trang và trả về giá trị đã JSON hóa. */
  async evaluate(fnSource, awaitPromise = false) {
    const res = await this.send("Runtime.evaluate", {
      expression: `(() => { ${fnSource} })()`,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      throw new Error(
        "Lỗi trong trang: " +
          (res.exceptionDetails.exception?.description || res.exceptionDetails.text),
      );
    }
    return res.result.value;
  }

  async setViewport(width, height, mobile) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: !!mobile,
      screenWidth: width,
      screenHeight: height,
    });
  }

  async goto(url, settleMs = 900) {
    const loaded = this.once("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
    await sleep(settleMs);
  }
}

export async function launchBrowser({ port = 9333 } = {}) {
  const bin = findBrowser();
  if (!bin) throw new Error("Không tìm thấy Chrome hoặc Edge trên máy này.");
  const profile = mkdtempSync(join(tmpdir(), "ui-cdp-"));
  const child = spawn(
    bin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  await waitForPort(port);

  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const target = list.find((t) => t.type === "page");
  if (!target) throw new Error("Không tìm thấy tab nào để điều khiển.");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener("open", resolveOpen, { once: true });
    ws.addEventListener("error", () => rejectOpen(new Error("WebSocket lỗi")), { once: true });
  });

  const session = new Session(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Console.enable").catch(() => {});

  const consoleErrors = [];
  session.listeners.set("Runtime.exceptionThrown", [
    (p) =>
      consoleErrors.push({
        type: "exception",
        text: p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || "",
      }),
  ]);
  session.listeners.set("Log.entryAdded", [
    (p) => {
      if (p?.entry?.level === "error") {
        consoleErrors.push({ type: "console", text: `${p.entry.source}: ${p.entry.text}` });
      }
    },
  ]);
  session.consoleErrors = consoleErrors;

  session.close = async () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    child.kill();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return session;
}
