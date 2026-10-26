const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const PORT = 8765;
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'ui')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let safeMode = true;

const SAFE_COMMAND_REGEX = /^(ls|dir|cat|head|tail|grep|find|git\s+(status|diff|log|branch)|pwd|echo|node\s+-v|pnpm\s+-v|npm\s+-v)(\s+.*)?$/i;
const FATAL_COMMAND_REGEX = /(rm\s+-rf\s+\/|mkfs|dd\s+if=.*of=\/dev|:\(\)\{\s*:\|:&\s*\};:)/i;

let uiSocket = null;
const extensionSockets = new Map();

function getSelectors() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'selectors.json'), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (err) {
      console.error('[DAEMON] Invalid message received:', err.message);
    }
  });

  ws.on('close', () => {
    if (ws === uiSocket) {
      uiSocket = null;
      console.log('[DAEMON] Cockpit UI disconnected');
    }
    for (const [agent, socket] of extensionSockets.entries()) {
      if (socket === ws) {
        extensionSockets.delete(agent);
        console.log(`[DAEMON] Agent disconnected: ${agent}`);
        broadcastState();
        break;
      }
    }
  });
});

function handleMessage(ws, data) {
  switch (data.type) {
    case 'REGISTER_UI':
      uiSocket = ws;
      console.log('[DAEMON] Cockpit UI registered successfully');
      broadcastState();
      break;

    case 'REGISTER_AGENT':
      extensionSockets.set(data.agent, ws);
      console.log(`[DAEMON] Agent registered: ${data.agent}`);
      ws.send(JSON.stringify({
        type: 'CONFIG_SYNC',
        selectors: getSelectors()
      }));
      broadcastState();
      break;

    case 'TOGGLE_SAFE_MODE':
      safeMode = Boolean(data.value);
      console.log(`[DAEMON] Safe mode toggled to: ${safeMode}`);
      broadcastState();
      break;

    case 'EXEC_REQUEST':
      console.log(`[DAEMON] EXEC_REQUEST from [${data.agent}]: "${data.command}"`);
      processCommand(data.agent, data.command);
      break;

    case 'MANUAL_DECISION':
      console.log(`[DAEMON] Decision for [${data.agent}] ("${data.command}"): ${data.approved ? 'APPROVED' : 'REJECTED'}`);
      if (data.approved) {
        runCommand(data.agent, data.command);
      } else {
        notifyAgent(data.agent, '<output exit_code="1">Execution rejected by user.</output>\n[REMINDER: Output next step strictly inside [EXEC]...[/EXEC]. Keep comments minimal and in English.]');
      }
      break;
  }
}

function processCommand(agent, command) {
  const trimmed = command.trim();

  if (FATAL_COMMAND_REGEX.test(trimmed)) {
    console.warn(`[DAEMON] Blocked fatal command: ${trimmed}`);
    notifyAgent(agent, '<output exit_code="1">Command blocked: Matches prohibited destructive pattern.</output>');
    return;
  }

  const isSafe = SAFE_COMMAND_REGEX.test(trimmed);
  if (!safeMode || isSafe) {
    console.log(`[DAEMON] Executing directly (safe=${isSafe}, safeMode=${safeMode})`);
    runCommand(agent, trimmed);
  } else {
    console.log(`[DAEMON] Requiring manual approval from UI for: "${trimmed}"`);
    if (uiSocket && uiSocket.readyState === uiSocket.OPEN) {
      uiSocket.send(JSON.stringify({
        type: 'REQUIRE_APPROVAL',
        agent,
        command: trimmed
      }));
    } else {
      console.error('[DAEMON] Cannot prompt review: UI is not connected!');
    }
  }
}

function runCommand(agent, command) {
  console.log(`[TERMINAL] Executing: ${command}`);

  exec(command, { maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
    const exitCode = error ? (error.code || 1) : 0;
    const combinedOutput = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
    const sanitized = combinedOutput.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

    const responsePayload = `<output exit_code="${exitCode}">\n${sanitized || '(Empty output)'}\n</output>\n[REMINDER: Output next step strictly inside [EXEC]...[/EXEC]. Keep comments minimal and in English. No 'any' types.]`;

    notifyAgent(agent, responsePayload);

    if (uiSocket && uiSocket.readyState === uiSocket.OPEN) {
      uiSocket.send(JSON.stringify({
        type: 'LOG_OUTPUT',
        agent,
        command,
        output: sanitized,
        exitCode
      }));
    }
  });
}

function notifyAgent(agent, content) {
  const socket = extensionSockets.get(agent);
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({
      type: 'INJECT_RESPONSE',
      content
    }));
  }
}

function broadcastState() {
  if (uiSocket && uiSocket.readyState === uiSocket.OPEN) {
    uiSocket.send(JSON.stringify({
      type: 'STATE_SYNC',
      safeMode,
      activeAgents: Array.from(extensionSockets.keys())
    }));
  }
}

server.listen(PORT, () => {
  console.log(`[DAEMON] Server ready at http://localhost:${PORT}`);
});
