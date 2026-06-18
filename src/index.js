import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const AI_LIGHT_DIR = join(homedir(), ".ai_light");
const RUNTIME_PATH = join(AI_LIGHT_DIR, "runtime.json");
const LOG_PATH = join(AI_LIGHT_DIR, "opencode-plugin.log");

function log(msg) {
  try {
    if (!existsSync(AI_LIGHT_DIR)) mkdirSync(AI_LIGHT_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function findAiLightUrl() {
  try {
    if (process.env.AI_LIGHT_URL) {
      const url = process.env.AI_LIGHT_URL.trim();
      if (url) return url;
    }
    if (!existsSync(RUNTIME_PATH)) return null;
    const raw = readFileSync(RUNTIME_PATH, "utf-8");
    const { http_port } = JSON.parse(raw);
    if (!http_port) return null;
    return `http://127.0.0.1:${http_port}/events`;
  } catch (err) {
    log(`findAiLightUrl error: ${err}`);
    return null;
  }
}

async function postEvent(url, eventType, sid, cwdPath) {
  try {
    const body = JSON.stringify({
      event_type: eventType,
      session_id: sid || "unknown",
      cwd: cwdPath || undefined,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    log(`sent: event=${eventType} session=${sid} status=${res.status}`);
  } catch (err) {
    log(`failed: event=${eventType} session=${sid} error=${err}`);
  }
}

export const OpenCodeAiLightPlugin = async ({ directory }) => {
  const url = findAiLightUrl();
  if (!url) {
    log("AI Light not detected — runtime.json not found and AI_LIGHT_URL not set");
    return {};
  }
  log(`initialized target=${url} cwd=${directory}`);

  let lastStopTime = 0;

  return {
    event: async ({ event }) => {
      const type = event?.type || "unknown";
      const sid = event?.sessionID || event?.session_id || "unknown";
      log(`received: type=${type} session=${sid}`);

      switch (type) {
        case "session.created":
          await postEvent(url, "session-start", sid, event?.properties?.cwd || directory || "");
          break;
        case "session.updated": {
          const now = Date.now();
          if (now - lastStopTime > 500) {
            await postEvent(url, "prompt-submit", sid);
          }
          break;
        }
        case "session.status": {
          const statusType = event?.properties?.status?.type;
          if (statusType === "idle") {
            lastStopTime = Date.now();
            await postEvent(url, "stop", sid);
          }
          break;
        }
        case "session.idle":
          lastStopTime = Date.now();
          await postEvent(url, "stop", sid);
          break;
        case "session.error":
          await postEvent(url, "notification", sid);
          break;
        case "session.deleted":
          await postEvent(url, "session-end", sid);
          break;
        case "permission.asked":
          await postEvent(url, "permission-request", sid);
          break;
      }
    },
  };
};