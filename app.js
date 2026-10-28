// Page logic: file manager, console, running Python in the worker, theme.

import { createEditor } from './editor.js';
import * as storage from './storage.js';

const MAIN = 'main.py';
const MAX_UPLOAD_BYTES = 1024 * 1024;
const CONSOLE_MAX_CHARS = 400_000;

// Common standard library modules. A student file with one of these names hides the real module.
const STDLIB = new Set(('abc array ast asyncio base64 bisect builtins calendar cmath code collections copy csv ' +
  'datetime decimal enum fractions functools glob hashlib heapq html http io itertools json keyword logging ' +
  'math operator os pathlib pickle platform pprint queue random re secrets select shutil socket statistics ' +
  'string struct sys tempfile textwrap threading time timeit token tokenize traceback turtle types typing ' +
  'unicodedata unittest urllib uuid warnings xml zipfile').split(' '));

const $ = (id) => document.getElementById(id);

const state = {
  files: new Map(),      // name -> content
  active: MAIN,
  worker: null,
  ready: false,
  running: false,
  inputAvailable: false,
  version: '',
  pendingInput: null,    // {id, el}
  runSnapshot: null,     // files as sent to Python, to see what Python changed
};

// ============================================================
// Small helpers
// ============================================================

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

function sortedNames() {
  const others = [...state.files.keys()].filter((n) => n !== MAIN).sort((a, b) => a.localeCompare(b));
  return [MAIN, ...others];
}

function stem(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** Returns an error message, or null if the name is fine. */
function validateName(raw, current = null) {
  const name = raw.trim();
  if (!name) return 'Please enter a name.';
  if (name.length > 64) return 'That name is too long.';
  if (!/^[\p{L}\p{N}_.\-]+$/u.test(name)) return 'Use letters, digits, "_", "-" and "." only (no spaces or slashes).';
  if (name.startsWith('.')) return 'The name cannot start with ".".';
  if (name !== current && state.files.has(name)) return `A file named "${name}" already exists.`;
  if (name.endsWith('.py') && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(stem(name))) {
    return 'Python files need an importable name: letters, digits and "_", not starting with a digit (e.g. my_functions.py).';
  }
  return null;
}

/** Asks before using a name that hides a standard module, like random.py. */
async function confirmStdlibName(name) {
  if (!name.endsWith('.py') || !STDLIB.has(stem(name))) return true;
  return confirmBox(
    `"${name}" has the same name as Python's built-in "${stem(name)}" module. ` +
    `"import ${stem(name)}" will then load your file instead of the real module. Use this name anyway?`,
    'Use anyway',
  );
}

// ============================================================
// Dialogs
// ============================================================

const dialog = $('dialog');

function openDialog({ message, value = null, okLabel = 'OK', danger = false, validate = null, cancel = true }) {
  const input = $('dialog-input');
  const error = $('dialog-error');
  const ok = $('dialog-ok');
  $('dialog-message').textContent = message;
  $('dialog-cancel').hidden = !cancel;
  ok.textContent = okLabel;
  ok.classList.toggle('danger', danger);
  error.textContent = '';
  input.hidden = value === null;
  input.value = value ?? '';

  const check = () => {
    const msg = validate && !input.hidden ? validate(input.value) : null;
    error.textContent = msg || '';
    ok.disabled = !!msg;
    return !msg;
  };
  input.oninput = check;
  ok.disabled = false;

  return new Promise((resolve) => {
    dialog.onclose = () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
    $('dialog-form').onsubmit = (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      if (!check()) { e.preventDefault(); return; }
      dialog.returnValue = 'ok';
    };
    dialog.returnValue = '';
    dialog.showModal();
    if (!input.hidden) {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    } else {
      ok.focus();
    }
  });
}

function askText(message, value, validate, okLabel = 'OK') {
  return openDialog({ message, value, validate, okLabel });
}

async function confirmBox(message, okLabel = 'OK', danger = false) {
  return (await openDialog({ message, okLabel, danger })) !== null;
}

function alertBox(message) {
  return openDialog({ message, okLabel: 'OK', cancel: false }).then(() => {});
}

// ============================================================
// Saving (debounced per file)
// ============================================================

const saveTimers = new Map();

function scheduleSave(name) {
  clearTimeout(saveTimers.get(name));
  saveTimers.set(name, setTimeout(() => {
    saveTimers.delete(name);
    if (state.files.has(name)) storage.saveFile(name, state.files.get(name));
  }, 300));
}

function flushSaves() {
  for (const [name, timer] of saveTimers) {
    clearTimeout(timer);
    if (state.files.has(name)) storage.saveFile(name, state.files.get(name));
  }
  saveTimers.clear();
}

// ============================================================
// Editor
// ============================================================

const editor = createEditor($('editor'), {
  onChange(name, content) {
    state.files.set(name, content);
    scheduleSave(name);
  },
  onRun: () => run(),
});

function openFile(name) {
  if (!state.files.has(name)) name = MAIN;
  state.active = name;
  editor.open(name, state.files.get(name));
  $('editor-title').textContent = name;
  lsSet('activeFile', name);
  renderFileList();
}

// ============================================================
// File manager
// ============================================================

const ICON = {
  py: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6.5 8.5 5.5 10l1 1.5M9.5 8.5l1 1.5-1 1.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  txt: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 8h4.5M6 10h4.5M6 12h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  rename: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  delete: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',
};

function renderFileList(flash = []) {
  const list = $('file-list');
  list.textContent = '';
  for (const name of sortedNames()) {
    const li = document.createElement('li');
    li.className = 'file' + (name === state.active ? ' active' : '') + (flash.includes(name) ? ' flash' : '');
    li.title = name;
    li.innerHTML = `<span class="file-icon">${name.endsWith('.py') ? ICON.py : ICON.txt}</span><span class="file-name"></span>`;
    li.querySelector('.file-name').textContent = name;
    if (name === MAIN) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'run';
      badge.title = 'The Run button always runs main.py';
      li.append(badge);
    } else {
      const actions = document.createElement('span');
      actions.className = 'file-actions';
      actions.innerHTML =
        `<button class="icon-btn small" data-act="rename" title="Rename">${ICON.rename}</button>` +
        `<button class="icon-btn small" data-act="delete" title="Delete">${ICON.delete}</button>`;
      li.append(actions);
    }
    li.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'rename') renameFile(name);
      else if (act === 'delete') deleteFile(name);
      else openFile(name);
    });
    li.addEventListener('dblclick', (e) => {
      if (name !== MAIN && !e.target.closest('button')) renameFile(name);
    });
    list.append(li);
  }
}

