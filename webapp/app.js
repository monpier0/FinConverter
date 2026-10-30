"use strict";

const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);
// ?demo: открыть интерфейс в обычном браузере на фейковых данных, без сервера
const params = new URLSearchParams(location.search);
const demo = !inTelegram && params.has("demo");
// на широком экране демо показываем в рамке телефона: внутри iframe та же страница
const framed = demo && !params.has("inner") && innerWidth > 600;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.22, .7, .3, 1)";
const SPLASH_MIN = 450; // мс: за это время заставка успевает проявиться, и она не мелькает на быстрой сети
const GAP = 22; // зазор между страницами в ленте
const UNDO_MS = 5000; // сколько можно вернуть удалённую страницу
const MARK_OPEN = "", MARK_CLOSE = ""; // границы слов, в которых распознавание сомневается

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const state = {
  items: [], options: {}, title: {}, workTypes: [],
  cur: 0, curKey: null, // текущая страница: индекс среди слотов и её ключ (ключ переживает перестановки и удаления)
  screen: "sStart", busy: false,
};

const HINT_QUALITY = { low: "сжатое", medium: "обычное", high: "высокое" };

/* ---------------- API ---------------- */

async function api(method, path, body, opts = {}) {
  if (demo) return demoApi(method, path, body);
  const headers = { "X-Init-Data": tg?.initData || "" };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, keepalive: Boolean(opts.keepalive) });
  } catch {
    throw Object.assign(new Error("Нет связи с сервером. Проверь интернет и попробуй ещё раз"), { network: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Что-то пошло не так"), { status: res.status });
  return data;
}

// применяет ответ сервера; удалённая, но ещё не подтверждённая страница не воскресает
function apply(data, { focusNew = false } = {}) {
  const before = new Set(state.items.map((i) => i.id));
  state.items = pending ? data.items.filter((i) => i.id !== pending.item.id) : data.items;
  state.options = data.options;
  state.title = data.title;
  state.workTypes = data.work_types;
  if (focusNew) {
    const fresh = state.items.find((i) => !before.has(i.id));
    if (fresh) state.curKey = fresh.id;
  }
  sync();
  if (data.errors?.length) toast(data.errors[0] + (data.errors.length > 1 ? ` (и ещё ${data.errors.length - 1})` : ""), { ms: 5000 });
}

const reload = () => api("GET", "/api/session").then((d) => apply(d)).catch(() => {});

/* ---------------- слои: шторки, диалоги, экраны поверх ---------------- */

const layers = []; // стек открытых слоёв: системная кнопка «Назад» закрывает верхний

function syncBack() {
  if (!inTelegram) return;
  layers.length ? tg.BackButton.show() : tg.BackButton.hide();
}

function syncScrim() {
  $("#scrim").classList.toggle("on", layers.some((l) => l.kind !== "screen"));
}

function openLayer(id, { dismiss = true, onClose } = {}) {
  const node = $("#" + id);
  if (layers.some((l) => l.id === id)) return;
  // шторка или диалог бывает одна за раз: открываем новую, а прежнюю закрываем
  layers.filter((l) => l.kind !== "screen").forEach(closeLayer);
  clearTimeout(node._hide);
  node.hidden = false;
  void node.offsetWidth; // чтобы переход сработал с нуля
  node.classList.add("on");
  layers.push({ id, node, kind: node.classList.contains("dialog") ? "dialog" : "sheet", dismiss, onClose });
  syncScrim();
  syncBack();
}

function openScreenLayer(id, onClose) {
  layers.push({ id, kind: "screen", dismiss: true, onClose });
  syncBack();
}

function closeLayer(entry) {
  const i = layers.indexOf(entry);
  if (i < 0) return;
  layers.splice(i, 1);
  if (entry.node) {
    entry.node.classList.remove("on");
    entry.node._hide = setTimeout(() => { entry.node.hidden = true; }, reduced ? 0 : 340);
  }
  syncScrim();
  syncBack();
  entry.onClose?.();
}

function popLayer() { const top = layers[layers.length - 1]; if (top) closeLayer(top); }
function closeLayerById(id) { const l = layers.find((x) => x.id === id); if (l) closeLayer(l); }
function closeAllLayers() { while (layers.length) closeLayer(layers[layers.length - 1]); }

/* ---------------- уведомление ---------------- */

let toastTimer, toastAction;
function toast(text, { ms = 3000, label, action } = {}) {
  const t = $("#toast");
  clearTimeout(t._hide);
  $("#toastText").textContent = text;
  const btn = $("#toastAct");
  btn.hidden = !action;
  btn.textContent = label || "";
  toastAction = action;
  t.hidden = false;
  void t.offsetWidth;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  const t = $("#toast");
  clearTimeout(toastTimer);
  t.classList.remove("on");
  t._hide = setTimeout(() => { t.hidden = true; }, reduced ? 0 : 320);
}

function haptic(kind) {
  const h = tg?.HapticFeedback;
  if (!h) return;
  ["success", "error", "warning"].includes(kind) ? h.notificationOccurred(kind) : h.impactOccurred(kind);
}

/* ---------------- экраны ---------------- */

function setScreen(id) {
  if (state.screen === id) return;
  const prev = state.screen;
  state.screen = id;
  if (prev === "sStart" && id === "sEdit") {
    const start = $("#sStart");
    start.classList.add("leaving-start"); // рамка уходит вниз и гаснет, пока выезжает редактор
    setTimeout(() => start.classList.remove("leaving-start"), 450);
  }
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  if (id === "sEdit") requestAnimationFrame(() => { measureDeck(); layoutDeck(false); scrollFilm(false); });
}

/* ---------------- модель слотов ---------------- */

// слот — страница в ленте; титульный лист — виртуальная первая страница, в сессии его нет
function slots() {
  const list = state.items.map((item) => ({ key: item.id, kind: item.kind, item }));
  return state.title.enabled && state.items.length ? [{ key: "title", kind: "title" }, ...list] : list;
}

function pageCount() {
  return state.items.reduce((n, i) => n + i.pages, 0) + (state.title.enabled && state.items.length ? 1 : 0);
}

const imageItems = () => state.items.filter((i) => i.kind === "image");
const textItems = () => imageItems().filter((i) => i.text != null);
const plainText = (t) => t.replaceAll(MARK_OPEN, "").replaceAll(MARK_CLOSE, "");

function syncCur() {
  const list = slots();
  let i = list.findIndex((s) => s.key === state.curKey);
  if (i < 0) i = clamp(state.cur, 0, Math.max(list.length - 1, 0));
  state.cur = i;
  state.curKey = list[i]?.key ?? null;
}

/* ---------------- отрисовка ---------------- */

function sync() {
  syncCur();
  const has = state.items.length > 0;
  if (state.screen === "sStart" || state.screen === "sEdit") setScreen(has ? "sEdit" : "sStart");
  if (has) { measureDeck(); syncDeck(); syncFilm(); }
  syncOptions();
  syncMeta();
  syncSettings();
  syncOcrBadge();
  layoutDeck(true);
  updateFilmCur();
}

const deckBox = { w: 0, h: 0, pw: 240, ph: 320, step: 262 };

function measureDeck() {
  const deck = $("#deck");
  const w = deck.clientWidth, h = deck.clientHeight;
  if (!w || !h) return false;
  let ph = h - 22, pw = ph * .75; // запас сверху и снизу под обводку текущей страницы
  if (pw > w - 96) { pw = w - 96; ph = pw / .75; }
  Object.assign(deckBox, { w, h, pw, ph, step: pw + GAP });
  deck.style.setProperty("--pw", `${pw}px`);
  deck.style.setProperty("--ph", `${ph}px`);
  deck.style.setProperty("--tb", `${(h - ph) / 2 + 14}px`);
  return true;
}

// накопленный угол: после 270° страница докручивается вперёд до 360°, а не отматывает назад
const spin = {};
function rotation(item) {
  let angle = spin[item.id] ?? item.rotation;
  if (angle % 360 !== item.rotation) angle = spin[item.id] = item.rotation; // сервер или откат изменили угол
  // повёрнутая на 90° портретная страница не влезает в портретную рамку: ужимаем
  return `rotate(${angle}deg)${item.rotation % 180 ? " scale(.75)" : ""}`;
}

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

const deckNode = (key) => $$("#deck .slot").find((n) => n.dataset.key === key);
const filmNode = (key) => $$("#film .th").find((n) => n.dataset.key === key);

function pdfTile(item) {
  const tile = el("div", "pdf-tile");
  const b = el("b");
  b.textContent = "PDF";
  const name = el("span");
  name.textContent = `${item.name || "Документ"} · ${item.pages} стр.`;
  tile.append(b, name);
  return tile;
}

// HTML-копия того, что рисует app/title.py: те же поля, кегль и блоки
function titleSheet(t) {
  const sheet = el("div", "a4");
  const inner = el("div", "a4-in");
  const line = (cls, text) => { const d = el("div", cls); d.textContent = text; return d; };
  const head = el("div", "t-head");
  head.append(
    line("", "Федеральное государственное образовательное бюджетное учреждение высшего образования"),
    line("", "«Финансовый университет при Правительстве Российской Федерации»"),
    line("", "(Финансовый университет)"),
  );
  if (t.faculty) head.append(line("t-faculty", t.faculty));
  const main = el("div", "t-main");
  main.append(line("t-type", t.work_type || "Реферат"));
  if (t.discipline) main.append(line("", `по дисциплине «${t.discipline}»`));
  if (t.topic) main.append(line("t-topic", `на тему: «${t.topic}»`));
  const sign = el("div", "t-sign");
  const label = t.student_label || "Выполнил";
  sign.append(Object.assign(el("b"), { textContent: `${label}:` }));
  if (t.group) sign.append(line("", `студент${label === "Выполнила" ? "ка" : ""} группы ${t.group}`));
  sign.append(line("", t.student || "ФИО студента"));
  if (t.teacher) {
    sign.append(el("div", "t-gap"));
    sign.append(Object.assign(el("b"), { textContent: "Проверил(а):" }));
    if (t.teacher_position) sign.append(line("", t.teacher_position));
    sign.append(line("", t.teacher));
  }
  inner.append(head, main, sign, line("t-city", `${t.city || "Москва"} ${new Date().getFullYear()}`));
  sheet.append(inner);
  return sheet;
}

function makeSlot(slot) {
  const node = el("div", "slot");
  node.dataset.key = slot.key;
  if (slot.kind === "title") node.classList.add("t");
  node.setAttribute("aria-label", slot.kind === "title" ? "Титульный лист" : "Страница");
  const pg = el("div", "pg");
  pg.append(el("div", "rot"));
  node.append(pg);
  return node;
}

function fillSlot(node, slot) {
  const rot = $(".rot", node);
  if (slot.kind === "title") {
    const sig = JSON.stringify(state.title);
    if (node._sig !== sig) { node._sig = sig; rot.replaceChildren(titleSheet(state.title)); }
    rot.style.transform = "";
  } else if (slot.kind === "pdf") {
    if (!rot.firstChild) rot.append(pdfTile(slot.item));
    rot.style.transform = rotation(slot.item);
  } else {
    let img = $("img", rot);
    const src = slot.item.mid || slot.item.thumb;
    if (!img) {
      img = el("img", "loading");
      img.alt = "";
      img.draggable = false;
      img.decoding = "async";
      img.addEventListener("load", () => img.classList.remove("loading"));
      img.addEventListener("error", () => img.classList.remove("loading"));
      rot.append(img);
    }
    if (img.getAttribute("src") !== src) img.src = src;
    rot.style.transform = rotation(slot.item);
  }
}

// сцена: ключевая сверка. Существующие страницы остаются на месте и плавно переезжают, новые выезжают, лишние пропадают
function syncDeck() {
  const track = $("#deck");
  const list = slots();
  const keys = new Set(list.map((s) => s.key));
  $$(".slot", track).forEach((n) => { if (!keys.has(n.dataset.key) && !n.classList.contains("gone")) n.remove(); });
  let fresh = 0;
  list.forEach((slot, i) => {
    let node = deckNode(slot.key);
    if (!node) {
      node = makeSlot(slot);
      node.style.transition = "none";
      if (!reduced) {
        node.classList.add("enter");
        node.style.animationDelay = `${Math.min(fresh++, 5) * 50}ms`;
        node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true });
      }
      track.insertBefore(node, $("#tools"));
      requestAnimationFrame(() => { node.style.transition = ""; });
    }
    fillSlot(node, slot);
    if (track.children[i] !== node) track.insertBefore(node, track.children[i] || $("#tools"));
  });
}

