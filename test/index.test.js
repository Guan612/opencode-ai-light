import test from "node:test";
import assert from "node:assert/strict";

import { OpenCodeAiLightPlugin } from "../src/index.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createHarness({ onFetch } = {}) {
  const calls = [];
  const previousUrl = process.env.AI_LIGHT_URL;
  const previousFetch = globalThis.fetch;

  process.env.AI_LIGHT_URL = "http://127.0.0.1:1/events";
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (onFetch) await onFetch(body);
    return { status: 200 };
  };

  const plugin = await OpenCodeAiLightPlugin({ directory: "C:/tmp" });

  return {
    calls,
    plugin,
    restore() {
      if (previousUrl === undefined) delete process.env.AI_LIGHT_URL;
      else process.env.AI_LIGHT_URL = previousUrl;
      globalThis.fetch = previousFetch;
    },
  };
}

test("initialization removes stale unknown session", async () => {
  const harness = await createHarness();
  try {
    assert.deepEqual(harness.calls, [{ event_type: "session-end", session_id: "unknown" }]);
  } finally {
    harness.restore();
  }
});

test("session.updated alone does not send a working light", async () => {
  const harness = await createHarness();
  try {
    harness.calls.length = 0;
    await harness.plugin.event({ event: { type: "session.updated", properties: { sessionID: "s1" } } });
    await sleep(250);

    assert.deepEqual(harness.calls, []);
  } finally {
    harness.restore();
  }
});

test("session.status busy sends working and idle sends stop", async () => {
  const harness = await createHarness();
  try {
    harness.calls.length = 0;
    await harness.plugin.event({
      event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
    });
    await sleep(250);
    await harness.plugin.event({
      event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
    });

    assert.deepEqual(
      harness.calls.map((call) => call.event_type),
      ["session-start", "prompt-submit", "stop"],
    );
  } finally {
    harness.restore();
  }
});

test("quick busy then idle does not leave a delayed working light", async () => {
  const harness = await createHarness();
  try {
    harness.calls.length = 0;
    await harness.plugin.event({
      event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
    });
    await harness.plugin.event({
      event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
    });
    await sleep(250);

    assert.deepEqual(
      harness.calls.map((call) => call.event_type),
      ["session-start", "stop"],
    );
  } finally {
    harness.restore();
  }
});

test("idle during busy setup prevents delayed working light", async () => {
  const harness = await createHarness({
    async onFetch(body) {
      if (body.event_type === "session-start") await sleep(50);
    },
  });
  try {
    harness.calls.length = 0;
    const busy = harness.plugin.event({
      event: { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
    });
    await harness.plugin.event({
      event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } },
    });
    await busy;
    await sleep(250);

    assert.deepEqual(
      harness.calls.map((call) => call.event_type),
      ["session-start", "stop"],
    );
  } finally {
    harness.restore();
  }
});

test("completed assistant message does not stop while session may continue", async () => {
  const harness = await createHarness();
  try {
    harness.calls.length = 0;
    await harness.plugin.event({
      event: {
        type: "message.updated",
        properties: { sessionID: "s1", info: { role: "assistant", time: { completed: Date.now() } } },
      },
    });

    assert.deepEqual(harness.calls, []);
  } finally {
    harness.restore();
  }
});

test("session.updated does not send a working light for unknown sessions", async () => {
  const harness = await createHarness();
  try {
    harness.calls.length = 0;
    await harness.plugin.event({ event: { type: "session.updated", properties: {} } });
    await sleep(250);

    assert.deepEqual(harness.calls, []);
  } finally {
    harness.restore();
  }
});

test("unknown session status does not update a shared unknown light", async () => {
  const harness = await createHarness();
  try {
    harness.calls.length = 0;
    await harness.plugin.event({
      event: { type: "session.status", properties: { status: { type: "busy" } } },
    });
    await harness.plugin.event({
      event: { type: "session.status", properties: { status: { type: "idle" } } },
    });

    assert.deepEqual(harness.calls, []);
  } finally {
    harness.restore();
  }
});
