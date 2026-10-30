const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);
// ?demo — открыть интерфейс в обычном браузере на фейковых данных, без сервера
const params = new URLSearchParams(location.search);
const demo = !inTelegram && params.has("demo");
// на широком экране демо показываем в рамке телефона: внутри iframe та же страница
const framed = demo && !params.has("inner") && innerWidth > 600;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2, .8, .2, 1)";
const SPLASH_MIN = 450; // мс: за это время заставка успевает проявиться, и она не мелькает на быстрой сети

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = { items: [], options: {}, title: {}, workTypes: [], viewing: -1, busy: false };

const HINTS = {
  gray: "Ч/Б — оттенки серого, файл меньше.",
  scan: "Скан убирает тени, фон становится белым.",
  low: "Сжатое — для порталов с лимитом на размер файла.",
};

/* ---------------- API ---------------- */

async function api(method, path, body) {
  if (demo) return demoApi(method, path, body);
  const headers = { "X-Init-Data": tg?.initData || "" };
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Что-то пошло не так"), { status: res.status });
  return data;
}

function apply(data) {
  state.items = data.items;
  state.options = data.options;
  state.title = data.title;
  state.workTypes = data.work_types;
  (data.errors || []).forEach((e) => toast(e));
  render();
}

/* ---------------- render ---------------- */

// титульный лист — виртуальная первая страница, в сессии его нет
function slots() {
  const list = state.items.map((item) => ({ kind: item.kind, item }));
  return state.title.enabled ? [{ kind: "title" }, ...list] : list;
}

function pageCount() {
  return state.items.reduce((n, i) => n + i.pages, 0) + (state.title.enabled ? 1 : 0);
}

function render() {
  const has = state.items.length > 0;
  $("#empty").hidden = has;
  $("#content").hidden = !has;
  $("#moreBtn").hidden = !has;
  const n = pageCount();
  $("#subtitle").textContent = `${n} ${plural(n, "страница", "страницы", "страниц")}${state.title.enabled ? ", включая титульный" : ""}`;
  $("#buildBtn").textContent = state.busy ? "Собираю…" : `Собрать PDF · ${n} стр.`;
  $("#buildBtn").disabled = state.busy;
  $("#buildBtn").classList.toggle("loading", state.busy);
  renderGrid();
  renderForm();
  renderOcr();
}

const seen = new Set(); // страницы, которые уже показывали, — им не нужна анимация появления

function renderGrid() {
  const grid = $("#grid");
  // FLIP: запоминаем, где были плитки, чтобы после перестройки плавно довезти их на новые места
  const before = new Map([...grid.children].map((n) => [n.dataset.key, n.getBoundingClientRect()]));
  grid.replaceChildren();
  let num = 1;
  slots().forEach((slot, idx) => {
    const pages = slot.item?.pages ?? 1;
    const page = el("div", "page");
    page.dataset.key = slot.kind === "title" ? "title" : slot.item.id;
    if (slot.kind === "image" && (slot.item.text != null || slot.item._got)) page.classList.add("got");
    const open = el("button", "page-open");
    open.type = "button";
    open.onclick = () => openViewer(idx);
    if (slot.kind === "title") {
      open.append(titleSheet(state.title));
      open.setAttribute("aria-label", "Титульный лист");
    } else {
      page.dataset.id = slot.item.id;
      page.dataset.rot = slot.item.rotation;
      open.setAttribute("aria-label", `Страница ${num}`);
      if (slot.kind === "image") {
        const img = el("img");
        img.src = slot.item.thumb;
        img.alt = "";
        img.loading = "lazy";
        img.style.transform = rotation(slot.item);
        open.append(img);
      } else {
        open.append(pdfTile(slot.item));
      }
    }
    const label = el("span", "page-num");
    label.textContent = slot.kind === "title" ? "Титульный" : pages > 1 ? `${num}–${num + pages - 1}` : String(num);
    num += pages;
    page.append(open, label);
    grid.append(page);
  });

  const keys = [...grid.children].map((n) => n.dataset.key);
  if (!reduced) {
    let fresh = 0;
    for (const node of grid.children) {
      const was = before.get(node.dataset.key);
      if (was) {
        const now = node.getBoundingClientRect();
        const dx = was.left - now.left, dy = was.top - now.top;
        if (dx || dy) node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 340, easing: EASE });
      } else if (!seen.has(node.dataset.key)) {
        node.animate(
          [{ opacity: 0, transform: "translateY(16px) scale(.96)" }, { opacity: 1, transform: "none" }],
          { duration: 420, easing: EASE, delay: Math.min(fresh++, 8) * 45, fill: "backwards" },
        );
      }
    }
  }
  seen.clear();
  keys.forEach((k) => seen.add(k));
}

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

