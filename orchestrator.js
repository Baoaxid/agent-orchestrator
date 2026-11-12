const puppeteer = require('puppeteer-core');
const { exec } = require('child_process');
const readline = require('readline');

const SAFE_COMMAND_REGEX = /^(ls|dir|cat|head|tail|grep|find|git\s+(status|diff|log|branch|add)|pwd|echo|node\s+-v|pnpm\s+-v|npm\s+-v)(\s+.*)?$/i;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function askQuestion(query) {
  return new Promise((resolve) => {
    rl.question(query, (ans) => resolve(ans.trim()));
  });
}

function askUserApproval(cmd) {
  return new Promise((resolve) => {
    rl.question(`\n[SAFE MODE] Approve command: "${cmd}"? (y/n): `, (ans) => {
      resolve(ans.trim().toLowerCase() === 'y');
    });
  });
}

function runShell(command) {
  return new Promise((resolve) => {
    console.log(`[TERMINAL] Executing: ${command}`);
    exec(command, { maxBuffer: 1024 * 1024 * 4, shell: 'bash.exe' }, (error, stdout, stderr) => {
      const exitCode = error ? (error.code || 1) : 0;
      const combined = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
      const clean = combined.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      resolve(`<output exit_code="${exitCode}">\n${clean || '(Empty output)'}\n</output>`);
    });
  });
}

const AGENTS = {
  chatgpt: {
    name: "ChatGPT",
    domain: "chatgpt.com",
    input: "form div.ProseMirror[contenteditable=\"true\"], form div[contenteditable=\"true\"], #prompt-textarea",
    sendBtn: "form button[type=\"submit\"], button[data-testid=\"send-button\"], button[aria-label*=\"Send\"], button[aria-label*=\"Gửi\"], button[aria-label*=\"送信\"]"
  },
  gemini: {
    name: "Gemini",
    domain: "gemini.google.com",
    input: "rich-textarea div[contenteditable=\"true\"], div[contenteditable=\"true\"]",
    sendBtn: "button[aria-label*=\"Gửi\"], button[aria-label*=\"Send\"], button.send-button, .send-button-container button"
  },
  claude: {
    name: "Claude",
    domain: "claude.ai",
    input: "fieldset div[contenteditable=\"true\"], div.ProseMirror[contenteditable=\"true\"], div[contenteditable=\"true\"]",
    sendBtn: "button[aria-label*=\"Send\"], button[aria-label*=\"Gửi\"], button[data-testid=\"send-button\"]"
  }
};

// Retrieve page instance and enable silent background execution
async function getPageHandle(browser, agentKey) {
  try {
    const pages = await browser.pages();
    const target = pages.find(p => p.url().includes(AGENTS[agentKey].domain));
    if (target) {
      try {
        const client = await target.createCDPSession();
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        await client.detach();
      } catch (e) {}

      await target.evaluate(() => {
        try {
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
          Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        } catch (e) {}
      });
    }
    return target || null;
  } catch (e) {
    return null;
  }
}

