// شاشة التلفاز + تبويب «+» — تُحمَّل عند أول ضغط على زر التلفاز أو زر + فقط (لا تؤثر على سرعة الشات).
// التلفاز: تصنيفات وقائمة القنوات، عرض القناة، إيقاف، تكبير، ملء الشاشة، نافذة عائمة تُسحب ويتغير حجمها،
//          حفظ آخر قناة، وإيقاف البث عند إغلاق الشاشة (إلا في النافذة العائمة).
// زر +: تشغيل رابط (m3u8 / mp4 / يوتيوب / تغريدة X) في نافذة عائمة، «روابطي» المحفوظة، ومشاركة الرابط مع الجميع
//       كبطاقة «▶ شاهد» داخل الشات. التشغيل بمشغّل المالك (tv-player.js).
import { WATCH_CHANNELS as CHANNELS } from "./tv-channels.js";
import { createPlayer } from "./tv-player.js";

const LAST_KEY = "tv_last_channel";
const LINKS_KEY = "tv_my_links";
const ALL = "الكل";
const LINKS_MAX = 30, URL_MAX = 2048, NAME_MAX = 60;
const FA_CSS = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css"; // أيقونات المشغّل
const YT_EMBED = "https://www.youtube-nocookie.com/embed/";

function addCss(href) {
  if (document.querySelector(`link[data-href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet"; l.href = href; l.dataset.href = href;
  document.head.append(l);
}
addCss(new URL("./tv.css", import.meta.url).href);
addCss(FA_CSS);

// بناء DOM آمن (textContent فقط)
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
};

/* ================= تحليل الروابط ================= */
function httpUrl(v) {
  if (typeof v !== "string" || !v || v.length > URL_MAX || /\s/.test(v)) return null;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u : null;
  } catch { return null; }
}
// يوتيوب: فيديو / بث مباشر / shorts / قائمة / بث قناة
function youtubeEmbed(u) {
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const vid = id => (/^[\w-]{11}$/.test(id || "") ? `${YT_EMBED}${id}?autoplay=1&playsinline=1` : null);
  if (host === "youtu.be") return vid(u.pathname.slice(1));
  if (host !== "youtube.com") return null;
  if (u.pathname === "/watch") return vid(u.searchParams.get("v"));
  let m = /^\/(live|shorts|embed)\/([\w-]{11})\/?$/.exec(u.pathname);
  if (m) return vid(m[2]);
  m = /^\/channel\/(UC[\w-]{22})\/live\/?$/.exec(u.pathname);
  if (m) return `${YT_EMBED}live_stream?channel=${m[1]}&autoplay=1&playsinline=1`;
  const l = u.searchParams.get("list");
  if (u.pathname === "/playlist" && /^[\w-]{10,64}$/.test(l || "")) return `${YT_EMBED}videoseries?list=${l}&autoplay=1&playsinline=1`;
  return null;
}
// تغريدة X/Twitter: تضمين رسمي برقم التغريدة فقط
function tweetEmbed(u) {
  const host = u.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;
  const m = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status(?:es)?\/(\d{1,25})\/?$/.exec(u.pathname);
  return m ? "https://platform.twitter.com/embed/Tweet.html?id=" + m[1] + "&dnt=true" : null;
}

/* ================= الحالة ================= */
let api = {};
let anchorBtn = null, mode = "tv", channel = null, group = ALL, player = null, gen = 0;
const anchors = { tv: null, link: null }; // زر 📺 يفتح القنوات فقط، وزر + يفتح الروابط فقط
let floating = false, expanded = false, floatPos = null;
export function setup(a) { api = a || {}; }

/* ================= الواجهة ================= */
const nameEl = h("strong", null, "اختر قناة");
const closeBtn = h("button", { type: "button", class: "tv-x", "aria-label": "إغلاق", title: "إغلاق" }, "✕");
const tagEl = h("span", { class: "tv-tag" }, CHANNELS.length + " قناة");
const linkTitle = h("strong", { hidden: true }, "＋ تشغيل أو مشاركة رابط بث / فيديو");

// ----- تبويب القنوات -----
const ph = h("div", { class: "tv-ph" }, "اختر قناة من القائمة أدناه");
const screen = h("div", { class: "tv-screen" }, ph);
const dockMark = h("div", { class: "tv-dock", hidden: true }, "▣ القناة تعمل في النافذة العائمة ",
  h("button", { type: "button", class: "tv-btn", "data-act": "dock" }, "↩ إرجاعها هنا"));
const startBtn = h("button", { type: "button", class: "tv-btn primary", "data-act": "start", disabled: true }, "▶ عرض القناة");
const expandBtn = h("button", { type: "button", class: "tv-btn", "data-act": "expand", "aria-pressed": "false" }, "⤢ تكبير");
const tools = h("div", { class: "tv-tools" },
  startBtn,
  h("button", { type: "button", class: "tv-btn", "data-act": "stop" }, "■ إيقاف"),
  expandBtn,
  h("button", { type: "button", class: "tv-btn", "data-act": "full" }, "⛶ ملء الشاشة"),
  h("button", { type: "button", class: "tv-btn wide", "data-act": "float" }, "▣ نافذة عائمة"));
const statusEl = h("p", { class: "tv-status", role: "status", "aria-live": "polite" }, "اختر قناة ثم اضغط عرض القناة.");
const cats = h("div", { class: "tv-cats", role: "group", "aria-label": "تصنيف القنوات" });
const list = h("div", { class: "tv-list" });
const tvPane = h("div", { class: "tv-pane" }, screen, dockMark, tools, statusEl, cats, list,
  h("p", { class: "tv-help" }, "اسحب النافذة العائمة من شريطها العلوي للمشاهدة أثناء الكتابة. الصوت والجودة من أدوات المشغّل."));

// ----- تبويب + (رابط ومشاركة) -----
const lkUrl = h("input", { class: "tv-input", type: "url", dir: "ltr", maxlength: String(URL_MAX), autocomplete: "off",
  placeholder: "رابط: m3u8 أو mp4 أو يوتيوب أو تغريدة X", "aria-label": "رابط البث أو الفيديو" });
const lkName = h("input", { class: "tv-input", type: "text", maxlength: String(NAME_MAX), autocomplete: "off",
  placeholder: "اسم اختياري (مثال: مباراة اليوم)", "aria-label": "اسم البث" });
const lkMsg = h("p", { class: "tv-status", role: "status", "aria-live": "polite" });
const lkList = h("div", { class: "tv-saved" });
const linkPane = h("div", { class: "tv-pane", hidden: true },
  lkUrl, lkName,
  h("div", { class: "tv-tools" },
    h("button", { type: "button", class: "tv-btn primary wide", "data-lk": "share" }, "📢 شارك مع الجميع في الشات"),
    h("button", { type: "button", class: "tv-btn", "data-lk": "play" }, "▶ تشغيل لي فقط"),
    h("button", { type: "button", class: "tv-btn", "data-lk": "paste" }, "📋 لصق"),
    h("button", { type: "button", class: "tv-btn wide", "data-lk": "save" }, "⭐ حفظ في روابطي")),
  lkMsg,
  h("strong", { class: "tv-head" }, "روابطي"),
  lkList,
  h("p", { class: "tv-help" }, "«شارك مع الجميع» يرسل بطاقة في الشات، ومن يضغط «▶ شاهد» يشاهد البث. بعض المصادر تمنع التشغيل خارج موقعها."));

const panel = h("section", { id: "tvPanel", role: "dialog", "aria-label": "التلفاز", hidden: true },
  h("div", { class: "tv-top" }, nameEl, linkTitle, tagEl, closeBtn),
  tvPane, linkPane);
document.body.append(panel);

function status(t) { if (statusEl.textContent !== t) statusEl.textContent = t; }
function lkSay(t, bad) { lkMsg.textContent = t || ""; lkMsg.classList.toggle("bad", !!bad); }

function renderCats() {
  const groups = [ALL, ...new Set(CHANNELS.map(c => c.group).filter(Boolean))];
  cats.replaceChildren(...groups.map(g => h("button", {
    type: "button", class: "tv-btn", dataset: { group: g }, "aria-pressed": String(g === group)
  }, g)));
}
function renderList() {
  const frag = document.createDocumentFragment();
  for (const c of CHANNELS) {
    if (group !== ALL && c.group !== group) continue;
    const ok = !!(c.embed || c.stream);
    frag.append(h("button", {
      type: "button", class: "tv-btn", dataset: { ch: c.id }, "aria-pressed": String(c === channel), disabled: !ok
    }, c.name, h("small", null, ok ? (c.kind || "بث مباشر") : (c.unavailableReason || "غير متاحة حاليًا"))));
  }
  list.replaceChildren(frag);
}

/* ================= روابطي ================= */
function readLinks() {
  try {
    const a = JSON.parse(store.get(LINKS_KEY) || "[]");
    return Array.isArray(a) ? a.filter(x => x && httpUrl(x.url)).map(x => ({ url: x.url, name: String(x.name || "").slice(0, NAME_MAX) })).slice(0, LINKS_MAX) : [];
  } catch { return []; }
}
function renderLinks() {
  const items = readLinks();
  if (!items.length) { lkList.replaceChildren(h("div", { class: "tv-empty" }, "لا روابط محفوظة بعد.")); return; }
  lkList.replaceChildren(...items.map((it, i) => h("div", { class: "tv-row" },
    h("button", { type: "button", class: "tv-go", title: it.url, dataset: { sp: String(i) } }, it.name || it.url),
    h("button", { type: "button", class: "tv-share", title: "مشاركة مع الجميع", "aria-label": "مشاركة " + (it.name || it.url), dataset: { ss: String(i) } }, "📢"),
    h("button", { type: "button", class: "tv-del", title: "حذف", "aria-label": "حذف " + (it.name || it.url), dataset: { sd: String(i) } }, "🗑"))));
}

/* ================= تشغيل القنوات ================= */
function clearScreen(msg) {
  gen++;
  if (player) { player.destroy(); player = null; }
  screen.querySelectorAll("iframe,video,.watch-xstage").forEach(n => n.remove());
  ph.hidden = false;
  if (msg) status(msg);
}
function select(c) {
  store.set(LAST_KEY, c.id);
  clearScreen();
  channel = c;
  nameEl.textContent = c.name;
  if (floatName) floatName.textContent = c.name;
  startBtn.disabled = !(c.embed || c.stream);
  ph.textContent = "اضغط «عرض القناة» للمشاهدة";
  status("المشغّل جاهز؛ التشغيل والتوفر يخضعان لمصدر القناة.");
  renderList();
}
function start() {
  if (!channel || !(channel.embed || channel.stream)) return;
  closeLink();
  clearScreen();
  const my = gen;
  ph.hidden = true;
  player = createPlayer(screen, { name: channel.name, embed: channel.embed, stream: channel.stream }, {
    onStatus(m, failed) {
      if (my !== gen) return;
      if (failed) { player = null; clearScreen(m); } else status(m);
    }
  });
}
function toggleFull(el, say) {
  if (!el.querySelector("iframe,video")) { say("اعرض قناة أولًا"); return; }
  try {
    const p = document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.();
    if (!p && !document.fullscreenElement && !el.requestFullscreen) say("استخدم زر ملء الشاشة داخل المشغّل.");
    p?.catch?.(() => say("استخدم زر ملء الشاشة داخل المشغّل."));
  } catch { say("استخدم زر ملء الشاشة داخل المشغّل."); }
}
function setExpanded(on) {
  expanded = on;
  panel.classList.toggle("expanded", on);
  expandBtn.textContent = on ? "⤡ تصغير" : "⤢ تكبير";
  expandBtn.setAttribute("aria-pressed", String(on));
}

/* ================= فتح وإغلاق والتبويبات ================= */
function setMode(m) {
  if (mode === "tv" && m !== "tv" && player && !floating) clearScreen("توقف البث عند فتح نافذة الروابط");
  mode = m;
  tvPane.hidden = m !== "tv";
  linkPane.hidden = m !== "link";
  nameEl.hidden = tagEl.hidden = m !== "tv";
  linkTitle.hidden = m !== "link";
  panel.setAttribute("aria-label", m === "tv" ? "التلفاز" : "مشاركة رابط بث أو فيديو");
  if (m === "link") renderLinks();
}
function open() {
  panel.hidden = false;
  anchorBtn?.setAttribute("aria-expanded", "true");
  dockMark.hidden = !floating;
  if (mode === "link") setTimeout(() => lkUrl.focus({ preventScroll: true }), 0);
}
function close() {
  panel.hidden = true;
  anchorBtn?.setAttribute("aria-expanded", "false");
  setExpanded(false);
  if (!floating && player) clearScreen("توقف البث عند إغلاق التلفاز");
}
export function toggle(btn, m = "tv") {
  if (!panel.hidden && mode === m && anchorBtn === (btn || anchorBtn)) { close(); return; }
  if (anchorBtn && anchorBtn !== btn) anchorBtn.setAttribute("aria-expanded", "false");
  anchorBtn = btn || anchors[m] || anchorBtn;
  if (btn) anchors[m] = btn;
  setMode(m);
  open();
}

/* ================= سحب النوافذ العائمة ================= */
function makeDraggable(head, box, onMove) {
  head.addEventListener("pointerdown", e => {
    if (e.target.closest("button") || (e.pointerType === "mouse" && e.button !== 0)) return;
    const r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    box.classList.add("dragging"); // يمنع الفيديو/الإطار من التقاط المؤشر أثناء السحب
    const move = ev => onMove(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      box.classList.remove("dragging");
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
    e.preventDefault();
  });
}
function bottomLimit() {
  const composer = document.getElementById("composer");
  return composer ? composer.getBoundingClientRect().top - 6 : (window.visualViewport?.height || window.innerHeight) - 8;
}

/* ================= نافذة القناة العائمة ================= */
let floatBox = null, floatName = null, grip = null;
// نقل الشاشة بلا إعادة تحميل حين يدعم المتصفح moveBefore، وإلا نستأنف الفيديو بعد النقل
function moveScreen(parent, before) {
  if (typeof parent.moveBefore === "function" && screen.isConnected && parent.isConnected) {
    try { parent.moveBefore(screen, before || null); return; } catch {}
  }
  const v = screen.querySelector("video"), playing = v && !v.paused;
  parent.insertBefore(screen, before || null);
  if (playing) v.play().catch(() => {});
  if (screen.querySelector("iframe")) status("إذا توقف الفيديو بعد النقل، اضغط تشغيل داخل المشغّل.");
}
function buildFloat() {
  floatName = h("strong", null, channel?.name || "التلفاز");
  const sizeBtn = h("button", { type: "button", title: "حجم صغير / كبير", "aria-label": "تغيير الحجم" }, "⤢");
  const dockBtn = h("button", { type: "button", title: "إرجاع للقائمة", "aria-label": "إرجاع للقائمة" }, "↩");
  const xBtn = h("button", { type: "button", title: "إغلاق وإيقاف", "aria-label": "إغلاق وإيقاف" }, "×");
  const head = h("div", { class: "tv-fhead" }, floatName, sizeBtn, dockBtn, xBtn);
  grip = h("span", { class: "tv-grip", role: "button", tabindex: "0", "aria-label": "تغيير الحجم: اسحب أو استخدم الأسهم", title: "تغيير الحجم" }, "⤡");
  floatBox = h("div", { id: "tvFloat", class: "tv-win", role: "dialog", "aria-label": "التلفاز العائم", hidden: true }, head, grip);
  document.body.append(floatBox);

  sizeBtn.onclick = () => { floatBox.style.width = ""; floatBox.classList.toggle("small"); clampFloat(); };
  dockBtn.onclick = dock;
  xBtn.onclick = () => { clearScreen("تم إيقاف التلفاز"); dock(true); };
  makeDraggable(head, floatBox, (left, top) => { floatPos = { left, top }; clampFloat(); });

  // تغيير الحجم من الزاوية (الحافة اليمنى ثابتة)
  const resizeTo = (w, right, top) => {
    w = Math.max(200, Math.min(w, document.documentElement.clientWidth - 16));
    floatBox.classList.remove("small");
    floatBox.style.width = w + "px";
    floatPos = { left: right - w, top };
    clampFloat();
  };
  grip.addEventListener("pointerdown", e => {
    const r = floatBox.getBoundingClientRect(), sx = e.clientX, sw = r.width, right = r.right;
    grip.setPointerCapture(e.pointerId);
    floatBox.classList.add("dragging");
    const move = ev => resizeTo(sw + (sx - ev.clientX), right, floatBox.getBoundingClientRect().top);
    const up = () => {
      floatBox.classList.remove("dragging");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
    e.preventDefault();
  });
  grip.addEventListener("keydown", e => {
    const d = e.key === "ArrowLeft" ? 20 : e.key === "ArrowRight" ? -20 : 0;
    if (!d) return;
    e.preventDefault();
    const r = floatBox.getBoundingClientRect();
    resizeTo(r.width + d, r.right, r.top);
  });
}
// إبقاء النافذة داخل الشاشة وفوق شريط الكتابة
function clampFloat() {
  if (!floatBox || floatBox.hidden) return;
  const vw = document.documentElement.clientWidth, limit = bottomLimit();
  const r = floatBox.getBoundingClientRect();
  const pos = floatPos || { left: 8, top: limit - r.height };
  floatBox.style.left = Math.max(8, Math.min(pos.left, vw - r.width - 8)) + "px";
  floatBox.style.top = Math.max(8, Math.min(pos.top, limit - r.height)) + "px";
}
function float() {
  if (!player) { status("اعرض قناة أولًا ثم افتحها في نافذة عائمة."); return; }
  if (!floatBox) buildFloat();
  floatName.textContent = channel?.name || "التلفاز";
  floatBox.hidden = false;
  moveScreen(floatBox, grip);
  floating = true;
  clampFloat();
  close(); // تبقى القناة تعمل في النافذة العائمة
}
function dock(silent) {
  if (!floating) return;
  floating = false;
  moveScreen(tvPane, dockMark);
  floatBox.hidden = true;
  dockMark.hidden = true;
  if (silent !== true) {
    if (anchors.tv && anchorBtn !== anchors.tv) { anchorBtn?.setAttribute("aria-expanded", "false"); anchorBtn = anchors.tv; }
    setMode("tv"); open();
  }
}

/* ================= نافذة الرابط العائمة (بث مشارك أو رابط شخصي) ================= */
let linkWin = null;
const linkPos = { left: null, top: null };
function closeLink() {
  if (!linkWin) return;
  const w = linkWin;
  linkWin = null;
  w.player.destroy();
  w.box.remove();
}
function placeLink(left, top) {
  if (!linkWin) return;
  const b = linkWin.box, vw = document.documentElement.clientWidth;
  b.style.left = Math.min(Math.max(4, left), Math.max(4, vw - b.offsetWidth - 4)) + "px";
  b.style.top = Math.min(Math.max(4, top), Math.max(4, bottomLimit() - b.offsetHeight)) + "px";
}
function sizeLink() {
  if (!linkWin) return;
  const vw = document.documentElement.clientWidth, narrow = vw < 600;
  const w = Math.min(narrow ? Math.round(vw * (linkWin.large ? 0.98 : 0.92)) : (linkWin.large ? 520 : 340), vw - 8);
  linkWin.box.style.width = w + "px";
  // التغريدة أطول من 16:9
  linkWin.screen.style.height = (linkWin.tweet ? Math.min(Math.round(w * 1.25), window.innerHeight - 140) : Math.round((w * 9) / 16)) + "px";
  placeLink(linkWin.box.offsetLeft, linkWin.box.offsetTop);
}
export function playLink(url, name) {
  const u = httpUrl(String(url || "").trim());
  if (!u) { lkSay("الرابط غير صالح: يجب أن يبدأ بـ http أو https.", true); return false; }
  const tw = tweetEmbed(u), embed = tw || youtubeEmbed(u);
  const src = embed ? { embed } : { stream: u.href };
  const title = String(name || "").slice(0, NAME_MAX) || u.hostname;
  // بث واحد في كل مرة: يتوقف التلفاز
  if (player) clearScreen("توقف التلفاز لتشغيل الرابط");
  if (floating) dock(true);
  closeLink();

  const fullB = h("button", { type: "button", title: "ملء الشاشة", "aria-label": "ملء الشاشة" }, "⛶");
  const sizeB = h("button", { type: "button", title: "تكبير / تصغير", "aria-label": "تكبير أو تصغير" }, "⤢");
  const xB = h("button", { type: "button", title: "إغلاق وإيقاف", "aria-label": "إغلاق وإيقاف" }, "×");
  const head = h("div", { class: "tv-fhead" }, h("strong", { title: u.href }, title), fullB, sizeB, xB);
  const note = h("div", { class: "tv-note", hidden: true });
  const scr = h("div", { class: "tv-lscreen" });
  const box = h("div", { id: "tvLink", class: "tv-win", role: "dialog", "aria-label": "بث: " + title }, head, note, scr);
  document.body.append(box);
  const p = createPlayer(scr, { name: title, ...src }, {
    onStatus: (t, failed) => { if (failed) { note.textContent = t; note.hidden = false; } else note.hidden = true; }
  });
  linkWin = { box, screen: scr, large: false, tweet: !!tw, player: p };
  sizeLink();
  placeLink(linkPos.left ?? 8, linkPos.top ?? bottomLimit() - box.offsetHeight);
  sizeB.onclick = () => { linkWin.large = !linkWin.large; sizeB.textContent = linkWin.large ? "⤡" : "⤢"; sizeLink(); };
  fullB.onclick = () => toggleFull(scr, t => { note.textContent = t; note.hidden = false; });
  xB.onclick = closeLink;
  makeDraggable(head, box, (left, top) => { placeLink(left, top); linkPos.left = box.offsetLeft; linkPos.top = box.offsetTop; });
  lkSay("");
  return true;
}

// إعادة ضبط النوافذ العائمة عند تغيّر حجم الشاشة أو ظهور الكيبورد (مرة واحدة لكل إطار)
let resizeQueued = false;
const onResize = () => {
  if (resizeQueued || (!floating && !linkWin)) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; clampFloat(); sizeLink(); });
};
window.addEventListener("resize", onResize, { passive: true });
window.visualViewport?.addEventListener("resize", onResize, { passive: true });

/* ================= أحداث تبويب + ================= */
function doShare(url, name) {
  if (typeof api.share !== "function") { lkSay("المشاركة غير متاحة الآن.", true); return; }
  const r = api.share(url, name);
  lkSay(r.msg, !r.ok);
  if (r.ok) { lkUrl.value = ""; lkName.value = ""; setTimeout(close, 700); }
}
async function doPaste() {
  try {
    const t = await navigator.clipboard.readText();
    if (!t) { lkSay("الحافظة فارغة.", true); return; }
    lkUrl.value = t.trim().slice(0, URL_MAX);
    lkUrl.focus();
  } catch { lkSay("المتصفح منع قراءة الحافظة؛ اضغط مطولًا داخل الحقل ثم «لصق».", true); }
}
function doSave() {
  const u = httpUrl(lkUrl.value.trim());
  if (!u) { lkSay("الرابط غير صالح: يجب أن يبدأ بـ http أو https.", true); return; }
  const a = readLinks().filter(x => x.url !== u.href);
  if (a.length >= LINKS_MAX) { lkSay("وصلت الحد الأقصى (" + LINKS_MAX + " رابطًا). احذف رابطًا أولًا.", true); return; }
  a.unshift({ url: u.href, name: lkName.value.trim().slice(0, NAME_MAX) });
  if (!store.set(LINKS_KEY, JSON.stringify(a))) { lkSay("تعذر الحفظ في هذا المتصفح.", true); return; }
  lkSay("⭐ تم الحفظ في روابطي.");
  renderLinks();
}
lkUrl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); playLink(lkUrl.value, lkName.value.trim()); } });

/* ================= الأحداث العامة ================= */
closeBtn.addEventListener("click", close);
panel.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b || !panel.contains(b)) return;
  const d = b.dataset;
  if (d.ch) { const c = CHANNELS.find(x => x.id === d.ch); if (c) select(c); return; }
  if (d.group) {
    group = d.group;
    cats.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.group === group)));
    renderList();
    return;
  }
  if (d.lk === "share") return doShare(lkUrl.value, lkName.value);
  if (d.lk === "play") return void playLink(lkUrl.value, lkName.value.trim());
  if (d.lk === "paste") return void doPaste();
  if (d.lk === "save") return doSave();
  if (d.sp || d.ss || d.sd) {
    const items = readLinks(), i = Number(d.sp ?? d.ss ?? d.sd), it = items[i];
    if (!it) return;
    if (d.sp) playLink(it.url, it.name);
    else if (d.ss) doShare(it.url, it.name);
    else { items.splice(i, 1); store.set(LINKS_KEY, JSON.stringify(items)); renderLinks(); }
    return;
  }
  switch (d.act) {
    case "start": start(); break;
    case "stop": clearScreen("تم إيقاف التلفاز"); break;
    case "expand": setExpanded(!expanded); break;
    case "full": toggleFull(screen, status); break;
    case "float": float(); break;
    case "dock": dock(); break;
  }
});

/* ================= البداية ================= */
renderCats();
setMode("tv");
const last = CHANNELS.find(c => c.id === store.get(LAST_KEY));
if (last) select(last); else renderList();