function renderForm() {
  const o = state.options, t = state.title;

  $$(".chip select").forEach((select) => {
    select.value = o[select.dataset.opt];
    select.parentElement.querySelector("span").textContent = select.selectedOptions[0]?.textContent || "";
  });
  $("#nameChip span").textContent = o.filename ? `«${o.filename}»` : "Имя файла";
  $("#optHint").textContent = [HINTS[o.mode], HINTS[o.quality]].filter(Boolean).join(" ");

  $$("[data-opt]:not(select), [data-title]").forEach((input) => {
    const src = input.dataset.opt ? o : t;
    const v = src[input.dataset.opt || input.dataset.title];
    if (input.type === "checkbox") input.checked = Boolean(v);
    else if (document.activeElement !== input) input.value = v ?? "";
  });

  // титульник: карточка на главном экране
  $("#titleMini").replaceChildren(titleSheet(t));
  const filled = t.student || t.discipline;
  $("#titleLine1").textContent = filled ? [t.work_type, t.discipline].filter(Boolean).join(" · ") : "Шаблон Финансового университета";
  $("#titleLine2").textContent = filled ? [shortName(t.student), t.group].filter(Boolean).join(", ") : "Нажми, чтобы заполнить";

  // титульник: шторка
  const types = $("#workTypes");
  types.replaceChildren(...state.workTypes.map((w) => {
    const b = el("button", "chip");
    b.type = "button";
    b.textContent = w;
    b.setAttribute("aria-pressed", String(w === t.work_type));
    b.onclick = () => { haptic("light"); setTitle("work_type", w); };
    return b;
  }));
  $$("#labelSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === (t.student_label || "Выполнил"))));
}

/* ---------------- actions ---------------- */

async function onFiles(e) {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append("file", f, f.name));
  toast(`Загружаю ${files.length} ${plural(files.length, "файл", "файла", "файлов")}…`, 60000);
  try {
    const data = await api("POST", "/api/upload", fd);
    hideToast();
    apply(data); // ошибки по отдельным файлам показываются уже после того, как погасло «Загружаю…»
  } catch (err) {
    toast(err.message);
  }
}

// накопленный угол: чтобы после 270° страница докручивалась вперёд до 360°, а не отматывала назад
const spin = {};

async function rotate(item) {
  haptic("light");
  spin[item.id] = (spin[item.id] ?? item.rotation) + 90;
  item.rotation = (item.rotation + 90) % 360;
  // крутим уже нарисованные картинки — CSS-переход сделает это плавно
  const tile = $(`#grid .page[data-key="${item.id}"]`);
  if (tile) {
    tile.dataset.rot = item.rotation;
    tile.querySelector("img").style.transform = rotation(item);
  }
  const big = $("#vStage img");
  if (big && state.viewing >= 0) big.style.transform = rotation(item);
  try {
    const data = await api("POST", `/api/items/${item.id}/rotate`, { rotation: item.rotation });
    state.items = data.items.map((i) => (i.id === item.id ? item : i));
  } catch (err) {
    toast(err.message);
    apply(await api("GET", "/api/session").catch(() => ({ items: state.items, options: state.options, title: state.title, work_types: state.workTypes })));
  }
}

async function remove(item) {
  haptic("medium");
  // убираем страницу сразу, не дожидаясь сервера; если он не ответил, возвращаем реальный список
  state.items = state.items.filter((i) => i.id !== item.id);
  render();
  try {
    apply(await api("DELETE", `/api/items/${item.id}`));
  } catch (err) {
    toast(err.message);
    apply(await api("GET", "/api/session"));
  }
}

const timers = {};
function debounced(key, fn, ms = 500) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

function setOption(key, value) {
  state.options[key] = value;
  renderForm();
  debounced("opt", () => api("POST", "/api/options", state.options).catch((e) => toast(e.message)));
}

