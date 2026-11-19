// Shows what the app is doing until the crew's dashboard replaces this page. The app keeps the text in the user's
// language; this page only asks for it (the one command the app offers, and only to its own pages).
const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
const main = document.getElementById("main");
const label = document.getElementById("label");
const detail = document.getElementById("detail");

async function tick() {
  try {
    const s = await invoke("status");
    label.textContent = s.text;
    detail.textContent = s.detail;
    main.classList.toggle("error", s.error);
  } catch {}
  setTimeout(tick, 400);
}
if (invoke) tick();