function layoutDeck(animate = true, dx = 0) {
  const deck = $("#deck");
  deck.classList.toggle("drag", !animate);
  const list = slots();
  const { step } = deckBox;
  $$(".slot", deck).forEach((node) => {
    const i = list.findIndex((s) => s.key === node.dataset.key);
    if (i < 0) return;
    const rel = i - state.cur + (step ? dx / step : 0);
    const d = Math.abs(rel);
    node.style.setProperty("--x", `${(i - state.cur) * step + dx}px`);
    node.style.setProperty("--sc", String(1 - Math.min(d, 1) * .1));
    node.style.setProperty("--op", String(d >= 2 ? 0 : 1 - Math.min(d, 1) * .45 - Math.max(d - 1, 0) * .55));
    node.style.pointerEvents = d >= 2 ? "none" : "";
    node.classList.toggle("cur", i === state.cur);
    node.setAttribute("aria-hidden", String(i !== state.cur));
  });
  const slot = list[state.cur];
  $("#tools").classList.toggle("off", !slot || slot.kind === "title" || state.busy);
  $("#rot").hidden = slot?.kind === "pdf"; // PDF-файл не поворачивается
  $("#count").textContent = list.length ? `${state.cur + 1} / ${list.length}` : "";
}

function setCur(i, animate = true) {
  const list = slots();
  state.cur = clamp(i, 0, Math.max(list.length - 1, 0));
  state.curKey = list[state.cur]?.key ?? null;
  layoutDeck(animate);
  updateFilmCur();
}