async function newFile() {
  const name = await askText('New file name (e.g. my_functions.py, data.txt):', '', (v) => validateName(v), 'Create');
  if (!name || !(await confirmStdlibName(name))) return;
  state.files.set(name, '');
  await storage.saveFile(name, '');
  openFile(name);
}

async function renameFile(oldName) {
  if (oldName === MAIN) return;
  const name = await askText(`Rename "${oldName}" to:`, oldName, (v) => validateName(v, oldName), 'Rename');
  if (!name || name === oldName || !(await confirmStdlibName(name))) return;
  const content = state.files.get(oldName);
  clearTimeout(saveTimers.get(oldName));
  saveTimers.delete(oldName);
  state.files.delete(oldName);
  state.files.set(name, content);
  await storage.renameFile(oldName, name, content);
  editor.rename(oldName, name, content);
  if (state.active === oldName) openFile(name);
  else renderFileList();
}

async function deleteFile(name) {
  if (name === MAIN) return;
  if (!(await confirmBox(`Delete "${name}"? This cannot be undone.`, 'Delete', true))) return;
  removeFile(name);
}

function removeFile(name) {
  clearTimeout(saveTimers.get(name));
  saveTimers.delete(name);
  state.files.delete(name);
  storage.deleteFile(name);
  editor.forget(name);
  if (state.active === name) openFile(MAIN);
  else renderFileList();
}

/** Stores a file (new or replacing an existing one) and refreshes the editor's copy. */
function putFile(name, content) {
  state.files.set(name, content);
  storage.saveFile(name, content);
  editor.replace(name, content);
}

function suggestName(name) {
  let s = name.trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_.\-]/gu, '');
  if (s.endsWith('.py')) s = stem(s).replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^(\p{N})/u, '_$1') + '.py';
  return s.replace(/^\.+/, '') || 'file.txt';
}

