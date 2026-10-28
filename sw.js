// Service Worker: the channel that lets Python's input() wait for the user.
//
// The Python worker makes a synchronous XHR to "__pyinput__?id=...". We hold that
// request open until the page sends the typed value with postMessage, then answer it.
// Every other request passes through untouched.

const waiting = new Map(); // id -> resolve function of a held request
const ready = new Map();   // id -> value that arrived before the request did

// Answer held requests now and then with {retry: true}, so the browser never kills
// a request that waits too long. The worker simply asks again.
const HOLD_MS = 60 * 1000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function reply(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith('/__pyinput__')) return;

  const id = url.searchParams.get('id');
  if (ready.has(id)) {
    const value = ready.get(id);
    ready.delete(id);
    event.respondWith(reply({ value }));
    return;
  }

  event.respondWith(new Promise((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => {
      if (waiting.get(id) === resolve) {
        waiting.delete(id);
        resolve(reply({ retry: true }));
      }
    }, HOLD_MS);
  }));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'claim') {
    // A hard reload starts the page without a controller; take it over.
    event.waitUntil(self.clients.claim());
  } else if (msg.type === 'inputResult') {
    const resolve = waiting.get(msg.id);
    if (resolve) {
      waiting.delete(msg.id);
      resolve(reply({ value: msg.value }));
    } else {
      ready.set(msg.id, msg.value);
    }
  }
});
