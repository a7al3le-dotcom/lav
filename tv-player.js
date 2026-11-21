// مشغّل «شاهد» — وحدة قابلة للتبديل: واجهة مشغّل يشبه يوتيوب (مأخوذة من مشغّل chat-new: public/js/xp/ui.js + engine.js + css/xp.css)
// تحل محل مشغّل سكربت krrrz الداخلي فقط (فيديو HLS/mp4). بلا خادم ولا مرحِّل ولا dash: hls.js يُحمَّل كسولًا من CDN كما في سكربت krrrz.
// الواجهة: createPlayer(container, { name, embed | stream }, { onStatus(text, failed) }) => { destroy() }
const HLS_SRC = "https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js";
const PK = "al3_watch_px"; // إعدادات المشغّل المحفوظة (الصوت، السرعة، الفلاتر)
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const FITS = [["contain", 1, "ملاءمة"], ["cover", 1, "ملء"], ["fill", 1, "تمدد"], ["contain", 1.25, "تكبير ×1.25"], ["contain", 1.5, "تكبير ×1.5"]];
const SLEEPS = [15, 30, 60, 90];
let hlsLoad = null;

const store = {
  get(k, d) { try { const v = localStorage.getItem(PK + "." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(PK + "." + k, JSON.stringify(v)); } catch (e) {} },
};
// بناء DOM آمن: لا innerHTML؛ النص عبر textContent
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const icon = (n) => h("i", { class: "fa fa-" + n, "aria-hidden": "true" });
const setIcon = (b, n) => { const i = b.querySelector("i"); if (i) i.className = "fa fa-" + n; };
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (hh ? hh + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(r).padStart(2, "0");
}
function srtToVtt(text, off = 0) {
  const src = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/^WEBVTT[^\n]*\n/, "");
  const shift = (hh, mm, ss, ms) => {
    let t = Math.max(0, (+hh || 0) * 3600 + +mm * 60 + +ss + +ms / 1000 + off);
    const H = Math.floor(t / 3600), M = Math.floor((t % 3600) / 60), S = Math.floor(t % 60), MS = Math.round((t - Math.floor(t)) * 1000);
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return p(H) + ":" + p(M) + ":" + p(S) + "." + p(MS, 3);
  };
  const re = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
  const conv = (s) => { const m = re.exec(s.trim()); return m ? shift(m[1] || 0, m[2], m[3], m[4].padEnd(3, "0")) : s.trim(); };
  return "WEBVTT\n\n" + src.split("\n").map((l) => {
    if (!l.includes("-->")) return l;
    const [a, rest] = l.split("-->");
    const [b, ...set] = rest.trim().split(/\s+/);
    return conv(a) + " --> " + conv(b) + (set.length ? " " + set.join(" ") : "");
  }).join("\n");
}

// تحميل كسول لمكتبة HLS عند أول قناة .m3u8 فقط
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLoad) return hlsLoad;
  hlsLoad = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    let done = false;
    const fin = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(tm);
      s.onload = s.onerror = null;
      if (ok && window.Hls) resolve(window.Hls);
      else { s.remove(); hlsLoad = null; reject(new Error("HLS library unavailable")); }
    };
    const tm = setTimeout(() => fin(false), 15000);
    s.async = true;
    s.src = HLS_SRC;
    s.onload = () => fin(true);
    s.onerror = () => fin(false);
    document.head.appendChild(s);
  });
  return hlsLoad;
}