function syncFilm() {
  const film = $("#film");
  const list = slots();
  const keys = new Set(list.map((s) => s.key));
  $$(".th", film).forEach((n) => { if (!keys.has(n.dataset.key) && !n.classList.contains("gone")) n.remove(); });
  let fresh = 0;
  list.forEach((slot, i) => {
    let node = filmNode(slot.key);
    if (!node) {
      node = el("button", "th press");
      node.type = "button";
      node.dataset.key = slot.key;
      node.setAttribute("role", "listitem");
      if (!reduced) {
        node.classList.add("enter");
        node.style.animationDelay = `${Math.min(fresh++, 8) * 45}ms`;
        node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true });
      }
    }
    fillThumb(node, slot, i);
    if (film.children[i] !== node) film.insertBefore(node, film.children[i] || null);
  });
}

function fillThumb(node, slot, i) {
  node.setAttribute("aria-label", slot.kind === "title" ? "Титульный лист" : `Страница ${i + 1}`);
  node.classList.toggle("t", slot.kind === "title");
  node.classList.toggle("p", slot.kind === "pdf");
  if (slot.kind === "title") { if (!node.firstChild) node.textContent = "Т"; return; }
  if (slot.kind === "pdf") { if (!node.firstChild) node.textContent = "PDF"; return; }
  let img = $("img", node);
  if (!img) {
    node.textContent = "";
    img = el("img");
    img.alt = "";
    img.draggable = false;
    node.append(img);
  }
  if (img.getAttribute("src") !== slot.item.thumb) img.src = slot.item.thumb;
  let gt = $(".gt", node);
  const got = slot.item.text != null || slot.item._got;
  if (got && !gt) { gt = el("span", "gt"); gt.textContent = "Aa"; node.append(gt); }
  if (!got && gt) gt.remove();
}

function updateFilmCur() {
  $$("#film .th").forEach((th) => th.classList.toggle("cur", th.dataset.key === state.curKey));
  scrollFilm();
}

function scrollFilm(smooth = true) {
  const film = $("#film"), th = filmNode(state.curKey);
  if (!th) return;
  film.scrollTo({ left: th.offsetLeft - (film.clientWidth - th.offsetWidth) / 2, behavior: smooth && !reduced ? "smooth" : "auto" });
}

function syncOptions() {
  const mode = state.options.mode || "color";
  const deck = $("#deck");
  deck.classList.remove("m-color", "m-gray", "m-scan");
  deck.classList.add(`m-${mode}`);
  $("#knob").style.transform = `translateX(${["color", "gray", "scan"].indexOf(mode) * 100}%)`;
  $$("#mode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === mode)));
}

function syncMeta() {
  const o = state.options, n = pageCount();
  const fmt = o.page === "a4" ? "A4 с полями" : "как фото";
  $("#meta").textContent = `${fmt} · ${HINT_QUALITY[o.quality] || "обычное"} качество · ${state.title.enabled ? "с титульным" : "без титульного"}`;
  $("#cap").textContent = n ? `Собрать · ${n} ${plural(n, "страница", "страницы", "страниц")}` : "";
}

function syncOcrBadge() {
  const got = textItems().length, dot = $("#odot");
  dot.hidden = !got;
  if (got) dot.textContent = String(got);
}

// шторки настроек и титульного листа
function syncSettings() {
  const o = state.options, t = state.title;
  $$(".mini-seg[data-opt]").forEach((g) => $$("button", g).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === o[g.dataset.opt]))));
  $$("input[data-opt]").forEach((input) => { if (document.activeElement !== input) input.value = o[input.dataset.opt] ?? ""; });
  $$("[data-title]").forEach((input) => {
    const v = t[input.dataset.title];
    if (input.type === "checkbox") input.checked = Boolean(v);
    else if (document.activeElement !== input) input.value = v ?? "";
  });
  const filled = t.student || t.discipline;
  $("#tsub").textContent = !t.enabled ? "Не будет добавлен" : filled ? [t.work_type, shortName(t.student)].filter(Boolean).join(", ") : "Нажми «Изменить», чтобы заполнить";
  $("#tprev").replaceChildren(titleSheet(t));
  const types = $("#workTypes");
  if (types.children.length !== state.workTypes.length) {
    types.replaceChildren(...state.workTypes.map((w) => {
      const b = el("button", "press");
      b.type = "button";
      b.textContent = w;
      b.onclick = () => { haptic("light"); setTitle("work_type", w); };
      return b;
    }));
  }
  $$("#workTypes button").forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === t.work_type)));
  $$("#labelSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === (t.student_label || "Выполнил"))));
}

