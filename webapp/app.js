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
    apply(await api("POST", "/api/upload", fd));
    hideToast();
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
  const data = await api("POST", `/api/items/${item.id}/rotate`, { rotation: item.rotation });
  state.items = data.items.map((i) => (i.id === item.id ? item : i));
}

async function remove(item) {
  haptic("medium");
  apply(await api("DELETE", `/api/items/${item.id}`));
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

// прячем после анимации ухода (класс .leaving в CSS)
function leave(node, ms = 220) {
  node.classList.add("leaving");
  setTimeout(() => { node.hidden = true; node.classList.remove("leaving"); }, reduced ? 0 : ms);
}

function openSheet(id) {
  const sheet = $("#" + id);
  if (!sheet.hidden) return;
  sheet.hidden = false;
  pushLayer(() => leave(sheet));
}

function openViewer(idx) {
  state.viewing = idx;
  $("#viewer").hidden = false;
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
  t.classList.remove("leaving");
  t.hidden = false;
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

async function demoApi(method, path, body) {
  await new Promise((r) => setTimeout(r, 120));
  const db = demoDb;
  const id = path.split("/")[3];
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
        apply(await api("POST", "/api/order", { ids }));
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
