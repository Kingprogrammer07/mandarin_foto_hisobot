/* Reys hisoboti — Telegram Mini App
 * Vanilla JS, no build step. Mobile-first. Light/dark via Telegram theme
 * (and prefers-color-scheme when run outside Telegram).
 */
(function () {
  "use strict";

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  // The SDK defines window.Telegram.WebApp even in a plain browser, where
  // initData is empty and MainButton is an invisible no-op. Only treat it as a
  // real Telegram client when initData is present.
  const inTelegram = !!(tg && tg.initData);
  const MAX_PHOTOS = 10;
  const DEFAULT_TYPES = ["akb", "triton", "izi", "navo", "xabib", "jet", "jon"];

  // ---- App state ----
  const state = {
    activeTab: "report",
    photos: [], // { id, file, url }
    type: "akb",
    customTypes: [], // user-added types not yet persisted to inventory
    inventory: {}, // tovar_turi -> weight (from server)
    coef: { mode: "none", value: 0 }, // mode: none | fixed | custom
    weightRaw: "",
    adjFrom: "",
    adjTo: "",
    adjWeightRaw: "",
  };

  // Union of default types, inventory types, and locally-added custom types.
  function allTypes() {
    const set = new Set(DEFAULT_TYPES);
    Object.keys(state.inventory).forEach((t) => set.add(t));
    state.customTypes.forEach((t) => set.add(t));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  const authHeaders = () => (inTelegram ? { "X-Telegram-Init-Data": tg.initData } : {});

  let photoSeq = 0;
  let sheetOpen = false;
  let pendingClose = null; // { done, timer } for an in-flight close animation

  // ---- Element refs ----
  const $ = (sel) => document.querySelector(sel);
  const els = {
    tabs: document.querySelectorAll(".tab"),
    panels: { report: $("#panel-report"), lost: $("#panel-lost") },
    photoGrid: $("#photoGrid"),
    photoCounter: $("#photoCounter"),
    btnGallery: $("#btnGallery"),
    btnCamera: $("#btnCamera"),
    inGallery: $("#inGallery"),
    inCamera: $("#inCamera"),
    typeSelect: $("#typeSelect"),
    typeValue: $("#typeValue"),
    typePencil: $("#typePencil"),
    coefChips: $("#coefChips"),
    coefCustomWrap: $("#coefCustomWrap"),
    coefCustom: $("#coefCustom"),
    weight: $("#weight"),
    saveBtn: $("#saveBtn"),
    // adashgan yuklar (tab 2)
    adjFromSelect: $("#adjFromSelect"),
    adjFromValue: $("#adjFromValue"),
    adjFromBal: $("#adjFromBal"),
    adjToSelect: $("#adjToSelect"),
    adjToValue: $("#adjToValue"),
    adjToBal: $("#adjToBal"),
    adjWeight: $("#adjWeight"),
    adjSaveBtn: $("#adjSaveBtn"),
    balances: $("#balances"),
    // activity
    activityBtn: $("#activityBtn"),
    activityScreen: $("#activityScreen"),
    activityClose: $("#activityClose"),
    activityList: $("#activityList"),
    actDate: $("#actDate"),
    actPrev: $("#actPrev"),
    actNext: $("#actNext"),
    sheet: $("#sheet"),
    sheetBackdrop: $("#sheetBackdrop"),
    sheetGrip: $("#sheetGrip"),
    sheetClose: $("#sheetClose"),
    sheetTitle: $("#sheetTitle"),
    sheetInput: $("#sheetInput"),
    sheetList: $("#sheetList"),
    themeColor: $("#themeColor"),
    themeBtn: $("#themeBtn"),
    toast: $("#toast"),
    passkeyAddBtn: $("#passkeyAddBtn"),
    passkeyLoginWrap: $("#passkeyLoginWrap"),
    passkeyLoginBtn: $("#passkeyLoginBtn"),
    loginScreen: $("#loginScreen"),
    loginForm: $("#loginForm"),
    loginUser: $("#loginUser"),
    loginPass: $("#loginPass"),
    passToggle: $("#passToggle"),
    loginSubmit: $("#loginSubmit"),
    loginError: $("#loginError"),
  };

  // ---- Theme (admin-controllable: auto / light / dark) ----
  const THEME_KEY = "reys-theme";
  const THEME_MODES = ["auto", "light", "dark"];
  const THEME_ICONS = {
    auto: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 2a10 10 0 1 0 0 20V2Z"/></svg>',
    light:
      '<svg viewBox="0 0 24 24" class="ic"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-6a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V2a1 1 0 0 1 1-1Zm0 18a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Zm11-7a1 1 0 0 1-1 1h-2a1 1 0 1 1 0-2h2a1 1 0 0 1 1 1ZM5 12a1 1 0 0 1-1 1H2a1 1 0 1 1 0-2h2a1 1 0 0 1 1 1Zm14.07 7.07a1 1 0 0 1-1.41 0l-1.42-1.42a1 1 0 0 1 1.42-1.41l1.41 1.41a1 1 0 0 1 0 1.42ZM7.76 7.76a1 1 0 0 1-1.41 0L4.93 6.34a1 1 0 0 1 1.41-1.41l1.42 1.41a1 1 0 0 1 0 1.42Zm11.31-2.83a1 1 0 0 1 0 1.41l-1.41 1.42a1 1 0 0 1-1.42-1.42l1.42-1.41a1 1 0 0 1 1.41 0ZM7.76 16.24a1 1 0 0 1 0 1.42l-1.42 1.41a1 1 0 0 1-1.41-1.41l1.41-1.42a1 1 0 0 1 1.42 0Z"/></svg>',
    dark: '<svg viewBox="0 0 24 24" class="ic"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  };
  const THEME_LABELS = { auto: "Mavzu: Avto", light: "Mavzu: Yorug'", dark: "Mavzu: Tungi" };

  let themeMode = "auto";
  try { themeMode = localStorage.getItem(THEME_KEY) || "auto"; } catch (_) {}
  if (THEME_MODES.indexOf(themeMode) === -1) themeMode = "auto";

  function effectiveScheme() {
    if (themeMode === "light" || themeMode === "dark") return themeMode;
    if (tg && tg.colorScheme) return tg.colorScheme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function rgbToHex(rgb) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || "");
    if (!m) return null;
    return "#" + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, "0")).join("");
  }

  function syncTelegramChrome() {
    let hex = null;
    try {
      hex = rgbToHex(getComputedStyle(document.body).backgroundColor);
      if (els.themeColor && hex) els.themeColor.setAttribute("content", hex);
    } catch (_) {}
    if (!tg) return;
    // Newer clients accept a hex; older accept only keywords; both are wrapped.
    try { if (tg.setBackgroundColor) tg.setBackgroundColor(hex || "secondary_bg_color"); } catch (_) {}
    try { if (tg.setHeaderColor) tg.setHeaderColor(hex || "secondary_bg_color"); } catch (_) {}
  }

  function applyTheme() {
    const root = document.documentElement;
    if (themeMode === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", themeMode);
    root.style.colorScheme = effectiveScheme();
    if (els.themeBtn) {
      els.themeBtn.innerHTML = THEME_ICONS[themeMode];
      els.themeBtn.setAttribute("aria-label", THEME_LABELS[themeMode]);
      els.themeBtn.title = THEME_LABELS[themeMode];
    }
    syncTelegramChrome();
  }

  function cycleTheme() {
    themeMode = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
    try { localStorage.setItem(THEME_KEY, themeMode); } catch (_) {}
    applyTheme();
    haptic("select");
  }

  // ---- Telegram init ----
  function initTelegram() {
    if (tg) {
      tg.ready();
      tg.expand();
      // Clear any lingering native MainButton (we use a single in-page Save
      // button instead — avoids a stale/duplicate Telegram bottom-bar button).
      if (tg.MainButton) { try { tg.MainButton.hide(); } catch (_) {} }
      // When the user flips their Telegram theme, only follow it in auto mode.
      if (tg.onEvent) tg.onEvent("themeChanged", () => { if (themeMode === "auto") applyTheme(); });
      if (tg.BackButton) tg.BackButton.onClick(onBack);
    }
    applyTheme();
    if (els.themeBtn) els.themeBtn.addEventListener("click", cycleTheme);
    els.saveBtn.addEventListener("click", onSave);
    // Inside Telegram the user is authenticated immediately — load stock now.
    if (inTelegram) loadInventory();
  }

  function haptic(type) {
    if (tg && tg.HapticFeedback) {
      if (type === "select") tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred(type || "light");
    }
  }

  // Telegram BackButton: dismiss the topmost overlay.
  function onBack() {
    if (sheetOpen) { closeSheet(); return; }
    if (!els.activityScreen.hidden) { closeActivity(); return; }
  }

  // ---- Tabs ----
  function setTab(name) {
    state.activeTab = name;
    els.tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    els.panels.report.classList.toggle("is-active", name === "report");
    els.panels.report.hidden = name !== "report";
    els.panels.lost.classList.toggle("is-active", name === "lost");
    els.panels.lost.hidden = name !== "lost";
    // Save only applies to the report tab.
    els.saveBtn.style.display = name === "report" ? "" : "none";
    haptic("select");
  }

  els.tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  // ---- Photos ----
  function renderPhotos() {
    els.photoGrid.innerHTML = "";
    state.photos.forEach((p) => {
      const cell = document.createElement("div");
      cell.className = "thumb";
      const img = document.createElement("img");
      img.src = p.url;
      img.alt = "";
      const del = document.createElement("button");
      del.className = "thumb__del";
      del.type = "button";
      del.setAttribute("aria-label", "O'chirish");
      del.textContent = "×";
      del.addEventListener("click", () => removePhoto(p.id));
      cell.append(img, del);
      els.photoGrid.appendChild(cell);
    });
    els.photoCounter.textContent = `${state.photos.length}/${MAX_PHOTOS}`;
    const full = state.photos.length >= MAX_PHOTOS;
    els.btnGallery.disabled = full;
    els.btnCamera.disabled = full;
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const room = MAX_PHOTOS - state.photos.length;
    if (room <= 0) {
      showToast(`Maksimal ${MAX_PHOTOS} ta rasm`, true);
      return;
    }
    if (files.length > room) showToast(`Faqat ${room} ta rasm qo'shildi`, true);
    files.slice(0, room).forEach((file) => {
      state.photos.push({ id: ++photoSeq, file, url: URL.createObjectURL(file) });
    });
    renderPhotos();
    haptic("light");
  }

  function removePhoto(id) {
    const idx = state.photos.findIndex((p) => p.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(state.photos[idx].url);
    state.photos.splice(idx, 1);
    renderPhotos();
    haptic("light");
  }

  els.btnGallery.addEventListener("click", () => els.inGallery.click());
  els.btnCamera.addEventListener("click", () => els.inCamera.click());
  els.inGallery.addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  els.inCamera.addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

  // ---- Searchable select (bottom sheet), reused by several targets ----
  let sheetTarget = null; // { title, fallback, value(getter), onSelect(t), allowDelete }

  function openSheet(target, focusSearch) {
    if (sheetOpen) return;
    sheetTarget = target;
    els.sheetTitle.textContent = target.title || "Tanlang";
    // Finalize any in-flight close (cancels its fallback timer + listener) so a
    // rapid open->close->open can't get re-hidden by a stale close.
    if (pendingClose) pendingClose.done();
    sheetOpen = true;
    els.sheet.style.transition = "";
    els.sheet.style.transform = "";
    els.sheetBackdrop.classList.remove("is-closing");
    els.sheetBackdrop.hidden = false;
    els.sheet.hidden = false; // toggling display re-triggers the slide-up animation
    els.sheetInput.value = "";
    renderSheet("");
    if (inTelegram && tg.BackButton) tg.BackButton.show();
    if (focusSearch) setTimeout(() => els.sheetInput.focus(), 80);
  }

  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    els.sheetInput.blur();

    els.sheetBackdrop.classList.add("is-closing");
    els.sheet.style.transition = "transform 0.22s cubic-bezier(0.2,0.8,0.2,1)";
    els.sheet.style.transform = "translateY(100%)";

    let finished = false;
    const onEnd = (e) => { if (e.propertyName === "transform") done(); };
    const done = () => {
      if (finished) return;
      finished = true;
      if (pendingClose) { clearTimeout(pendingClose.timer); pendingClose = null; }
      els.sheet.removeEventListener("transitionend", onEnd);
      els.sheet.hidden = true;
      els.sheetBackdrop.hidden = true;
      els.sheetBackdrop.classList.remove("is-closing");
      els.sheet.style.transition = "";
      els.sheet.style.transform = "";
    };
    els.sheet.addEventListener("transitionend", onEnd);
    pendingClose = { done, timer: setTimeout(done, 280) }; // fallback if transitionend doesn't fire

    if (inTelegram && tg.BackButton) tg.BackButton.hide();
  }

  // A type is deletable only if it's a local custom addition not yet persisted
  // to inventory (never used in a saved report/adjustment).
  function isDeletable(t) {
    return state.customTypes.includes(t) && !(t in state.inventory);
  }

  function renderSheet(query) {
    const q = query.trim().toLowerCase();
    const cur = sheetTarget ? sheetTarget.value : "";
    const matches = allTypes().filter((t) => t.toLowerCase().includes(q));
    els.sheetList.innerHTML = "";

    matches.forEach((t) => {
      const selected = t === cur;
      const li = document.createElement("li");
      li.className = "sheet__item" + (selected ? " is-selected" : "");

      const label = document.createElement("span");
      label.className = "sheet__item__label";
      label.textContent = t;
      li.appendChild(label);

      const right = document.createElement("span");
      right.className = "sheet__item__right";
      if (selected) {
        const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        check.setAttribute("viewBox", "0 0 24 24");
        check.setAttribute("class", "check");
        check.innerHTML = '<path d="m9.6 16.6-4.2-4.2 1.4-1.4 2.8 2.8 6-6 1.4 1.4z"/>';
        right.appendChild(check);
      }
      if (isDeletable(t)) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "sheet__del";
        del.setAttribute("aria-label", "O'chirish");
        del.innerHTML =
          '<svg viewBox="0 0 24 24" class="ic"><path d="M18.3 5.7 12 12 5.7 5.7 4.3 7.1 10.6 13.4 4.3 19.7l1.4 1.4L12 14.8l6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3z"/></svg>';
        del.addEventListener("click", (e) => { e.stopPropagation(); deleteType(t); });
        right.appendChild(del);
      }
      li.appendChild(right);

      li.addEventListener("click", () => selectValue(t));
      els.sheetList.appendChild(li);
    });

    // Offer "add custom" when query is non-empty and not an exact existing option.
    const exact = allTypes().some((t) => t.toLowerCase() === q);
    if (q && !exact) {
      const li = document.createElement("li");
      li.className = "sheet__item sheet__item--add";
      li.textContent = `«${query.trim()}» qo'shish`;
      li.addEventListener("click", () => addType(query.trim()));
      els.sheetList.appendChild(li);
    }
  }

  function selectValue(t) {
    if (sheetTarget) sheetTarget.onSelect(t);
    closeSheet();
    haptic("select");
  }

  function addType(value) {
    value = (value || "").trim();
    if (!value) return;
    // Prefer the canonical casing of an existing option; only add if new.
    const existing = allTypes().find((t) => t.toLowerCase() === value.toLowerCase());
    if (existing) { selectValue(existing); return; }
    state.customTypes.push(value);
    selectValue(value);
  }

  function deleteType(t) {
    const idx = state.customTypes.indexOf(t);
    if (idx === -1) return;
    state.customTypes.splice(idx, 1);
    // If any selector currently points at the deleted type, reset it.
    if (state.type === t) reysTypeTarget.onSelect(reysTypeTarget.fallback);
    if (state.adjFrom === t) adjFromTarget.onSelect("");
    if (state.adjTo === t) adjToTarget.onSelect("");
    renderSheet(els.sheetInput.value); // keep the sheet open
    haptic("light");
  }

  // Selector targets
  const reysTypeTarget = {
    title: "Tovar turi", fallback: "akb",
    get value() { return state.type; },
    onSelect(t) { state.type = t || "akb"; els.typeValue.textContent = state.type; },
  };
  const adjFromTarget = {
    title: "Qaysi turdan ayirish", fallback: "",
    get value() { return state.adjFrom; },
    onSelect(t) { state.adjFrom = t; renderAdjust(); },
  };
  const adjToTarget = {
    title: "Qaysi turga qo'shish", fallback: "",
    get value() { return state.adjTo; },
    onSelect(t) { state.adjTo = t; renderAdjust(); },
  };

  els.typeSelect.addEventListener("click", () => openSheet(reysTypeTarget, false));
  els.typePencil.addEventListener("click", () => openSheet(reysTypeTarget, true));
  els.adjFromSelect.addEventListener("click", () => openSheet(adjFromTarget, false));
  els.adjToSelect.addEventListener("click", () => openSheet(adjToTarget, false));
  els.sheetBackdrop.addEventListener("click", closeSheet);
  els.sheetClose.addEventListener("click", closeSheet);
  els.sheetInput.addEventListener("input", (e) => renderSheet(e.target.value));
  els.sheetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = els.sheetInput.value.trim();
      if (v) addType(v);
    }
  });
  // Escape closes the topmost overlay (hardware keyboards / desktop / browser).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (sheetOpen) closeSheet();
    else if (!els.activityScreen.hidden) closeActivity();
  });

  // Swipe-down on the grip to dismiss.
  let drag = null;
  els.sheetGrip.addEventListener("touchstart", (e) => {
    drag = { startY: e.touches[0].clientY, dy: 0 };
    els.sheet.style.transition = "none";
  }, { passive: true });
  els.sheetGrip.addEventListener("touchmove", (e) => {
    if (!drag) return;
    drag.dy = Math.max(0, e.touches[0].clientY - drag.startY);
    els.sheet.style.transform = `translateY(${drag.dy}px)`;
  }, { passive: true });
  function snapSheetBack() {
    drag = null;
    els.sheet.style.transition = "transform 0.2s cubic-bezier(0.2,0.8,0.2,1)";
    els.sheet.style.transform = "";
  }
  els.sheetGrip.addEventListener("touchend", () => {
    if (!drag) return;
    const dy = drag.dy;
    if (dy > 70) {
      drag = null;
      els.sheet.style.transition = "";
      closeSheet();
    } else {
      snapSheetBack();
    }
  });
  // OS/browser may cancel the gesture (system swipe takeover) — reset cleanly.
  els.sheetGrip.addEventListener("touchcancel", () => {
    if (drag) snapSheetBack();
  });

  // ---- Coefficient ----
  els.coefChips.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      els.coefChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const mode = chip.dataset.mode;
      state.coef.mode = mode;
      if (mode === "custom") {
        els.coefCustomWrap.hidden = false;
        setTimeout(() => els.coefCustom.focus(), 60);
      } else {
        els.coefCustomWrap.hidden = true;
        state.coef.value = mode === "none" ? 0 : parseFloat(chip.dataset.value);
      }
      haptic("select");
    });
  });
  els.coefCustom.addEventListener("input", (e) => {
    state.coef.value = parseFloat(e.target.value.replace(",", "."));
  });

  // ---- Weight ----
  els.weight.addEventListener("input", (e) => { state.weightRaw = e.target.value; });

  // ---- Inventory / balances ----
  const balanceOf = (t) => Number(state.inventory[t] || 0);
  const fmtKg = (n) => `${(Math.round(n * 100) / 100).toLocaleString("en-US")} kg`;

  async function loadInventory() {
    try {
      const res = await fetch("/api/inventory", { headers: authHeaders() });
      if (!res.ok) return;
      const json = await res.json();
      state.inventory = json.inventory || {};
      renderBalances();
      renderAdjust();
    } catch (_) {}
  }

  function renderBalances() {
    const entries = Object.entries(state.inventory).sort((a, b) => a[0].localeCompare(b[0]));
    els.balances.innerHTML = "";
    entries.forEach(([t, w]) => {
      const cell = document.createElement("div");
      cell.className = "bal-cell";
      const name = document.createElement("div");
      name.className = "bal-cell__name";
      name.textContent = t;
      const val = document.createElement("div");
      val.className = "bal-cell__val";
      val.innerHTML = `${(Math.round(Number(w) * 100) / 100).toLocaleString("en-US")}<span> kg</span>`;
      cell.append(name, val);
      els.balances.appendChild(cell);
    });
  }

  // ---- Adashgan yuklar (transfer) ----
  function setSelectLabel(el, val, placeholder) {
    el.textContent = val || placeholder;
    el.classList.toggle("select__value--muted", !val);
  }
  function renderAdjust() {
    setSelectLabel(els.adjFromValue, state.adjFrom, "Tanlang");
    setSelectLabel(els.adjToValue, state.adjTo, "Tanlang");
    els.adjFromBal.innerHTML = state.adjFrom ? `Mavjud: <strong>${fmtKg(balanceOf(state.adjFrom))}</strong>` : "";
    els.adjToBal.innerHTML = state.adjTo ? `Mavjud: <strong>${fmtKg(balanceOf(state.adjTo))}</strong>` : "";
    els.adjSaveBtn.textContent = state.adjFrom && state.adjTo ? `${state.adjFrom} → ${state.adjTo}` : "Saqlash";
  }

  els.adjWeight.addEventListener("input", (e) => { state.adjWeightRaw = e.target.value; });

  let adjusting = false;
  async function onAdjustSave() {
    if (adjusting) return;
    const weight = parseFloat(String(state.adjWeightRaw).replace(",", "."));
    if (!state.adjFrom || !state.adjTo) { showToast("Ikkala tovar turini tanlang", true); haptic("rigid"); return; }
    if (state.adjFrom === state.adjTo) { showToast("Tovar turlari bir xil bo'lmasin", true); haptic("rigid"); return; }
    if (!isFinite(weight) || weight <= 0) { showToast("Og'irlikni to'g'ri kiriting", true); haptic("rigid"); return; }

    adjusting = true;
    els.adjSaveBtn.disabled = true;
    const restoreText = els.adjSaveBtn.textContent;
    els.adjSaveBtn.textContent = "Saqlanmoqda…";
    try {
      const res = await fetch("/api/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          init_data: inTelegram ? tg.initData : "",
          from_type: state.adjFrom,
          to_type: state.adjTo,
          weight,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Xatolik");
      state.inventory = json.balances || state.inventory;
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      showToast("Saqlandi ✓");
      state.adjWeightRaw = "";
      els.adjWeight.value = "";
      renderBalances();
      renderAdjust();
    } catch (e) {
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
      showToast(e.message || "Xatolik", true);
    } finally {
      adjusting = false;
      els.adjSaveBtn.disabled = false;
      els.adjSaveBtn.textContent = restoreText;
    }
  }
  els.adjSaveBtn.addEventListener("click", onAdjustSave);

  // ---- Faolligim (activity log) ----
  function fmtTs(ts) {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const ICON_REYS = '<svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5Zm10 1v3h3l-3-3Z"/></svg>';
  const ICON_ADJ = '<svg viewBox="0 0 24 24"><path d="M7 7h9l-2.5-2.5L15 3l5 5-5 5-1.5-1.5L16 9H7V7Zm10 10H8l2.5 2.5L9 21l-5-5 5-5 1.5 1.5L8 15h9v2Z"/></svg>';

  function renderActivity(items) {
    els.activityList.innerHTML = "";
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "act__empty";
      p.textContent = "Bu kunda faollik yo'q";
      els.activityList.appendChild(p);
      return;
    }
    items.forEach((a) => {
      const row = document.createElement("div");
      row.className = "act";
      const isReys = a.action === "reys";
      const icon = document.createElement("div");
      icon.className = "act__icon " + (isReys ? "act__icon--reys" : "act__icon--adjust");
      icon.innerHTML = isReys ? ICON_REYS : ICON_ADJ;
      const main = document.createElement("div");
      main.className = "act__main";
      const title = document.createElement("div");
      title.className = "act__title";
      const sub = document.createElement("div");
      sub.className = "act__sub";
      if (isReys) {
        title.textContent = `Reys: ${a.tovar_turi} +${fmtKg(a.net)}`;
        const coefTxt = a.coefficient ? `, koef ${a.coefficient}` : "";
        sub.textContent = `og'irlik ${fmtKg(a.weight)}${coefTxt} · ${a.photos || 0} rasm`;
      } else {
        title.textContent = `Ko'chirish: ${a.from_type} → ${a.to_type}`;
        sub.textContent = fmtKg(a.weight);
      }
      main.append(title, sub);
      const time = document.createElement("div");
      time.className = "act__time";
      time.textContent = fmtTs(a.ts);
      row.append(icon, main, time);
      els.activityList.appendChild(row);
    });
  }

  // Local day helpers (bounds in the admin's own timezone).
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function dayBounds(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const start = Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
    const end = Math.floor(new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime() / 1000);
    return { start, end };
  }
  function shiftDay(dateStr, delta) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const nd = new Date(y, m - 1, d + delta);
    const p = (n) => String(n).padStart(2, "0");
    return `${nd.getFullYear()}-${p(nd.getMonth() + 1)}-${p(nd.getDate())}`;
  }

  async function loadActivityFor(dateStr) {
    const today = todayStr();
    if (dateStr > today) dateStr = today; // never navigate to the future
    els.actDate.value = dateStr;
    els.actDate.max = today;
    els.actNext.disabled = dateStr >= today;
    els.activityList.innerHTML = '<p class="act__empty">Yuklanmoqda…</p>';
    const { start, end } = dayBounds(dateStr);
    try {
      const res = await fetch(`/api/activity?start=${start}&end=${end}`, { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      renderActivity((res.ok && json.activity) || []);
    } catch (_) {
      renderActivity([]);
    }
  }

  function openActivity() {
    els.activityScreen.hidden = false;
    document.body.classList.add("locked");
    if (inTelegram && tg.BackButton) tg.BackButton.show();
    loadActivityFor(todayStr()); // default: today only
  }

  els.actDate.addEventListener("change", () => loadActivityFor(els.actDate.value || todayStr()));
  els.actPrev.addEventListener("click", () => loadActivityFor(shiftDay(els.actDate.value || todayStr(), -1)));
  els.actNext.addEventListener("click", () => loadActivityFor(shiftDay(els.actDate.value || todayStr(), 1)));
  function closeActivity() {
    els.activityScreen.hidden = true;
    document.body.classList.remove("locked");
    if (inTelegram && tg.BackButton && !sheetOpen) tg.BackButton.hide();
  }
  els.activityBtn.addEventListener("click", openActivity);
  els.activityClose.addEventListener("click", closeActivity);

  // ---- Save ----
  function collect() {
    const weight = parseFloat(state.weightRaw.replace(",", "."));
    let coefValue = 0;
    if (state.coef.mode === "none") coefValue = 0;
    else if (state.coef.mode === "fixed") coefValue = state.coef.value;
    else coefValue = parseFloat(String(els.coefCustom.value).replace(",", "."));

    return {
      type: state.type,
      coefficient_mode: state.coef.mode,
      coefficient: coefValue,
      weight,
      photos: state.photos.map((p) => p.file),
    };
  }

  function validate(data) {
    if (!data.photos.length) return "Kamida 1 ta rasm qo'shing";
    if (!isFinite(data.weight) || data.weight <= 0) return "Og'irlikni to'g'ri kiriting";
    if (state.coef.mode === "custom" && (!isFinite(data.coefficient) || data.coefficient <= 0))
      return "Koeffitsientni kiriting";
    return null;
  }

  let saving = false;
  async function onSave() {
    if (saving) return;
    const data = collect();
    const err = validate(data);
    if (err) {
      showToast(err, true);
      haptic("rigid");
      return;
    }

    saving = true;
    setBusy(true);

    const fd = new FormData();
    fd.append("init_data", tg ? tg.initData : "");
    fd.append("type", data.type);
    fd.append("coefficient", String(data.coefficient));
    fd.append("coefficient_mode", data.coefficient_mode);
    fd.append("weight", String(data.weight));
    data.photos.forEach((file, i) => fd.append("photos", file, file.name || `photo_${i}.jpg`));

    try {
      const res = await fetch("/api/report", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Server xatosi");

      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      showToast(json.balance != null ? `Saqlandi ✓  ${data.type}: ${fmtKg(json.balance)}` : "Saqlandi ✓");
      resetForm();
      loadInventory();
    } catch (e) {
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
      showToast(e.message || "Xatolik", true);
    } finally {
      saving = false;
      setBusy(false);
    }
  }

  function setBusy(busy) {
    els.saveBtn.disabled = busy;
    els.saveBtn.textContent = busy ? "Saqlanmoqda…" : "Saqlash";
  }

  function resetForm() {
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    state.type = "akb";
    state.coef = { mode: "none", value: 0 };
    state.weightRaw = "";
    els.typeValue.textContent = "akb";
    els.weight.value = "";
    els.coefCustom.value = "";
    els.coefCustomWrap.hidden = true;
    els.coefChips.querySelectorAll(".chip").forEach((c, i) => c.classList.toggle("is-active", i === 0));
    renderPhotos();
  }

  // ---- Toast ----
  let toastTimer = null;
  function showToast(msg, isErr) {
    els.toast.textContent = msg;
    els.toast.className = "toast" + (isErr ? " toast--err" : "");
    els.toast.hidden = false;
    // restart entrance animation on rapid successive calls
    els.toast.style.animation = "none";
    void els.toast.offsetWidth;
    els.toast.style.animation = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 2400);
  }

  // ---- Browser login gate (username / password) ----
  // Inside Telegram the user is already authenticated via initData, so the
  // login screen is never shown there. In a plain browser we require a valid
  // session cookie; otherwise we show the username/password form.
  const hasWebAuthn = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

  async function gateAccess() {
    if (inTelegram) return;
    try {
      const me = await (await fetch("/api/auth/me")).json();
      if (me && me.authenticated) { onAuthed(); return; }
    } catch (_) {}
    showLogin();
  }

  // Browser user is authenticated → reveal the "add passkey" action + load stock.
  function onAuthed() {
    if (!inTelegram && hasWebAuthn) els.passkeyAddBtn.hidden = false;
    loadInventory();
  }

  function showLoginError(msg) {
    els.loginError.textContent = msg;
    els.loginError.hidden = false;
  }

  function showLogin() {
    document.body.classList.add("locked");
    els.loginScreen.hidden = false;
    if (hasWebAuthn) els.passkeyLoginWrap.hidden = false;
    setTimeout(() => els.loginUser.focus(), 80);
  }

  // ---- WebAuthn helpers ----
  const _b64uToBuf = (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    s += "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  };
  const _bufToB64u = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  async function registerPasskey() {
    if (!hasWebAuthn) { showToast("Bu qurilma passkey'ni qo'llab-quvvatlamaydi", true); return; }
    try {
      const begin = await (await fetch("/api/webauthn/register/begin", { method: "POST" })).json();
      if (begin.detail) throw new Error(begin.detail);
      const o = begin.options;
      o.challenge = _b64uToBuf(o.challenge);
      o.user.id = _b64uToBuf(o.user.id);
      if (o.excludeCredentials) o.excludeCredentials = o.excludeCredentials.map((c) => ({ ...c, id: _b64uToBuf(c.id) }));
      const cred = await navigator.credentials.create({ publicKey: o });
      const payload = {
        id: cred.id,
        rawId: _bufToB64u(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: _bufToB64u(cred.response.clientDataJSON),
          attestationObject: _bufToB64u(cred.response.attestationObject),
          transports: cred.response.getTransports ? cred.response.getTransports() : [],
        },
        clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      };
      const res = await fetch("/api/webauthn/register/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: begin.challenge_id, credential: payload }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "xato");
      showToast("Passkey o'rnatildi ✓");
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "AbortError") return; // user cancelled
      showToast("Passkey o'rnatib bo'lmadi", true);
    }
  }

  async function loginWithPasskey() {
    if (!hasWebAuthn) return;
    els.loginError.hidden = true;
    try {
      const begin = await (await fetch("/api/webauthn/auth/begin", { method: "POST" })).json();
      if (begin.detail) throw new Error(begin.detail);
      const o = begin.options;
      o.challenge = _b64uToBuf(o.challenge);
      if (o.allowCredentials) o.allowCredentials = o.allowCredentials.map((c) => ({ ...c, id: _b64uToBuf(c.id) }));
      const asr = await navigator.credentials.get({ publicKey: o });
      const payload = {
        id: asr.id,
        rawId: _bufToB64u(asr.rawId),
        type: asr.type,
        response: {
          clientDataJSON: _bufToB64u(asr.response.clientDataJSON),
          authenticatorData: _bufToB64u(asr.response.authenticatorData),
          signature: _bufToB64u(asr.response.signature),
          userHandle: asr.response.userHandle ? _bufToB64u(asr.response.userHandle) : null,
        },
        clientExtensionResults: asr.getClientExtensionResults ? asr.getClientExtensionResults() : {},
      };
      const res = await fetch("/api/webauthn/auth/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: begin.challenge_id, credential: payload }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Passkey xato");
      els.loginScreen.hidden = true;
      document.body.classList.remove("locked");
      onAuthed();
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "AbortError") return; // cancelled
      showLoginError("Passkey bilan kirib bo'lmadi");
    }
  }

  let loggingIn = false;
  async function onLoginSubmit(e) {
    e.preventDefault();
    if (loggingIn) return;
    const username = els.loginUser.value.trim();
    const password = els.loginPass.value;
    if (!username || !password) {
      showLoginError("Foydalanuvchi nomi va parolni kiriting");
      return;
    }
    loggingIn = true;
    els.loginError.hidden = true;
    els.loginSubmit.disabled = true;
    els.loginSubmit.textContent = "Kirilmoqda…";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Kirish rad etildi");
      els.loginScreen.hidden = true;
      document.body.classList.remove("locked");
      els.loginPass.value = "";
      onAuthed();
    } catch (err) {
      showLoginError(err.message || "Xatolik");
      els.loginPass.select();
    } finally {
      loggingIn = false;
      els.loginSubmit.disabled = false;
      els.loginSubmit.textContent = "Kirish";
    }
  }

  function togglePassword() {
    const show = els.loginPass.type === "password";
    els.loginPass.type = show ? "text" : "password";
    els.passToggle.setAttribute("aria-label", show ? "Parolni yashirish" : "Parolni ko'rsatish");
    els.passToggle.classList.toggle("is-on", show);
  }

  if (els.loginForm) els.loginForm.addEventListener("submit", onLoginSubmit);
  if (els.passToggle) els.passToggle.addEventListener("click", togglePassword);
  if (els.passkeyLoginBtn) els.passkeyLoginBtn.addEventListener("click", loginWithPasskey);
  if (els.passkeyAddBtn) els.passkeyAddBtn.addEventListener("click", registerPasskey);

  // ---- Boot ----
  initTelegram();
  renderPhotos();
  renderAdjust();
  renderBalances();
  gateAccess();
})();
