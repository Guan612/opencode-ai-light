import { readFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const AI_LIGHT_DIR = join(homedir(), ".ai_light");
const RUNTIME_PATH = join(AI_LIGHT_DIR, "runtime.json");
const LOG_PATH = join(AI_LIGHT_DIR, "opencode-plugin.log");
const PLUGIN_VERSION = "0.1.0";
const WORKING_DELAY_MS = 100;

const UNKNOWN_SESSION_ID = "unknown";

const AI_LIGHT_EVENT = {
  NOTIFICATION: "notification",
  PERMISSION_REQUEST: "permission-request",
  PROMPT_SUBMIT: "prompt-submit",
  SESSION_END: "session-end",
  SESSION_START: "session-start",
  STOP: "stop",
};

const OPENCODE_EVENT = {
  MESSAGE_UPDATED: "message.updated",
  PERMISSION_ASKED: "permission.asked",
  SESSION_CREATED: "session.created",
  SESSION_DELETED: "session.deleted",
  SESSION_ERROR: "session.error",
  SESSION_IDLE: "session.idle",
  SESSION_STATUS: "session.status",
  SESSION_UPDATED: "session.updated",
};

const SESSION_STATUS = {
  BUSY: "busy",
  IDLE: "idle",
  RETRY: "retry",
};

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
    UNKNOWN_SESSION_ID
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
      session_id: sid || UNKNOWN_SESSION_ID,
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
  await postEvent(url, AI_LIGHT_EVENT.SESSION_END, UNKNOWN_SESSION_ID);

  const sessions = createSessionController(url, directory || "");

  return {
    event: async ({ event }) => {
      const type = event?.type || "unknown";
      const sid = getSessionId(event);
      log(`received: type=${type} session=${sid}`);

      switch (type) {
        case OPENCODE_EVENT.SESSION_CREATED:
          await sessions.start(sid, event?.properties?.cwd);
          break;
        case OPENCODE_EVENT.SESSION_UPDATED:
        case OPENCODE_EVENT.MESSAGE_UPDATED:
          break;
        case OPENCODE_EVENT.SESSION_STATUS: {
          const statusType = getStatusType(event);
          log(`status: session=${sid} value=${statusType || "unknown"}`);
          if (statusType === SESSION_STATUS.BUSY || statusType === SESSION_STATUS.RETRY) {
            await sessions.scheduleWorking(sid);
          } else if (statusType === SESSION_STATUS.IDLE) {
            await sessions.stop(sid);
          }
          break;
        }
        case OPENCODE_EVENT.SESSION_IDLE:
          await sessions.stop(sid);
          break;
        case OPENCODE_EVENT.SESSION_ERROR:
          await postEvent(url, AI_LIGHT_EVENT.NOTIFICATION, sid);
          break;
        case OPENCODE_EVENT.SESSION_DELETED:
          sessions.forget(sid);
          await postEvent(url, AI_LIGHT_EVENT.SESSION_END, sid);
          break;
        case OPENCODE_EVENT.PERMISSION_ASKED:
          await postEvent(url, AI_LIGHT_EVENT.PERMISSION_REQUEST, sid);
          break;
      }
    },
  };
};

function createSessionController(url, defaultDirectory) {
  const knownSessions = new Set();
  const pendingWorkingTimers = new Map();
  const sessionVersions = new Map();

  async function start(sid, cwdPath) {
    if (knownSessions.has(sid)) return;
    knownSessions.add(sid);
    await postEvent(url, AI_LIGHT_EVENT.SESSION_START, sid, cwdPath || defaultDirectory);
  }

  async function postKnownSessionEvent(eventType, sid) {
    if (sid === UNKNOWN_SESSION_ID) {
      log(`ignored: event=${eventType} reason=unknown-session`);
      return;
    }
    await start(sid);
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
    if (sid === UNKNOWN_SESSION_ID) {
      log(`ignored: event=${AI_LIGHT_EVENT.PROMPT_SUBMIT} reason=unknown-session`);
      return;
    }
    const version = sessionVersions.get(sid) || 0;
    await start(sid);
    if ((sessionVersions.get(sid) || 0) !== version) {
      log(`ignored: event=${AI_LIGHT_EVENT.PROMPT_SUBMIT} session=${sid} reason=stale-busy`);
      return;
    }
    clearPendingWorking(sid);
    const timer = setTimeout(async () => {
      pendingWorkingTimers.delete(sid);
      if ((sessionVersions.get(sid) || 0) !== version) {
        log(`ignored: event=${AI_LIGHT_EVENT.PROMPT_SUBMIT} session=${sid} reason=stale-timer`);
        return;
      }
      await postEvent(url, AI_LIGHT_EVENT.PROMPT_SUBMIT, sid);
    }, WORKING_DELAY_MS);
    pendingWorkingTimers.set(sid, timer);
  }

  async function stop(sid) {
    sessionVersions.set(sid, (sessionVersions.get(sid) || 0) + 1);
    clearPendingWorking(sid);
    await postKnownSessionEvent(AI_LIGHT_EVENT.STOP, sid);
  }

  function forget(sid) {
    sessionVersions.set(sid, (sessionVersions.get(sid) || 0) + 1);
    clearPendingWorking(sid);
    knownSessions.delete(sid);
  }

  return {
    forget,
    scheduleWorking,
    start,
    stop,
  };
}
