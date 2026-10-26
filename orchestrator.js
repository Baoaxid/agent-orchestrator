const puppeteer = require('puppeteer-core');
const { exec } = require('child_process');
const readline = require('readline');

const SAFE_COMMAND_REGEX = /^(ls|dir|cat|head|tail|grep|find|git\s+(status|diff|log|branch)|pwd|echo|node\s+-v|pnpm\s+-v|npm\s+-v)(\s+.*)?$/i;
const FATAL_COMMAND_REGEX = /(rm\s+-rf\s+\/|mkfs|dd\s+if=.*of=\/dev|:\(\)\{\s*:\|:&\s*\};:)/i;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askUserApproval(command) {
  return new Promise((resolve) => {
    rl.question(`\n[SAFE MODE] Approve command: "${command}"? (y/n): `, (answer) => {
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

function runShell(command) {
  return new Promise((resolve) => {
    console.log(`[TERMINAL] Executing: ${command}`);
    exec(command, { maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
      const exitCode = error ? (error.code || 1) : 0;
      const combined = (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).trim();
      const clean = combined.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      resolve(`<output exit_code="${exitCode}">\n${clean || '(Empty output)'}\n</output>`);
    });
  });
}

async function sendTextToPage(page, text) {
  await page.bringToFront();
  await new Promise(r => setTimeout(r, 600));

  await page.evaluate((payload) => {
    const input = document.querySelector('div.ProseMirror, #prompt-textarea, rich-textarea p, textarea, [contenteditable="true"]');
    if (input) {
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, payload);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, text);

  await new Promise(r => setTimeout(r, 800));

  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const testid = (b.getAttribute('data-testid') || '').toLowerCase();
      const isAttach = aria.includes('đính kèm') || aria.includes('attach') || testid.includes('attach');
      return !isAttach && (aria.includes('send') || aria.includes('gửi') || testid.includes('send') || b.type === 'submit');
    });

    if (buttons.length > 0 && !buttons[buttons.length - 1].disabled) {
      buttons[buttons.length - 1].click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    await page.keyboard.press('Enter');
  }
}

// Multi-tier robust selector mapping for assistant bubbles
async function getLatestAssistantResponse(page, agentName) {
  return await page.evaluate((agent) => {
    let bubbles = [];

    if (agent === 'chatgpt') {
      // Tier 1: Standard message attributes
      bubbles = [...document.querySelectorAll('[data-message-author-role="assistant"], div.agent-turn')];
      // Tier 2: Markdown blocks inside conversation turns
      if (!bubbles.length) {
        bubbles = [...document.querySelectorAll('article:not(:has([data-message-author-role="user"])) div.markdown')];
      }
      // Tier 3: General markdown container fallback
      if (!bubbles.length) {
        bubbles = [...document.querySelectorAll('div.markdown, .prose')];
      }
    } else if (agent === 'gemini') {
      bubbles = [...document.querySelectorAll('model-response, .response-container-content, [data-test-id="model-response"], .model-response-text')];
      if (!bubbles.length) {
        bubbles = [...document.querySelectorAll('.message-content, message-content')];
      }
    } else if (agent === 'claude') {
      bubbles = [...document.querySelectorAll('div[data-message-author-role="assistant"], .font-claude-message, [data-is-streaming]')];
      if (!bubbles.length) {
        bubbles = [...document.querySelectorAll('.standard-markdown')];
      }
    }

    if (!bubbles.length) return '';
    return bubbles[bubbles.length - 1].innerText.trim() || '';
  }, agentName);
}

async function checkQuotaError(page, agentName) {
  return await page.evaluate((agent) => {
    const text = document.body.innerText.toLowerCase();

    if (agent === 'claude') {
      return text.includes('out of free messages') || 
             text.includes('message limit') || 
             text.includes('limit reached') ||
             document.querySelector('[data-testid="message-limit"]') !== null;
    }
    if (agent === 'gemini') {
      return text.includes('quota') || 
             text.includes('rate limit') || 
             text.includes('try again later');
    }
    if (agent === 'chatgpt') {
      return text.includes('you\'ve reached our limit') ||
             document.querySelector('[data-testid="fruitcake-banner"]') !== null;
    }
    return false;
  }, agentName);
}

async function waitForResponseFinish(page, agentName) {
  console.log(`[PIPELINE] Waiting for [${agentName}] to finish generating...`);
  let stableCount = 0;
  let lastLength = 0;
  let emptyRetries = 0;

  while (stableCount < 3) {
    await new Promise(r => setTimeout(r, 1500));

    const isLimited = await checkQuotaError(page, agentName);
    if (isLimited) {
      console.warn(`[WARN] [${agentName}] has encountered quota or rate limit!`);
      return false;
    }

    let currentText = await getLatestAssistantResponse(page, agentName);

    // Fallback: If assistant bubble selector misses completely after multiple checks
    if (!currentText && emptyRetries > 4) {
      currentText = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        return bodyText.slice(-1500);
      });
    }

    if (!currentText) {
      emptyRetries++;
      continue;
    }

    const currentLength = currentText.length;

    const isGenerating = await page.evaluate(() => {
      const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Dừng"], button[data-testid*="stop"]');
      return Boolean(stopBtn);
    });

    if (!isGenerating && currentLength === lastLength && currentLength > 0) {
      stableCount++;
    } else {
      stableCount = 0;
      lastLength = currentLength;
    }
  }
  return true;
}

async function checkAndSwitchGeminiModel(page) {
  const isRateLimited = await checkQuotaError(page, 'gemini');
  if (isRateLimited) {
    console.warn('[GEMINI] Rate limit reached. Attempting to switch model via UI picker...');
    await page.evaluate(() => {
      const picker = document.querySelector('button[aria-haspopup="menu"], [data-test-id="model-picker-btn"]');
      if (picker) picker.click();
    });
    await new Promise(r => setTimeout(r, 800));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    return true;
  }
  return false;
}

async function main() {
  console.log('[CDP] Connecting to Chrome on port 9222...');
  const browser = await puppeteer.connect({
    browserURL: 'http://localhost:9222',
    defaultViewport: null
  });

  const pages = await browser.pages();
  const chatgpt = pages.find(p => p.url().includes('chatgpt.com'));
  const gemini = pages.find(p => p.url().includes('gemini.google.com'));
  const claude = pages.find(p => p.url().includes('claude.ai'));

  if (!chatgpt || !gemini || !claude) {
    console.error('[ERROR] Missing required tabs! Make sure ChatGPT, Gemini, and Claude are opened.');
    process.exit(1);
  }

  console.log('[CDP] All 3 tabs mapped successfully:');
  console.log(' - ChatGPT (Architect)');
  console.log(' - Gemini (Executor)');
  console.log(' - Claude (Reviewer)');

  rl.question('\n[BAOAXID] Enter task for Ngan Ha AI: ', async (taskPrompt) => {
    // STEP 1: ChatGPT (Architect)
    console.log('\n>>> STEP 1: Sending task to ChatGPT (Architect)...');
    const gptPrompt = `You are the Lead Architect for project Ngan Ha AI.
Task: ${taskPrompt}
Break down this task into clear instructions for Gemini.
Specify requirements and inform Gemini to wrap commands in [EXEC]...[/EXEC]. Do NOT use placeholder text like "command".`;

    await sendTextToPage(chatgpt, gptPrompt);
    const gptOk = await waitForResponseFinish(chatgpt, 'chatgpt');
    if (!gptOk) {
      console.error('[ABORT] ChatGPT is currently unavailable or quota-limited.');
      process.exit(1);
    }
    const gptPlan = await getLatestAssistantResponse(chatgpt, 'chatgpt');
    console.log('[CHATGPT] Plan ready.');

    // STEP 2: Gemini (Executor)
    console.log('\n>>> STEP 2: Forwarding assignment to Gemini (Executor)...');
    const geminiPrompt = `You are the Executor Engineer for Ngan Ha AI. Follow this architect plan:
${gptPlan}

Rules:
1. Wrap terminal commands strictly in [EXEC]...[/EXEC], e.g., [EXEC]ls -la[/EXEC]. Do NOT output the literal word "command".
2. When finished, output: [STATUS]: COMPLETED.
3. Keep code comments strictly in English.`;

    await sendTextToPage(gemini, geminiPrompt);

    let isGeminiDone = false;
    let lastHandledCommand = '';

    while (!isGeminiDone) {
      const geminiOk = await waitForResponseFinish(gemini, 'gemini');
      if (!geminiOk) {
        await checkAndSwitchGeminiModel(gemini);
      }

      const geminiOutput = await getLatestAssistantResponse(gemini, 'gemini');
      const matches = [...geminiOutput.matchAll(/\[EXEC\]([\s\S]*?)\[\/EXEC\]/gi)];
      const lastMatch = matches.length > 0 ? matches[matches.length - 1][1].trim() : null;

      if (lastMatch && lastMatch !== lastHandledCommand && lastMatch.toLowerCase() !== 'command' && lastMatch.toLowerCase() !== '...') {
        lastHandledCommand = lastMatch;
        let canRun = SAFE_COMMAND_REGEX.test(lastMatch);
        if (!canRun) {
          canRun = await askUserApproval(lastMatch);
        }

        if (canRun) {
          const terminalOutput = await runShell(lastMatch);
          await sendTextToPage(gemini, terminalOutput);
        } else {
          await sendTextToPage(gemini, '<output exit_code="1">Command rejected by user.</output>');
        }
      } else if (geminiOutput.includes('[STATUS]: COMPLETED')) {
        isGeminiDone = true;
        console.log('[GEMINI] Task implementation completed.');
      } else {
        break;
      }
    }

    // STEP 3: Review Phase (Claude with Fallback to ChatGPT)
    console.log('\n>>> STEP 3: Forwarding code diff to Reviewer...');
    const gitDiff = await runShell('git diff');
    const reviewPrompt = `You are the Security & Code Reviewer for Ngan Ha AI.
Inspect this implementation diff:
${gitDiff}

If safe and meets standards, output strictly: [REVIEW]: APPROVED
If changes needed, output strictly: [REVIEW]: REJECTED followed by reasons.`;

    let reviewerPage = claude;
    let reviewerName = 'claude';

    const claudeLimited = await checkQuotaError(claude, 'claude');
    if (claudeLimited) {
      console.warn('[FALLBACK] Claude is out of quota. Re-routing Review task to ChatGPT...');
      reviewerPage = chatgpt;
      reviewerName = 'chatgpt';
    }

    await sendTextToPage(reviewerPage, reviewPrompt);
    const reviewOk = await waitForResponseFinish(reviewerPage, reviewerName);

    if (!reviewOk && reviewerName === 'claude') {
      console.warn('[FALLBACK] Claude hit limit during review. Re-routing Review task to ChatGPT...');
      await sendTextToPage(chatgpt, reviewPrompt);
      await waitForResponseFinish(chatgpt, 'chatgpt');
      reviewerPage = chatgpt;
      reviewerName = 'chatgpt';
    }

    const reviewDecision = await getLatestAssistantResponse(reviewerPage, reviewerName);

    if (reviewDecision.includes('[REVIEW]: APPROVED')) {
      console.log(`\n[SUCCESS] Pipeline cycle finished! Code approved by ${reviewerName.toUpperCase()}.`);
    } else {
      console.log(`\n[REVISE] ${reviewerName.toUpperCase()} requested changes. Diff needs adjustment.`);
    }

    process.exit(0);
  });
}

main().catch(console.error);
