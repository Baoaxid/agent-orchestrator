const hostname = window.location.hostname;
let agentName = 'unknown';

if (hostname.includes('gemini.google')) agentName = 'gemini';
else if (hostname.includes('claude.ai')) agentName = 'claude';
else if (hostname.includes('chatgpt.com')) agentName = 'chatgpt';
else if (hostname.includes('grok.com')) agentName = 'grok';

let ws = null;
let lastDispatchedIndex = -1;
let activeSelectors = null;

function connectDaemon() {
  ws = new WebSocket('ws://localhost:8765');

  ws.onopen = () => {
    console.log(`%c[BRIDGE] Connected to daemon as: ${agentName}`, 'color: #00ff00; font-weight: bold;');
    ws.send(JSON.stringify({ type: 'REGISTER_AGENT', agent: agentName }));
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'CONFIG_SYNC' && data.selectors[agentName]) {
        activeSelectors = data.selectors[agentName];
      } else if (data.type === 'INJECT_RESPONSE') {
        console.log(`[BRIDGE] Received terminal response. Injecting into ${agentName}...`);
        await injectIntoChat(data.content);
      }
    } catch (err) {
      console.error('[BRIDGE] Socket message error:', err);
    }
  };

  ws.onclose = () => {
    setTimeout(connectDaemon, 2000);
  };
}

connectDaemon();

function queryWithFallback(selectors) {
  if (!selectors || !selectors.length) return null;
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch (e) {}
  }
  return null;
}

// Locate the real send button while filtering out attachment and tool buttons
function resolveSendButton() {
  const allButtons = [...document.querySelectorAll('button')].filter((b) => {
    const testid = (b.getAttribute('data-testid') || '').toLowerCase();
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    if (testid.includes('attach') || aria.includes('đính kèm') || aria.includes('attach')) return false;
    if (b.getAttribute('aria-haspopup') === 'menu') return false;
    return true;
  });

  // Strategy 1: Find by aria-label / type in configured languages
  const target = allButtons.find((b) => {
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    const type = (b.getAttribute('type') || '').toLowerCase();
    return (
      type === 'submit' ||
      aria.includes('gửi') ||
      aria.includes('send') ||
      aria.includes('submit') ||
      aria.includes('ask')
    );
  });
  if (target) return target;

  // Strategy 2: Query bar container action button fallback
  const inputEl = queryWithFallback(activeSelectors?.input || ['div.ProseMirror', 'textarea']);
  if (inputEl) {
    const container = inputEl.closest('form, div.relative, div[class*="query"]') || inputEl.parentElement;
    if (container) {
      const containerButtons = [...container.querySelectorAll('button')].filter((b) => {
        const testid = (b.getAttribute('data-testid') || '').toLowerCase();
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        return !testid.includes('attach') && !aria.includes('đính kèm') && !aria.includes('attach');
      });
      if (containerButtons.length > 0) {
        return containerButtons[containerButtons.length - 1];
      }
    }
  }

  return null;
}

async function injectIntoChat(text) {
  const inputEl = queryWithFallback(activeSelectors?.input || ['div.ProseMirror', 'textarea']);
  if (!inputEl) {
    console.error('[BRIDGE] Target input container not found');
    return;
  }

  inputEl.focus();
  await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));

  if (inputEl.tagName.toLowerCase() === 'textarea') {
    const valueSetter = Object.getOwnPropertyDescriptor(inputEl, 'value')?.set;
    const prototypeValueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inputEl), 'value')?.set;
    if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
      prototypeValueSetter.call(inputEl, text);
    } else {
      inputEl.value = text;
    }
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // For TipTap ProseMirror / ContentEditable elements
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  await new Promise((r) => setTimeout(r, 500 + Math.random() * 400));

  const sendBtn = resolveSendButton();
  if (sendBtn && !sendBtn.disabled) {
    console.log('[BRIDGE] Clicking resolved send button:', sendBtn);
    const rect = sendBtn.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    sendBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
    await new Promise((r) => setTimeout(r, 80));
    sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    sendBtn.click();
  } else {
    console.log('[BRIDGE] Send button not ready or disabled. Emitting Enter key event...');
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  }
}

// Index-based command tracker preventing consecutive-command lockups
function scanLatestCommand() {
  const fullText = document.body.innerText || '';
  if (!fullText) return;

  const matches = [...fullText.matchAll(/\[EXEC\]([\s\S]*?)\[\/EXEC\]/gi)];
  if (!matches.length) return;

  const validEntries = [];
  matches.forEach((m, idx) => {
    const cmd = m[1].trim();
    const lower = cmd.toLowerCase();
    if (
      cmd &&
      lower !== 'and' &&
      lower !== '...' &&
      !lower.includes('example:') &&
      !lower.includes('your_command')
    ) {
      validEntries.push({ index: idx, command: cmd });
    }
  });

  if (!validEntries.length) return;

  const latest = validEntries[validEntries.length - 1];

  if (latest.index !== lastDispatchedIndex) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      lastDispatchedIndex = latest.index;
      console.log(`%c[BRIDGE] >> DISPATCHING TURN #${latest.index}: "${latest.command}"`, 'color: #00e5ff; font-weight: bold;');
      ws.send(JSON.stringify({
        type: 'EXEC_REQUEST',
        agent: agentName,
        command: latest.command
      }));
    }
  }
}

setInterval(scanLatestCommand, 1200);
const observer = new MutationObserver(() => scanLatestCommand());
observer.observe(document.body, { childList: true, subtree: true });