// «Иванова Мария Сергеевна» → «Иванова М. С.»
function shortName(full = "") {
  const [last, ...rest] = full.trim().split(/\s+/);
  return [last, ...rest.map((p) => p[0] + ".")].filter(Boolean).join(" ");
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function humanSize(n) {
  return n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1048576).toFixed(1).replace(".", ",")} МБ`;
}

/* ---------------- жесты: листание, клавиши ---------------- */

function bindDeck() {
  const deck = $("#deck");
  let x0 = null, dx = 0, moved = false, vx = 0, lastX = 0, lastT = 0, pid = null, suppressClick = false;
  deck.addEventListener("pointerdown", (e) => {
    if ((e.pointerType === "mouse" && e.button !== 0) || e.target.closest(".tools")) return;
    x0 = e.clientX; dx = 0; moved = false; vx = 0; lastX = e.clientX; lastT = e.timeStamp; pid = e.pointerId;
  });
  deck.addEventListener("pointermove", (e) => {
    if (x0 === null || e.pointerId !== pid) return;
    const raw = e.clientX - x0;
    if (!moved) {
      if (Math.abs(raw) < 8) return;
      moved = true;
      deck.setPointerCapture(pid);
    }
    const dt = e.timeStamp - lastT;
    if (dt > 0) vx = (e.clientX - lastX) / dt;
    lastX = e.clientX; lastT = e.timeStamp;
    const atEdge = (state.cur === 0 && raw > 0) || (state.cur === slots().length - 1 && raw < 0);
    dx = atEdge ? raw * .35 : raw; // у края страница подаётся туго, как резинка
    layoutDeck(false, dx);
  });
  const end = (e) => {
    if (x0 === null || e.pointerId !== pid) return;
    x0 = null;
    if (!moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    let next = state.cur;
    if ((dx < -60 || vx < -.5) && next < slots().length - 1) next++;
    else if ((dx > 60 || vx > .5) && next > 0) next--;
    if (next !== state.cur) haptic("light");
    setCur(next, true);
  };
  deck.addEventListener("pointerup", end);
  deck.addEventListener("pointercancel", end);
  // нажатие на соседнюю страницу, выглядывающую сбоку, переходит к ней
  deck.addEventListener("click", (e) => {
    if (suppressClick) return;
    const node = e.target.closest(".slot");
    if (!node || node.classList.contains("cur")) return;
    setCur(slots().findIndex((s) => s.key === node.dataset.key));
  });
  deck.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); setCur(state.cur + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setCur(state.cur - 1); }
  });
  $("#film").addEventListener("click", (e) => {
    const th = e.target.closest(".th");
    if (th) setCur(slots().findIndex((s) => s.key === th.dataset.key));
  });
  new ResizeObserver(() => { if (measureDeck()) { layoutDeck(false); scrollFilm(false); } }).observe(deck);
}

/* ---------------- действия над страницами ---------------- */

async function onFiles(e) {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append("file", f, f.name));
  toast(`Загружаю ${files.length} ${plural(files.length, "файл", "файла", "файлов")}…`, { ms: 60000 });
  try {
    const data = await api("POST", "/api/upload", fd);
    hideToast();
    apply(data, { focusNew: true }); // ошибки по отдельным файлам показываются уже после того, как погасло «Загружаю…»
    if (state.items.length) haptic("success");
  } catch (err) {
    haptic("error");
    toast(err.message, { ms: 5000 });
  }
}

async function rotate() {
  const slot = slots()[state.cur];
  if (!slot || slot.kind !== "image") return;
  const item = slot.item;
  haptic("light");
  spin[item.id] = (spin[item.id] ?? item.rotation) + 90;
  item.rotation = (item.rotation + 90) % 360;
  // рамки слов посчитаны для прежнего поворота
  if (item.text != null && item.boxes?.length) {
    item.boxes = [];
    api("PUT", `/api/items/${item.id}/text`, { text: item.text, boxes: [] }).catch(() => {});
  }
  // крутим уже нарисованную страницу: переход в CSS делает это плавно
  fillSlot(deckNode(slot.key), slot);
  try {
    await api("POST", `/api/items/${item.id}/rotate`, { rotation: item.rotation });
  } catch (err) {
    toast(err.message);
    reload();
  }
}

// удалённая страница ещё несколько секунд лежит на сервере: так её можно вернуть
let pending = null;
let removing = false;

async function commitPending() {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  try {
    await api("DELETE", `/api/items/${p.item.id}`, undefined, { keepalive: true });
  } catch {
    state.items.splice(Math.min(p.index, state.items.length), 0, p.item);
    sync();
    toast("Не удалось удалить страницу");
  }
}

async function removeCurrent() {
  const slot = slots()[state.cur];
  if (!slot || slot.kind === "title" || removing) return;
  removing = true;
  await commitPending(); // предыдущее удаление подтверждается сразу, вернуть можно только последнюю страницу
  haptic("medium");
  const item = slot.item, index = state.items.indexOf(item), list = slots();
  const next = (list[state.cur + 1] ?? list[state.cur - 1])?.key ?? null;
  deckNode(slot.key)?.classList.add("gone");
  filmNode(slot.key)?.classList.add("gone");
  await sleep(reduced ? 0 : 300);
  removing = false;
  const at = state.items.indexOf(item);
  if (at < 0) return; // за это время список заменили (очистка, сброс)
  state.items.splice(at, 1);
  state.curKey = next;
  pending = { item, index, timer: setTimeout(commitPending, UNDO_MS) };
  $$(".gone").forEach((n) => n.remove());
  sync();
  toast("Страница удалена", { ms: UNDO_MS, label: "Вернуть", action: undoRemove });
}

function undoRemove() {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  state.items.splice(Math.min(p.index, state.items.length), 0, p.item);
  state.curKey = p.item.id;
  haptic("light");
  hideToast();
  sync();
}

// закрыли мини-апп, пока висело подтверждение: удаляем сразу, иначе страница вернулась бы при следующем входе
addEventListener("pagehide", () => { commitPending(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) commitPending(); });

async function onReorder(evt) {
  if (evt.oldIndex === evt.newIndex) return;
  const ids = $$("#film .th[data-key]:not(.t)").map((n) => n.dataset.key);
  const byId = new Map(state.items.map((i) => [i.id, i]));
  state.items = [...ids.map((id) => byId.get(id)).filter(Boolean), ...state.items.filter((i) => !ids.includes(i.id))];
  syncCur();
  syncDeck();
  layoutDeck(true);
  updateFilmCur();
  try {
    await api("POST", "/api/order", { ids });
  } catch (err) {
    toast(err.message);
    reload();
  }
}

function bindFilmSort() {
  if (!window.Sortable) return;
  Sortable.create($("#film"), {
    animation: 180, delay: 220, delayOnTouchOnly: true, touchStartThreshold: 6,
    draggable: ".th:not(.t)", ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
    onMove: (evt) => !evt.related.matches(".t"), // титульный лист всегда первый
    onStart: () => haptic("medium"),
    onEnd: onReorder,
  });
}

/* ---------------- настройки и титульный лист ---------------- */

const timers = {};
function debounced(key, fn, ms = 500) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

function setOption(key, value) {
  state.options[key] = value;
  syncOptions(); syncMeta(); syncSettings();
  debounced("opt", () => api("POST", "/api/options", state.options).catch((e) => toast(e.message)));
}

function setTitle(key, value) {
  state.title[key] = value;
  if (key === "enabled") { syncCur(); syncDeck(); syncFilm(); layoutDeck(true); updateFilmCur(); }
  else { const node = deckNode("title"); if (node) fillSlot(node, { kind: "title" }); }
  syncMeta(); syncSettings();
  debounced("title", () => api("POST", "/api/title", state.title).catch((e) => toast(e.message)));
}

function missingTitleFields() {
  const t = state.title;
  if (!t.enabled) return [];
  return [["work_type", "тип работы"], ["student", "ФИО"], ["group", "группу"]].filter(([k]) => !t[k]).map(([, l]) => l);
}

/* ---------------- сборка PDF ---------------- */

async function build() {
  if (state.busy || !state.items.length) return;
  await commitPending();
  const missing = missingTitleFields();
  if (missing.length) {
    haptic("error");
    toast(`Для титульного листа укажи ${missing.join(", ")}`, { ms: 4000 });
    openLayer("shTitle");
    return;
  }
  state.busy = true;
  $("#build").classList.add("busy");
  layoutDeck(true);
  try {
    ["opt", "title"].forEach((k) => clearTimeout(timers[k])); // настройки уходят вместе с запросом сборки
    const res = await api("POST", "/api/build", { ...state.options, title: state.title });
    haptic("success");
    state.items = []; // сервер очистил сессию
    showDone("pdf", { name: state.options.filename ? `${state.options.filename}.pdf` : "PDF-файл", meta: `${res.pages} ${plural(res.pages, "страница", "страницы", "страниц")} · ${humanSize(res.size)}` });
  } catch (err) {
    haptic("error");
    toast(err.message, { ms: 5000 });
  } finally {
    state.busy = false;
    $("#build").classList.remove("busy");
    layoutDeck(true);
  }
}

function showDone(kind, { name, meta }) {
  closeAllLayers();
  const heading = { pdf: "PDF уже в чате", docx: "Документ в чате", pdftext: "PDF с текстом в чате" }[kind];
  $("#doneTitle").replaceChildren("Готово.", el("br"), heading);
  $("#doneLead").textContent = kind === "pdf" ? "Новые фото пойдут в следующий файл." : "Страницы остались в редакторе: из них можно собрать и обычный PDF.";
  $("#doneIcon").textContent = kind === "docx" ? "DOC" : "PDF";
  $("#doneName").textContent = name;
  $("#doneMeta").textContent = meta;
  setScreen("sDone");
}

async function again() {
  try { apply(await api("GET", "/api/session")); } catch { /* останемся на экране «готово» */ }
  setScreen(state.items.length ? "sEdit" : "sStart");
  sync();
}

/* ---------------- распознавание текста ---------------- */

const ocr = { active: false, finished: false, seen: new Set() };
const rv = { i: 0, boxes: [], token: 0 };

async function onOcrButton() {
  if (!imageItems().length) { toast("Распознавать нечего: добавь фото"); return; }
  if (ocr.active) return;
  if (textItems().length === imageItems().length) return openReview(Math.max(textItems().findIndex((i) => i.id === state.curKey), 0));
  haptic("light");
  await commitPending();
  let job;
  try {
    job = await api("POST", "/api/ocr");
  } catch (err) {
    haptic("error");
    showMessage("Распознавание недоступно", err.message);
    return;
  }
  if (job.state === "done" && !job.total) return openReview(0);
  showOcrSheet(job);
}

function showMessage(title, text) {
  $("#dMsgTitle").textContent = title;
  $("#dMsgText").textContent = text;
  openLayer("dMsg");
}

function showOcrSheet(job) {
  ocr.active = true;
  ocr.finished = false;
  ocr.seen = new Set();
  const steps = $("#oSteps");
  steps.replaceChildren(...Array.from({ length: job.total }, (_, n) => Object.assign(el("span", "is-wait"), { textContent: n + 1 })));
  steps.hidden = job.total > 10; // для большого числа страниц хватает полоски
  $("#oBar").style.width = "0";
  $("#oLabel").textContent = "";
  $("#ocr").classList.add("busy");
  $("#ocr .ringo circle").style.strokeDashoffset = "160";
  openLayer("shOcr", {
    dismiss: false,
    onClose: () => { // закрыли шторку: если задача ещё идёт, это отмена
      ocr.active = false;
      $("#ocr").classList.remove("busy");
      if (!ocr.finished) { api("POST", "/api/ocr/cancel").catch(() => {}).then(reload); }
    },
  });
  pollOcr();
}

function setOcrLabel(text) {
  const label = $("#oLabel");
  if (label.textContent === text) return;
  if (reduced || !label.textContent) { label.textContent = text; return; }
  label.style.opacity = 0;
  setTimeout(() => { label.textContent = text; label.style.opacity = 1; }, 140);
}

const CHECK = '<svg class="i" style="width:16px;height:16px" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-check"/></svg>';

function paintOcr(j) {
  setOcrLabel(j.state === "queued" ? `Ты в очереди: ${j.position}-й` : `Страница ${Math.min(j.done + 1, j.total)} из ${j.total}`);
  const share = j.total ? (j.done + (j.state === "running" ? .5 : 0)) / j.total : 0;
  $("#oBar").style.width = `${share * 100}%`;
  $("#shOcr .pbar").setAttribute("aria-valuenow", String(Math.round(share * 100)));
  $("#ocr .ringo circle").style.strokeDashoffset = String(160 * (1 - (j.total ? j.done / j.total : 0)));
  $$("#oSteps span").forEach((step, k) => {
    if (k < j.done) {
      if (!step.classList.contains("is-done")) { step.className = "is-done"; step.innerHTML = CHECK; }
    } else {
      step.className = k === j.done && j.state === "running" ? "is-now" : "is-wait";
    }
  });
  let fresh = false;
  for (const id of j.finished) {
    if (ocr.seen.has(id)) continue;
    ocr.seen.add(id);
    const item = state.items.find((i) => i.id === id);
    if (item) { item._got = true; fresh = true; }
  }
  if (fresh) syncFilm();
}

async function pollOcr() {
  while (ocr.active) {
    let j;
    try { j = await api("GET", "/api/ocr"); } catch { await sleep(1500); continue; }
    if (!ocr.active) return;
    paintOcr(j);
    if (j.state === "queued" || j.state === "running") { await sleep(700); continue; }
    ocr.finished = true;
    try { apply(await api("GET", "/api/session")); } catch { /* список обновится при следующем действии */ }
    closeLayerById("shOcr");
    if (j.state === "error") { haptic("error"); toast(j.error, { ms: 5000 }); }
    else if (j.state === "done" && textItems().length) { haptic("success"); setTimeout(() => openReview(0), reduced ? 0 : 320); }
    return;
  }
}

// задача могла идти, пока мини-апп был закрыт
async function resumeOcr() {
  try {
    const j = await api("GET", "/api/ocr");
    if (j.state === "queued" || j.state === "running") showOcrSheet(j);
  } catch { /* не критично */ }
}

/* проверка и правка текста */

function fillText(box, paragraphs) {
  box.replaceChildren();
  let k = 0;
  for (const para of paragraphs.length ? paragraphs : [""]) {
    const p = el("p");
    para.split(new RegExp(`[${MARK_OPEN}${MARK_CLOSE}]`)).forEach((part, n) => { // нечётные куски — помеченные слова
      if (!part) return;
      if (n % 2) { const m = el("mark"); m.textContent = part; m.dataset.k = String(k++); p.append(m); }
      else p.append(part);
    });
    if (!p.childNodes.length) p.append(el("br"));
    box.append(p);
  }
  return k;
}

// текст страницы обратно в абзацы с пометками и рамки оставшихся помеченных слов
function readText(box) {
  const boxes = [];
  const walk = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return n.data;
    if (n.nodeName === "BR") return "";
    if (n.nodeName === "MARK") {
      const b = rv.boxes[Number(n.dataset.k)];
      if (b) boxes.push(b);
      return MARK_OPEN + n.textContent + MARK_CLOSE;
    }
    return walk(n);
  }).join("");
  const out = [];
  let inline = "";
  const flush = () => { if (inline.trim()) out.push(inline); inline = ""; };
  for (const n of box.childNodes) {
    if (n.nodeType === 1 && (n.nodeName === "P" || n.nodeName === "DIV")) { flush(); out.push(walk(n)); }
    else inline += walk({ childNodes: [n] });
  }
  flush();
  return { text: out.map((t) => t.replaceAll(" ", " ")).filter((t) => t.trim()), boxes };
}

function openReview(start = 0) {
  if (!textItems().length) return;
  rv.i = clamp(start, 0, textItems().length - 1);
  renderReview(0);
  setScreen("sReview");
  openScreenLayer("sReview", () => { flushText(); setScreen(state.items.length ? "sEdit" : "sStart"); sync(); });
}

const currentTextItem = () => textItems()[rv.i];

// страница с учётом поворота: рамки слов посчитаны по повёрнутому снимку, поэтому поворачиваем само изображение
const rotatedCache = new Map();
function rotatedSrc(src, deg) {
  const key = `${src}|${deg}`;
  if (!deg) return Promise.resolve(src);
  if (rotatedCache.has(key)) return Promise.resolve(rotatedCache.get(key));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = el("canvas"), swap = deg % 180 !== 0;
      c.width = swap ? img.naturalHeight : img.naturalWidth;
      c.height = swap ? img.naturalWidth : img.naturalHeight;
      const g = c.getContext("2d");
      g.translate(c.width / 2, c.height / 2);
      g.rotate((deg * Math.PI) / 180);
      g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      c.toBlob((blob) => {
        const url = blob ? URL.createObjectURL(blob) : src;
        rotatedCache.set(key, url);
        resolve(url);
      }, "image/jpeg", .88);
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

function renderReview(dir) {
  const items = textItems(), item = items[rv.i];
  if (!item) return;
  const box = $("#rvText");
  $("#rvCount").textContent = `Страница ${rv.i + 1} из ${items.length}`;
  const token = ++rv.token, img = $("#rvImg"), src = item.mid || item.thumb;
  $("#rvZoom").style.transform = "";
  rotatedSrc(src, item.rotation).then((url) => { if (token === rv.token && img.getAttribute("src") !== url) img.src = url; });
  const marks = fillText(box, item.text);
  rv.boxes = item.boxes && item.boxes.length === marks ? [...item.boxes] : []; // рамки нужны, только пока они совпадают с подсвеченными словами
  buildBoxes();
  updateLegend();
  $("#rvDots").replaceChildren(...Array.from({ length: Math.min(items.length, 5) }, (_, j) => Object.assign(el("i"), { className: j === Math.min(rv.i, 4) ? "on" : "" })));
  $("#rvPrev").disabled = rv.i === 0;
  $("#rvNext").disabled = rv.i === items.length - 1;
  if (dir && !reduced) box.animate([{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE });
  box.scrollTo({ top: 0 });
}

function buildBoxes() {
  $("#rvBoxes").replaceChildren(...rv.boxes.map(([x, y, w, h]) => {
    const b = el("span", "wbox");
    Object.assign(b.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
    return b;
  }));
}

// рамка слова, которое уже поправили, не нужна
function syncBoxes() {
  const alive = new Set($$("#rvText mark").map((m) => m.dataset.k));
  $$("#rvBoxes .wbox").forEach((b, k) => { b.hidden = !alive.has(String(k)); });
}

function updateLegend() {
  const legend = $("#rvLegend"), box = $("#rvText");
  const empty = !readText(box).text.length;
  legend.hidden = !empty && !box.querySelector("mark");
  if (empty) legend.textContent = "Текст на фото не нашёлся. Можно ввести его вручную или перейти к следующей странице.";
  else legend.replaceChildren(Object.assign(el("mark"), { textContent: "Подсвеченные" }), " слова распознаны неуверенно: нажми на слово, и фото приблизится к нему");
}

// нажатие на подсвеченное слово: фото плавно подъезжает к нему, рамка подпрыгивает
function focusMark(mark) {
  const k = Number(mark.dataset.k), on = !mark.classList.contains("act");
  $$("#rvText mark").forEach((m) => m.classList.remove("act"));
  $$("#rvBoxes .wbox").forEach((b) => b.classList.remove("act"));
  const zoom = $("#rvZoom");
  const b = rv.boxes[k], node = $("#rvBoxes").children[k];
  if (!on || !b || !node) { zoom.style.transform = ""; return; }
  mark.classList.add("act");
  void node.offsetWidth;
  node.classList.add("act");
  const pg = $("#rvPg"), W = pg.clientWidth, Hc = pg.clientHeight, Hi = zoom.offsetHeight;
  const s = clamp(.5 / Math.max(b[2], .01), 1.3, 2.2);
  const cx = (b[0] + b[2] / 2) * W, cy = (b[1] + b[3] / 2) * Hi;
  const tx = clamp(W / 2 - cx * s, W - W * s, 0);
  const ty = Hi * s <= Hc ? (Hc - Hi * s) / 2 : clamp(Hc / 2 - cy * s, Hc - Hi * s, 0);
  zoom.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}

function onTextInput() {
  const item = currentTextItem();
  if (!item) return;
  const anchor = getSelection().anchorNode;
  const mark = (anchor?.nodeType === 3 ? anchor.parentElement : anchor)?.closest?.("mark");
  if (mark && $("#rvText").contains(mark)) { mark.replaceWith(...mark.childNodes); $("#rvZoom").style.transform = ""; } // слово поправили, пометка не нужна
  const { text, boxes } = readText($("#rvText"));
  item.text = text;
  item.boxes = boxes;
  syncBoxes();
  updateLegend();
  debounced("text", flushText, 600);
}

// отправляет текст текущей страницы на сервер сразу
function flushText() {
  clearTimeout(timers.text);
  const item = currentTextItem();
  if (!item || state.screen !== "sReview") return Promise.resolve();
  return api("PUT", `/api/items/${item.id}/text`, { text: item.text, boxes: item.boxes || [] }).catch((err) => toast(err.message));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* пробуем запасной способ */ }
  const area = Object.assign(el("textarea"), { value: text });
  area.style.cssText = "position:fixed;opacity:0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Не получилось скопировать");
}

async function exportText(btn) {
  if (btn.classList.contains("busy")) return;
  const fmt = btn.dataset.fmt;
  haptic("light");
  btn.classList.add("busy");
  try {
    await flushText();
    const res = await api("POST", "/api/export", { format: fmt });
    if (fmt === "text") {
      await copyText(res.text);
      haptic("success");
      toast("Текст скопирован");
    } else {
      haptic("success");
      showDone(fmt === "docx" ? "docx" : "pdftext", {
        name: res.name,
        meta: `${res.pages} ${plural(res.pages, "страница", "страницы", "страниц")} · ${res.words} ${plural(res.words, "слово", "слова", "слов")}`,
      });
    }
  } catch (err) {
    haptic("error");
    toast(err.message, { ms: 5000 });
  } finally {
    btn.classList.remove("busy");
  }
}

/* ---------------- тема, заставка, диагностика ---------------- */

function animateTheme() {
  if (reduced) return;
  document.documentElement.classList.add("theme-anim");
  setTimeout(() => document.documentElement.classList.remove("theme-anim"), 400);
}

function applyTheme() {
  const forced = params.get("theme");
  const dark = forced ? forced === "dark" : inTelegram ? tg.colorScheme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (inTelegram) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    try { tg.setHeaderColor?.(bg); tg.setBackgroundColor?.(bg); tg.setBottomBarColor?.(bg); } catch { /* старая версия клиента */ }
  }
}

// заставка гаснет, логотип в шапке проявляется, интерфейс уже стоит на месте
function exitSplash() {
  const splash = $("#splash");
  document.documentElement.classList.remove("booting");
  if (!splash) return;
  if (reduced) return splash.remove();
  const opts = { duration: 270, easing: EASE };
  $$(".brand img").forEach((img) => img.animate([{ opacity: 0 }, { opacity: 1 }], opts));
  splash.querySelector(".splash-logo").animate([{ transform: "none" }, { transform: "scale(.92)" }], { ...opts, fill: "forwards" });
  splash.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, fill: "forwards" }).finished.then(() => splash.remove(), () => splash.remove());
}

// 7 нажатий по логотипу или счётчику за 3 секунды открывают диагностику: по ней видно, что реально происходит на устройстве
let brandTaps = [];
function diagReport() {
  const d = document.documentElement;
  const rect = (sel) => { const n = $(sel); if (!n) return "нет"; const b = n.getBoundingClientRect(); return `x ${Math.round(b.left)}…${Math.round(b.right)}, w ${Math.round(b.width)}, y ${Math.round(b.top)}…${Math.round(b.bottom)}`; };
  const probe = el("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const safe = `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`;
  probe.remove();
  const vv = window.visualViewport;
  return [
    navigator.userAgent,
    `экран: ${screen.width}×${screen.height}, dpr ${devicePixelRatio}`,
    `окно: ${innerWidth}×${innerHeight}, clientWidth ${d.clientWidth}, scrollWidth ${d.scrollWidth}`,
    `прокрутка: x ${scrollX}, y ${scrollY}, body ${document.body.scrollLeft}/${document.body.scrollTop}`,
    `visualViewport: ${vv ? `${Math.round(vv.width)}×${Math.round(vv.height)}, сдвиг ${vv.offsetLeft}/${vv.offsetTop}, масштаб ${vv.scale}` : "нет"}`,
    `безопасные поля (сверху справа снизу слева): ${safe}`,
    `Telegram: ${tg ? `${tg.platform} ${tg.version}, высота ${tg.viewportHeight}/${tg.viewportStableHeight}, развёрнут ${tg.isExpanded}, тема ${tg.colorScheme}` : "нет"}`,
    `экран: ${state.screen}, страниц ${state.items.length}`,
    `bar: ${rect(".screen.on .bar")}`, `deck: ${rect("#deck")}`, `film: ${rect("#film")}`, `dock: ${rect(".screen.on .dock")}`,
  ].join("\n");
}

function onBrandTap() {
  const now = Date.now();
  brandTaps = [...brandTaps.filter((t) => now - t < 3000), now];
  if (brandTaps.length < 7) return;
  brandTaps = [];
  $("#diagText").textContent = diagReport();
  openLayer("shDiag");
}

/* ---------------- привязки ---------------- */

function bind() {
  $$(".file-input").forEach((input) => (input.onchange = onFiles));
  $$(".brand, #count").forEach((b) => b.addEventListener("click", onBrandTap));

  $("#more").onclick = () => openLayer("shSettings");
  $("#tEdit").onclick = () => openLayer("shTitle");
  $("#clear").onclick = () => openLayer("dClear");
  $("#clearYes").onclick = async () => {
    closeLayerById("dClear");
    await commitPending();
    try { apply(await api("POST", "/api/clear")); } catch (err) { toast(err.message); }
  };
  $$("[data-close]").forEach((b) => (b.onclick = () => { const host = b.closest(".sheet, .dialog"); if (host) closeLayerById(host.id); }));
  $("#scrim").onclick = () => { const top = layers[layers.length - 1]; if (top && top.kind !== "screen" && top.dismiss) closeLayer(top); };
  addEventListener("keydown", (e) => { if (e.key === "Escape") popLayer(); });

  $$("#mode button").forEach((b) => (b.onclick = () => { haptic("light"); setOption("mode", b.dataset.m); }));
  $$(".mini-seg[data-opt]").forEach((g) => g.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { haptic("light"); setOption(g.dataset.opt, b.dataset.v); } }));
  $$("input[data-opt]").forEach((i) => i.addEventListener("input", () => setOption(i.dataset.opt, i.value)));
  $$("[data-title]").forEach((input) =>
    input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
      if (input.type === "checkbox") haptic("light");
      setTitle(input.dataset.title, input.type === "checkbox" ? input.checked : input.value);
    }));
  $$("#labelSeg button").forEach((b) => (b.onclick = () => { haptic("light"); setTitle("student_label", b.dataset.v); }));

  $("#rot").onclick = rotate;
  $("#del").onclick = removeCurrent;
  $("#build").onclick = build;
  $("#ocr").onclick = onOcrButton;
  $("#oCancel").onclick = () => closeLayerById("shOcr");
  $("#toastAct").onclick = () => { const act = toastAction; hideToast(); act?.(); };

  $("#rvClose").onclick = popLayer;
  $("#rvPrev").onclick = () => { if (rv.i > 0) { flushText(); rv.i--; renderReview(-1); } };
  $("#rvNext").onclick = () => { if (rv.i < textItems().length - 1) { flushText(); rv.i++; renderReview(1); } };
  $("#rvText").addEventListener("input", onTextInput);
  $("#rvText").addEventListener("click", (e) => { const m = e.target.closest("mark"); if (m) focusMark(m); });
  $("#rvText").addEventListener("paste", (e) => { // вставляем только текст, без чужой вёрстки
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData || window.clipboardData).getData("text/plain"));
  });
  $$(".acts button").forEach((b) => (b.onclick = () => exportText(b)));
  $("#diagCopy").onclick = () => copyText($("#diagText").textContent).then(() => toast("Скопировано"), () => toast("Не получилось скопировать"));

  $("#backToChat").onclick = () => (inTelegram ? tg.close() : again());
  $("#again").onclick = again;

  bindDeck();
  bindFilmSort();

  if (inTelegram) {
    tg.BackButton.onClick(popLayer);
    tg.onEvent("themeChanged", () => { animateTheme(); applyTheme(); });
    tg.onEvent("viewportChanged", () => { if (measureDeck()) layoutDeck(false); });
  } else {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { animateTheme(); applyTheme(); });
    // переключатель темы из рамки телефона
    addEventListener("message", (e) => {
      if (e.origin !== location.origin || !e.data?.theme) return;
      params.set("theme", e.data.theme);
      animateTheme();
      applyTheme();
    });
  }
}

/* ---------------- демо ---------------- */

function demoThumb(i) {
  const desk = ["#cfc6b5", "#b9c0c8", "#d6cdbd", "#c3c7bb"];
  const lines = Array.from({ length: 11 }, (_, k) =>
    `<path d="M24 ${58 + k * 20} q40 ${(k % 2) * 2 - 1} ${120 - (k * 17) % 50} 0" stroke="#3a3f4a" stroke-width="2.2" fill="none" opacity=".75"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320" viewBox="0 0 240 320">
    <rect width="240" height="320" fill="${desk[i % desk.length]}"/>
    <g transform="rotate(${(i % 3) - 1} 120 160)"><rect x="12" y="10" width="216" height="300" fill="#fbfaf5"/>
    ${Array.from({ length: 14 }, (_, k) => `<line x1="12" x2="228" y1="${40 + k * 20}" y2="${40 + k * 20}" stroke="#b9cbe0" stroke-width="1"/>`).join("")}
    ${lines}</g></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

