// Kipfel Bridge: lets the desk panel drive Photoshop's brush live.
//
// Photoshop's COM interface cannot carry a drag — every DoJavaScript call costs
// ~200ms whatever it contains. From in here, measured on 27.10:
//
//   brush read                      0.8ms
//   brush write, own modal scope    4.9ms
//
// So the plugin connects out to RaphiiWinUtils and applies whatever arrives.
// The socket is outbound to 127.0.0.1, so it needs no credential and Photoshop
// does not have to listen for anything.
/* global document */
const { action, core } = require("photoshop");
const { entrypoints } = require("uxp");

const SERVICE_URL = "ws://127.0.0.1:17642/photoshop/ws";
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
// A brush change made in Photoshop itself (the `[` and `]` keys, the canvas
// HUD) should reach the panel too, but `set` fires for a great many things.
// Coalesce to one read per burst.
const ECHO_DEBOUNCE_MS = 120;

let socket = null;
let backoff = RECONNECT_MIN_MS;
let reconnectTimer = null;
let echoTimer = null;
let status = "starting";
let statusNode = null;

const GET_TOOL_OPTIONS = {
  _obj: "get",
  _target: [
    { _property: "currentToolOptions" },
    { _ref: "application", _enum: "ordinal", _value: "targetEnum" }
  ]
};

const setBrushDescriptor = (diameter, angle) => ({
  _obj: "set",
  _target: [{ _ref: "brush", _enum: "ordinal", _value: "targetEnum" }],
  to: {
    _obj: "computedBrush",
    diameter: { _unit: "pixelsUnit", _value: diameter },
    angle: { _unit: "angleUnit", _value: angle }
  }
});

const describe = (error) => String(error && error.message ? error.message : error);

function setStatus(next) {
  status = next;
  console.log("[kipfel] " + next);
  if (statusNode) statusNode.textContent = next;
}

async function readBrush() {
  const res = await action.batchPlay([GET_TOOL_OPTIONS], { synchronousExecution: false });
  const options = res && res[0] && res[0].currentToolOptions;
  const brush = options && options.brush;
  if (!brush || !brush.diameter) return null;
  return {
    diameter: brush.diameter._value,
    angle: brush.angle ? brush.angle._value : 0
  };
}

function send(payload) {
  if (!socket || socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    /* the close handler reconnects */
  }
}

async function sendBrush() {
  try {
    const brush = await readBrush();
    send(brush ? { type: "brush", diameter: brush.diameter, angle: brush.angle } : { type: "brush" });
  } catch {
    send({ type: "brush" });
  }
}

async function applyBrush(diameter, angle) {
  // Anything that modifies Photoshop has to run in a modal scope, and both
  // fields go together: a set that omits one resets it to its default.
  await core.executeAsModal(async () => action.batchPlay([setBrushDescriptor(diameter, angle)], { synchronousExecution: false }), {
    commandName: "Kipfel brush"
  });
}

function scheduleEcho() {
  if (echoTimer) return;
  echoTimer = setTimeout(() => {
    echoTimer = null;
    void sendBrush();
  }, ECHO_DEBOUNCE_MS);
}

async function handle(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;

  if (message.type === "read") {
    await sendBrush();
    return;
  }
  if (message.type !== "set") return;
  if (typeof message.diameter !== "number" || typeof message.angle !== "number") return;

  const diameter = Math.max(1, Math.min(5000, message.diameter));
  // Photoshop takes the angle as -180..180; the panel sends 0..359.
  let angle = ((message.angle % 360) + 360) % 360;
  if (angle > 180) angle -= 360;

  try {
    await applyBrush(diameter, angle);
    send({ type: "brush", diameter, angle: message.angle });
  } catch (error) {
    setStatus("write failed: " + describe(error));
    await sendBrush();
  }
}

function connect() {
  reconnectTimer = null;
  setStatus("connecting");
  try {
    socket = new WebSocket(SERVICE_URL);
  } catch (error) {
    setStatus("constructor threw: " + describe(error));
    retry();
    return;
  }
  socket.onopen = () => {
    backoff = RECONNECT_MIN_MS;
    setStatus("connected");
    void sendBrush();
  };
  socket.onmessage = (event) => {
    void handle(typeof event.data === "string" ? event.data : "");
  };
  socket.onclose = () => {
    socket = null;
    setStatus("disconnected");
    retry();
  };
  socket.onerror = () => {
    setStatus("socket error");
  };
}

function retry() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
}

// Manifest v5 refuses to load a plugin whose declared entrypoints are not
// registered, even when the panel is never opened.
entrypoints.setup({
  panels: {
    kipfelBridgePanel: {
      show(node) {
        const wrap = document.createElement("div");
        wrap.style.padding = "12px";
        const title = document.createElement("p");
        title.textContent = "Kipfel Bridge";
        title.style.fontWeight = "bold";
        statusNode = document.createElement("p");
        statusNode.textContent = status;
        wrap.appendChild(title);
        wrap.appendChild(statusNode);
        node.appendChild(wrap);
      }
    }
  }
});

// Report a brush changed inside Photoshop, so the panel's readout follows the
// `[` and `]` keys as well as its own joggers.
try {
  action.addNotificationListener([{ event: "set" }], () => scheduleEcho());
} catch {
  /* without this the panel is still correct, just not live from Photoshop */
}

connect();
