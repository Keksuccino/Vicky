#!/usr/bin/env node
// Drives a headless Chrome through the DevTools protocol to check UI offscreen: no window, no
// focus change. Steps come from a JSON file; see TESTING_GUIDELINES.md for the format.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_CHROME_PATHS = {
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  linux: "/usr/bin/google-chrome",
  win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
};
const DEFAULT_TIMEOUT_MS = 15_000;

const fail = (message) => {
  console.error(`[offscreen-browser] ${message}`);
  process.exit(1);
};

const stepsPath = process.argv[2];
if (!stepsPath) {
  fail("Usage: node scripts/offscreen-browser.mjs <steps.json>");
}

const plan = JSON.parse(await readFile(stepsPath, "utf8"));
const baseDir = path.dirname(path.resolve(stepsPath));
const chromePath = process.env.CHROME_PATH || DEFAULT_CHROME_PATHS[process.platform];
// One reused profile keeps runs from leaving profiles behind; runs must therefore not overlap.
const profileDir = path.resolve(process.env.OFFSCREEN_BROWSER_PROFILE_DIR || path.join(process.cwd(), "node_modules", ".cache", "offscreen-browser-profile"));
const viewport = { width: 1440, height: 1000, deviceScaleFactor: 1, ...plan.viewport };

await mkdir(profileDir, { recursive: true });
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--mute-audio",
    `--window-size=${viewport.width},${viewport.height}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const browserUrl = await new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error("Chrome did not start.")), DEFAULT_TIMEOUT_MS);
  chrome.on("error", reject);
  chrome.stderr.on("data", (chunk) => {
    output += chunk;
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
}).catch((error) => fail(error.message));

const { port } = new URL(browserUrl);
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const listeners = new Set();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) {
    const { reject, resolve } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result);
    }
  } else if (message.method) {
    listeners.forEach((listener) => listener(message));
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { reject, resolve });
    socket.send(JSON.stringify({ id, method, params }));
  });

const waitForEvent = (method, timeoutMs = DEFAULT_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`Timed out waiting for ${method}.`));
    }, timeoutMs);
    const listener = (message) => {
      if (message.method === method) {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message.params);
      }
    };
    listeners.add(listener);
  });

const evaluate = async (expression) => {
  const { exceptionDetails, result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
};

const waitForSelector = async (selector, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${selector}.`);
};

// Scrolling is instant: a page's smooth scroll-behavior would otherwise animate after the measurement.
/** Centre of the element's box after scrolling it into view, in CSS pixels of the viewport. */
const elementCenter = async (selector) => {
  await waitForSelector(selector);
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
};

/**
 * Document-coordinate box of an element for a full-page capture. The page is scrolled to the top
 * first, so sticky headers render at the top of the document instead of over the element.
 */
const elementClip = async (selector) => {
  await waitForSelector(selector);
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    window.scrollTo({ behavior: "instant", left: 0, top: 0 });
    const box = element.getBoundingClientRect();
    return { x: box.left + window.scrollX, y: box.top + window.scrollY, width: box.width, height: box.height, scale: 1 };
  })()`);
};

/** Windows virtual key codes of the named keys `key` steps press; Chrome runs a key's default action (deleting, moving the caret or focus) only with its code. */
const NAMED_KEY_CODES = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };

/** Presses one key as a keyboard does: a named key, or a single character, which is typed. */
const pressKey = async (key) => {
  const keyCode = NAMED_KEY_CODES[key];
  const text = key === "Enter" ? "\r" : keyCode === undefined ? key : "";
  const event = { key, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode ?? 0 };
  await send("Input.dispatchKeyEvent", { ...event, type: text ? "keyDown" : "rawKeyDown" });
  await send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runStep = async (step) => {
  if (step.goto) {
    const loaded = waitForEvent("Page.loadEventFired", step.timeoutMs);
    await send("Page.navigate", { url: step.goto });
    await loaded;
  } else if (step.waitFor) {
    await waitForSelector(step.waitFor, step.timeoutMs);
  } else if (step.click) {
    const { x, y } = await elementCenter(step.click);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } else if (step.type !== undefined) {
    await send("Input.insertText", { text: step.type });
  } else if (step.keys !== undefined) {
    for (const [index, character] of [...step.keys].entries()) {
      if (index > 0 && step.delay) {
        await sleep(step.delay);
      }
      await pressKey(character);
    }
  } else if (step.key) {
    for (let count = 0; count < (step.repeat ?? 1); count += 1) {
      await pressKey(step.key);
    }
  } else if (step.eval) {
    console.log(JSON.stringify(await evaluate(step.eval)));
  } else if (step.wait) {
    await sleep(step.wait);
  } else if (step.screenshot) {
    const clip = step.selector ? await elementClip(step.selector) : undefined;
    const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    const outputPath = path.resolve(baseDir, step.screenshot);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(data, "base64"));
    console.log(`[offscreen-browser] Saved ${outputPath}`);
  } else {
    throw new Error(`Unknown step ${JSON.stringify(step)}.`);
  }
};

// A JavaScript dialog (alert, confirm, prompt) blocks the page until it is answered. Dialogs are
// printed and answered right away: accepted by default, or as the plan's `dialogs` says
// ("accept" or "dismiss").
listeners.add((message) => {
  if (message.method === "Page.javascriptDialogOpening") {
    const accept = plan.dialogs !== "dismiss";
    console.log(`[offscreen-browser] ${accept ? "Accepted" : "Dismissed"} ${message.params.type}: ${JSON.stringify(message.params.message)}`);
    void send("Page.handleJavaScriptDialog", { accept });
  }
});

try {
  await send("Page.enable");
  // The tab is headless and has no OS window; fronting it only lets it render and scroll like a visible tab.
  await send("Page.bringToFront");
  await send("Emulation.setDeviceMetricsOverride", { ...viewport, mobile: Boolean(plan.mobile) });
  if (plan.colorScheme) {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: plan.colorScheme }] });
  }
  for (const cookie of plan.cookies ?? []) {
    await send("Network.setCookie", cookie);
  }
  if (plan.initScript) {
    await send("Page.addScriptToEvaluateOnNewDocument", { source: plan.initScript });
  }
  for (const step of plan.steps ?? []) {
    await runStep(step);
  }
} catch (error) {
  console.error(`[offscreen-browser] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  socket.close();
  chrome.kill();
}
