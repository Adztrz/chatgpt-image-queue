// ==UserScript==
// @name         ChatGPT Image Queue
// @namespace    adztrz
// @license      MIT
// @version      2.0
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
    bad: false,
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
      if (err) return pause(`${err} Press Check and tell Claude what it says.`);
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

  function pause(msg, bad = true) {
    state.running = false; save(); render();
    setStatus(msg, bad);
    if (bad) notify(msg);
  }
  function notify(text) {
    try { GM_notification({ title: 'Image queue', text, timeout: 8000 }); } catch (_) { /* notifications off */ }
  }

  // ---------- panel: Faust's look (near-black cards, hairlines, bone primary, uppercase tags with a dot) ----------
  // Built without innerHTML and styled in JS, so ChatGPT's page rules don't block it.
  const C = {
    canvas: '#07090b', card: '#090b0c', raised: '#1a1d1e', divider: '#262727', border: '#363738', rule: '#696a68',
    strong: '#efefed', bone: '#e9e1dc', text: '#b3b0af', muted: '#8a8b8a', faint: '#565858', alert: '#f12614', positive: '#55bc82',
  };
  const SANS = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
  const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const CARD_SHADOW = `inset 0 0 0 1px ${C.divider}, 0 1px 0 rgba(255,255,255,.02), 0 12px 32px rgba(0,0,0,.55)`;

  const el = (tag, style, text) => { const e = document.createElement(tag); Object.assign(e.style, style || {}); if (text) e.textContent = text; return e; };
  const hover = (e, on, off) => { e.addEventListener('mouseenter', () => !e.disabled && Object.assign(e.style, on)); e.addEventListener('mouseleave', () => Object.assign(e.style, off)); };

  // buttons: 32px, 8px corners, hairline edge; the one primary action is bone
  function button(label, kind = 'plain') {
    const base = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '30px', padding: '0 12px', boxSizing: 'border-box',
      width: 'auto', minWidth: '0', margin: '0', flex: 'none', textTransform: 'none', letterSpacing: 'normal', // ignore the page's own button styles
      borderRadius: '8px', cursor: 'pointer', whiteSpace: 'nowrap', font: `500 13px/1 ${SANS}`, transition: `border-color .15s ${EASE}, background .15s ${EASE}, color .15s ${EASE}`,
    };
    const look = {
      plain: { background: 'transparent', border: `1px solid ${C.border}`, color: C.strong },
      primary: { background: C.bone, border: `1px solid ${C.bone}`, color: C.canvas, boxShadow: '0 1px 3px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.5)' },
      ghost: { background: 'transparent', border: '1px solid transparent', color: C.muted, padding: '0 8px' },
    }[kind];
    const b = el('button', { ...base, ...look }, label);
    b.type = 'button';
    if (kind === 'primary') hover(b, { background: C.strong, borderColor: C.strong }, { background: C.bone, borderColor: C.bone });
    else if (kind === 'ghost') hover(b, { color: C.strong, borderColor: C.border }, { color: C.muted, borderColor: 'transparent' });
    else hover(b, { borderColor: C.rule, background: 'rgba(255,255,255,.03)' }, { borderColor: C.border, background: 'transparent' });
    return b;
  }
  // "tag with dot": uppercase label, wide tracking, a small dot, no box
  function tag(text, dot = C.bone, color = C.muted) {
    const t = el('span', { display: 'inline-flex', alignItems: 'center', gap: '7px', font: `600 11px/1 ${SANS}`, letterSpacing: '.1em', textTransform: 'uppercase', color });
    const d = el('i', { width: '6px', height: '6px', borderRadius: '50%', background: dot, flex: 'none', display: 'inline-block' });
    t.append(d, document.createTextNode(text));
    t.dot = d;
    return t;
  }
  const pulse = (e) => e.animate([{ opacity: 1 }, { opacity: .25 }, { opacity: 1 }], { duration: 1600, iterations: Infinity, easing: 'ease-in-out' });

  // the launcher: a quiet button with the progress in it
  const toggle = button('', 'plain');
  Object.assign(toggle.style, { position: 'fixed', right: '16px', bottom: '96px', zIndex: 99999, gap: '8px', background: C.card, boxShadow: '0 4px 16px rgba(0,0,0,.45)' });
  hover(toggle, { borderColor: C.rule, background: C.raised }, { borderColor: C.border, background: C.card });
  const toggleTag = tag('Queue', C.bone, C.strong);
  const toggleCount = el('span', { font: `500 12px/1 ${MONO}`, color: C.muted });
  toggle.append(toggleTag, toggleCount);

  const panel = el('div', {
    position: 'fixed', right: '16px', bottom: '138px', zIndex: 99999, width: '412px', maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box',
    padding: '20px', borderRadius: '8px', background: C.card, color: C.text, boxShadow: CARD_SHADOW, font: `400 13px/1.45 ${SANS}`, display: 'none',
  });

  // header: tag on the left, count pill on the right
  const header = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' });
  const headTag = tag('Image queue');
  const pill = el('span', { minWidth: '20px', padding: '2px 8px', borderRadius: '9999px', background: 'rgba(255,255,255,.05)', font: `500 11px/1.4 ${MONO}`, color: C.muted, textAlign: 'center' });
  header.append(headTag, pill);

  // edit view: paste prompts, see how many were found
  const editView = el('div');
  const area = el('textarea', {
    width: '100%', height: '150px', boxSizing: 'border-box', resize: 'vertical', padding: '10px 12px', borderRadius: '8px',
    border: `1px solid ${C.border}`, background: C.raised, color: C.strong, font: `400 12px/1.55 ${MONO}`, outline: 'none',
    transition: `border-color .15s ${EASE}`,
  });
  area.placeholder = 'Paste prompts, one per line.\n1. A single red rose…\n2. Three pastel eggs…';
  area.addEventListener('focus', () => { area.style.borderColor = C.rule; });
  area.addEventListener('blur', () => { area.style.borderColor = C.border; });
  const found = el('div', { margin: '8px 0 14px', fontSize: '12px', color: C.muted });
  const editRow = el('div', { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
  const bCancel = button('Cancel', 'ghost');
  const bLoad = button('Load prompts', 'primary');
  editRow.append(bCancel, bLoad);
  editView.append(area, found, editRow);

  // queue view: each prompt is its own card, spaced apart
  const queueView = el('div');
  const list = el('ol', { listStyle: 'none', margin: '0 -4px 0 0', padding: '0 4px 0 0', display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '46vh', overflowY: 'auto' });
  const status = el('div', { margin: '14px 0', minHeight: '18px', fontSize: '12px', lineHeight: '1.4', color: C.muted });
  const row = el('div', { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' });
  const bStart = button('Start', 'primary');
  const bPause = button('Pause');
  const bSkip = button('Skip');
  bSkip.title = 'Skip the next prompt';
  const spacer = el('span', { flex: '1' });
  const bEdit = button('Edit', 'ghost');
  const bCheck = button('Check', 'ghost');
  bCheck.title = 'Show what the script can find on this page';
  const bClear = button('Clear', 'ghost');
  row.append(bStart, bPause, bSkip, spacer, bEdit, bCheck, bClear);
  queueView.append(list, status, row);

  panel.append(header, editView, queueView);
  document.body.append(toggle, panel);

  let editing = !state.queue.length;
  let pulseAnim = null;

  function setStatus(t, bad = false) { state.note = t; state.bad = bad; status.textContent = t; status.style.color = bad ? C.alert : C.muted; }

  function card(text, i) {
    const sent = i < state.idx, next = i === state.idx, working = state.running && i === state.idx - 1;
    const li = el('li', {
      display: 'grid', gridTemplateColumns: '28px 1fr', gap: '4px 10px', padding: '12px 14px', borderRadius: '8px',
      background: next ? C.raised : C.card, boxShadow: `inset 0 0 0 1px ${next ? C.rule : C.divider}`,
      opacity: sent && !working ? '.55' : '1', transition: `opacity .2s ${EASE}, box-shadow .2s ${EASE}`,
    });
    const num = el('span', { gridRow: 'span 2', font: `500 12px/18px ${MONO}`, color: next ? C.strong : C.faint }, String(i + 1).padStart(2, '0'));
    const label = working ? tag('Generating', C.bone, C.strong)
      : sent ? tag('Sent', C.positive)
      : next ? tag(state.running ? 'Up next' : 'Next', C.bone, C.strong)
      : tag('Queued', C.faint, C.faint);
    if (working) pulseAnim = pulse(label.dot);
    const body = el('p', {
      margin: '0', color: sent ? C.muted : C.text, fontSize: '13px', lineHeight: '1.5', overflowWrap: 'anywhere',
      display: '-webkit-box', WebkitLineClamp: '3', WebkitBoxOrient: 'vertical', overflow: 'hidden', cursor: 'pointer',
    }, text);
    body.title = 'Click to show or hide the whole prompt';
    body.onclick = () => { const open = body.style.webkitLineClamp === 'unset'; body.style.webkitLineClamp = open ? '3' : 'unset'; };
    li.append(num, label, body);
    return li;
  }

  function render() {
    const n = state.queue.length;
    pill.textContent = n ? `${state.idx} / ${n}` : '0';
    toggleCount.textContent = n ? `${state.idx}/${n}` : '';
    toggleTag.dot.style.background = state.running ? C.positive : C.bone;

    editView.style.display = editing ? 'block' : 'none';
    queueView.style.display = editing ? 'none' : 'block';
    bCancel.style.display = n ? 'inline-flex' : 'none';
    const cnt = parse(area.value).length;
    found.textContent = cnt ? `${cnt} prompt${cnt === 1 ? '' : 's'} found` : 'One prompt per line. Numbers like "1." are removed.';
    bLoad.disabled = !cnt;

    if (pulseAnim) { pulseAnim.cancel(); pulseAnim = null; }
    list.replaceChildren(...state.queue.map(card));
    const cur = list.children[Math.min(state.idx, n - 1)];
    if (cur && panel.style.display !== 'none') cur.scrollIntoView({ block: 'nearest' });

    bStart.textContent = state.running ? 'Running' : state.idx > 0 && state.idx < n ? 'Resume' : 'Start';
    bStart.disabled = state.running || state.idx >= n;
    bPause.disabled = !state.running;
    bSkip.disabled = state.running || state.idx >= n;
    bEdit.disabled = bClear.disabled = state.running;
    for (const b of [bLoad, bStart, bPause, bSkip, bEdit, bClear]) { b.style.opacity = b.disabled ? '.4' : '1'; b.style.cursor = b.disabled ? 'default' : 'pointer'; }
    setStatus(state.note || (n && state.idx >= n ? `Done: all ${n} prompts sent.` : n ? 'Ready. Leave the chat box alone while it runs.' : ''), state.bad);
  }

  toggle.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; render(); };
  area.addEventListener('input', render);
  bLoad.onclick = () => {
    const l = parse(area.value);
    if (!l.length) return;
    state.queue = l; state.idx = 0; state.note = ''; save();
    editing = false; render();
    setStatus(`Loaded ${l.length} prompts. Press Start.`);
  };
  bCancel.onclick = () => { editing = false; render(); };
  bEdit.onclick = () => { if (state.running) return; area.value = state.queue.slice(state.idx).join('\n'); editing = true; render(); area.focus(); };
  bStart.onclick = () => {
    if (state.running || state.idx >= state.queue.length) return;
    state.running = true; save(); render();
    setStatus('Starting…');
    run().catch((e) => pause(`Stopped: ${e && e.message ? e.message : e}`));
  };
  bPause.onclick = () => pause('Paused. Press Resume to continue from the next prompt.', false);
  bSkip.onclick = () => { if (!state.running && state.idx < state.queue.length) { state.idx++; save(); state.note = ''; render(); } };
  bClear.onclick = () => { if (state.running) return; state.queue = []; state.idx = 0; state.note = ''; save(); area.value = ''; editing = true; render(); };
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