async function readTextFile(file) {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('it is larger than 1 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.includes(0)) throw new Error('it is not a text file');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n');
  } catch {
    throw new Error('it is not UTF-8 text');
  }
}

/** Adds files from the computer. Opens the last one if openAfter is true. */
async function uploadFiles(fileList, openAfter) {
  let last = null;
  for (const file of fileList) {
    let content;
    try {
      content = await readTextFile(file);
    } catch (err) {
      await alertBox(`"${file.name}" was not added: ${err.message}.`);
      continue;
    }
    let name = file.name;
    // The name must be valid; an existing name is fine here (we ask before replacing).
    let problem = validateName(name, name);
    if (problem) {
      name = await askText(`"${file.name}" can't be used as a file name. ${problem}\nChoose a name:`,
        suggestName(file.name), (v) => validateName(v), 'Add');
      if (!name) continue;
    }
    if (state.files.has(name)) {
      if (!(await confirmBox(`"${name}" already exists. Replace it with the uploaded file?`, 'Replace', true))) continue;
    } else if (!(await confirmStdlibName(name))) {
      continue;
    }
    putFile(name, content);
    last = name;
  }
  if (last && openAfter) openFile(last);
  else renderFileList(last ? [last] : []);
}

// ============================================================
// Console
// ============================================================

const consoleEl = $('console');
const out = $('out');
let writeQueue = [];
let writeScheduled = false;
let consoleChars = 0;

function nearBottom() {
  return consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
}

/** Appends text to the console. cls: 'stdout' | 'stderr' | 'stdin' | 'info' | 'error' */
function write(text, cls = 'stdout') {
  if (!text) return;
  writeQueue.push([text, cls]);
  if (!writeScheduled) {
    writeScheduled = true;
    requestAnimationFrame(flushConsole);
  }
}

function flushConsole() {
  writeScheduled = false;
  if (!writeQueue.length) return;
  const stick = nearBottom();
  for (const [text, cls] of writeQueue) {
    const last = out.lastChild;
    if (last && last.nodeType === 1 && last.tagName === 'SPAN' && last.className === cls && last.firstChild) {
      last.firstChild.appendData(text);
    } else {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      out.append(span);
    }
    consoleChars += text.length;
  }
  writeQueue = [];
  trimConsole();
  if (stick) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function trimConsole() {
  while (consoleChars > CONSOLE_MAX_CHARS && out.firstChild) {
    consoleChars -= out.firstChild.textContent.length;
    out.firstChild.remove();
  }
}

function clearConsole() {
  writeQueue = [];
  out.textContent = '';
  consoleChars = 0;
  if (state.pendingInput) out.append(state.pendingInput.el);
}

/** Makes sure the console ends with a newline (before info lines). */
function ensureNewline() {
  flushConsole();
  const text = out.lastChild?.textContent;
  if (text && !text.endsWith('\n')) write('\n', out.lastChild.className);
}

/** Shows a traceback; "File "x", line N" parts link to the editor. Returns the deepest link. */
function writeError(text) {
  ensureNewline();
  flushConsole();
  const box = document.createElement('span');
  box.className = 'error';
  const lines = text.replace(/\n$/, '').split('\n');
  let deepest = null;
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*File ")([^"]+)(", line )(\d+)(.*)$/);
    if (m && state.files.has(m[2])) {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'tb-link';
      link.textContent = `${m[2]}", line ${m[4]}`;
      const target = { file: m[2], line: Number(m[4]) };
      link.addEventListener('click', (e) => { e.preventDefault(); goTo(target); });
      box.append(m[1], link, m[5]);
      deepest = target;
    } else if (i === lines.length - 1) {
      const strong = document.createElement('strong');
      strong.textContent = line;
      box.append(strong);
    } else {
      box.append(line);
    }
    box.append('\n');
  });
  out.append(box);
  consoleChars += text.length;
  consoleEl.scrollTop = consoleEl.scrollHeight;
  return deepest;
}

function goTo({ file, line }) {
  if (!state.files.has(file)) return;
  if (state.active !== file) openFile(file);
  editor.highlightLine(line);
}

// ---------- input() ----------