function setTitle(key, value) {
  state.title[key] = value;
  if (key === "enabled") render();
  else { renderForm(); refreshTitleTile(); }
  debounced("title", () => api("POST", "/api/title", state.title).catch((e) => toast(e.message)));
}

function refreshTitleTile() {
  const tile = $("#grid .page:first-child .page-open .a4");
  if (tile) tile.replaceWith(titleSheet(state.title));
}

function missingTitleFields() {
  const t = state.title;
  if (!t.enabled) return [];
  return [["work_type", "тип работы"], ["student", "ФИО"], ["group", "группу"]].filter(([k]) => !t[k]).map(([, l]) => l);
}

async function build() {
  if (state.busy || !state.items.length) return;
  const missing = missingTitleFields();
  if (missing.length) {
    haptic("error");
    toast(`Для титульного листа укажи ${missing.join(", ")}`);
    openSheet("titleSheet");
    return;
  }
  state.busy = true;
  render();
  try {
    Object.values(timers).forEach(clearTimeout);
    const res = await api("POST", "/api/build", { ...state.options, title: state.title });
    haptic("success");
    showDone(res);
  } catch (err) {
    haptic("error");
    toast(err.message);
  } finally {
    state.busy = false;
    if (!$("#editor").hidden) render();
  }
}

function showDone(res) {
  $("#editor").hidden = true;
  $("#moreBtn").hidden = true;
  $("#done").hidden = false;
  $("#doneTitle").replaceChildren("Готово.", el("br"), "PDF уже в чате");
  $("#doneLead").textContent = "Новые фото пойдут в следующий файл.";
  $("#doneIcon").textContent = "PDF";
  $("#doneName").textContent = state.options.filename ? `${state.options.filename}.pdf` : "PDF-файл";
  $("#doneMeta").textContent = `${res.pages} ${plural(res.pages, "страница", "страницы", "страниц")} · ${humanSize(res.size)}`;
  state.items = [];
}

async function again() {
  $("#done").hidden = true;
  $("#editor").hidden = false;
  apply(await api("GET", "/api/session"));
}

/* ---------------- шторки и просмотр ---------------- */

// стек открытых слоёв — системная кнопка «Назад» закрывает верхний
const layers = [];

function pushLayer(close) {
  layers.push(close);
  if (inTelegram) tg.BackButton.show();
}

function popLayer() {
  const close = layers.pop();
  if (close) close();
  if (inTelegram && !layers.length) tg.BackButton.hide();
}

// прячем после анимации ухода (класс .leaving в CSS). Таймер хранится на узле: если слой успели
// открыть снова, show() его отменяет, иначе старый таймер спрятал бы уже открытый слой
function leave(node, ms = 220) {
  clearTimeout(node._leave);
  node.classList.add("leaving");
  node._leave = setTimeout(() => { node.hidden = true; node.classList.remove("leaving"); }, reduced ? 0 : ms);
}

function show(node) {
  clearTimeout(node._leave);
  node.classList.remove("leaving");
  node.hidden = false;
}

function openSheet(id) {
  const sheet = $("#" + id);
  if (!sheet.hidden && !sheet.classList.contains("leaving")) return;
  show(sheet);
  pushLayer(() => leave(sheet));
}

function openViewer(idx) {
  state.viewing = idx;
  show($("#viewer"));
  pushLayer(() => { state.viewing = -1; leave($("#viewer"), 200); });
  renderViewer();
}

function renderViewer(dir = 0) {
  const list = slots();
  const slot = list[state.viewing];
  if (!slot) return popLayer();
  $("#vTitle").textContent = slot.kind === "title" ? "Титульный лист" : `${state.viewing + 1} / ${list.length}`;
  const stage = $("#vStage");
  if (slot.kind === "title") stage.replaceChildren(titleSheet(state.title));
  else if (slot.kind === "pdf") stage.replaceChildren(pdfTile(slot.item));
  else {
    const img = el("img");
    img.src = slot.item.thumb;
    img.alt = "";
    img.style.transform = rotation(slot.item);
    stage.replaceChildren(img);
  }
  if (dir && !reduced) {
    // анимируем сцену, а не саму картинку: у картинки свой transform — поворот
    stage.animate(
      [{ opacity: 0, transform: `translateX(${dir * 48}px) scale(.97)` }, { opacity: 1, transform: "none" }],
      { duration: 300, easing: EASE },
    );
  }
  $("#vRotate").hidden = slot.kind === "title";
  $("#vDelete").setAttribute("aria-label", slot.kind === "title" ? "Убрать титульный лист" : "Удалить");
  $("#vPrev").disabled = state.viewing === 0;
  $("#vNext").disabled = state.viewing === list.length - 1;
}

