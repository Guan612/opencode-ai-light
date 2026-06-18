import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { homedir, platform } from "os";
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

function sessionId(event) {
  return event.sessionID || event.session_id || "unknown";
}

function cwd(event) {
  return event.properties?.cwd || event.cwd || event.directory || "";
}

async function postEvent(url, eventType, sid, cwdPath) {
  try {
    const body = JSON.stringify({
      event_type: eventType,
      session_id: sid,
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

let aiLightUrl = null;

export const OpenCodeAiLightPlugin = async ({ directory }) => {
  aiLightUrl = findAiLightUrl();
  if (!aiLightUrl) {
    log("AI Light not detected — runtime.json not found and AI_LIGHT_URL not set");
    return {};
  }
  log(`plugin initialized, target=${aiLightUrl} cwd=${directory}`);

  const queued = {};

  return {
    "session.created": async (event) => {
      const sid = sessionId(event);
      const cwdPath = cwd(event) || directory || "";
      await postEvent(aiLightUrl, "session-start", sid, cwdPath);
    },

    "session.updated": async (event) => {
      const sid = sessionId(event);
      await postEvent(aiLightUrl, "prompt-submit", sid);
    },

    "session.idle": async (event) => {
      const sid = sessionId(event);
      await postEvent(aiLightUrl, "stop", sid);
    },

    "session.error": async (event) => {
      const sid = sessionId(event);
      await postEvent(aiLightUrl, "notification", sid);
    },

    "session.deleted": async (event) => {
      const sid = sessionId(event);
      await postEvent(aiLightUrl, "session-end", sid);
    },

    "permission.asked": async (event) => {
      const sid = sessionId(event);
      await postEvent(aiLightUrl, "permission-request", sid);
    },
  };
};