function showInput(id) {
  flushConsole();
  const el = document.createElement('input');
  el.className = 'stdin-field';
  el.type = 'text';
  el.spellcheck = false;
  el.autocomplete = 'off';
  el.setAttribute('aria-label', 'Program input');
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = el.value;
    el.remove();
    state.pendingInput = null;
    write(value + '\n', 'stdin');
    sendInput(id, value);
    setStatus('running', 'Running…');
  });
  out.append(el);
  state.pendingInput = { id, el };
  consoleEl.scrollTop = consoleEl.scrollHeight;
  el.focus({ preventScroll: true });
  setStatus('input', 'Waiting for input…');
}

function sendInput(id, value) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (sw) sw.postMessage({ type: 'inputResult', id, value });
}

consoleEl.addEventListener('click', () => {
  if (state.pendingInput && !window.getSelection().toString()) state.pendingInput.el.focus();
});

// ============================================================
// Running Python
// ============================================================

function setStatus(kind, text) {
  const el = $('status');
  el.dataset.kind = kind;
  $('status-text').textContent = text;
}

function updateButtons() {
  $('run').disabled = !state.ready || state.running;
  $('stop').disabled = !state.running;
}

// ---------- Loading lightbox (first load only) ----------

function loaderStep(text) {
  $('loader-step').textContent = text;
}

function hideLoader() {
  $('loader').classList.add('done');
}

function loaderFailed(text) {
  const loader = $('loader');
  if (loader.classList.contains('done')) return; // Python had loaded before; the console shows the error
  loader.classList.add('failed');
  loader.querySelector('.loader-title').textContent = 'Python could not be loaded';
  loaderStep(text);
  const btn = $('loader-reload');
  btn.hidden = false;
  btn.onclick = () => location.reload();
}

function startWorker() {
  state.ready = false;
  updateButtons();
  setStatus('loading', 'Loading Python…');
  const worker = new Worker('worker.js');
  state.worker = worker;
  worker.onmessage = (e) => handleWorkerMessage(worker, e.data);
  worker.onerror = (e) => {
    setStatus('error', 'Python failed to start');
    loaderFailed('Check your internet connection and try again.');
    write(`Python could not start: ${e.message || 'worker error'}\n`, 'error');
  };
  worker.postMessage({ type: 'init', inputAvailable: state.inputAvailable });
}

function handleWorkerMessage(worker, msg) {
  if (worker !== state.worker) return; // message from a stopped worker
  switch (msg.type) {
    case 'progress':
      loaderStep(msg.text);
      break;
    case 'ready':
      state.ready = true;
      state.version = msg.version;
      setStatus('ready', `Python ${msg.version}`);
      updateButtons();
      hideLoader();
      break;
    case 'initError':
      setStatus('error', 'Python failed to load');
      loaderFailed('Check your internet connection and try again.');
      write(`Python could not be loaded: ${msg.message}\nCheck your internet connection and reload the page.\n`, 'error');
      break;
    case 'out':
      write(msg.text, msg.stream);
      break;
    case 'inputRequest':
      showInput(msg.id);
      break;
    case 'done':
      finishRun(msg);
      break;
  }
}

function run() {
  if (!state.ready || state.running) return;
  flushSaves();
  clearConsole();
  state.running = true;
  state.runSnapshot = Object.fromEntries(state.files);
  updateButtons();
  setStatus('running', 'Running…');
  state.worker.postMessage({ type: 'run', files: state.runSnapshot });
}

function finishRun(msg) {
  state.running = false;
  updateButtons();
  setStatus('ready', `Python ${state.version}`);

  let target = null;
  if (msg.exitMessage) {
    ensureNewline();
    write(msg.exitMessage + '\n', 'stderr');
  }
  if (msg.error) target = writeError(msg.error);
  ensureNewline();
  const secs = (msg.elapsed / 1000).toFixed(2);
  write(msg.error ? `Finished with an error (${secs} s)\n` : `Finished (${secs} s)\n`, 'info');

  syncBack(msg.files);
  if (target) goTo(target);
}

/** Applies files Python created, changed or deleted. */
function syncBack(result) {
  if (!result) return;
  const before = state.runSnapshot || {};
  const changed = [];
  for (const [name, content] of Object.entries(result)) {
    if (before[name] === content) continue;
    if (!(name in before) && validateName(name, name)) continue; // unusable name: skip
    putFile(name, content);
    changed.push(name);
  }
  for (const name of Object.keys(before)) {
    if (!(name in result) && name !== MAIN && state.files.has(name)) {
      removeFile(name);
    }
  }
  if (changed.length) {
    write(`Files updated: ${changed.join(', ')}\n`, 'info');
  }
  renderFileList(changed);
}