const demoDb = {
  items: Array.from({ length: 6 }, (_, i) => ({ id: "d" + i, kind: "image", rotation: 0, pages: 1, name: "", thumb: demoThumb(i), mid: demoThumb(i), text: null, boxes: null }))
    .concat([{ id: "dp", kind: "pdf", rotation: 0, pages: 4, name: "Методичка по финансовому менеджменту.pdf" }]),
  options: { page: "a4", mode: "scan", quality: "medium", filename: "" },
  title: {
    enabled: true, work_type: "Реферат", discipline: "Микроэкономика",
    topic: "Ценовая дискриминация на рынках цифровых платформ", faculty: "",
    student: "Иванова Мария Сергеевна", student_label: "Выполнила", group: "ЭБ24-3",
    teacher: "Петров П. П.", teacher_position: "к.э.н., доцент", city: "Москва",
  },
  work_types: ["Реферат", "Доклад", "Эссе", "Контрольная работа", "Домашнее задание", "Курсовая работа", "Лабораторная работа", "Отчёт по практике"],
};

const M = (w) => MARK_OPEN + w + MARK_CLOSE;
const DEMO_TEXT = [
  [`Валовой внутренний продукт (ВВП) измеряет рыночную стоимость всех ${M("конечных")} товаров и услуг, произведённых в стране за год.`,
   `Центральный банк управляет ${M("ключевой")} ставкой: её повышение сдерживает инфляцию, но замедляет рост экономики.`],
  ["Различают номинальный и реальный ВВП. Реальный ВВП пересчитан в неизменных ценах, поэтому показывает рост " + M("выпуска") + ", а не цен.",
   "Дефлятор ВВП отражает изменение общего уровня цен в экономике."],
  ["Безработица бывает фрикционной, структурной и циклической. Естественный уровень безработицы включает первые две формы.",
   `Закон Оукена связывает отставание ВВП от потенциального уровня с ${M("циклической")} безработицей.`],
];
const DEMO_BOXES = [[[.17, .27, .22, .04], [.46, .49, .27, .04]], [[.55, .27, .2, .04]], [[.3, .49, .3, .04]]];
let demoJob = null;