// ---------- المحرك (من engine.js، مبسّط: hls.js أو أصلي أو مباشر) ----------
function createEngine(v, src, hooks) {
  let hls = null, dead = false, reconnects = 0, lastProgress = Date.now(), lastTime = -1, started = false, startTimer = 0;
  const isHls = /m3u8/i.test(src);
  const onTime = () => { if (v.currentTime !== lastTime) { lastTime = v.currentTime; lastProgress = Date.now(); } };
  v.addEventListener("timeupdate", onTime);
  const wd = setInterval(() => {
    if (dead || !started || v.paused || v.ended) return;
    if (eng.isLive() && Date.now() - lastProgress > 12000) { lastProgress = Date.now(); reconnect(); }
  }, 2000);
  const teardown = () => {
    clearTimeout(startTimer);
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    try { v.pause(); } catch (e) {}
    if (v.getAttribute("src")) { v.removeAttribute("src"); v.load(); }
  };
  const armStart = () => {
    clearTimeout(startTimer);
    startTimer = setTimeout(() => { if (!dead && !started) hooks.fail("تأخر البث. أعد المحاولة أو اختر قناة أخرى."); }, 30000);
  };
  const play = () => { if (!dead) { const p = v.play(); if (p && p.catch) p.catch(() => hooks.status("اضغط ▶ لبدء المشاهدة.")); } };
  v.addEventListener("loadeddata", () => { started = true; clearTimeout(startTimer); });
  function reconnect() {
    if (dead) return;
    if (reconnects >= 3) return hooks.fail("انقطع البث. اختر قناة أخرى أو أعد المحاولة.");
    const n = ++reconnects;
    hooks.toast("جارٍ إعادة الاتصال…");
    setTimeout(() => { if (!dead) { teardown(); start(); } }, 1000 * 2 ** (n - 1));
  }
  function start() {
    started = false;
    armStart();
    if (!isHls || v.canPlayType("application/vnd.apple.mpegurl")) { v.src = src; v.load(); play(); return; }
    loadHls().then((Hls) => {
      if (dead) return;
      if (!Hls.isSupported()) return hooks.fail("هذا المتصفح لا يدعم تشغيل هذه القناة.");
      const g = (hls = new Hls({ enableWorker: true, lowLatencyMode: true, capLevelToPlayerSize: true, maxBufferLength: 30, backBufferLength: 60 }));
      let net = 0, media = 0;
      const E = Hls.Events;
      g.on(E.MANIFEST_PARSED, () => { hooks.levels(); play(); });
      g.on(E.LEVEL_SWITCHED, () => hooks.levels());
      g.on(E.FRAG_LOADED, () => { net = 0; });
      g.on(E.ERROR, (_e, d) => {
        if (dead || !d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && net < 4 && started) { net++; hooks.toast("جارٍ إعادة الاتصال…"); setTimeout(() => { if (hls === g) g.startLoad(); }, 1000 * 2 ** (net - 1)); return; }
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && media++ < 2) { if (media === 2) g.swapAudioCodec(); g.recoverMediaError(); return; }
        if (started) reconnect();
        else hooks.fail(d.type === Hls.ErrorTypes.NETWORK_ERROR ? "تعذر الاتصال بالمصدر: قد يمنع الخادم الوصول أو يكون البث محجوبًا ببلدك." : "تعذر تشغيل القناة. قد تكون الصيغة غير مدعومة.");
      });
      g.attachMedia(v);
      g.loadSource(src);
    }).catch(() => hooks.fail("تعذر تحميل مشغل الفيديو. قد تمنع إعدادات الموقع المكتبة الخارجية."));
  }
  v.addEventListener("error", () => { if (dead) return; if (started) reconnect(); else if (!hls) hooks.fail("تعذر تشغيل القناة. قد يكون البث متوقفًا أو غير متاح ببلدك."); });
  const eng = {
    start,
    destroy() { dead = true; clearInterval(wd); v.removeEventListener("timeupdate", onTime); teardown(); },
    isLive() {
      if (hls) { const lv = hls.levels?.[hls.currentLevel >= 0 ? hls.currentLevel : Math.max(0, hls.loadLevel)]; if (lv?.details) return !!lv.details.live; }
      return v.duration === Infinity;
    },
    seekRange() {
      const s = v.seekable;
      if (s && s.length) return [s.start(0), s.end(s.length - 1)];
      return [0, isFinite(v.duration) ? v.duration : 0];
    },
    goLive() { const [, end] = eng.seekRange(); v.currentTime = hls?.liveSyncPosition || Math.max(0, end - 1); play(); },
    levels() {
      if (!hls) return { list: [], auto: true, current: -1 };
      const manual = hls.manualLevel;
      return { list: (hls.levels || []).map((l, i) => ({ id: i, height: l.height, bitrate: l.bitrate })), auto: hls.autoLevelEnabled, current: Number.isInteger(manual) && manual >= 0 ? manual : hls.currentLevel };
    },
    setLevel(id) { if (hls) hls.currentLevel = id === "auto" ? -1 : id; },
    audioTracks() {
      if (hls?.audioTracks?.length > 1) return { list: hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || "مسار " + (i + 1) })), current: hls.audioTrack };
      return { list: [], current: -1 };
    },
    setAudio(i) { if (hls) hls.audioTrack = i; },
    textTracks() {
      const out = [];
      for (let i = 0; i < v.textTracks.length; i++) { const t = v.textTracks[i]; if (t.kind === "subtitles" || t.kind === "captions") out.push({ id: i, label: t.label || t.language || "ترجمة " + (i + 1), on: t.mode === "showing" }); }
      return out;
    },
    setText(i) {
      const tt = v.textTracks;
      for (let k = 0; k < tt.length; k++) if (tt[k].kind === "subtitles" || tt[k].kind === "captions") tt[k].mode = k === i ? "showing" : "disabled";
    },
  };
  return eng;
}

