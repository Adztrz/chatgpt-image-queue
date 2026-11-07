// ==UserScript==
// @name         ChatGPT Prompt Queue
// @namespace    adztrz
// @version      1.1
// @description  Paste a list of prompts; each one is sent after the previous reply or image has finished.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    settleMs: 8000,             // the page must look finished this long before the next prompt goes
    gapMs: 5000,                // extra pause between prompts
    startWaitMs: 30000,         // how long to wait for ChatGPT to start replying after a send
    maxWaitMs: 8 * 60 * 1000,   // a reply taking longer than this pauses the queue
  };

  // ChatGPT changes its page now and then; if the queue stops sending, these are the first thing to check.
  const SEL = {
    // tried in order; the first visible one wins (ChatGPT keeps a hidden textarea next to the real editor)
    input: ['div#prompt-textarea[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', 'form [contenteditable="true"]', 'textarea#prompt-textarea', 'form textarea'],
    send: ['button[data-testid="send-button"]', 'button#composer-submit-button', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]'],
    stop: 'button[data-testid="stop-button"], button[aria-label^="Stop"]',
    turn: '[data-message-author-role="assistant"]',
  };
  const BUSY_TEXT = /creating image|generating image|image creation in progress/i;
  const LIMIT_TEXT = /(hit|reached) (the|your) .*limit|rate limit|too many requests/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const visible = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const first = (list) => { for (const s of list) for (const e of document.querySelectorAll(s)) if (visible(e) && !panel.contains(e)) return e; return null; };
  const findInput = () => first(SEL.input);
  const findSend = () => first(SEL.send);
  const boxText = (box) => (box.isContentEditable ? box.innerText : box.value).trim();
  const lastTurn = () => { const t = document.querySelectorAll(SEL.turn); return t[t.length - 1] || null; };
  const turnCount = () => document.querySelectorAll(SEL.turn).length;

  // ---------- state (kept across reloads, but never auto-resumes) ----------
  const state = {
    queue: GM_getValue('queue', []),
    idx: GM_getValue('idx', 0),
    running: false,
    note: '',
  };
  if (GM_getValue('running', false)) state.note = 'Paused because the page reloaded. Press Start to continue.';
  const save = () => { GM_setValue('queue', state.queue); GM_setValue('idx', state.idx); GM_setValue('running', state.running); };

  // One prompt per line; "1. " or "1) " numbering is removed.
  const parse = (text) => text.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s+/, '').trim()).filter(Boolean);

  // ---------- page checks ----------
  function busy() {
    if ($(SEL.stop)) return true;
    const t = lastTurn();
    if (!t) return false;
    if (BUSY_TEXT.test(t.innerText || '')) return true;
    return [...t.querySelectorAll('img')].some((img) => !img.complete);
  }
  const limitHit = () => LIMIT_TEXT.test((lastTurn() || {}).innerText || '');

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(500); }
    return null;
  }

  // Finished = not busy for settleMs in a row. False if it never settles within maxWaitMs.
  async function waitIdle() {
    const start = Date.now();
    let calmSince = null;
    while (state.running) {
      const now = Date.now();
      if (busy()) calmSince = null; else if (calmSince === null) calmSince = now;
      if (calmSince !== null && now - calmSince >= CFG.settleMs) return true;
      if (now - start > CFG.maxWaitMs) return false;
      setStatus(calmSince === null ? 'Waiting for ChatGPT to finish…' : 'Making sure it has finished…');
      await sleep(1000);
    }
    return true;
  }

  // Put the text in the chat box. Tries typing, then pasting, then setting it directly, and checks each time.
  async function fill(box, text) {
    const want = text.slice(0, 40);
    const landed = () => boxText(box).includes(want);
    box.focus();
    if (box.isContentEditable) {
      const sel = window.getSelection(), range = document.createRange();
      range.selectNodeContents(box); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('insertText', false, text);
      await sleep(300); if (landed()) return true;

      const dt = new DataTransfer(); dt.setData('text/plain', text);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(300); if (landed()) return true;

      const p = document.createElement('p'); p.textContent = text;
      box.replaceChildren(p);
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await sleep(300); return landed();
    }
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300); return landed();
  }

  // Returns '' when sent, or what went wrong.
  async function sendPrompt(text) {
    const box = await waitFor(findInput, 15000);
    if (!box) return "Couldn't find the chat box.";
    if (!(await fill(box, text))) return "Found the chat box, but the text didn't go in.";
    const btn = await waitFor(() => { const b = findSend(); return b && !b.disabled ? b : null; }, 10000);
    if (btn) { btn.click(); return ''; }
    // no button found: press Enter in the box instead
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await sleep(1500);
    return boxText(box).includes(text.slice(0, 40)) ? "Text is in the chat box, but the send button wasn't found." : '';
  }

  // ---------- the queue ----------
  async function run() {
    while (state.running && state.idx < state.queue.length) {
      const idle = await waitIdle();
      if (!state.running) break;
      if (!idle) return pause('The last reply took too long. Check the page, then press Start.');
      if (limitHit()) return pause('ChatGPT says you hit a limit. Paused.');
      setStatus('Next prompt in a moment…');
      await sleep(CFG.gapMs);
      if (!state.running) break;

      const before = turnCount();
      const err = await sendPrompt(state.queue[state.idx]);
      if (err) return pause(`${err} Press Check page and tell Claude what it says.`);
      state.idx++; save(); render();
      setStatus(`Sent ${state.idx} of ${state.queue.length}. Waiting for the reply…`);
      await waitFor(() => !state.running || busy() || turnCount() > before, CFG.startWaitMs);
    }
    if (state.running && state.idx >= state.queue.length) {
      // let the last image finish before calling it done
      await waitIdle();
      state.running = false; save(); render();
      setStatus(`Done: all ${state.queue.length} prompts sent.`);
      notify('All prompts sent.');
    }
  }

  function pause(msg) {
    state.running = false; save(); render();
    setStatus(msg);
    notify(msg);
  }
  function notify(text) {
    try { GM_notification({ title: 'Prompt queue', text, timeout: 8000 }); } catch (_) { /* notifications off */ }
  }

  // ---------- panel (built without innerHTML, styled in JS, so ChatGPT's page rules don't block it) ----------
  const el = (tag, style, text) => { const e = document.createElement(tag); Object.assign(e.style, style || {}); if (text) e.textContent = text; return e; };
  const btnStyle = { padding: '6px 10px', borderRadius: '8px', border: '1px solid #555', background: '#2a2a2a', color: '#eee', cursor: 'pointer', font: '13px system-ui' };

  const toggle = el('button', { ...btnStyle, position: 'fixed', right: '16px', bottom: '90px', zIndex: 99999 }, 'Queue');
  const panel = el('div', {
    position: 'fixed', right: '16px', bottom: '130px', zIndex: 99999, width: '340px', padding: '12px',
    borderRadius: '12px', background: '#1b1b1b', color: '#eee', border: '1px solid #444',
    boxShadow: '0 8px 30px rgba(0,0,0,.4)', font: '13px system-ui', display: 'none',
  });
  const title = el('div', { fontWeight: '600', marginBottom: '6px' }, 'Prompt queue (one prompt per line)');
  const area = el('textarea', {
    width: '100%', height: '140px', boxSizing: 'border-box', resize: 'vertical', padding: '8px',
    borderRadius: '8px', border: '1px solid #555', background: '#111', color: '#eee', font: '12px ui-monospace, monospace',
  });
  area.placeholder = '1. First prompt\n2. Second prompt\n…';
  const row = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '8px 0' });
  const bLoad = el('button', btnStyle, 'Load');
  const bStart = el('button', btnStyle, 'Start');
  const bPause = el('button', btnStyle, 'Pause');
  const bSkip = el('button', btnStyle, 'Skip next');
  const bClear = el('button', btnStyle, 'Clear');
  const bCheck = el('button', btnStyle, 'Check page');
  const count = el('div', { color: '#bbb' });
  const status = el('div', { color: '#9cf', marginTop: '4px', minHeight: '1.2em' });
  const nextLine = el('div', { color: '#888', marginTop: '4px', overflowWrap: 'anywhere' });

  row.append(bLoad, bStart, bPause, bSkip, bClear, bCheck);
  panel.append(title, area, row, count, nextLine, status);
  document.body.append(toggle, panel);

  function setStatus(t) { state.note = t; status.textContent = t; }
  function render() {
    count.textContent = state.queue.length ? `${state.idx} of ${state.queue.length} sent` : 'No prompts loaded.';
    const next = state.queue[state.idx];
    nextLine.textContent = next ? `Next: ${next.slice(0, 120)}${next.length > 120 ? '…' : ''}` : '';
    bStart.disabled = state.running || state.idx >= state.queue.length;
    bPause.disabled = !state.running;
    bSkip.disabled = state.idx >= state.queue.length;
    bLoad.disabled = bClear.disabled = state.running;
    for (const b of [bLoad, bStart, bPause, bSkip, bClear]) b.style.opacity = b.disabled ? '.45' : '1';
    status.textContent = state.note;
  }

  toggle.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; };
  bLoad.onclick = () => {
    const list = parse(area.value);
    if (!list.length) return setStatus('Paste at least one prompt first.');
    state.queue = list; state.idx = 0; save();
    setStatus(`Loaded ${list.length} prompts. Press Start.`); render();
  };
  bStart.onclick = () => {
    if (state.running || state.idx >= state.queue.length) return;
    state.running = true; save(); render();
    setStatus('Starting…');
    run().catch((e) => pause(`Stopped: ${e && e.message ? e.message : e}`));
  };
  bPause.onclick = () => pause('Paused. Press Start to continue from the next prompt.');
  bSkip.onclick = () => { if (state.idx < state.queue.length) { state.idx++; save(); render(); } };
  bClear.onclick = () => { state.queue = []; state.idx = 0; save(); setStatus(''); render(); };
  // Reports what the script can see, so a broken selector is easy to spot.
  bCheck.onclick = () => {
    const box = findInput(), send = findSend();
    const all = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter((e) => !panel.contains(e));
    const desc = (e) => e ? `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.isContentEditable ? ' (editable)' : ''}` : 'none';
    setStatus(`Chat box: ${desc(box)}. Send button: ${send ? (send.getAttribute('data-testid') || send.getAttribute('aria-label') || 'found') + (send.disabled ? ' (disabled)' : '') : 'none'}. Editors on page: ${all.map(desc).join(', ') || 'none'}. Busy: ${busy() ? 'yes' : 'no'}.`);
  };

  GM_setValue('running', false);
  render();
})();