// Background text submission via CDP protocol
// Background text submission supporting contenteditable, ProseMirror, and standard inputs
async function sendTextSilent(page, agentKey, text) {
  if (!page) return false;
  const cfg = AGENTS[agentKey];

  const injection = await page.evaluate((selector, payload) => {
    const el = document.querySelector(selector);
    if (!el) return { success: false, reason: "INPUT_NOT_FOUND" };

    el.focus();

    const escapeHtml = (str) =>
      str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

    const htmlPayload = payload
      .split("\n")
      .map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`)
      .join("");

    if (el.isContentEditable) {
      el.innerHTML = htmlPayload;
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: payload,
        })
      );
    } else if (el.value !== undefined) {
      el.value = payload;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    return {
      success: true,
      textLen: (el.innerText || el.value || "").trim().length,
    };
  }, cfg.input, text);

  if (!injection || !injection.success) {
    console.error(`[ERROR] Input element not found for [${cfg.name}]`);
    return false;
  }

  // Poll send button readiness and click
  let clicked = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 250));
    clicked = await page.evaluate((btnSel) => {
      const btn = document.querySelector(btnSel);
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        btn.click();
        return true;
      }
      return false;
    }, cfg.sendBtn);

    if (clicked) break;
  }

  // Fallback: Dispatch Enter event if submit button was not clicked
  if (!clicked) {
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      if (el) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      }
    }, cfg.input);

    try {
      const client = await page.createCDPSession();
      await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await client.detach();
    } catch (e) {}
  }

  console.log(`[CDP-SILENT] Dispatched text payload (${text.length} chars) to [${cfg.name}]. Clicked: ${clicked}`);
  await new Promise((r) => setTimeout(r, 1000));
  return true;
}

// Extract conversation turns
async function getAssistantTurns(page, agentKey) {
  if (!page) return [];
  try {
    return await page.evaluate((key) => {
      if (key === "chatgpt") {
        const assistantUnits = [...document.querySelectorAll('[data-content-search-unit-key*=":assistant"], [data-chatgpt-search-unit-key*=":assistant"], [data-message-author-role="assistant"]')];

        if (assistantUnits.length > 0) {
          return assistantUnits.map(unit => {
            const wb = unit.querySelector('[data-testid="chatgpt-writing-block"], [data-oai-writing-block-surface], [data-markdown-copy-text]');
            let text = wb ? (wb.getAttribute("data-markdown-copy-text") || wb.innerText) : unit.innerText;

            text = text.trim()
              .replace(/^ChatGPT\s*(đã nói|said|の発言):\s*/i, "")
              .replace(/^(文章作成|Viết|Document|Code)\s*\n+/i, "")
              .trim();

            return text;
          }).filter(Boolean);
        }

        const standaloneWb = [...document.querySelectorAll('[data-testid="chatgpt-writing-block"], [data-oai-writing-block-surface]')];
        if (standaloneWb.length > 0) {
          return standaloneWb.map(wb => (wb.getAttribute("data-markdown-copy-text") || wb.innerText || "").trim()).filter(Boolean);
        }

        return [];
      }

      if (key === "gemini") {
        let bubbles = [...document.querySelectorAll("model-response")];
        if (!bubbles.length) {
          bubbles = [...document.querySelectorAll('[data-test-id="model-response"]')];
        }
        if (!bubbles.length) {
          bubbles = [...document.querySelectorAll(".response-container-content")];
        }
        return bubbles.map(b => b.innerText.trim()).filter(Boolean);
      }

      if (key === "claude") {
        let bubbles = [...document.querySelectorAll('div[data-message-author-role="assistant"]')];
        if (!bubbles.length) {
          bubbles = [...document.querySelectorAll(".font-claude-message, .standard-markdown")];
        }
        return bubbles.map(b => b.innerText.trim()).filter(Boolean);
      }
      return [];
    }, agentKey);
  } catch (err) {
    return [];
  }
}

// Check streaming status
async function isGenerating(page, agentKey) {
  if (!page) return false;
  try {
    return await page.evaluate((key) => {
      if (key === "chatgpt") {
        const stop = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Dừng"]');
        return Boolean(stop && (stop.offsetParent !== null || stop.getClientRects().length > 0));
      }
      if (key === "gemini") {
        const stop = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Dừng"], .stop-button, button[data-test-id="stop-button"], mat-icon[fonticon="stop"]');
        return Boolean(stop && (stop.offsetParent !== null || stop.getClientRects().length > 0));
      }
      if (key === "claude") {
        const stop = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Dừng"]');
        const streaming = document.querySelector('[data-is-streaming="true"]');
        return Boolean((stop && (stop.offsetParent !== null || stop.getClientRects().length > 0)) || streaming);
      }
      return false;
    }, agentKey);
  } catch (e) {
    return false;
  }
}

// Wait for complete assistant response turn without focus interruptions
async function waitForNewTurn(page, agentKey, baseTurnCount, initialText = "") {
  const agentName = AGENTS[agentKey].name;
  console.log(`[PIPELINE] Waiting for turn response from [${agentName}] (base turns: ${baseTurnCount})...`);
  let stableCount = 0;
  let lastLen = 0;
  let hasStarted = false;

  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));

    const turns = await getAssistantTurns(page, agentKey);
    const generating = await isGenerating(page, agentKey);
    const latestText = turns[turns.length - 1] || "";
    const currentLen = latestText.length;
    const turnsIncreased = turns.length > baseTurnCount;
    const contentChanged = latestText.length > 0 && latestText !== initialText;

    if (!hasStarted) {
      if (generating || turnsIncreased || contentChanged) {
        hasStarted = true;
      }
    }

    if (i % 3 === 0 || generating || turnsIncreased) {
      console.log(`   [${agentName}] turns: ${turns.length}/${baseTurnCount} | len: ${currentLen} | generating: ${generating} | started: ${hasStarted} | stable: ${stableCount}`);
    }

    if (hasStarted && !generating && currentLen > 0 && currentLen === lastLen) {
      stableCount++;
      if (stableCount >= 2) return latestText;
    } else {
      stableCount = 0;
    }
    lastLen = currentLen;
  }
  console.warn(`[WARN] Timeout reached waiting for [${agentName}].`);
  return null;
}

function parseReviewVerdict(text) {
  if (!text) return { approved: false, text: '(No review response received)' };
  const clean = text.replace(/\*\*/g, '').replace(/`/g, '');
  const hasApprovedMarker = /\[REVIEW\]:\s*APPROVED\b/i.test(clean);
  const hasRejectedMarker = /\[REVIEW\]:\s*REJECTED\b/i.test(clean);

  if (hasApprovedMarker && !hasRejectedMarker) {
    return { approved: true, text };
  }
  return { approved: false, text };
}

async function configureTopology(detectedKeys) {
  console.log('\n======================================================');
  console.log('              DYNAMIC AGENT TOPOLOGY SELECTOR         ');
  console.log('======================================================');
  console.log('Detected active browser tabs:');
  detectedKeys.forEach((key, idx) => {
    console.log(`  [${idx + 1}] ${AGENTS[key].name} (${AGENTS[key].domain})`);
  });
  console.log('------------------------------------------------------');

  let archKey = '';
  let execKey = '';
  let revKey = '';

  if (detectedKeys.length === 1) {
    const single = detectedKeys[0];
    console.log(`Only 1 agent tab detected. Activating Solo Mode for [${AGENTS[single].name}].`);
    return { archKey: single, execKey: single, revKey: single };
  }

  console.log('Select operational configuration mode:');
  console.log('  1. Background Optimized Dual Mode (ChatGPT as Executor, Other as Architect/Reviewer)');
  console.log('  2. Solo Agent Mode (Choose 1 agent for all 3 roles)');
  console.log('  3. Custom Role Assignment (Manually assign Architect, Executor, Reviewer)');

  const modeChoice = await askQuestion('\nEnter mode selection (1-3, default 1): ');

  if (modeChoice === '2') {
    console.log('\nSelect agent for Solo Mode:');
    detectedKeys.forEach((k, idx) => console.log(`  ${idx + 1}. ${AGENTS[k].name}`));
    const pick = parseInt(await askQuestion('Pick agent number: '), 10) - 1;
    const selected = detectedKeys[pick] || detectedKeys[0];
    return { archKey: selected, execKey: selected, revKey: selected };
  }

  if (modeChoice === '3') {
    console.log('\nAssign role mappings by agent index:');
    detectedKeys.forEach((k, idx) => console.log(`  [${idx + 1}] ${AGENTS[k].name}`));

    const aIdx = parseInt(await askQuestion('Assign Architect (1-' + detectedKeys.length + '): '), 10) - 1;
    const eIdx = parseInt(await askQuestion('Assign Executor  (1-' + detectedKeys.length + '): '), 10) - 1;
    const rIdx = parseInt(await askQuestion('Assign Reviewer  (1-' + detectedKeys.length + '): '), 10) - 1;

    archKey = detectedKeys[aIdx] || detectedKeys[0];
    execKey = detectedKeys[eIdx] || detectedKeys[0];
    revKey = detectedKeys[rIdx] || detectedKeys[0];
    return { archKey, execKey, revKey };
  }

  // Default: Background-optimized mode
  const hasGpt = detectedKeys.includes('chatgpt');
  const otherKeys = detectedKeys.filter(k => k !== 'chatgpt');

  if (hasGpt && otherKeys.length > 0) {
    execKey = 'chatgpt';
    archKey = otherKeys[0];
    revKey = otherKeys[1] || otherKeys[0];
  } else {
    archKey = detectedKeys[0];
    execKey = detectedKeys[1] || detectedKeys[0];
    revKey = detectedKeys[0];
  }

  return { archKey, execKey, revKey };
}

async function main() {
  console.log('[CDP] Connecting to Chrome debugger via port 9222...');
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });

  const detectedKeys = [];
  for (const key of Object.keys(AGENTS)) {
    const handle = await getPageHandle(browser, key);
    if (handle) detectedKeys.push(key);
  }

  if (detectedKeys.length === 0) {
    console.error('[ERROR] No supported AI tabs detected on port 9222!');
    process.exit(1);
  }

  const { archKey, execKey, revKey } = await configureTopology(detectedKeys);

  console.log('\nActive Pipeline Topology:');
  console.log(` - Architect : [${AGENTS[archKey].name}]`);
  console.log(` - Executor  : [${AGENTS[execKey].name}]`);
  console.log(` - Reviewer  : [${AGENTS[revKey].name}]`);
  console.log('======================================================\n');

  const archPage = await getPageHandle(browser, archKey);
  const execPage = await getPageHandle(browser, execKey);
  const revPage = await getPageHandle(browser, revKey);

  const task = await askQuestion('[BAOAXID] Enter task description for Ngan Ha AI: ');

  // -------------------------------------------------------------
  // STEP 1: Architect Planning
  // -------------------------------------------------------------
  console.log(`\n>>> STEP 1: Sending task to [${AGENTS[archKey].name}] (Architect)...`);
  const archTurns = await getAssistantTurns(archPage, archKey);
  const archBase = archTurns.length;
  const archInitial = archTurns.slice(-1)[0] || '';

  const archPrompt = `You are the Lead Architect for project Ngan Ha AI.
Task: ${task}
Break down this task into clear instructions for ${AGENTS[execKey].name.toUpperCase()}.
Specify requirements and inform ${AGENTS[execKey].name.toUpperCase()} to wrap commands in [EXEC]...[/EXEC]. Do NOT use placeholder text. Output plain text specifications.`;

  await sendTextSilent(archPage, archKey, archPrompt);
  const plan = await waitForNewTurn(archPage, archKey, archBase, archInitial);
  if (!plan) {
    console.error(`[ABORT] Failed to receive plan from [${AGENTS[archKey].name}].`);
    process.exit(1);
  }
  console.log(`[${AGENTS[archKey].name}] Plan finalized. Length:`, plan.length);

  // -------------------------------------------------------------
  // STEP 2: Executor Implementation Loop
  // -------------------------------------------------------------
  console.log(`\n>>> STEP 2: Forwarding specification to [${AGENTS[execKey].name}] (Executor)...`);
  let execTurns = await getAssistantTurns(execPage, execKey);
  let execBase = execTurns.length;
  let execInitial = execTurns.slice(-1)[0] || '';

  const execPrompt = `You are the Executor Engineer for Ngan Ha AI. Follow this plan:
${plan}

Rules:
1. Wrap terminal commands strictly in [EXEC]...[/EXEC], e.g. [EXEC]ls -la[/EXEC].
2. Execute step-by-step and inspect terminal output.
3. When finished and tests pass, output strictly: [STATUS]: COMPLETED.
4. Keep code comments strictly in English.`;

  await sendTextSilent(execPage, execKey, execPrompt);

  let isDone = false;
  const handled = new Set();
  let nudgeCount = 0;

  while (!isDone) {
    const execOutput = await waitForNewTurn(execPage, execKey, execBase, execInitial);
    if (!execOutput) break;

    const matches = [...execOutput.matchAll(/\[EXEC\]([\s\S]*?)\[\/EXEC\]/gi)];
    const newCmds = matches.map(m => m[1].trim()).filter(c => c && c.toLowerCase() !== 'command' && !handled.has(c));

    const isCompletedMarker = execOutput.includes('[STATUS]: COMPLETED') ||
      (!newCmds.length && /(all tests? (passed|pass)|tests? passed successfully|task completed|hoàn thành)/i.test(execOutput));

    if (newCmds.length > 0) {
      nudgeCount = 0;
      let outputs = [];
      for (const cmd of newCmds) {
        handled.add(cmd);
        let allowed = SAFE_COMMAND_REGEX.test(cmd);
        if (!allowed) allowed = await askUserApproval(cmd);

        if (allowed) {
          outputs.push(await runShell(cmd));
        } else {
          outputs.push('<output exit_code="1">Command rejected by user.</output>');
        }
      }
      const currentTurns = await getAssistantTurns(execPage, execKey);
      execBase = currentTurns.length;
      execInitial = currentTurns.slice(-1)[0] || '';
      await sendTextSilent(execPage, execKey, outputs.join('\n\n'));
    } else if (isCompletedMarker) {
      isDone = true;
      console.log(`[${AGENTS[execKey].name}] Task execution completed successfully.`);
    } else {
      if (nudgeCount < 2) {
        nudgeCount++;
        console.log(`[${AGENTS[execKey].name}] Plan pending completion. Issuing continuation reminder (#${nudgeCount})...`);
        const currentTurns = await getAssistantTurns(execPage, execKey);
        execBase = currentTurns.length;
        execInitial = currentTurns.slice(-1)[0] || '';
        await sendTextSilent(execPage, execKey, 'Please continue executing remaining steps. Wrap commands in [EXEC]...[/EXEC] or output [STATUS]: COMPLETED if finished.');
      } else {
        console.log(`[${AGENTS[execKey].name}] Execution loop ended after reminder threshold.`);
        break;
      }
    }
  }

  // -------------------------------------------------------------
  // STEP 3: Code Review
  // -------------------------------------------------------------
  console.log(`\n>>> STEP 3: Forwarding implementation diff to [${AGENTS[revKey].name}] (Reviewer)...`);
  await runShell('git add -N .');
  const diff = await runShell('git diff');

  if (diff.trim().length === 0 || diff.includes('(Empty output)')) {
    console.log('[REVIEW] Git diff is empty. Pipeline concluded.');
    process.exit(0);
  }

  const revPrompt = `You are the Security & Code Reviewer for Ngan Ha AI.
Inspect this implementation diff:
${diff}

If safe and meets standards, output strictly: [REVIEW]: APPROVED
If changes needed, output strictly: [REVIEW]: REJECTED followed by reasons.`;

  let revTurns = await getAssistantTurns(revPage, revKey);
  let revBase = revTurns.length;
  let revInitial = revTurns.slice(-1)[0] || '';

  await sendTextSilent(revPage, revKey, revPrompt);
  const rawReviewText = await waitForNewTurn(revPage, revKey, revBase, revInitial);

  const verdict = parseReviewVerdict(rawReviewText);

  if (verdict.approved) {
    console.log(`\n[SUCCESS] Pipeline cycle completed! Code APPROVED by [${AGENTS[revKey].name}].`);
  } else {
    console.log(`\n[REVISE] [${AGENTS[revKey].name}] REJECTED diff.`);
    console.log(`--- REVIEW FEEDBACK ---\n${verdict.text}\n-----------------------`);
  }

  process.exit(0);
}

main().catch(console.error);