// ---------- الواجهة (من ui.js: أزرار، شريط تقدم، قوائم إعدادات، لمس، اختصارات) ----------
function buildStage() {
  const R = {};
  const b = (key, cls, ic, title) => (R[key] = h("button", { type: "button", class: "watch-xb " + (cls || ""), title, "aria-label": title }, icon(ic)));
  R.v = h("video", { class: "watch-xv", playsinline: "", preload: "none", "aria-label": "فيديو" });
  R.tap = h("div", { class: "watch-xtap" });
  R.fx = h("div", { class: "watch-xfx" });
  R.spin = h("div", { class: "watch-xspin", hidden: true });
  R.big = h("button", { type: "button", class: "watch-xbig", "aria-label": "تشغيل" }, icon("play"));
  R.speedhint = h("div", { class: "watch-xhint", hidden: true }, "2×");
  R.toast = h("div", { class: "watch-xtoast", hidden: true });
  R.buf = h("div", { class: "watch-xbuf" });
  R.played = h("div", { class: "watch-xplayed" });
  R.knob = h("div", { class: "watch-xknob" });
  R.tip = h("div", { class: "watch-xtip", hidden: true });
  R.prog = h("div", { class: "watch-xprog", role: "slider", "aria-label": "شريط التقدم", tabindex: "0" }, R.buf, R.played, R.knob, R.tip);
  R.vol = h("input", { class: "watch-xvol", type: "range", min: "0", max: "1", step: "0.02", value: "1", "aria-label": "مستوى الصوت" });
  R.vgrp = h("div", { class: "watch-xvgrp" }, b("bMute", "", "volume-up", "كتم (m)"), R.vol);
  R.live = h("span", { class: "watch-xlive", hidden: true }, h("i"), h("b", null, "مباشر"));
  R.time = h("span", { class: "watch-xtime" }, "0:00 / 0:00");
  b("bBack", "txt", "step-forward", "العودة للبث");
  R.bBack.hidden = true; R.bBack.replaceChildren("العودة للبث");
  R.row = h("div", { class: "watch-xrow" }, b("bPlay", "", "play", "تشغيل / إيقاف (k)"), R.vgrp, R.live, R.time, R.bBack, h("span", { class: "watch-xsp" }),
    b("bCC", "watch-xlow", "cc", "الترجمة (c)"), b("bSet", "", "cog", "الإعدادات"), b("bPip", "watch-xlow", "external-link", "صورة داخل صورة (p)"), b("bFull", "", "expand", "ملء الشاشة (f)"));
  R.ctl = h("div", { class: "watch-xctl", dir: "ltr" }, R.prog, R.row);
  R.menu = h("div", { class: "watch-xmenu", hidden: true });
  R.subfile = h("input", { type: "file", hidden: true, accept: ".vtt,.srt,text/vtt" });
  R.root = h("div", { class: "watch-xstage idle paused", tabindex: "0" }, R.v, R.tap, R.fx, R.spin, R.big, R.speedhint, R.toast, R.ctl, R.menu, R.subfile);
  return R;
}