// «сервер» распознавания: сначала очередь, потом по странице за 650 мс
function demoJobView() {
  const j = demoJob, t = Date.now() - j.start;
  const done = j.frozen ?? Math.max(0, Math.min(j.total, Math.floor((t - 1200) / 650)));
  j.todo.slice(0, done).forEach((id, n) => {
    const item = demoDb.items.find((i) => i.id === id);
    if (item && item.text == null) { item.text = DEMO_TEXT[n % 3]; item.boxes = DEMO_BOXES[n % 3]; }
  });
  const st = j.cancel ? "cancelled" : done >= j.total ? "done" : t < 1200 ? "queued" : "running";
  return { state: st, total: j.total, done, position: st === "queued" ? 2 : 0, finished: j.todo.slice(0, done), error: "" };
}

async function demoApi(method, path, body) {
  await sleep(120);
  const db = demoDb;
  const id = path.split("/")[3];
  if (path === "/api/ocr") {
    if (method === "GET") return demoJob ? demoJobView() : { state: "idle" };
    const todo = db.items.filter((i) => i.kind === "image" && i.text == null).map((i) => i.id);
    demoJob = { todo, total: todo.length, start: Date.now(), cancel: false };
    return todo.length ? demoJobView() : { state: "done", total: 0, done: 0, position: 0, finished: [], error: "" };
  }
  if (path === "/api/ocr/cancel") {
    if (demoJob) { demoJob.frozen = demoJobView().done; demoJob.cancel = true; }
    return { ok: true };
  }
  if (path.endsWith("/text") && method === "PUT") {
    const item = db.items.find((i) => i.id === id);
    item.text = body.text;
    item.boxes = body.boxes;
    return { ok: true };
  }
  if (path === "/api/export") {
    const items = db.items.filter((i) => i.kind === "image" && i.text);
    const paragraphs = items.flatMap((i) => i.text.map(plainText));
    const words = paragraphs.reduce((n, t) => n + t.split(/\s+/).filter(Boolean).length, 0);
    if (body.format === "text") return { ok: true, pages: items.length, words, text: paragraphs.join("\n\n") };
    await sleep(900);
    return { ok: true, pages: items.length, words, name: `${db.options.filename || "Конспект"}.${body.format}`, size: 36000 };
  }
  if (path === "/api/build") {
    await sleep(1600);
    const pages = db.items.reduce((n, i) => n + i.pages, 0) + (body.title.enabled ? 1 : 0);
    db.items = [];
    db.title = { ...body.title, enabled: false, topic: "" };
    return { ok: true, pages, size: 3_420_000 };
  }
  if (path === "/api/upload") {
    for (const f of body.getAll("file")) {
      const pdf = f.name.toLowerCase().endsWith(".pdf");
      const url = pdf ? null : URL.createObjectURL(f);
      db.items.push({ id: "u" + Math.random().toString(16).slice(2), kind: pdf ? "pdf" : "image", rotation: 0, pages: 1, name: f.name, thumb: url, mid: url, text: null, boxes: null });
    }
  }
  if (path === "/api/order") db.items = body.ids.map((x) => db.items.find((i) => i.id === x));
  if (path.endsWith("/rotate")) db.items.find((i) => i.id === id).rotation = body.rotation;
  if (method === "DELETE") db.items = db.items.filter((i) => i.id !== id);
  if (path === "/api/clear") db.items = [];
  if (path === "/api/options") db.options = { ...body };
  if (path === "/api/title") db.title = { ...body };
  return structuredClone(db);
}