function stop() {
  if (!state.running) return;
  if (state.pendingInput) {
    sendInput(state.pendingInput.id, '');
    state.pendingInput.el.remove();
    state.pendingInput = null;
  }
  state.worker.terminate();
  state.running = false;
  ensureNewline();
  write('Stopped.\n', 'info');
  startWorker();
}

// ---------- Service Worker (needed for input()) ----------

async function setupInputChannel() {
  const sw = navigator.serviceWorker;
  if (!sw || !window.isSecureContext) return false;
  try {
    await sw.register('sw.js');
    if (sw.controller) return true;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(!!sw.controller), 4000);
      sw.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(true); }, { once: true });
      sw.ready.then((reg) => reg.active && reg.active.postMessage({ type: 'claim' }));
    });
  } catch (err) {
    console.warn('Service Worker registration failed:', err);
    return false;
  }
}

// ============================================================
// Theme
// ============================================================

function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  lsSet('theme', next);
}

// ============================================================
// Drag and drop
// ============================================================

function hasFiles(e) {
  return e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}

function dropZone(el, openAfter) {
  // Capture phase, so CodeMirror never sees dropped files (it would paste their text).
  el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('dragging');
  }, true);
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('dragging');
  }, true);
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('dragging');
    uploadFiles([...e.dataTransfer.files], openAfter);
  }, true);
}

// ============================================================
// Editor / console splitter (the file list keeps a fixed width)
// ============================================================

function setupSplitter() {
  const layout = document.querySelector('.layout');
  const splitter = $('splitter');
  const consolePane = document.querySelector('.console-pane');

  // CSS clamps the value, so the editor and console never get too narrow.
  const setWidth = (px) => layout.style.setProperty('--console-w', `${Math.round(px)}px`);
  const save = () => lsSet('consoleWidth', String(Math.round(consolePane.getBoundingClientRect().width)));

  const saved = Number(lsGet('consoleWidth'));
  if (saved > 0) setWidth(saved);

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    const right = consolePane.getBoundingClientRect().right;
    const half = splitter.getBoundingClientRect().width / 2;

    const move = (ev) => setWidth(right - ev.clientX - half);
    const end = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', end);
      splitter.removeEventListener('pointercancel', end);
      splitter.classList.remove('dragging');
      document.body.classList.remove('resizing');
      save();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);
  });

  // Keyboard: arrow keys move the splitter.
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 20;
    const width = consolePane.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') setWidth(width + step);
    else if (e.key === 'ArrowRight') setWidth(width - step);
    else return;
    e.preventDefault();
    save();
  });

  // Double-click: back to the default width.
  splitter.addEventListener('dblclick', () => {
    layout.style.removeProperty('--console-w');
    try { localStorage.removeItem('consoleWidth'); } catch { /* ignore */ }
  });
}

// ============================================================
// Start
// ============================================================

async function main() {
  // Buttons
  $('run').addEventListener('click', run);
  $('stop').addEventListener('click', stop);
  $('new-file').addEventListener('click', newFile);
  $('upload').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    uploadFiles([...e.target.files], true);
    e.target.value = '';
  });
  $('clear-console').addEventListener('click', clearConsole);
  $('theme-toggle').addEventListener('click', toggleTheme);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  setupSplitter();
  dropZone($('sidebar'), false);
  dropZone($('editor-pane'), true);
  // Files dropped anywhere else should not make the browser open them.
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => hasFiles(e) && e.preventDefault());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSaves();
  });

  // Files
  const saved = await storage.loadFiles();
  for (const [name, content] of Object.entries(saved)) state.files.set(name, content);
  if (!state.files.has(MAIN)) {
    state.files.set(MAIN, '');
    storage.saveFile(MAIN, '');
  }
  openFile(lsGet('activeFile') || MAIN);

  write('Press Run (Ctrl+Enter) to run main.py.\n', 'info');

  // Python
  loaderStep('Preparing the input channel…');
  state.inputAvailable = await setupInputChannel();
  if (!state.inputAvailable) {
    write('Note: input() will not work here. Open this page through a web server (http/https), not as a file.\n', 'stderr');
  }
  startWorker();
}

main();