function mountUI(R, eng) {
  const v = R.v, stage = R.root, menu = R.menu, prog = R.prog;
  const st = { fit: 0, speed: 1, loop: false, sleepAt: 0, idle: 0, drag: false, dragFrac: 0, subRaw: "", subOff: 0, subUrl: "", subTrack: null, subLabel: "", cc: store.get("cc", false) };
  const filters = Object.assign({ b: 100, c: 100, s: 100 }, store.get("filters", {}));
  const timers = [];
  const offs = [];
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); offs.push(() => t.removeEventListener(ev, fn, o)); };

  v.volume = Math.min(1, Math.max(0, store.get("vol", 1)));
  v.muted = store.get("muted", false);
  const narrow = () => stage.classList.contains("watch-xnarrow");
  const fitNarrow = () => stage.classList.toggle("watch-xnarrow", stage.clientWidth < 340);
  let ro = null;
  if (typeof ResizeObserver === "function") { ro = new ResizeObserver(fitNarrow); ro.observe(stage); }
  const showControls = () => {
    stage.classList.remove("idle");
    clearTimeout(st.idle);
    st.idle = setTimeout(() => { if (!v.paused && menu.hidden && !st.drag) stage.classList.add("idle"); }, 3000);
  };
  on(stage, "pointermove", (e) => { if (e.pointerType !== "touch") showControls(); });
  on(stage, "pointerdown", () => { if (!stage.classList.contains("idle")) showControls(); }, true);
  on(stage, "pointerleave", () => { if (!v.paused && menu.hidden) stage.classList.add("idle"); });

  const toast = (text, ms = 2200) => { R.toast.textContent = text; R.toast.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { R.toast.hidden = true; }, ms); };
  const togglePlay = () => { if (v.paused || v.ended) v.play().catch(() => {}); else v.pause(); };
  const syncPlay = () => { const p = v.paused; setIcon(R.bPlay, p ? "play" : "pause"); setIcon(R.big, p ? "play" : "pause"); stage.classList.toggle("paused", p); showControls(); }; // عند التشغيل يبدأ مؤقت إخفاء الأدوات (3 ثوانٍ)
  on(v, "play", syncPlay); on(v, "pause", syncPlay);
  // يظهر فقط عند الانتظار الفعلي: بحث جارٍ، أو تشغيل مطلوب وبياناته غير كافية (readyState < 3). ويُخفى عند الإيقاف والخطأ والنهاية.
  // يُحسب من حالة العنصر في كل حدث وفي نبضة tick أيضًا، فلا يبقى بسبب حدث stalled/waiting قديم.
  let errored = false;
  const updateSpin = () => {
    const busy = !errored && !v.ended && (v.seeking || (!v.paused && v.readyState < 3));
    if (R.spin.hidden === busy) R.spin.hidden = !busy;
  };
  for (const n of ["waiting", "seeking", "stalled", "playing", "canplay", "canplaythrough", "loadeddata", "seeked", "pause", "play", "ended", "emptied"]) on(v, n, updateSpin);
  on(v, "error", () => { errored = true; R.spin.hidden = true; });
  on(v, "loadstart", () => { errored = false; updateSpin(); });
  R.bPlay.onclick = togglePlay; R.big.onclick = togglePlay;

  // الصوت
  const syncVol = () => { const vol = v.muted ? 0 : v.volume; R.vol.value = vol; setIcon(R.bMute, vol === 0 ? "volume-off" : vol < 0.5 ? "volume-down" : "volume-up"); };
  on(v, "volumechange", () => { syncVol(); store.set("vol", v.volume); store.set("muted", v.muted); });
  R.vol.oninput = (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; };
  R.bMute.onclick = () => { v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; };
  const changeVol = (d) => { v.muted = false; v.volume = Math.min(1, Math.max(0, v.volume + d)); toast("الصوت " + Math.round(v.volume * 100) + "%"); };
  syncVol();

  // التقدم والبحث
  const range = () => (eng.isLive() ? eng.seekRange() : [0, isFinite(v.duration) ? v.duration : 0]);
  const fracAt = (e) => { const r = prog.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const timeAt = (f) => { const [a, b] = range(); return a + f * (b - a); };
  const seekTo = (t) => { if (!isFinite(t)) return; const [a, b] = range(); v.currentTime = Math.min(b, Math.max(a, t)); };
  const seekBy = (d) => { seekTo(v.currentTime + d); toast(d > 0 ? "+" + d + " ث" : d + " ث"); };
  const paintProg = (f) => { R.played.style.width = f * 100 + "%"; R.knob.style.left = f * 100 + "%"; };
  const showTip = (f) => {
    const [a, b] = range();
    R.tip.hidden = !(b > a);
    R.tip.style.left = f * 100 + "%";
    R.tip.textContent = fmtTime(timeAt(f));
  };
  let dragId = null;
  prog.addEventListener("pointerdown", (e) => {
    if (dragId !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
    dragId = e.pointerId;
    st.drag = true;
    try { prog.setPointerCapture(e.pointerId); } catch (err) { /* لا يهم */ }
    st.dragFrac = fracAt(e);
    paintProg(st.dragFrac);
    showTip(st.dragFrac);
    showControls();
    e.preventDefault();
  });
  prog.addEventListener("pointermove", (e) => {
    const f = fracAt(e);
    if (st.drag && e.pointerId === dragId) { st.dragFrac = f; paintProg(f); showTip(f); showControls(); }
    else if (e.pointerType === "mouse") showTip(f);
  });
  prog.addEventListener("pointerleave", () => { if (!st.drag) R.tip.hidden = true; });
  const endDrag = (e) => {
    if (!st.drag || e.pointerId !== dragId) return;
    st.drag = false;
    dragId = null;
    R.tip.hidden = true;
    try { prog.releasePointerCapture(e.pointerId); } catch (err) { /* لا يهم */ }
    seekTo(timeAt(e.type === "pointercancel" ? st.dragFrac : fracAt(e))); // الفيديو لا يتحرك إلا عند رفع الإصبع
    showControls(); // يعيد مؤقت الإخفاء بعد السحب
  };
  prog.addEventListener("pointerup", endDrag); prog.addEventListener("pointercancel", endDrag);
  const bufNodes = [];
  const paintBuffer = () => {
    const [a, b] = range(), len = b - a, br = v.buffered;
    let n = 0;
    for (let i = 0; i < br.length && len > 0 && n < 12; i++) {
      const s = Math.max(a, br.start(i)), e = Math.min(b, br.end(i));
      if (e <= s) continue;
      let node = bufNodes[n];
      if (!node) { node = h("i"); bufNodes[n] = node; R.buf.append(node); }
      node.hidden = false;
      node.style.left = ((s - a) / len) * 100 + "%";
      node.style.width = ((e - s) / len) * 100 + "%";
      n++;
    }
    for (let i = n; i < bufNodes.length; i++) bufNodes[i].hidden = true;
  };
  const tick = () => {
    const live = eng.isLive(), [a, b] = range();
    if (!st.drag) paintProg(b > a ? (v.currentTime - a) / (b - a) : 0);
    paintBuffer();
    R.live.hidden = !live;
    R.prog.hidden = live; // البث المباشر: «مباشر» فقط بلا شريط تقدم
    R.time.hidden = live;
    updateSpin();
    if (!live) R.time.textContent = fmtTime(v.currentTime) + " / " + fmtTime(v.duration);
    const behind = live ? b - v.currentTime : 0;
    R.bBack.hidden = !(live && behind > 10);
    R.live.classList.toggle("behind", live && behind > 10);
    if (st.sleepAt && Date.now() >= st.sleepAt) { st.sleepAt = 0; v.pause(); toast("انتهى مؤقت الإيقاف"); }
  };
  const tickT = setInterval(() => { if (!document.hidden && stage.isConnected) tick(); }, 250); // لا عمل والصفحة مخفية
  R.bBack.onclick = () => eng.goLive(); R.live.onclick = () => eng.goLive();

  // السرعة والصورة
  const setSpeed = (x, silent) => { x = Math.min(4, Math.max(0.1, +x || 1)); st.speed = x; v.playbackRate = x; store.set("speed", x); if (!silent) toast("السرعة ×" + x); };
  on(v, "loadeddata", () => { v.playbackRate = st.speed; });
  setSpeed(store.get("speed", 1), true);
  const applyFit = () => { const [f, z] = FITS[st.fit]; v.style.objectFit = f; v.style.transform = z === 1 ? "" : "scale(" + z + ")"; };
  const applyFilters = () => { const d = filters.b === 100 && filters.c === 100 && filters.s === 100; v.style.filter = d ? "" : "brightness(" + filters.b + "%) contrast(" + filters.c + "%) saturate(" + filters.s + "%)"; store.set("filters", filters); };
  applyFilters();

  // الترجمة
  const syncCC = () => R.bCC.classList.toggle("on", eng.textTracks().some((x) => x.on));
  const toggleCC = () => {
    const t = eng.textTracks();
    if (!t.length) return openMenu("subs");
    const onNow = t.some((x) => x.on);
    if (onNow) eng.setText(-1); else eng.setText((t.find((x) => /ملف|\.(srt|vtt)$/i.test(x.label)) || t[0]).id);
    st.cc = !onNow; store.set("cc", st.cc); syncCC();
  };
  v.textTracks.addEventListener?.("change", syncCC);
  R.bCC.onclick = toggleCC;
  const mountSub = () => {
    if (st.subTrack) st.subTrack.remove();
    if (st.subUrl) URL.revokeObjectURL(st.subUrl);
    st.subUrl = URL.createObjectURL(new Blob([srtToVtt(st.subRaw, st.subOff)], { type: "text/vtt" }));
    const tr = h("track", { kind: "subtitles", label: st.subLabel, srclang: "ar", src: st.subUrl });
    st.subTrack = tr; v.append(tr); tr.track.mode = "showing";
    for (let i = 0; i < v.textTracks.length; i++) if (v.textTracks[i] !== tr.track && v.textTracks[i].mode === "showing") v.textTracks[i].mode = "disabled";
    st.cc = true; store.set("cc", true); syncCC();
  };
  R.subfile.onchange = (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (f) f.text().then((txt) => { st.subRaw = txt; st.subOff = 0; st.subLabel = f.name.slice(0, 40); mountSub(); toast("تم تحميل الترجمة"); }).catch(() => toast("تعذّر قراءة ملف الترجمة"));
  };

  // قوائم الإعدادات
  const kbps = (x) => (x >= 1e6 ? (x / 1e6).toFixed(1) + " Mbps" : Math.round(x / 1000) + " kbps");
  const panels = {
    root() {
      const lv = eng.levels(), cur = lv.list.find((l) => l.id === lv.current);
      const qv = lv.auto ? "تلقائي" + (cur?.height ? " (" + cur.height + "p)" : "") : cur?.height ? cur.height + "p" : "";
      return ["الإعدادات", [
        { label: "الجودة", value: qv, go: "quality" },
        { label: "السرعة", value: st.speed === 1 ? "عادية" : "×" + st.speed, go: "speed" },
        { label: "الصوت", value: "", go: "audio" },
        { label: "الترجمة", value: eng.textTracks().some((x) => x.on) ? "مفعّلة" : "بدون", go: "subs" },
        { label: "حجم الصورة", value: FITS[st.fit][2], go: "fit" },
        { label: "الصورة", value: "", go: "picture" },
        { label: "مؤقت الإيقاف", value: st.sleepAt ? "مفعّل" : "بدون", go: "sleep" },
        ...(narrow() && document.pictureInPictureEnabled ? [{ label: "صورة داخل صورة", act: () => { closeMenu(); togglePip(); } }] : []),
        { label: "تكرار", toggle: st.loop, act: () => { st.loop = v.loop = !st.loop; showPanel("root"); } },
      ]];
    },
    quality() {
      const lv = eng.levels();
      const items = [{ label: "تلقائي", check: lv.auto, act: () => { eng.setLevel("auto"); showPanel("quality"); } }];
      for (const l of [...lv.list].sort((a, b) => (b.height || 0) - (a.height || 0) || b.bitrate - a.bitrate)) items.push({ label: (l.height ? l.height + "p" : "") + (l.bitrate ? " " + kbps(l.bitrate) : "") || "مستوى", check: !lv.auto && l.id === lv.current, act: () => { eng.setLevel(l.id); showPanel("quality"); } });
      if (!lv.list.length) items.push({ label: "لا توجد مستويات متعددة لهذا المصدر", plain: true });
      return ["الجودة", items];
    },
    speed() {
      const items = SPEEDS.map((x) => ({ label: x === 1 ? "عادية" : "×" + x, check: st.speed === x, act: () => { setSpeed(x); showPanel("speed"); } }));
      const inp = h("input", { type: "number", min: "0.1", max: "4", step: "0.05", value: String(st.speed), dir: "ltr", "aria-label": "سرعة مخصصة" });
      inp.onchange = () => { setSpeed(inp.value); showPanel("speed"); };
      items.push({ node: h("div", { class: "watch-xmi plain" }, h("span", { class: "ml" }, "مخصصة"), inp) });
      return ["السرعة", items];
    },
    audio() {
      const a = eng.audioTracks();
      const items = a.list.map((t) => ({ label: t.label, check: t.id === a.current, act: () => { eng.setAudio(t.id); showPanel("audio"); } }));
      if (!items.length) items.push({ label: "لا توجد مسارات صوت متعددة", plain: true });
      return ["الصوت", items];
    },
    subs() {
      const t = eng.textTracks();
      const items = [{ label: "بدون", check: !t.some((x) => x.on), act: () => { eng.setText(-1); st.cc = false; store.set("cc", false); syncCC(); showPanel("subs"); } }];
      for (const x of t) items.push({ label: x.label, check: x.on, act: () => { eng.setText(x.id); st.cc = true; store.set("cc", true); syncCC(); showPanel("subs"); } });
      items.push({ label: "تحميل ملف ترجمة (.vtt / .srt)", act: () => R.subfile.click() });
      if (st.subRaw) {
        const mk = (d) => h("button", { type: "button", onclick: () => { st.subOff = Math.round((st.subOff + d) * 10) / 10; mountSub(); showPanel("subs"); } }, (d > 0 ? "+" : "") + d);
        items.push({ node: h("div", { class: "watch-xmi plain" }, h("span", { class: "ml" }, "إزاحة التوقيت: " + st.subOff + " ث"), h("span", { class: "btns" }, mk(-0.5), mk(0.5), mk(-5), mk(5))) });
      }
      return ["الترجمة", items];
    },
    fit() { return ["حجم الصورة", FITS.map((f, i) => ({ label: f[2], check: st.fit === i, act: () => { st.fit = i; applyFit(); showPanel("fit"); } }))]; },
    picture() {
      const sl = (label, key) => {
        const out = h("span", { class: "mv" }, filters[key] + "%");
        const r = h("input", { type: "range", min: "30", max: "200", step: "5", value: String(filters[key]), "aria-label": label });
        r.oninput = () => { filters[key] = +r.value; out.textContent = r.value + "%"; applyFilters(); };
        return { node: h("div", { class: "watch-xmi plain col" }, h("div", { class: "rowx" }, h("span", { class: "ml" }, label), out), r) };
      };
      return ["الصورة", [sl("السطوع", "b"), sl("التباين", "c"), sl("التشبّع", "s"), { label: "إعادة الضبط", act: () => { filters.b = filters.c = filters.s = 100; applyFilters(); showPanel("picture"); } }]];
    },
    sleep() {
      const items = SLEEPS.map((m) => ({ label: m + " دقيقة", act: () => { st.sleepAt = Date.now() + m * 60000; toast("سيتوقف التشغيل بعد " + m + " دقيقة"); closeMenu(); } }));
      items.push({ label: "إيقاف المؤقت", check: !st.sleepAt, act: () => { st.sleepAt = 0; showPanel("sleep"); } });
      return ["مؤقت الإيقاف", items];
    },
  };
  function showPanel(name) {
    const [title, items] = panels[name]();
    menu.replaceChildren();
    if (name !== "root") menu.append(h("button", { class: "watch-xmi head", type: "button", onclick: () => showPanel("root") }, icon("arrow-right"), h("span", { class: "ml" }, title)));
    for (const it of items) {
      if (it.node) { menu.append(it.node); continue; }
      if (it.plain) { menu.append(h("div", { class: "watch-xmi plain" }, it.label)); continue; }
      menu.append(h("button", { class: "watch-xmi", type: "button", onclick: () => (it.go ? showPanel(it.go) : it.act()) },
        h("span", { class: "ml" }, it.label), it.value ? h("span", { class: "mv" }, it.value) : null,
        it.toggle !== undefined ? h("span", { class: "sw" + (it.toggle ? " on" : "") }) : null, it.check ? icon("check") : null, it.go ? icon("angle-left") : null));
    }
  }
  function openMenu(name = "root") { menu.hidden = false; showPanel(name); showControls(); }
  function closeMenu() { menu.hidden = true; }
  R.bSet.onclick = () => (menu.hidden ? openMenu() : closeMenu());
  on(document, "pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target) && !R.bSet.contains(e.target) && !R.bCC.contains(e.target)) closeMenu(); });

  // ملء الشاشة وPiP
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  const toggleFull = () => {
    if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    const rq = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (rq) { const p = rq.call(stage); if (p && p.catch) p.catch(() => {}); } else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  };
  const onFs = () => setIcon(R.bFull, fsEl() === stage ? "compress" : "expand");
  on(document, "fullscreenchange", onFs);
  const togglePip = async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v.requestPictureInPicture(); } catch (e) { toast("الصورة داخل صورة غير متاحة"); } };
  if (!document.pictureInPictureEnabled) R.bPip.hidden = true;
  R.bFull.onclick = toggleFull; R.bPip.onclick = togglePip;

  // اللمس: نقرتان على الجانبين = ±10 ث، ضغطة مطوّلة = ×2
  const tap = R.tap;
  let lastTap = { t: 0, x: 0 }, singleT = 0, longT = 0, longOn = false, down = null;
  const ripple = (side, text) => { const r = h("div", { class: "watch-xripple " + side }, h("span", null, text)); R.fx.append(r); setTimeout(() => r.remove(), 700); };
  tap.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
    stage.focus({ preventScroll: true });
    if (e.pointerType === "mouse") return;
    longOn = false; clearTimeout(longT);
    longT = setTimeout(() => { longOn = true; v.playbackRate = 2; R.speedhint.hidden = false; }, 500);
  });
  tap.addEventListener("pointermove", (e) => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) clearTimeout(longT); });
  const endPress = () => { clearTimeout(longT); if (longOn) { v.playbackRate = st.speed; R.speedhint.hidden = true; } };
  tap.addEventListener("pointercancel", () => { endPress(); longOn = false; });
  tap.addEventListener("pointerup", (e) => {
    const wasLong = longOn; endPress();
    if (wasLong) { longOn = false; return; }
    if (e.pointerType === "mouse") return;
    const now = Date.now(), r = tap.getBoundingClientRect(), rel = (e.clientX - r.left) / r.width;
    if (now - lastTap.t < 320 && Math.abs(e.clientX - lastTap.x) < 80) {
      clearTimeout(singleT); lastTap.t = 0;
      if (rel < 0.4) { seekBy(-10); ripple("l", "-10"); } else if (rel > 0.6) { seekBy(10); ripple("r", "+10"); } else togglePlay();
      showControls();
      return;
    }
    lastTap = { t: now, x: e.clientX };
    singleT = setTimeout(() => { if (!menu.hidden) { closeMenu(); return; } if (stage.classList.contains("idle")) showControls(); else if (!v.paused) { clearTimeout(st.idle); stage.classList.add("idle"); } }, 320);
  });
  tap.addEventListener("click", (e) => { if (e.detail && matchMedia("(pointer:fine)").matches) { if (!menu.hidden) closeMenu(); else togglePlay(); } });
  tap.addEventListener("dblclick", () => { if (matchMedia("(pointer:fine)").matches) toggleFull(); });
  tap.addEventListener("contextmenu", (e) => { if (longOn) e.preventDefault(); });

  // اختصارات لوحة المفاتيح: تعمل فقط والتركيز داخل المشغّل (لا تعترض الكتابة في الدردشة)
  stage.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target;
    if (tg && (tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || (tg.tagName === "INPUT" && (tg.type !== "range" || e.key.startsWith("Arrow") || e.key === " ")))) return;
    if (tg && tg.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
    const k = e.key;
    let ok = true;
    if (k === " " || k === "k" || k === "K") togglePlay();
    else if (k === "j" || k === "J") seekBy(-10);
    else if (k === "l" || k === "L") seekBy(10);
    else if (k === "ArrowLeft") seekBy(-5);
    else if (k === "ArrowRight") seekBy(5);
    else if (k === "ArrowUp") changeVol(0.05);
    else if (k === "ArrowDown") changeVol(-0.05);
    else if (k === "m" || k === "M") v.muted = !v.muted;
    else if (k === "f" || k === "F") toggleFull();
    else if (k === "p" || k === "P") togglePip();
    else if (k === "c" || k === "C") toggleCC();
    else if (k === "<" || k === ">") { const i = SPEEDS.indexOf(st.speed); setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 3 : i) + (k === ">" ? 1 : -1)))]); }
    else if (k === "Escape" && !menu.hidden) closeMenu();
    else if (/^[0-9]$/.test(k)) { const [a, b] = range(); if (b > a) seekTo(a + (+k / 10) * (b - a)); }
    else ok = false;
    if (ok) { e.preventDefault(); e.stopPropagation(); showControls(); }
  });

  syncPlay(); showControls(); tick();
  return {
    toast, syncCC,
    destroy() {
      if (ro) ro.disconnect();
      clearInterval(tickT); clearTimeout(st.idle); clearTimeout(singleT); clearTimeout(longT); clearTimeout(toast.t);
      offs.forEach((f) => f()); timers.length = 0;
      if (st.subUrl) URL.revokeObjectURL(st.subUrl);
    },
  };
}