/* ---------------- запуск ---------------- */

function mountPhoneFrame() {
  let theme = params.get("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.classList.add("framed");
  document.body.innerHTML = `
    <div class="frame-stage">
      <div class="frame-phone"><iframe title="FinConverter, мини-апп" src="/?demo&inner&theme=${theme}"></iframe></div>
      <div class="frame-bar">
        <span>Демо мини-аппа · 390 × 844</span>
        <button type="button" id="themeToggle"></button>
      </div>
    </div>`;
  const paint = () => {
    document.documentElement.dataset.theme = theme;
    $("#themeToggle").textContent = theme === "dark" ? "Светлая тема" : "Тёмная тема";
  };
  $("#themeToggle").onclick = () => {
    theme = theme === "dark" ? "light" : "dark";
    animateTheme();
    paint();
    $(".frame-phone iframe").contentWindow.postMessage({ theme }, location.origin);
  };
  // ноутбуки пониже: ужимаем телефон, чтобы влез целиком
  const fit = () => {
    const scale = Math.min(1, (innerHeight - 110) / 868);
    $(".frame-phone").style.transform = `scale(${scale})`;
    $(".frame-phone").style.marginBottom = `${868 * (scale - 1)}px`;
  };
  addEventListener("resize", fit);
  fit();
  paint();
}

async function init() {
  if (inTelegram) {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.(); // иначе перетаскивание страниц сворачивает мини-апп
  }
  applyTheme();
  bind();
  // данные грузятся, пока показана заставка; интерфейс появляется, когда пришли данные и подгрузился шрифт (иначе текст «прыгал» бы при замене)
  const load = api("GET", "/api/session").then((data) => ({ data }), (error) => ({ error }));
  const fonts = Promise.race([document.fonts?.ready ?? Promise.resolve(), sleep(1200)]);
  const [res] = await Promise.all([load, sleep(reduced ? 0 : SPLASH_MIN), fonts]);
  const closed = res.error?.status === 403; // бот закрыт для всех, кроме админов
  if (closed) setScreen("sClosed");
  else if (res.error) sync();
  else apply(res.data);
  exitSplash();
  if (res.error && !closed) toast(res.error.message, { ms: 6000 });
  if (!closed && !res.error) resumeOcr();
}

if (framed) mountPhoneFrame();
else init();
