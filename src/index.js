import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const AI_LIGHT_DIR = join(homedir(), ".ai_light");
const RUNTIME_PATH = join(AI_LIGHT_DIR, "runtime.json");
const LOG_PATH = join(AI_LIGHT_DIR, "opencode-plugin.log");
const PLUGIN_VERSION = "debug-2026-06-18-status-driven-v3";
const WORKING_DELAY_MS = 100;

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

function getSessionId(event) {
  return (
    event?.sessionID ||
    event?.sessionId ||
    event?.session_id ||
    event?.properties?.sessionID ||
    event?.properties?.sessionId ||
    event?.properties?.session_id ||
    event?.properties?.info?.sessionID ||
    event?.properties?.info?.sessionId ||
    event?.properties?.info?.session_id ||
    event?.properties?.info?.session?.id ||
    event?.properties?.info?.id ||
    event?.properties?.session?.id ||
    "unknown"
  );
}

function getStatusType(event) {
  const status = event?.properties?.status;
  if (typeof status === "string") return status;
  return status?.type || status?.status || status?.state || event?.properties?.statusType;
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
  log(`initialized version=${PLUGIN_VERSION} target=${url} cwd=${directory}`);
  await postEvent(url, "session-end", "unknown");

  const knownSessions = new Set();
  const pendingWorkingTimers = new Map();
  const sessionVersions = new Map();

  async function ensureSessionStarted(sid, cwdPath) {
    if (knownSessions.has(sid)) return;
    knownSessions.add(sid);
    await postEvent(url, "session-start", sid, cwdPath || directory || "");
  }

  async function postKnownSessionEvent(eventType, sid) {
    if (sid === "unknown") {
      log(`ignored: event=${eventType} reason=unknown-session`);
      return;
    }
    await ensureSessionStarted(sid);
    await postEvent(url, eventType, sid);
  }

  function clearPendingWorking(sid) {
    const timer = pendingWorkingTimers.get(sid);
    if (!timer) return;
    clearTimeout(timer);
    pendingWorkingTimers.delete(sid);
    log(`cancelled: event=prompt-submit session=${sid}`);
  }

  async function scheduleWorking(sid) {
    if (sid === "unknown") {
      log("ignored: event=prompt-submit reason=unknown-session");
      return;
    }
    const version = sessionVersions.get(sid) || 0;
    await ensureSessionStarted(sid);
    if ((sessionVersions.get(sid) || 0) !== version) {
      log(`ignored: event=prompt-submit session=${sid} reason=stale-busy`);
      return;
    }
    clearPendingWorking(sid);
    const timer = setTimeout(async () => {
      pendingWorkingTimers.delete(sid);
      if ((sessionVersions.get(sid) || 0) !== version) {
        log(`ignored: event=prompt-submit session=${sid} reason=stale-timer`);
        return;
      }
      await postEvent(url, "prompt-submit", sid);
    }, WORKING_DELAY_MS);
    pendingWorkingTimers.set(sid, timer);
  }

  async function sendStop(sid) {
    sessionVersions.set(sid, (sessionVersions.get(sid) || 0) + 1);
    clearPendingWorking(sid);
    await postKnownSessionEvent("stop", sid);
  }

  return {
    event: async ({ event }) => {
      const type = event?.type || "unknown";
      const sid = getSessionId(event);
      log(`received: type=${type} session=${sid}`);

      switch (type) {
        case "session.created":
          knownSessions.add(sid);
          await postEvent(url, "session-start", sid, event?.properties?.cwd || directory || "");
          break;
        case "session.updated":
          break;
        case "session.status": {
          const statusType = getStatusType(event);
          log(`status: session=${sid} value=${statusType || "unknown"}`);
          if (statusType === "busy" || statusType === "retry") {
            await scheduleWorking(sid);
          } else if (statusType === "idle") {
            await sendStop(sid);
          }
          break;
        }
        case "message.updated":
          break;
        case "session.idle":
          await sendStop(sid);
          break;
        case "session.error":
          await postEvent(url, "notification", sid);
          break;
        case "session.deleted":
          sessionVersions.set(sid, (sessionVersions.get(sid) || 0) + 1);
          clearPendingWorking(sid);
          await postEvent(url, "session-end", sid);
          break;
        case "permission.asked":
          await postEvent(url, "permission-request", sid);
          break;
      }
    },
  };
};