async function viewerDelete() {
  const slot = slots()[state.viewing];
  if (slot.kind === "title") setTitle("enabled", false);
  else await remove(slot.item);
  state.viewing = Math.min(state.viewing, slots().length - 1);
  state.items.length ? renderViewer() : popLayer();
}

/* ---------------- распознавание текста ---------------- */

const MARK_OPEN = "", MARK_CLOSE = ""; // границы слов, в которых распознавание сомневается
const ocr = { active: false, finished: false, seen: new Set() };
const rv = { i: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const imageItems = () => state.items.filter((i) => i.kind === "image");
const textItems = () => imageItems().filter((i) => i.text != null);
const plainText = (t) => t.replaceAll(MARK_OPEN, "").replaceAll(MARK_CLOSE, "");

function renderOcr() {
  const imgs = imageItems(), got = textItems().length, all = got === imgs.length;
  $("#ocrCard").hidden = !imgs.length;
  $("#ocrTitle").textContent = !got ? "Распознать текст"
    : all ? `Текст готов: ${got} ${plural(got, "страница", "страницы", "страниц")}` : `Распознано ${got} из ${imgs.length}`;
  $("#ocrSub").textContent = !got ? "Печатный текст станет страницами, их можно проверить и поправить"
    : all ? "Проверь, поправь и получи документ" : "Остальные страницы можно распознать сейчас";
  $("#ocrBtn").textContent = all ? "Проверить" : "Распознать";
}

async function startOcr() {
  if (ocr.active) return;
  haptic("light");
  let job;
  try {
    job = await api("POST", "/api/ocr");
  } catch (err) {
    haptic("error");
    toast(err.message, 5000);
    return;
  }
  if (job.state === "done" && !job.total) return openReview(0); // всё уже распознано
  showOcrSheet(job);
}

function showOcrSheet(job) {
  ocr.active = true;
  ocr.finished = false;
  ocr.seen = new Set();
  const steps = $("#ocrSteps");
  steps.replaceChildren(...Array.from({ length: job.total }, (_, n) => Object.assign(el("span", "is-wait"), { textContent: n + 1 })));
  steps.hidden = job.total > 10; // для большого числа страниц хватает полоски
  $("#ocrBar").style.width = "0";
  $("#ocrLabel").textContent = "";
  show($("#ocrSheet"));
  pushLayer(() => { // закрыли шторку: если задача ещё идёт, это отмена
    ocr.active = false;
    if (!ocr.finished) api("POST", "/api/ocr/cancel").catch(() => {});
    leave($("#ocrSheet"));
    if (!ocr.finished) api("GET", "/api/session").then(apply).catch(() => {});
  });
  pollOcr();
}

function setOcrLabel(text) {
  const label = $("#ocrLabel");
  if (label.textContent === text) return;
  if (reduced || !label.textContent) { label.textContent = text; return; }
  label.style.opacity = 0;
  setTimeout(() => { label.textContent = text; label.style.opacity = 1; }, 140);
}

const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function paintOcr(j) {
  setOcrLabel(j.state === "queued" ? `Ты в очереди: ${j.position}-й` : `Страница ${Math.min(j.done + 1, j.total)} из ${j.total}`);
  $("#ocrBar").style.width = `${j.total ? ((j.done + (j.state === "running" ? .5 : 0)) / j.total) * 100 : 0}%`;
  $$("#ocrSteps span").forEach((step, k) => {
    if (k < j.done) {
      if (!step.classList.contains("is-done")) { step.className = "is-done"; step.innerHTML = CHECK; }
    } else {
      step.className = k === j.done && j.state === "running" ? "is-now" : "is-wait";
    }
  });
  for (const id of j.finished) {
    if (ocr.seen.has(id)) continue;
    ocr.seen.add(id);
    const item = state.items.find((i) => i.id === id);
    if (item) item._got = true;
    $(`#grid .page[data-key="${id}"]`)?.classList.add("got", "got-new"); // значок «Aa» на готовой странице
  }
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
    popLayer(); // закрывает шторку
    if (j.state === "error") { haptic("error"); toast(j.error, 5000); }
    else if (j.state === "done" && textItems().length) { haptic("success"); setTimeout(() => openReview(0), reduced ? 0 : 260); }
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
  for (const para of paragraphs.length ? paragraphs : [""]) {
    const p = el("p");
    para.split(new RegExp(`[${MARK_OPEN}${MARK_CLOSE}]`)).forEach((part, k) => { // нечётные куски — помеченные слова
      if (!part) return;
      if (k % 2) p.append(Object.assign(el("u"), { textContent: part }));
      else p.append(part);
    });
    if (!p.childNodes.length) p.append(el("br"));
    box.append(p);
  }
}

function readText(box) {
  const walk = (node) => [...node.childNodes].map((n) => (n.nodeType === 3 ? n.data : n.nodeName === "BR" ? "" : n.nodeName === "U"
    ? MARK_OPEN + n.textContent + MARK_CLOSE : walk(n))).join("");
  const out = [];
  let inline = "";
  const flush = () => { if (inline.trim()) out.push(inline); inline = ""; };
  for (const n of box.childNodes) {
    if (n.nodeType === 1 && (n.nodeName === "P" || n.nodeName === "DIV")) { flush(); out.push(walk(n)); }
    else inline += n.nodeType === 3 ? n.data : walk({ childNodes: [n] });
  }
  flush();
  return out.map((t) => t.replaceAll(" ", " ")).filter((t) => t.trim());
}

function openReview(start = 0) {
  if (!textItems().length) return;
  rv.i = Math.min(start, textItems().length - 1);
  const node = $("#review");
  show(node);
  node.classList.add("fresh");
  pushLayer(() => { flushText(); leave(node); });
  renderReview(0);
}

function renderReview(dir) {
  const items = textItems(), item = items[rv.i];
  if (!item) return popLayer();
  const box = $("#rvText");
  $("#rvCount").textContent = `Страница ${rv.i + 1} из ${items.length}`;
  $("#rvImg").src = item.thumb;
  $("#rvImg").style.transform = rotation(item);
  fillText(box, item.text);
  updateLegend();
  $("#rvNext").textContent = rv.i === items.length - 1 ? "Готово" : `Дальше · стр. ${rv.i + 2}`;
  $("#rvPrev").style.opacity = rv.i === 0 ? .35 : 1;
  $("#rvPrev").disabled = rv.i === 0;
  if (dir && !reduced) box.animate([{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: "none" }], { duration: 280, easing: EASE });
  $("#review .review-body").scrollTo({ top: 0 });
}

function updateLegend() {
  const legend = $("#rvLegend"), box = $("#rvText");
  const empty = !readText(box).length;
  legend.hidden = !empty && !box.querySelector("u");
  if (empty) legend.textContent = "Текст на фото не нашёлся. Можно ввести его вручную или пропустить страницу.";
  else legend.replaceChildren(Object.assign(el("u"), { textContent: "Подчёркнутые" }), " слова распознаны неуверенно, проверь их по фото");
}

function currentTextItem() { return textItems()[rv.i]; }

function onTextInput() {
  const item = currentTextItem();
  if (!item) return;
  const anchor = getSelection().anchorNode;
  const mark = (anchor?.nodeType === 3 ? anchor.parentElement : anchor)?.closest?.("u");
  if (mark && $("#rvText").contains(mark)) mark.replaceWith(...mark.childNodes); // слово поправили, пометка не нужна
  item.text = readText($("#rvText"));
  updateLegend();
  debounced("text", flushText, 600);
}

// отправляет текст текущей страницы на сервер сразу
function flushText() {
  clearTimeout(timers.text);
  const item = currentTextItem();
  if (!item || $("#review").hidden) return Promise.resolve();
  return api("PUT", `/api/items/${item.id}/text`, { text: item.text }).catch((err) => toast(err.message));
}

/* результат: Word, PDF или копирование */

function openResult() {
  const items = textItems();
  const words = items.reduce((n, i) => n + i.text.reduce((m, t) => m + plainText(t).trim().split(/\s+/).filter(Boolean).length, 0), 0);
  $("#resStat").textContent = `${items.length} ${plural(items.length, "страница", "страницы", "страниц")}, ${words} ${plural(words, "слово", "слова", "слов")}.`;
  const node = $("#result");
  show(node);
  pushLayer(() => leave(node));
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
  if (btn.disabled) return;
  const fmt = btn.dataset.fmt;
  haptic("light");
  btn.disabled = true;
  btn.classList.add("loading");
  try {
    await flushText();
    const res = await api("POST", "/api/export", { format: fmt });
    if (fmt === "text") {
      await copyText(res.text);
      haptic("success");
      toast("Текст скопирован");
    } else {
      haptic("success");
      while (layers.length) popLayer();
      showDoneDoc(fmt, res);
    }
  } catch (err) {
    haptic("error");
    toast(err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

function showDoneDoc(fmt, res) {
  $("#editor").hidden = true;
  $("#moreBtn").hidden = true;
  $("#done").hidden = false;
  $("#doneTitle").replaceChildren("Готово.", el("br"), fmt === "docx" ? "Документ в чате" : "PDF с текстом в чате");
  $("#doneLead").textContent = "Страницы остались в редакторе: из них можно собрать и обычный PDF.";
  $("#doneIcon").textContent = fmt === "docx" ? "DOC" : "PDF";
  $("#doneName").textContent = res.name;
  $("#doneMeta").textContent = `${res.pages} ${plural(res.pages, "страница", "страницы", "страниц")} · ${res.words} ${plural(res.words, "слово", "слова", "слов")}`;
}

/* ---------------- helpers ---------------- */

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

// «Иванова Мария Сергеевна» → «Иванова М. С.»
function shortName(full = "") {
  const [last, ...rest] = full.trim().split(/\s+/);
  return [last, ...rest.map((p) => p[0] + ".")].filter(Boolean).join(" ");
}

// повёрнутая на 90° портретная страница не влезает в портретную рамку — ужимаем
function rotation(item) {
  return `rotate(${spin[item.id] ?? item.rotation}deg)${item.rotation % 180 ? " scale(.75)" : ""}`;
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

let toastTimer;
function toast(text, ms = 3000) {
  const t = $("#toast");
  t.textContent = text;
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  const t = $("#toast");
  if (!t.hidden) leave(t, 200);
}

function haptic(kind) {
  const h = tg?.HapticFeedback;
  if (!h) return;
  ["success", "error", "warning"].includes(kind) ? h.notificationOccurred(kind) : h.impactOccurred(kind);
}

/* ---------------- demo ---------------- */

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
  items: Array.from({ length: 6 }, (_, i) => ({ id: "d" + i, kind: "image", rotation: 0, pages: 1, name: "", thumb: demoThumb(i) }))
    .concat([{ id: "dp", kind: "pdf", rotation: 0, pages: 4, name: "Методичка по финансовому менеджменту.pdf" }]),
  options: { page: "original", mode: "scan", quality: "medium", filename: "" },
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
let demoJob = null;

// «сервер» распознавания: сначала очередь, потом по странице за 650 мс
function demoJobView() {
  const j = demoJob, t = Date.now() - j.start;
  const done = j.frozen ?? Math.max(0, Math.min(j.total, Math.floor((t - 1200) / 650)));
  j.todo.slice(0, done).forEach((id, n) => {
    const item = demoDb.items.find((i) => i.id === id);
    if (item && item.text == null) item.text = DEMO_TEXT[n % DEMO_TEXT.length];
  });
  const state = j.cancel ? "cancelled" : done >= j.total ? "done" : t < 1200 ? "queued" : "running";
  return { state, total: j.total, done, position: state === "queued" ? 2 : 0, finished: j.todo.slice(0, done), error: "" };
}

async function demoApi(method, path, body) {
  await new Promise((r) => setTimeout(r, 120));
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
    db.items.find((i) => i.id === id).text = body.text;
    return { ok: true };
  }
  if (path === "/api/export") {
    const items = db.items.filter((i) => i.kind === "image" && i.text);
    const paragraphs = items.flatMap((i) => i.text.map(plainText));
    const words = paragraphs.reduce((n, t) => n + t.split(/\s+/).filter(Boolean).length, 0);
    if (body.format === "text") return { ok: true, pages: items.length, words, text: paragraphs.join("\n\n") };
    await new Promise((r) => setTimeout(r, 900));
    return { ok: true, pages: items.length, words, name: `${db.options.filename || "Конспект"}.${body.format}`, size: 36000 };
  }
  if (path === "/api/build") {
    await new Promise((r) => setTimeout(r, 900));
    const pages = db.items.reduce((n, i) => n + i.pages, 0) + (body.title.enabled ? 1 : 0);
    db.items = [];
    db.title = { ...body.title, enabled: false, topic: "" };
    return { ok: true, pages, size: 3_420_000 };
  }
  if (path === "/api/upload") {
    for (const f of body.getAll("file")) {
      const pdf = f.name.toLowerCase().endsWith(".pdf");
      db.items.push({ id: "u" + Math.random().toString(16).slice(2), kind: pdf ? "pdf" : "image", rotation: 0,
        pages: 1, name: f.name, thumb: pdf ? null : URL.createObjectURL(f) });
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

/* ---------------- init ---------------- */

function mountPhoneFrame() {
  let theme = params.get("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.classList.add("framed");
  document.body.innerHTML = `
    <div class="stage">
      <div class="phone"><iframe title="FinConverter — мини-апп" src="/?demo&inner&theme=${theme}"></iframe></div>
      <div class="stage-bar">
        <span>Демо мини-аппа · 390 × 844</span>
        <button type="button" class="pill small" id="themeToggle"></button>
      </div>
    </div>`;
  const sync = () => {
    document.documentElement.dataset.theme = theme;
    $("#themeToggle").textContent = theme === "dark" ? "Светлая тема" : "Тёмная тема";
  };
  $("#themeToggle").onclick = () => {
    theme = theme === "dark" ? "light" : "dark";
    animateTheme();
    sync();
    $(".phone iframe").contentWindow.postMessage({ theme }, location.origin);
  };
  // ноутбуки пониже: ужимаем телефон, чтобы влез целиком
  const fit = () => {
    const scale = Math.min(1, (innerHeight - 110) / 868);
    $(".phone").style.transform = `scale(${scale})`;
    $(".phone").style.marginBottom = `${868 * (scale - 1)}px`;
  };
  addEventListener("resize", fit);
  fit();
  sync();
}

function animateTheme() {
  if (reduced) return;
  document.documentElement.classList.add("theme-anim");
  setTimeout(() => document.documentElement.classList.remove("theme-anim"), 400);
}

function applyTheme() {
  const forced = params.get("theme");
  const dark = forced ? forced === "dark"
    : inTelegram ? tg.colorScheme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (inTelegram) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    tg.setHeaderColor?.(bg);
    tg.setBackgroundColor?.(bg);
    tg.setBottomBarColor?.(bg);
  }
}

function bind() {
  $$(".chip select").forEach((s) => s.addEventListener("change", () => { haptic("light"); setOption(s.dataset.opt, s.value); }));
  $$("input[data-opt]").forEach((i) => i.addEventListener("input", () => setOption(i.dataset.opt, i.value)));
  $$("[data-title]").forEach((input) =>
    input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
      if (input.type === "checkbox") haptic("light");
      setTitle(input.dataset.title, input.type === "checkbox" ? input.checked : input.value);
    }));
  $$("#labelSeg button").forEach((b) => (b.onclick = () => setTitle("student_label", b.dataset.v)));
  $$(".file-input").forEach((input) => (input.onchange = onFiles));
  $$("[data-close]").forEach((b) => (b.onclick = popLayer));

  $("#titleOpen").onclick = () => openSheet("titleSheet");
  $("#nameChip").onclick = () => { openSheet("nameSheet"); $("#nameSheet input").focus(); };
  $("#buildBtn").onclick = build;
  $("#moreBtn").onclick = () => {
    const go = () => api("POST", "/api/clear").then(apply);
    if (inTelegram) tg.showConfirm("Удалить все страницы?", (ok) => ok && go());
    else if (confirm("Удалить все страницы?")) go();
  };
  $("#ocrBtn").onclick = () => (textItems().length === imageItems().length ? openReview(0) : startOcr());
  $("#ocrOpen").onclick = () => (textItems().length ? openReview(0) : startOcr());
  $("#ocrCancel").onclick = popLayer;
  $("#rvClose").onclick = popLayer;
  $("#rvPrev").onclick = () => { if (rv.i > 0) { flushText(); rv.i--; renderReview(-1); } };
  $("#rvNext").onclick = () => {
    flushText();
    if (rv.i === textItems().length - 1) openResult();
    else { rv.i++; renderReview(1); }
  };
  $("#rvPhoto").onclick = () => openViewer(slots().findIndex((sl) => sl.item?.id === currentTextItem()?.id));
  $("#rvText").addEventListener("input", onTextInput);
  $("#rvText").addEventListener("paste", (e) => { // вставляем только текст, без чужой вёрстки
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData || window.clipboardData).getData("text/plain"));
  });
  $("#resBack").onclick = popLayer;
  $$("#result .opt").forEach((b) => (b.onclick = () => exportText(b)));
  $("#vClose").onclick = popLayer;
  $("#vPrev").onclick = () => { state.viewing--; renderViewer(-1); };
  $("#vNext").onclick = () => { state.viewing++; renderViewer(1); };
  $("#vRotate").onclick = () => rotate(slots()[state.viewing].item);
  $("#vDelete").onclick = viewerDelete;
  $("#backToChat").onclick = () => (inTelegram ? tg.close() : again());
  $("#again").onclick = again;

  if (window.Sortable) {
    Sortable.create($("#grid"), {
      animation: 160,
      delay: 200,
      delayOnTouchOnly: true,
      draggable: ".page[data-id]", // титульный всегда первый
      onStart: () => haptic("medium"),
      onEnd: async () => {
        const ids = $$("#grid .page[data-id]").map((n) => n.dataset.id);
        try {
          apply(await api("POST", "/api/order", { ids }));
        } catch (err) {
          toast(err.message);
          apply(await api("GET", "/api/session").catch(() => ({ items: state.items, options: state.options, title: state.title, work_types: state.workTypes })));
        }
      },
    });
  }

  if (inTelegram) {
    tg.BackButton.onClick(popLayer);
    tg.onEvent("themeChanged", () => { animateTheme(); applyTheme(); });
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

  $("#vStage").addEventListener("touchstart", (e) => { swipeX = e.touches[0].clientX; }, { passive: true });
  $("#vStage").addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - swipeX;
    if (Math.abs(dx) < 50) return;
    const next = state.viewing + (dx < 0 ? 1 : -1);
    if (next >= 0 && next < slots().length) { state.viewing = next; renderViewer(dx < 0 ? 1 : -1); }
  });
}
let swipeX = 0;

async function init() {
  if (inTelegram) {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.(); // иначе перетаскивание страниц сворачивает мини-апп
  }
  applyTheme();
  bind();
  // данные грузятся, пока показана заставка; интерфейс выезжает не раньше, чем пройдёт SPLASH_MIN
  const load = api("GET", "/api/session").then((data) => ({ data }), (error) => ({ error }));
  const [res] = await Promise.all([load, new Promise((r) => setTimeout(r, reduced ? 0 : SPLASH_MIN))]);
  const closed = res.error?.status === 403; // бот закрыт для всех, кроме админов
  if (closed) $("#closed").hidden = false;
  else if (res.error) render();
  else apply(res.data);
  exitSplash();
  if (!closed && !res.error) resumeOcr();
  if (res.error && !closed) toast(res.error.message, 6000);
}

// заставка гаснет, логотип в шапке проявляется, а интерфейс (уже отрисованный) выезжает под ней
function exitSplash() {
  const splash = $("#splash");
  document.documentElement.classList.remove("booting");
  if (!splash) return;
  if (reduced) return splash.remove();
  const opts = { duration: 270, easing: EASE };
  $(".brand img").animate([{ opacity: 0 }, { opacity: 1 }], opts);
  splash.querySelector(".splash-logo").animate([{ transform: "none" }, { transform: "scale(.92)" }], { ...opts, fill: "forwards" });
  splash.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, fill: "forwards" }).finished.then(() => splash.remove(), () => splash.remove());
}

if (framed) mountPhoneFrame();
else init();