// ---------- الواجهة العامة ----------
export function createPlayer(container, src, opts = {}) {
  const say = opts.onStatus || (() => {});
  let dead = false, node = null, eng = null, ui = null;
  const destroy = () => {
    if (dead) return;
    dead = true;
    if (ui) ui.destroy();
    if (eng) eng.destroy();
    if (node) {
      if (node.tagName === "IFRAME") node.src = "about:blank"; // يوقف الصوت فورًا
      node.remove();
    }
    node = eng = ui = null;
  };
  const fail = (t) => { if (!dead) { destroy(); say(t, true); } };

  if (src.embed) {
    node = h("iframe", { title: src.name || "شاهد", allow: "autoplay; fullscreen; picture-in-picture; encrypted-media", referrerpolicy: "strict-origin-when-cross-origin" });
    node.src = src.embed;
    container.appendChild(node);
    say("اضغط تشغيل داخل المشغّل. الصوت والجودة من أدوات القناة.");
    return { destroy };
  }
  const R = buildStage();
  node = R.root;
  R.v.setAttribute("aria-label", src.name || "شاهد");
  container.appendChild(node);
  say("جارٍ تحميل البث…");
  let uiRef = null;
  eng = createEngine(R.v, src.stream, {
    status: (t) => { if (!dead) say(t, false); },
    toast: (t) => uiRef && uiRef.toast(t),
    levels: () => {},
    fail,
  });
  ui = uiRef = mountUI(R, eng);
  R.v.addEventListener("playing", () => { if (!dead) say("يعمل الآن · مشاهدة شخصية", false); });
  // نهاية البث المباشر فقط تُنهي المشغّل؛ فيديو mp4 المنتهي يبقى بزر إعادة التشغيل
  R.v.addEventListener("ended", () => { if (eng && eng.isLive()) fail("انتهى البث."); });
  eng.start();
  return { destroy };
}
