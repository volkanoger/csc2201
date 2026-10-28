// Web Worker that runs Python with Pyodide.
//
// Messages from the page:
//   {type: 'init', inputAvailable}   load Pyodide
//   {type: 'run', files}             write files, run main.py, send back the files
// Messages to the page:
//   {type: 'ready', version} | {type: 'initError', message}
//   {type: 'out', stream: 'stdout'|'stderr', text}
//   {type: 'inputRequest', id}
//   {type: 'done', error, exitMessage, files, elapsed}

const PYODIDE_VERSION = '0.29.5';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const HOME = '/home/pyodide';
const MAX_SYNC_BYTES = 2 * 1024 * 1024; // files bigger than this are not sent back

let pyodide = null;
let inputAvailable = false;

// ---------- Output (batched, so a print loop does not flood the page) ----------

const pending = { stdout: '', stderr: '' };
let lastFlush = 0;

function flushOutput() {
  for (const stream of ['stdout', 'stderr']) {
    if (pending[stream]) {
      postMessage({ type: 'out', stream, text: pending[stream] });
      pending[stream] = '';
    }
  }
  lastFlush = Date.now();
}

function makeWriter(stream) {
  const decoder = new TextDecoder();
  return {
    write(bytes) {
      pending[stream] += decoder.decode(bytes, { stream: true });
      if (pending[stream].length > 8192 || Date.now() - lastFlush > 30) flushOutput();
      return bytes.length;
    },
  };
}

// ---------- input(): synchronous XHR answered by the Service Worker ----------

function newId() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Called from Python. Blocks until the user presses Enter in the console.
self.requestInputSync = function () {
  flushOutput();
  const id = newId();
  postMessage({ type: 'inputRequest', id });
  for (;;) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `__pyinput__?id=${encodeURIComponent(id)}`, false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`input channel answered ${xhr.status}`);
    const data = JSON.parse(xhr.responseText);
    if (!data.retry) return String(data.value ?? '');
  }
};

self.inputIsAvailable = () => inputAvailable;

// ---------- Python side ----------

const PY_SETUP = String.raw`
import sys, os, builtins, importlib, runpy, traceback

HOME = "/home/pyodide"
sys.dont_write_bytecode = True
os.chdir(HOME)
if HOME not in sys.path:
    sys.path.insert(0, HOME)

def _input(prompt=""):
    import js
    if not js.inputIsAvailable():
        raise RuntimeError(
            "input() is not available. Reload the page; if you opened the file "
            "directly (file://), serve the folder with a web server instead.")
    sys.stdout.write(str(prompt))
    sys.stdout.flush()
    sys.stderr.flush()
    return str(js.requestInputSync())

builtins.input = _input

def _short(path):
    if path and path.startswith(HOME + "/"):
        return path[len(HOME) + 1:]
    return path

def _is_user(path):
    return bool(path) and path.startswith(HOME + "/")

def _format_error(exc):
    te = traceback.TracebackException(type(exc), exc, exc.__traceback__)
    # Drop chained exceptions and every frame that is not in the student's files.
    te.__cause__ = None
    te.__context__ = None
    frames = [f for f in te.stack if _is_user(f.filename)]
    for f in frames:
        f.filename = _short(f.filename)
    te.stack = traceback.StackSummary.from_list(frames)
    if getattr(te, "filename", None):
        te.filename = _short(te.filename)
    return "".join(te.format())

def _run_main():
    # Fresh start: forget the student's modules so edited files are imported again.
    for name, mod in list(sys.modules.items()):
        if _is_user(getattr(mod, "__file__", None) or ""):
            del sys.modules[name]
    importlib.invalidate_caches()
    os.chdir(HOME)
    try:
        runpy.run_path(HOME + "/main.py", run_name="__main__")
        return (None, None)
    except SystemExit as e:
        code = e.code
        if code is None or code == 0:
            return (None, None)
        if isinstance(code, int):
            return (None, f"Process exited with code {code}")
        return (None, str(code))
    except BaseException as e:
        return (_format_error(e), None)
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
`;

// ---------- File system ----------

function clearHome() {
  const FS = pyodide.FS;
  for (const name of FS.readdir(HOME)) {
    if (name === '.' || name === '..') continue;
    const path = `${HOME}/${name}`;
    if (FS.isFile(FS.stat(path).mode)) FS.unlink(path);
  }
}

function writeFiles(files) {
  clearHome();
  for (const [name, content] of Object.entries(files)) {
    pyodide.FS.writeFile(`${HOME}/${name}`, content, { encoding: 'utf8' });
  }
}

// Reads every top-level text file back, so files made by open(..., "w") show up.
function readFiles() {
  const FS = pyodide.FS;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const result = {};
  for (const name of FS.readdir(HOME)) {
    if (name === '.' || name === '..') continue;
    const path = `${HOME}/${name}`;
    const stat = FS.stat(path);
    if (!FS.isFile(stat.mode) || stat.size > MAX_SYNC_BYTES) continue;
    try {
      result[name] = decoder.decode(FS.readFile(path));
    } catch {
      // Not UTF-8 text (e.g. a binary file): leave it out.
    }
  }
  return result;
}

// ---------- Messages ----------

async function init(msg) {
  inputAvailable = !!msg.inputAvailable;
  try {
    importScripts(`${PYODIDE_URL}pyodide.js`);
    pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
    pyodide.setStdout(makeWriter('stdout'));
    pyodide.setStderr(makeWriter('stderr'));
    pyodide.runPython(PY_SETUP);
    const version = pyodide.runPython('import sys; sys.version.split()[0]');
    postMessage({ type: 'ready', version });
  } catch (err) {
    postMessage({ type: 'initError', message: String(err && err.message || err) });
  }
}

function run(msg) {
  const started = performance.now();
  let error = null;
  let exitMessage = null;
  let files = null;
  try {
    writeFiles(msg.files);
    const result = pyodide.globals.get('_run_main')();
    [error, exitMessage] = result.toJs();
    result.destroy();
  } catch (err) {
    error = `Internal error: ${err && err.message || err}`;
  }
  flushOutput();
  try {
    files = readFiles();
  } catch {
    files = null;
  }
  postMessage({ type: 'done', error, exitMessage, files, elapsed: performance.now() - started });
}

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'run') run(msg);
};
