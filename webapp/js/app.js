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

  // iOS gets its own (still lightweight) motion curve; Android keeps the current feel.
  const isIOS =
    (tg && tg.platform === "ios") ||
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) document.documentElement.classList.add("ios");

  const MAX_PHOTOS = 10;
  const DEFAULT_TYPES = [
    "akb", "triton", "izi", "navo", "xabib", "jet", "jon", "top", "uztez", "mandarin",
    "oneway", "x637", "x517", "redwing",
  ];
  const OBSHIY_SECTIONS = ["top", "topchiqgan", "bizda", "chiqgan"];

  // Obshiy ves sub-sections that share one photo+code+weight form. `codeRequired`
  // toggles whether karobka kodi is mandatory (Bizda qoladigan lets it be blank).
  // Obshiy-ves shared-form sections + the two backend-wired work-area tabs.
  // `codeRequired` only applies to the shared form; reys/adjust have their own forms.
  const SECTIONS = {
    top: { title: "Top", codeRequired: true },
    topchiqgan: { title: "Topdan chiqgan", codeRequired: false },
    bizda: { title: "Bizda qoladigan", codeRequired: false },
    chiqgan: { title: "Bizdan chiqgan", codeRequired: false },
    reys: { title: "Reys hisoboti" },
    adjust: { title: "Adashgan yuklar" },
  };
  const ENTRIES_PAGE = 15;

  // ---- App state ----
  const state = {
    activeTab: "report",
    reportId: null,
    reportName: "",
    photos: [], // reys photos { id, file, url }
    adjPhotos: [], // adashgan photos
    topPhotos: [], // shared Obshiy-ves form photos (one section open at a time)
    topWeightRaw: "",
    topCoef: { mode: "none", value: 0 },
    topCodeFree: false, // pencil unlocked → karobka kodi accepts any character
    topFast: false, // fast-mode capture loop
    reysFast: false, // kargolarga tarqatish fast-mode capture loop
    formSection: "top", // which SECTIONS entry the form is currently editing
    entries: { top: [], topchiqgan: [], bizda: [], chiqgan: [], reys: [], adjust: [] },
    type: "akb",
    customTypes: [], // server-persisted user-added types
    inventory: {}, // tovar_turi -> weight (from server)
    coef: { mode: "none", value: 0, boxWeight: 0 }, // mode: none | box | fixed | custom
    weightRaw: "",
    adjFrom: "",
    adjTo: "",
    adjWeightRaw: "",
  };

  let remember = false;
  try { remember = localStorage.getItem("reys-remember") === "1"; } catch (_) {}
  try { state.topFast = localStorage.getItem("reys-top-fast") === "1"; } catch (_) {}
  try { state.reysFast = localStorage.getItem("reys-fast") === "1"; } catch (_) {}
  let homeReports = [];
  let homeReportsMax = 25;
  let homeArchiveOpen = false;
  let homeRenderKey = "";
  let reportsLoaded = false;
  let routeRestoring = false;
  let suppressTabRoute = false;
  let activityReturnRoute = "";

  function parseRoute() {
    let raw = (location.hash || "").replace(/^#\/?/, "");
    try { raw = decodeURIComponent(raw); } catch (_) {}
    const parts = raw.split("/").filter(Boolean);
    if (!parts.length || parts[0] === "reports") return { kind: "reports" };
    if (parts[0] !== "report" || !parts[1]) return { kind: "reports" };
    const reportId = Number(parts[1]);
    const page = parts[2] || "menu";
    return {
      kind: "report",
      reportId,
      page,
      section: parts[3] || "",
    };
  }

  function setRoute(path, replace) {
    if (routeRestoring) return;
    const next = `#${path.replace(/^#?\/?/, "/")}`;
    if (location.hash === next) return;
    try {
      if (replace) history.replaceState(null, "", next);
      else history.pushState(null, "", next);
    } catch (_) {
      location.hash = next;
    }
  }

  function findCachedReport(reportId) {
    return homeReports.find((r) => Number(r.id) === Number(reportId));
  }

  // iOS numeric keyboards can emit a comma as the decimal separator — normalize
  // to a dot and drop stray chars / extra dots so parseFloat works.
  function cleanDecimal(v) {
    v = String(v == null ? "" : v).replace(/,/g, ".").replace(/[^\d.]/g, "");
    const i = v.indexOf(".");
    if (i !== -1) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, "");
    return v;
  }

  function sameNum(a, b) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= 0.0001;
  }

  function sameText(a, b) {
    return String(a || "").trim() === String(b || "").trim();
  }

  // Union of default types, inventory types, and locally-added custom types.
  function allTypes() {
    const set = new Set(DEFAULT_TYPES);
    state.customTypes.forEach((t) => set.add(t));
    Object.entries(state.inventory).forEach(([t, w]) => {
      if (Number(w) !== 0) set.add(t);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  async function loadTypes() {
    try {
      const res = await fetch("/api/types", { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return;
      state.customTypes = Array.isArray(json.custom) ? json.custom : [];
      if (sheetOpen) renderSheet(els.sheetInput.value || "");
    } catch (_) {}
  }

  const authHeaders = () => (inTelegram ? { "X-Telegram-Init-Data": tg.initData } : {});

  function closestNode(node, selector) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return el && el.closest ? el.closest(selector) : null;
  }

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
    camModal: $("#camModal"),
    camVideo: $("#camVideo"),
    camClose: $("#camClose"),
    camFlip: $("#camFlip"),
    camShot: $("#camShot"),
    camCanvas: $("#camCanvas"),
    camZoom: $("#camZoom"),
    lightbox: $("#lightbox"),
    lightboxImg: $("#lightboxImg"),
    lightboxClose: $("#lightboxClose"),
    lightboxDel: $("#lightboxDel"),
    lightboxPrev: $("#lightboxPrev"),
    lightboxNext: $("#lightboxNext"),
    lightboxCount: $("#lightboxCount"),
    lightboxCaption: $("#lightboxCaption"),
    lightboxCapMain: $("#lightboxCapMain"),
    lightboxCapSub: $("#lightboxCapSub"),
    lightboxEdit: $("#lightboxEdit"),
    lightboxEditPanel: $("#lightboxEditPanel"),
    lbEditTitle: $("#lbEditTitle"),
    lbEditNameLabel: $("#lbEditNameLabel"),
    lbEditName: $("#lbEditName"),
    lbEditWeight: $("#lbEditWeight"),
    lbEditCoefRow: $("#lbEditCoefRow"),
    lbEditCoefLabel: $("#lbEditCoefLabel"),
    lbEditCoef: $("#lbEditCoef"),
    lbEditCancel: $("#lbEditCancel"),
    lbEditSave: $("#lbEditSave"),
    reysViewBtn: $("#reysViewBtn"),
    reysViewCount: $("#reysViewCount"),
    adjViewBtn: $("#adjViewBtn"),
    adjViewCount: $("#adjViewCount"),
    typeSelect: $("#typeSelect"),
    typeValue: $("#typeValue"),
    typePencil: $("#typePencil"),
    coefChips: $("#coefChips"),
    coefBoxMenu: $("#coefBoxMenu"),
    coefCustomWrap: $("#coefCustomWrap"),
    coefCustom: $("#coefCustom"),
    weight: $("#weight"),
    weightQuickSave: $("#weightQuickSave"),
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
    // reports / home
    backHomeBtn: $("#backHomeBtn"),
    reportName: $("#reportName"),
    settingsBtn: $("#settingsBtn"),
    homeScreen: $("#homeScreen"),
    homeThemeBtn: $("#homeThemeBtn"),
    newReportBtn: $("#newReportBtn"),
    homeHint: $("#homeHint"),
    reportList: $("#reportList"),
    // report section menu
    menuScreen: $("#menuScreen"),
    menuTitle: $("#menuTitle"),
    menuBackBtn: $("#menuBackBtn"),
    menuTotalBtn: $("#menuTotalBtn"),
    menuTotalXls: $("#menuTotalXls"),
    menuDistBtn: $("#menuDistBtn"),
    menuDistXls: $("#menuDistXls"),
    // Obshiy ves submenu
    obshiyScreen: $("#obshiyScreen"),
    obshiyBackBtn: $("#obshiyBackBtn"),
    obshiyTopBtn: $("#obshiyTopBtn"),
    obshiyTopChiqganBtn: $("#obshiyTopChiqganBtn"),
    obshiyBizdaBtn: $("#obshiyBizdaBtn"),
    obshiyChiqganBtn: $("#obshiyChiqganBtn"),
    // Shared Obshiy-ves form (Top / Bizda qoladigan / Bizdan chiqgan)
    topScreen: $("#topScreen"),
    topTitle: $("#topTitle"),
    topBackBtn: $("#topBackBtn"),
    topViewBtn: $("#topViewBtn"),
    topViewCount: $("#topViewCount"),
    topPhotoGrid: $("#topPhotoGrid"),
    topPhotoCounter: $("#topPhotoCounter"),
    topBtnGallery: $("#topBtnGallery"),
    topBtnCamera: $("#topBtnCamera"),
    topCodeLabel: $("#topCodeLabel"),
    topCode: $("#topCode"),
    topCodePencil: $("#topCodePencil"),
    topCoefChips: $("#topCoefChips"),
    topCoefCustomWrap: $("#topCoefCustomWrap"),
    topCoefCustom: $("#topCoefCustom"),
    topWeight: $("#topWeight"),
    topFast: $("#topFast"),
    topSave: $("#topSave"),
    // Saved-entries viewer
    entriesScreen: $("#entriesScreen"),
    entriesBackBtn: $("#entriesBackBtn"),
    entriesTitle: $("#entriesTitle"),
    entriesList: $("#entriesList"),
    entriesActions: $("#entriesActions"),
    entriesSendUnsentBtn: $("#entriesSendUnsentBtn"),
    entriesResendSentBtn: $("#entriesResendSentBtn"),
    entriesSendSelectedBtn: $("#entriesSendSelectedBtn"),
    entriesPager: $("#entriesPager"),
    entriesPrev: $("#entriesPrev"),
    entriesNext: $("#entriesNext"),
    entriesPageLabel: $("#entriesPageLabel"),
    // entry actions (kebab menu)
    entryActBackdrop: $("#entryActBackdrop"),
    entryActSheet: $("#entryActSheet"),
    entryEditBtn: $("#entryEditBtn"),
    entryDeleteBtn: $("#entryDeleteBtn"),
    nameBackdrop: $("#nameBackdrop"),
    nameSheet: $("#nameSheet"),
    nameClose: $("#nameClose"),
    nameInput: $("#nameInput"),
    nameSave: $("#nameSave"),
    nameError: $("#nameError"),
    setBackdrop: $("#setBackdrop"),
    setSheet: $("#setSheet"),
    setClose: $("#setClose"),
    rememberToggle: $("#rememberToggle"),
    reysFastToggle: $("#reysFastToggle"),
    zeroCoefBtn: $("#zeroCoefBtn"),
    outboxDiagBtn: $("#outboxDiagBtn"),
    outboxBackdrop: $("#outboxBackdrop"),
    outboxSheet: $("#outboxSheet"),
    outboxClose: $("#outboxClose"),
    outboxRefresh: $("#outboxRefresh"),
    outboxSync: $("#outboxSync"),
    outboxSummary: $("#outboxSummary"),
    outboxList: $("#outboxList"),
    // adashgan photos
    adjPhotoGrid: $("#adjPhotoGrid"),
    adjPhotoCounter: $("#adjPhotoCounter"),
    adjBtnGallery: $("#adjBtnGallery"),
    adjBtnCamera: $("#adjBtnCamera"),
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
    document.querySelectorAll(".js-theme").forEach((b) => {
      b.innerHTML = THEME_ICONS[themeMode];
      b.setAttribute("aria-label", THEME_LABELS[themeMode]);
      b.title = THEME_LABELS[themeMode];
    });
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
    document.querySelectorAll(".js-theme").forEach((b) => b.addEventListener("click", cycleTheme));
    els.saveBtn.addEventListener("click", onSave);
    if (els.weightQuickSave) els.weightQuickSave.addEventListener("click", onSave);
    // Inside Telegram the user is authenticated immediately — go to the home list.
    if (inTelegram) showHome();
  }

  // Show the Telegram BackButton whenever we're not at the home root.
  function syncBackButton() {
    if (!inTelegram || !tg.BackButton) return;
    const overlay =
      sheetOpen ||
      !els.camModal.hidden || !els.lightbox.hidden || !els.activityScreen.hidden ||
      !els.entriesScreen.hidden || !els.entryActSheet.hidden ||
      !els.nameSheet.hidden || !els.setSheet.hidden || !els.outboxSheet.hidden;
    if (overlay || (state.reportId && els.homeScreen.hidden)) tg.BackButton.show();
    else tg.BackButton.hide();
  }

  // `body.locked` (overflow:hidden) must stay on while ANY full-screen overlay or
  // sheet is open. It's a plain class (not ref-counted), so closing one layer
  // (lightbox/camera) must recompute it, not blindly drop it — otherwise the page
  // scroll-unlocks behind a still-open .screen and rubber-bands on iOS.
  function anyOverlayOpen() {
    return (
      sheetOpen ||
      !els.homeScreen.hidden || !els.menuScreen.hidden || !els.obshiyScreen.hidden ||
      !els.topScreen.hidden || !els.entriesScreen.hidden || !els.activityScreen.hidden ||
      !els.camModal.hidden || !els.lightbox.hidden ||
      !els.nameSheet.hidden || !els.setSheet.hidden || !els.outboxSheet.hidden || !els.entryActSheet.hidden
    );
  }
  function syncLock() { document.body.classList.toggle("locked", anyOverlayOpen()); }

  function haptic(type) {
    if (tg && tg.HapticFeedback) {
      if (type === "select") tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred(type || "light");
    }
  }

  // Telegram BackButton: dismiss the topmost overlay, else go home.
  function onBack() {
    if (!els.lightbox.hidden) { closeLightbox(); return; }
    if (!els.camModal.hidden) { closeCamera(); return; }
    if (!els.entryActSheet.hidden) { closeEntryActions(); return; }
    if (!els.outboxSheet.hidden) { closeOutboxDiag(); return; }
    if (!els.nameSheet.hidden) { closeNameSheet(); syncBackButton(); return; }
    if (!els.setSheet.hidden) { closeSettings(); syncBackButton(); return; }
    if (sheetOpen) { closeSheet(); return; }
    if (!els.activityScreen.hidden) { closeActivity(); return; }
    if (!els.entriesScreen.hidden) { closeEntries(); return; }   // viewer → form
    if (!els.topScreen.hidden) { formBack(); return; }           // form → Obshiy submenu
    if (!els.obshiyScreen.hidden) { showMenu(); return; }        // Obshiy → report menu
    if (!els.menuScreen.hidden) { showHome(); return; }          // menu → reports list
    if (state.reportId && els.homeScreen.hidden) { showMenu(); return; } // work area → menu
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
    if (!suppressTabRoute && workAreaVisible()) {
      setRoute(`/report/${state.reportId}/kargo/${name === "lost" ? "adjust" : "reys"}`, true);
    }
    haptic("select");
  }

  els.tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  // ---- Photos (two independent sets: reys "photos", adashgan "adjPhotos") ----
  let activePk = "photos"; // which set the gallery/camera currently targets
  let savingTop = false;

  function updateTopSaveAvailability() {
    if (!els.topSave) return;
    const missingPhoto = state.topPhotos.length === 0;
    els.topSave.disabled = savingTop || missingPhoto;
    els.topSave.title = missingPhoto ? "Kamida 1 ta rasm qo'shing" : "";
  }

  function photoEls(pk) {
    if (pk === "adjPhotos")
      return { grid: els.adjPhotoGrid, counter: els.adjPhotoCounter, bg: els.adjBtnGallery, bc: els.adjBtnCamera };
    if (pk === "topPhotos")
      return { grid: els.topPhotoGrid, counter: els.topPhotoCounter, bg: els.topBtnGallery, bc: els.topBtnCamera };
    return { grid: els.photoGrid, counter: els.photoCounter, bg: els.btnGallery, bc: els.btnCamera };
  }

  function renderPhotos(pk) {
    const e = photoEls(pk);
    const arr = state[pk];
    e.grid.innerHTML = "";
    arr.forEach((p) => {
      const cell = document.createElement("div");
      cell.className = "thumb";
      const img = document.createElement("img");
      img.src = p.url;
      img.alt = "";
      img.addEventListener("click", () => openLightbox(p, pk));
      const del = document.createElement("button");
      del.className = "thumb__del";
      del.type = "button";
      del.setAttribute("aria-label", "O'chirish");
      del.textContent = "×";
      del.addEventListener("click", () => removePhoto(p.id, pk));
      cell.append(img, del);
      e.grid.appendChild(cell);
    });
    e.counter.textContent = `${arr.length}/${MAX_PHOTOS}`;
    const full = arr.length >= MAX_PHOTOS;
    e.bg.disabled = full;
    e.bc.disabled = full;
    if (pk === "topPhotos") updateTopSaveAvailability();
  }
  function renderAllPhotos() { renderPhotos("photos"); renderPhotos("adjPhotos"); renderPhotos("topPhotos"); }

  function addFiles(fileList, pk) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const arr = state[pk];
    const room = MAX_PHOTOS - arr.length;
    if (room <= 0) { showToast(`Maksimal ${MAX_PHOTOS} ta rasm`, true); return; }
    if (files.length > room) showToast(`Faqat ${room} ta rasm qo'shildi`, true);
    files.slice(0, room).forEach((file) => {
      arr.push({ id: ++photoSeq, file, url: URL.createObjectURL(file) });
    });
    renderPhotos(pk);
    haptic("light");
    if (pk === "photos" && state.reysFast) {
      setTimeout(() => { try { els.weight.focus(); } catch (_) {} }, 60);
    }
    if (pk === "topPhotos" && state.topFast) {
      setTimeout(() => { try { els.topCode.focus(); } catch (_) {} }, 60);
    }
  }

  function removePhoto(id, pk) {
    const arr = state[pk];
    const idx = arr.findIndex((p) => p.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(arr[idx].url);
    arr.splice(idx, 1);
    renderPhotos(pk);
    haptic("light");
  }

  els.btnGallery.addEventListener("click", () => { activePk = "photos"; els.inGallery.click(); });
  els.btnCamera.addEventListener("click", () => { activePk = "photos"; openCamera(); });
  els.adjBtnGallery.addEventListener("click", () => { activePk = "adjPhotos"; els.inGallery.click(); });
  els.adjBtnCamera.addEventListener("click", () => { activePk = "adjPhotos"; openCamera(); });
  els.inGallery.addEventListener("change", (e) => { addFiles(e.target.files, activePk); e.target.value = ""; });
  els.inCamera.addEventListener("change", (e) => { addFiles(e.target.files, activePk); e.target.value = ""; });

  // ---- Live camera (getUserMedia) ----
  // The stream stays alive between shots (only the modal toggles display), so
  // the camera permission isn't re-requested on every capture.
  let camStream = null;
  let camFacing = "environment";
  let camZoom = 1; // digital zoom (works on every device)
  const hasCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  async function startStream(facing) {
    // Acquire the new stream BEFORE stopping the old one, so a failed flip
    // (e.g. device has one camera) leaves the current view intact.
    // {exact} forces the requested front/back on Android (ideal is often ignored,
    // so the flip / front camera wouldn't actually switch); fall back if absent.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { exact: facing } }, audio: false,
      });
    } catch (e) {
      if (e && e.name === "OverconstrainedError") {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing }, audio: false,
        });
      } else {
        throw e;
      }
    }
    stopStream();
    camStream = stream;
    camFacing = facing;
    els.camVideo.srcObject = stream;
    try { await els.camVideo.play(); } catch (_) {} // WebViews need an explicit play()
    setZoom(1);
  }
  function stopStream() {
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  }

  function setZoom(z) {
    camZoom = Math.max(1, Math.min(z, 5));
    els.camVideo.style.transform = `scale(${camZoom})`;
    els.camZoom.textContent = `${camZoom.toFixed(1)}x`;
  }

  async function openCamera() {
    if (state[activePk].length >= MAX_PHOTOS) { showToast(`Maksimal ${MAX_PHOTOS} ta rasm`, true); return; }
    if (!hasCamera) { els.inCamera.click(); return; } // fallback to file-input capture
    els.camModal.hidden = false;
    document.body.classList.add("locked");
    syncBackButton();
    try {
      if (!camStream) await startStream(camFacing);
      else { try { await els.camVideo.play(); } catch (_) {} } // resume the kept-alive stream
    } catch (e) {
      closeCamera();
      const n = e && e.name;
      if (n === "NotAllowedError" || n === "NotFoundError" || n === "NotReadableError") els.inCamera.click();
      else showToast("Kamera ochilmadi", true);
    }
  }

  function closeCamera() {
    els.camModal.hidden = true;
    syncLock(); // keep the lock if the top form / a .screen is still open behind
    syncBackButton();
  }

  function capturePhoto() {
    const v = els.camVideo;
    if (!v.videoWidth) return;
    // Crop the centre region to match the on-screen digital zoom.
    const sw = v.videoWidth / camZoom;
    const sh = v.videoHeight / camZoom;
    const sx = (v.videoWidth - sw) / 2;
    const sy = (v.videoHeight - sh) / 2;
    const canvas = els.camCanvas;
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    canvas.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const pk = activePk;
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], `cam_${blob.size}_${state[pk].length}.jpg`, { type: "image/jpeg" });
        addFiles([file], pk);
      }
      closeCamera(); // hide modal, keep stream alive for the next shot
    }, "image/jpeg", 0.92);
  }

  async function flipCamera() {
    const next = camFacing === "environment" ? "user" : "environment";
    try { await startStream(next); } catch (_) { showToast("Kamera almashtirilmadi", true); }
  }

  // Pinch-to-zoom.
  let pinch = null;
  const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  els.camModal.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) pinch = { d: touchDist(e.touches), z: camZoom };
  }, { passive: true });
  els.camModal.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length === 2) setZoom(pinch.z * (touchDist(e.touches) / pinch.d));
  }, { passive: true });
  els.camModal.addEventListener("touchend", () => { pinch = null; });

  els.camShot.addEventListener("click", capturePhoto);
  els.camClose.addEventListener("click", closeCamera);
  els.camFlip.addEventListener("click", flipCamera);
  els.camZoom.addEventListener("click", () => setZoom(camZoom >= 3 ? 1 : Math.floor(camZoom) + 1));
  window.addEventListener("pagehide", stopStream);

  // ---- Photo lightbox (Telegram-like: prev/next arrows, counter, caption) ----
  // Two sources: 'form' pages through a live form photo set (deletable, has
  // persistent object URLs) and 'entry' pages through a saved entry's Files
  // (view-only + caption; one ephemeral URL at a time).
  let lb = null; // { mode: 'form'|'entry', pk?, section?, entry?, files?, caption?, i }
  let lbTempUrl = null;
  let lbEditing = false;
  let lbSaving = false;

  function lbItems() { return lb.mode === "form" ? state[lb.pk] : lb.files; }
  function isLightboxEditable() {
    return !!(lb && lb.mode === "entry" && lb.entry && lb.entry.synced && !lb.entry.pending &&
      (lb.section === "reys" || OBSHIY_SECTIONS.includes(lb.section)));
  }

  // Two-line caption: bold summary + dim meta. Reys shows the arithmetic the
  // admin asked for: "AKB 100 - 0.94 = 99.06 kg".
  function entryCaption(e) {
    const n2 = (v) => String(Math.round(Number(v) * 100) / 100);
    let main;
    if (e.from && e.to) {
      main = `${e.from.toUpperCase()} → ${e.to.toUpperCase()} · ${fmtKg(e.weight)}`;
    } else if (e.type) {
      const coef = Number(e.coefficient) || 0;
      main = coef
        ? `${e.type.toUpperCase()} ${n2(e.weight)} - ${n2(coef)} = ${fmtKg(e.weight - coef)}`
        : `${e.type.toUpperCase()} ${fmtKg(e.weight)}`;
    } else {
      const boxWeight = Number(e.boxWeight) || 0;
      const n = (v) => String(Math.round(Number(v) * 100) / 100);
      main = boxWeight
        ? `${e.code || "—"} · ${fmtKg(e.weight)} · karobka ${n(boxWeight)}`
        : `${e.code || "—"} · ${fmtKg(e.weight)}`;
    }
    return { main, sub: `${fmtTs(e.ts / 1000)} · ${(e.files || []).length} rasm` };
  }

  function lbShow() {
    const items = lbItems();
    if (!items.length) { closeLightbox(); return; }
    lb.i = Math.min(Math.max(lb.i, 0), items.length - 1);
    if (lbTempUrl) { URL.revokeObjectURL(lbTempUrl); lbTempUrl = null; }
    if (lb.mode === "form") {
      els.lightboxImg.src = items[lb.i].url;
    } else {
      lbTempUrl = URL.createObjectURL(items[lb.i]);
      els.lightboxImg.src = lbTempUrl;
    }
    const many = items.length > 1;
    const canPrev = lb.i > 0 || hasEntryNeighbor(-1);
    const canNext = lb.i < items.length - 1 || hasEntryNeighbor(1);
    const canPage = many || canPrev || canNext;
    els.lightboxCount.hidden = !canPage;
    els.lightboxCount.textContent = `${lb.i + 1}/${items.length}`;
    els.lightboxPrev.hidden = !canPage;
    els.lightboxNext.hidden = !canPage;
    els.lightboxPrev.disabled = !canPrev;
    els.lightboxNext.disabled = !canNext;
    const cap = lb.mode === "entry" ? lb.caption : null;
    els.lightboxCaption.hidden = !cap;
    els.lightboxCapMain.textContent = cap ? cap.main : "";
    els.lightboxCapSub.textContent = cap ? cap.sub : "";
    els.lightboxEdit.hidden = !isLightboxEditable() || lbEditing;
  }

  function openLightbox(photo, pk) {
    const arr = state[pk || "photos"];
    lb = { mode: "form", pk: pk || "photos", i: Math.max(0, arr.findIndex((p) => p.id === photo.id)) };
    els.lightboxDel.hidden = false;
    lbShow();
    els.lightbox.hidden = false;
    document.body.classList.add("locked");
    syncBackButton();
  }

  function viewEntryPhotos(entry, startIndex) {
    closeLightboxEdit(false);
    lb = {
      mode: "entry",
      section: viewerSection,
      entry,
      files: entry.files || [],
      caption: entryCaption(entry),
      i: startIndex || 0,
    };
    els.lightboxDel.hidden = true; // view-only — edit/delete live in the kebab menu
    lbShow();
    els.lightbox.hidden = false;
    document.body.classList.add("locked");
    syncBackButton();
  }

  function entryOrder(section) {
    return (state.entries[section] || []).slice().reverse().filter((e) => (e.files || []).length);
  }

  function hasEntryNeighbor(d) {
    if (!lb || lb.mode !== "entry") return false;
    const order = entryOrder(lb.section);
    const cur = order.indexOf(lb.entry);
    return cur >= 0 && !!order[cur + (d > 0 ? 1 : -1)];
  }

  function setLightboxEntry(entry, index) {
    closeLightboxEdit(false);
    lb.entry = entry;
    lb.files = entry.files || [];
    lb.caption = entryCaption(entry);
    lb.i = Math.min(Math.max(index || 0, 0), Math.max(lb.files.length - 1, 0));
  }

  function lbNav(d) {
    if (!lb) return;
    const ni = lb.i + d;
    const items = lbItems();
    if (ni >= 0 && ni < items.length) {
      lb.i = ni;
    } else if (lb.mode === "entry") {
      const order = entryOrder(lb.section);
      const cur = order.indexOf(lb.entry);
      const next = order[cur + (d > 0 ? 1 : -1)];
      if (!next) return;
      const nextFiles = next.files || [];
      setLightboxEntry(next, d > 0 ? 0 : nextFiles.length - 1);
    } else {
      return;
    }
    lbShow();
    haptic("select");
  }

  function closeLightbox() {
    els.lightbox.hidden = true;
    els.lightbox.classList.remove("is-editing");
    els.lightboxImg.src = "";
    if (lbTempUrl) { URL.revokeObjectURL(lbTempUrl); lbTempUrl = null; }
    closeLightboxEdit(false);
    lb = null;
    els.lightboxEdit.hidden = true;
    els.lightboxDel.hidden = false;
    syncLock(); // keep the lock if a .screen (entries viewer / top form) is still open
    syncBackButton();
  }

  function deleteFromLightbox() {
    if (!lb || lb.mode !== "form") return;
    const cur = state[lb.pk][lb.i];
    if (cur) removePhoto(cur.id, lb.pk);
    if (!state[lb.pk].length) closeLightbox();
    else lbShow(); // index clamps to the shortened list
  }

  function closeLightboxEdit(refresh) {
    lbEditing = false;
    if (els.lightbox) els.lightbox.classList.remove("is-editing");
    if (els.lightboxEditPanel) els.lightboxEditPanel.hidden = true;
    if (els.lightboxEdit) els.lightboxEdit.hidden = !isLightboxEditable();
    if (refresh && lb) lbShow();
  }

  function openLightboxEdit() {
    if (!isLightboxEditable()) return;
    const e = lb.entry;
    lbEditing = true;
    els.lightbox.classList.add("is-editing");
    els.lightboxEdit.hidden = true;
    els.lightboxEditPanel.hidden = false;
    els.lbEditWeight.value = String(e.weight || "");
    els.lbEditCoef.value = String(e.boxWeight || e.coefficient || "");
    if (lb.section === "reys") {
      els.lbEditTitle.textContent = "Kargolarga tarqatish";
      els.lbEditNameLabel.textContent = "Tovar turi";
      els.lbEditName.value = e.type || "";
      els.lbEditCoefLabel.textContent = "Koeffitsient";
      els.lbEditCoefRow.hidden = false;
    } else {
      els.lbEditTitle.textContent = SECTIONS[lb.section].title;
      els.lbEditNameLabel.textContent = "Karobka kodi";
      els.lbEditName.value = e.code || "";
      els.lbEditCoefLabel.textContent = "Karobka og'irligi";
      els.lbEditCoefRow.hidden = lb.section === "top";
      if (lb.section === "top") els.lbEditCoef.value = "0";
    }
    setTimeout(() => els.lbEditWeight.focus(), 50);
  }

  async function saveLightboxEdit() {
    if (!isLightboxEditable() || lbSaving) return;
    const e = lb.entry;
    const name = els.lbEditName.value.trim();
    const weight = parseFloat(cleanDecimal(els.lbEditWeight.value));
    let coefficient = lb.section === "top" ? 0 : parseFloat(cleanDecimal(els.lbEditCoef.value || "0"));
    if (lb.section === "reys" && !name) { showToast("Tovar turini kiriting", true); return; }
    if (lb.section !== "reys" && SECTIONS[lb.section].codeRequired && !name) { showToast("Karobka kodini kiriting", true); return; }
    if (!isFinite(weight) || weight <= 0) { showToast("Og'irlikni to'g'ri kiriting", true); return; }
    if (!isFinite(coefficient) || coefficient < 0) coefficient = 0;
    const isReysEdit = lb.section === "reys";
    const boxWeight = isReysEdit ? 0 : coefficient;
    if (isReysEdit && weight - coefficient < 0) { showToast("Koeffitsient og'irlikdan katta", true); return; }
    const net = isReysEdit ? Math.round((weight - coefficient) * 1e4) / 1e4 : weight;

    lbSaving = true;
    els.lbEditSave.disabled = true;
    try {
      const fd = new FormData();
      fd.append("init_data", inTelegram ? tg.initData : "");
      fd.append("report_id", String(state.reportId));
      fd.append("weight", String(weight));
      fd.append("coefficient", String(isReysEdit ? coefficient : 0));
      fd.append("coefficient_mode", isReysEdit && coefficient ? "custom" : (boxWeight ? "custom" : "none"));
      if (!isReysEdit) fd.append("box_weight", String(boxWeight || 0));
      const path = lb.section === "reys" ? `/api/report/${e.id}` : `/api/obshiy/${e.id}`;
      if (lb.section === "reys") {
        fd.append("type", name);
      } else {
        fd.append("section", lb.section);
        fd.append("code", name);
      }
      const res = await fetch(path, { method: "PUT", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Yangilab bo'lmadi");
      if (lb.section === "reys") {
        Object.assign(e, { type: name, weight, coefficient, coefMode: coefficient ? "custom" : "none", net });
        if (json.inventory) state.inventory = json.inventory;
        loadInventory();
      } else {
        Object.assign(e, { code: name, weight, coefficient: 0, boxWeight, coefMode: boxWeight ? "custom" : "none", net });
      }
      if (json.edited) e.editedAt = Date.now();
      lb.caption = entryCaption(e);
      closeLightboxEdit(true);
      renderEntries();
      showToast(json.edited ? "Yangilandi ✓" : "O'zgarish yo'q");
    } catch (err) {
      showToast(err.message || "Yangilab bo'lmadi", true);
    } finally {
      lbSaving = false;
      els.lbEditSave.disabled = false;
    }
  }

  // Swipe left/right to page (Telegram-style). The .lightbox has
  // touch-action:none so the WebView can't consume the pan before touchend;
  // the last touchmove position is tracked because some WebViews report a
  // stale/зero delta in touchend's changedTouches after a suppressed pan.
  let lbTouch = null; // { x, y, lx, ly }
  els.lightbox.addEventListener("touchstart", (e) => {
    lbTouch = e.touches.length === 1
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY, lx: e.touches[0].clientX, ly: e.touches[0].clientY }
      : null; // multi-touch is not a swipe
  }, { passive: true });
  els.lightbox.addEventListener("touchmove", (e) => {
    if (lbTouch && e.touches.length === 1) {
      lbTouch.lx = e.touches[0].clientX;
      lbTouch.ly = e.touches[0].clientY;
    }
  }, { passive: true });
  els.lightbox.addEventListener("touchend", () => {
    if (!lbTouch) return;
    const dx = lbTouch.lx - lbTouch.x;
    const dy = lbTouch.ly - lbTouch.y;
    lbTouch = null;
    // Mostly-horizontal, decisive swipe → page; ignore taps and vertical pans.
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) lbNav(dx > 0 ? -1 : 1);
  }, { passive: true });
  els.lightbox.addEventListener("touchcancel", () => { lbTouch = null; });

  els.lightbox.addEventListener("click", (e) => { if (e.target === els.lightbox) closeLightbox(); });
  els.lightboxClose.addEventListener("click", closeLightbox);
  els.lightboxDel.addEventListener("click", deleteFromLightbox);
  els.lightboxEdit.addEventListener("click", openLightboxEdit);
  els.lbEditCancel.addEventListener("click", () => closeLightboxEdit(true));
  els.lbEditSave.addEventListener("click", saveLightboxEdit);
  els.lightboxEditPanel.addEventListener("click", (e) => e.stopPropagation());
  els.lightboxPrev.addEventListener("click", () => lbNav(-1));
  els.lightboxNext.addEventListener("click", () => lbNav(1));

  // ---- Reports (home) ----
  function confirmDialog(msg) {
    return new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "confirm-modal";
      wrap.innerHTML = `
        <div class="confirm-modal__card" role="dialog" aria-modal="true">
          <div class="confirm-modal__title">Tasdiqlang</div>
          <div class="confirm-modal__msg"></div>
          <div class="confirm-modal__actions">
            <button type="button" class="confirm-modal__cancel">Bekor qilish</button>
            <button type="button" class="confirm-modal__ok">Tasdiqlash</button>
          </div>
        </div>`;
      wrap.querySelector(".confirm-modal__msg").textContent = msg;
      const done = (ok) => {
        wrap.classList.add("is-closing");
        setTimeout(() => wrap.remove(), 140);
        syncLock();
        resolve(!!ok);
      };
      wrap.addEventListener("click", (e) => { if (e.target === wrap) done(false); });
      wrap.querySelector(".confirm-modal__cancel").addEventListener("click", () => done(false));
      wrap.querySelector(".confirm-modal__ok").addEventListener("click", () => done(true));
      document.body.appendChild(wrap);
      document.body.classList.add("locked");
    });
  }

  async function downloadSummaryExcel(rep, btn) {
    if (!rep || !rep.id) return;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/export/summary?report_id=${rep.id}`, { headers: authHeaders() });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.detail || "Excel yuklab bo'lmadi");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFromDisposition(
        res.headers.get("content-disposition"),
        `${rep.name || "Hisobot"} UMUMIY HISOBOT.xlsx`
      );
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Excel tayyor");
    } catch (e) {
      showToast(e.message || "Excel yuklab bo'lmadi", true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function reportItem(rep) {
    const li = document.createElement("li");
    li.className = "report-item";
    const main = document.createElement("div");
    main.className = "report-item__main";
    const head = document.createElement("div");
    head.className = "report-item__head";
    const name = document.createElement("div");
    name.className = "report-item__name";
    name.textContent = rep.name;
    const go = document.createElement("span");
    go.className = "report-item__go";
    go.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6-1.4-1.4L12.2 12 7.6 7.4z"/></svg>';
    head.append(name, go);
    const sub = document.createElement("div");
    sub.className = "report-item__sub";
    sub.textContent = `${fmtTs(rep.created_at)} · ${rep.entries || 0} yozuv`;
    main.append(head, sub);
    const actions = document.createElement("div");
    actions.className = "report-item__actions";
    const xls = document.createElement("button");
    xls.className = "report-item__xls";
    xls.type = "button";
    xls.setAttribute("aria-label", "Umumiy hisobot Excel yuklab olish");
    xls.title = "Umumiy hisobot Excel yuklab olish";
    xls.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M11 4h2v8h3l-4 4-4-4h3V4ZM5 18h14v2H5z"/></svg><span>Excel</span>';
    xls.addEventListener("click", (e) => { e.stopPropagation(); downloadSummaryExcel(rep, xls); });
    const del = document.createElement("button");
    del.className = "report-item__del";
    del.type = "button";
    del.setAttribute("aria-label", "O'chirish");
    del.innerHTML = "<svg viewBox=\"0 0 24 24\" class=\"ic\"><path d=\"M9 3h6l1 2h4v2H4V5h4l1-2ZM6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8Z\"/></svg><span>O'chirish</span>";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteReport(rep); });
    actions.append(xls, del);
    main.append(actions);
    li.append(main);
    li.addEventListener("click", () => openReport(rep));
    return li;
  }

  function archiveToggle(count) {
    const li = document.createElement("li");
    li.className = "report-archive";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "report-archive__btn" + (homeArchiveOpen ? " is-open" : "");
    btn.innerHTML = `<span>Arxiv</span><strong>${count}</strong><svg viewBox="0 0 24 24" class="ic"><path d="m7 10 5 5 5-5z"/></svg>`;
    btn.addEventListener("click", () => {
      homeArchiveOpen = !homeArchiveOpen;
      renderReports(homeReports, homeReportsMax, true);
    });
    li.appendChild(btn);
    return li;
  }

  function renderReports(reports, max, force) {
    const key = JSON.stringify({
      ids: reports.map((r) => [r.id, r.name, r.entries, r.created_at]),
      max,
      open: homeArchiveOpen,
    });
    if (!force && key === homeRenderKey) return;
    homeRenderKey = key;
    els.reportList.innerHTML = "";
    const frag = document.createDocumentFragment();
    reports.slice(0, 3).forEach((rep) => frag.appendChild(reportItem(rep)));
    const archived = reports.slice(3);
    if (archived.length) {
      frag.appendChild(archiveToggle(archived.length));
      if (homeArchiveOpen) {
        const wrap = document.createElement("li");
        wrap.className = "report-archive__panel is-open";
        const ul = document.createElement("ul");
        ul.className = "report-list report-list--archive";
        archived.forEach((rep) => ul.appendChild(reportItem(rep)));
        wrap.appendChild(ul);
        frag.appendChild(wrap);
      }
    }
    els.reportList.appendChild(frag);
  }

  async function loadReports() {
    els.homeHint.textContent = "Yuklanmoqda…";
    try {
      const res = await fetch("/api/reports", { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      const reports = (res.ok && json.reports) || [];
      homeReports = reports;
      homeReportsMax = json.max || 25;
      els.homeHint.textContent = reports.length
        ? `Oxirgi 3 ta ko'rsatiladi · ${reports.length}/${homeReportsMax} saqlangan`
        : "Hali hisobot yo'q. Yangi hisobot qo'shing.";
      renderReports(reports, homeReportsMax);
      reportsLoaded = true;
      if (!routeRestoring) applyRouteFromHash();
    } catch (_) {
      els.homeHint.textContent = "Yuklashda xatolik";
    }
  }

  function showHome() {
    startOutboxLoop();
    const route = parseRoute();
    state.reportId = null;
    els.reportName.textContent = "";
    document.body.classList.remove("work-open");
    showScreen(null);          // hide menu / obshiy / top
    els.homeScreen.hidden = false;
    document.body.classList.add("locked");
    if (!routeRestoring && (reportsLoaded || route.kind === "reports")) setRoute("/reports", !reportsLoaded);
    syncBackButton(); // home is the root → no back button
    loadTypes();
    loadReports();
  }

  // Only one report-level screen is visible at a time: 'menu' | 'obshiy' |
  // 'top' (or null to reveal the work area behind them).
  function showScreen(which) {
    if (which !== null) document.body.classList.remove("work-open");
    els.menuScreen.hidden = which !== "menu";
    els.obshiyScreen.hidden = which !== "obshiy";
    els.topScreen.hidden = which !== "top";
    els.entriesScreen.hidden = true; // leaf overlay — drop it on any nav change
  }

  function workAreaVisible() {
    return !!(
      state.reportId &&
      els.homeScreen.hidden &&
      els.menuScreen.hidden &&
      els.obshiyScreen.hidden &&
      els.topScreen.hidden &&
      els.entriesScreen.hidden
    );
  }

  function applyRouteFromHash() {
    const route = parseRoute();
    if (route.kind === "reports") return false;
    if (!reportsLoaded) return false;
    const rep = findCachedReport(route.reportId);
    if (!rep) {
      routeRestoring = true;
      try { showHome(); } finally { routeRestoring = false; }
      setRoute("/reports", true);
      return false;
    }

    routeRestoring = true;
    try {
      openReport(rep);
      if (route.page === "kargo") {
        openWork(route.section === "adjust" ? "lost" : "report");
      } else if (route.page === "obshiy") {
        if (OBSHIY_SECTIONS.includes(route.section)) openForm(route.section);
        else showObshiy();
      } else if (route.page === "entries") {
        const section = route.section || "reys";
        if (OBSHIY_SECTIONS.includes(section)) {
          openForm(section);
          openEntries(section);
        } else {
          openWork(section === "adjust" ? "lost" : "report");
          openEntries(section);
        }
      } else if (route.page === "activity") {
        openActivity();
      } else {
        showMenu();
      }
    } finally {
      routeRestoring = false;
      syncBackButton();
    }
    return true;
  }

  // Opening a report lands on its section menu (Obshiy ves / Kargolarga
  // tarqatish), not straight into the reys/adashgan work area.
  function openReport(rep) {
    state.reportId = rep.id;
    state.reportName = rep.name;
    els.reportName.textContent = rep.name;
    resetForm(true);   // each report starts everything from 0
    resetAdjust(true);
    resetTop(true);
    clearEntries();
    setTab("report");
    loadTypes();
    loadInventory();
    OBSHIY_SECTIONS.forEach(loadEntries);
    loadEntries("reys");
    loadEntries("adjust");
    syncOutbox();
    els.homeScreen.hidden = true;
    showMenu();
  }

  // Leaving the work area cancels any pending reys/adjust edit — otherwise the
  // next save (meant as a NEW record) would silently PUT over the old entry.
  function cancelWorkEdits() {
    if (editingReys) { editingReys = null; resetForm(); }
    if (editingAdj) { editingAdj = null; resetAdjust(); }
    els.saveBtn.textContent = "Saqlash";
  }

  // Report section menu (Obshiy ves / Kargolarga tarqatish).
  function showMenu() {
    cancelWorkEdits();
    els.menuTitle.textContent = state.reportName;
    showScreen("menu");
    document.body.classList.add("locked");
    if (state.reportId) setRoute(`/report/${state.reportId}/menu`);
    syncBackButton();
  }

  // Obshiy ves → Top / Bizda qoladigan / Adashgan yuklar.
  function showObshiy() {
    showScreen("obshiy");
    document.body.classList.add("locked");
    if (state.reportId) setRoute(`/report/${state.reportId}/obshiy`);
    syncBackButton();
  }

  // Obshiy ves → one of the shared-form sections (Top / Bizda qoladigan /
  // Bizdan chiqgan). They differ only by title + whether karobka kodi is required.
  function openForm(section) {
    state.formSection = section;
    const cfg = SECTIONS[section];
    els.topTitle.textContent = cfg.title;
    els.topCodeLabel.textContent = cfg.codeRequired ? "Karobka kodi" : "Karobka kodi (ixtiyoriy)";
    els.topCode.placeholder = cfg.codeRequired ? "Masalan: 12345" : "Ixtiyoriy";
    resetTop(true);
    els.topFast.checked = state.topFast;
    updateViewCount();
    showScreen("top");
    document.body.classList.add("locked");
    if (state.reportId) setRoute(`/report/${state.reportId}/obshiy/${section}`);
    syncBackButton();
  }

  function updateViewCount() {
    els.topViewCount.textContent = String(state.entries[state.formSection].length);
    els.reysViewCount.textContent = String(state.entries.reys.length);
    els.adjViewCount.textContent = String(state.entries.adjust.length);
  }

  // "Kargolarga tarqatish" → reveal the reys/adashgan tab work area.
  function openWork(tab) {
    showScreen(null);
    document.body.classList.add("work-open");
    document.body.classList.remove("locked");
    const nextTab = tab || "report";
    suppressTabRoute = true;
    setTab(nextTab);
    suppressTabRoute = false;
    if (state.reportId) setRoute(`/report/${state.reportId}/kargo/${nextTab === "lost" ? "adjust" : "reys"}`);
    syncBackButton();
  }

  function resetTop(full) {
    state.topPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    state.topPhotos = [];
    els.topCode.value = "";
    state.topWeightRaw = "";
    els.topWeight.value = "";
    renderPhotos("topPhotos");
    if (state.formSection === "bizda") setTopCoefUI("fixed", 1);
    else setTopCoefUI("none", 0);
    if (full) {
      // Opening a report resets the free-text unlock back to numeric-only;
      // fast mode is a persisted workflow preference, so it's kept.
      state.topCodeFree = false;
      els.topCodePencil.classList.remove("is-on");
      els.topCode.inputMode = "numeric";
    }
  }

  function topCoefValue() {
    if (state.topCoef.mode === "none") return 0;
    if (state.topCoef.mode === "fixed") return Number(state.topCoef.value) || 0;
    return parseFloat(String(els.topCoefCustom.value).replace(",", "."));
  }

  function setTopCoefUI(mode, value) {
    const chips = [...els.topCoefChips.querySelectorAll(".chip")];
    chips.forEach((c) => c.classList.remove("is-active"));
    let chip = null;
    if (mode === "none") chip = chips.find((c) => c.dataset.mode === "none");
    else if (mode === "custom") chip = chips.find((c) => c.dataset.mode === "custom");
    else chip = chips.find((c) => c.dataset.mode === "fixed" && sameNum(c.dataset.value, value));
    if (!chip) {
      mode = "custom";
      chip = chips.find((c) => c.dataset.mode === "custom");
    }
    if (chip) chip.classList.add("is-active");
    state.topCoef = { mode, value: mode === "none" ? 0 : value };
    els.topCoefCustomWrap.hidden = mode !== "custom";
    els.topCoefCustom.value = mode === "custom" ? String(value || "") : "";
  }

  let editingEntry = null; // shared-form entry being edited (null = creating)
  let editingReys = null;  // reys-tab entry being edited (backend PUT on save)
  let editingAdj = null;   // adashgan-tab entry being edited (backend PUT on save)
  async function onFormSave() {
    if (savingTop) return;
    if (!state.reportId) { showToast("Hisobot tanlanmagan", true); return; }
    const cfg = SECTIONS[state.formSection];
    const code = els.topCode.value.trim();
    const weight = parseFloat(cleanDecimal(state.topWeightRaw));
    const boxWeight = topCoefValue();
    const coefficient = 0;
    const net = weight;
    if (!state.topPhotos.length) { showToast("Kamida 1 ta rasm qo'shing", true); haptic("rigid"); updateTopSaveAvailability(); return; }
    if (cfg.codeRequired && !code) { showToast("Karobka kodini kiriting", true); haptic("rigid"); return; }
    if (!isFinite(weight) || weight <= 0) { showToast("Og'irlikni to'g'ri kiriting", true); haptic("rigid"); return; }
    if (state.topCoef.mode === "custom" && (!isFinite(boxWeight) || boxWeight <= 0)) {
      showToast("Karobka og'irligini kiriting", true); haptic("rigid"); return;
    }
    if (!isFinite(boxWeight) || boxWeight < 0) {
      showToast("Karobka og'irligini tekshiring", true); haptic("rigid"); return;
    }

    savingTop = true;
    updateTopSaveAvailability();
    // Entries hold the actual File objects (so photos can be viewed later);
    // object URLs are created on demand at render time. Backend isn't wired yet.
    const files = state.topPhotos.map((p) => p.file);
    if (editingEntry && editingEntry.synced && editingEntry.id != null) {
      if (
        sameText(editingEntry.code, code) &&
        sameNum(editingEntry.weight, weight) &&
        sameText(editingEntry.coefMode || "none", state.topCoef.mode || "none") &&
        sameNum(editingEntry.boxWeight || editingEntry.coefficient || 0, boxWeight)
      ) {
        const edited = editingEntry;
        editingEntry = null;
        els.topSave.textContent = "Saqlash";
        showToast("O'zgarish yo'q");
        resetTop(false);
        updateViewCount();
        savingTop = false;
        updateTopSaveAvailability();
        returnToEditedEntry(state.formSection, edited);
        return;
      }
      try {
        const fd = new FormData();
        fd.append("init_data", inTelegram ? tg.initData : "");
        fd.append("report_id", String(state.reportId));
        fd.append("section", state.formSection);
        fd.append("code", code);
        fd.append("coefficient", String(coefficient));
        fd.append("coefficient_mode", state.topCoef.mode);
        fd.append("box_weight", String(boxWeight || 0));
        fd.append("weight", String(weight));
        const res = await fetch(`/api/obshiy/${editingEntry.id}`, { method: "PUT", body: fd });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) throw new Error(json.detail || "Xatolik");
        Object.assign(editingEntry, { code, weight, coefficient, boxWeight, coefMode: state.topCoef.mode, net });
        if (json.edited) editingEntry.editedAt = Date.now();
        const edited = editingEntry;
        editingEntry = null;
        els.topSave.textContent = "Saqlash";
        showToast("Yangilandi ✓");
        resetTop(false);
        updateViewCount();
        returnToEditedEntry(state.formSection, edited);
      } catch (e) {
        showToast(e.message || "Xatolik", true);
      } finally {
        savingTop = false;
        updateTopSaveAvailability();
      }
      return;
    }
    if (!editingEntry) {
      try {
        await enqueueCreate(state.formSection, {
          section: state.formSection,
          code,
          coefficient,
          coefficient_mode: state.topCoef.mode,
          box_weight: boxWeight || 0,
          weight,
        }, files);
        showToast("Saqlandi ✓");
        resetTop(false);
        if (state.topFast) { activePk = "topPhotos"; openCamera(); }
      } catch (e) {
        showToast(e.message || "Xatolik", true);
      } finally {
        savingTop = false;
        updateTopSaveAvailability();
      }
      return;
    }
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    if (editingEntry) {
      const changed = !sameText(editingEntry.code, code) ||
        !sameNum(editingEntry.weight, weight) ||
        !sameNum(editingEntry.boxWeight || editingEntry.coefficient || 0, boxWeight);
      editingEntry.code = code;
      editingEntry.weight = weight;
      editingEntry.coefficient = coefficient;
      editingEntry.boxWeight = boxWeight;
      editingEntry.coefMode = state.topCoef.mode;
      editingEntry.net = net;
      editingEntry.files = files;
      if (changed) editingEntry.editedAt = Date.now();
      editingEntry = null;
      els.topSave.textContent = "Saqlash";
      showToast("Yangilandi ✓");
      resetTop(false);
      updateViewCount();
      savingTop = false;
      updateTopSaveAvailability();
      return; // no fast-mode camera reopen while editing
    }
    state.entries[state.formSection].push({ code, weight, coefficient, boxWeight, coefMode: state.topCoef.mode, net, files, ts: Date.now() });
    updateViewCount();
    showToast("Saqlandi ✓");
    resetTop(false);
    savingTop = false;
    updateTopSaveAvailability();
    // Fast mode: reopen the camera immediately for the next box.
    if (state.topFast) { activePk = "topPhotos"; openCamera(); }
  }

  // Leaving the form: drop any in-progress edit and go back to the submenu.
  function formBack() {
    editingEntry = null;
    els.topSave.textContent = "Saqlash";
    showObshiy();
  }

  // Free all session entries + their in-flight URLs (each report starts empty).
  function clearEntries() {
    clearEntryUrls();
    editingEntry = null;
    editingReys = null;
    editingAdj = null;
    actionEntry = null;
    els.topSave.textContent = "Saqlash";
    els.saveBtn.textContent = "Saqlash";
    state.entries = { top: [], topchiqgan: [], bizda: [], chiqgan: [], reys: [], adjust: [] };
    updateViewCount();
  }

  // ---- Saved-entries viewer (cards, paginated) ----
  let entriesPage = 0;
  let viewerSection = "top"; // which SECTIONS list the viewer is showing
  let entryUrls = []; // object URLs created for the current render; revoked on re-render
  let selectedEntryIds = new Set();
  let entriesFocusId = null;
  let editReturn = null;
  let sendStatusPollTimer = null;
  let sendStatusPollKind = null;
  function clearEntryUrls() { entryUrls.forEach((u) => URL.revokeObjectURL(u)); entryUrls = []; }
  function entriesScroller() { return els.entriesList ? els.entriesList.parentElement : null; }

  function openEntries(section, focusId) {
    viewerSection = section || state.formSection;
    entriesFocusId = focusId == null ? null : String(focusId);
    if (!entriesFocusId) entriesPage = 0;
    selectedEntryIds = new Set();
    els.entriesTitle.textContent = SECTIONS[viewerSection].title + " — yuklanganlar";
    els.entriesScreen.hidden = false;
    document.body.classList.add("locked");
    renderEntries();
    if (isBackendSection(viewerSection)) loadEntries(viewerSection);
    if (state.reportId) setRoute(`/report/${state.reportId}/entries/${viewerSection}`);
    syncBackButton();
  }
  function closeEntries() {
    const section = viewerSection;
    clearEntryUrls();
    selectedEntryIds = new Set();
    stopSendStatusPolling();
    els.entriesScreen.hidden = true;
    els.entriesActions.hidden = true;
    if (state.reportId) {
      if (OBSHIY_SECTIONS.includes(section)) setRoute(`/report/${state.reportId}/obshiy/${section}`, true);
      else setRoute(`/report/${state.reportId}/kargo/${section === "adjust" ? "adjust" : "reys"}`, true);
    }
    syncLock(); // form screen may still be open beneath; work area isn't locked
    syncBackButton();
  }
  function rememberEditReturn(entry) {
    if (!isBulkSection() || !entry || entry.id == null) { editReturn = null; return; }
    editReturn = {
      section: viewerSection,
      entryId: String(entry.id),
      page: entriesPage,
      scrollTop: entriesScroller() ? entriesScroller().scrollTop : 0,
    };
  }
  function returnToEditedEntry(section, entry) {
    const entryId = entry && entry.id != null ? String(entry.id) : (editReturn && editReturn.entryId);
    const targetSection = section || (editReturn && editReturn.section);
    if (!targetSection || !entryId) return;
    if (editReturn && editReturn.section === targetSection) entriesPage = editReturn.page || 0;
    openEntries(targetSection, entryId);
    editReturn = null;
  }
  function renderEntries() {
    const list = state.entries[viewerSection];
    const liveIds = new Set(list.filter((e) => e.synced && e.id != null).map((e) => String(e.id)));
    selectedEntryIds = new Set([...selectedEntryIds].filter((id) => liveIds.has(id)));
    const ordered = list.slice().reverse(); // newest first
    if (entriesFocusId) {
      const focusIdx = ordered.findIndex((e) => String(e.id || e.localId) === entriesFocusId);
      if (focusIdx !== -1) entriesPage = Math.floor(focusIdx / ENTRIES_PAGE);
    }
    const pages = Math.max(1, Math.ceil(list.length / ENTRIES_PAGE));
    entriesPage = Math.min(Math.max(entriesPage, 0), pages - 1);
    clearEntryUrls();
    els.entriesList.innerHTML = "";
    renderBulkSendState(list);
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "entries__empty";
      p.textContent = "Hali yozuv yo'q";
      els.entriesList.appendChild(p);
      els.entriesPager.hidden = true;
      return;
    }
    const start = entriesPage * ENTRIES_PAGE;
    ordered.slice(start, start + ENTRIES_PAGE).forEach((e) => els.entriesList.appendChild(entryCard(e)));
    els.entriesPager.hidden = pages <= 1;
    els.entriesPageLabel.textContent = `${entriesPage + 1}/${pages}`;
    els.entriesPrev.disabled = entriesPage <= 0;
    els.entriesNext.disabled = entriesPage >= pages - 1;
    if (entriesFocusId) {
      const safeId = window.CSS && CSS.escape ? CSS.escape(entriesFocusId) : entriesFocusId.replace(/"/g, '\\"');
      const target = els.entriesList.querySelector(`[data-entry-id="${safeId}"]`);
      if (target) {
        target.classList.add("is-focus");
        setTimeout(() => { try { target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }, 80);
        setTimeout(() => target.classList.remove("is-focus"), 1600);
        entriesFocusId = null;
      }
    }
    if (isBulkSection() && hasChannelPending(viewerSection)) startSendStatusPolling(viewerSection);
  }

  let sendingBulk = false;
  function isBackendSection(section) { return section === "reys" || section === "adjust" || OBSHIY_SECTIONS.includes(section); }
  function isBulkSection() { return isBackendSection(viewerSection); }
  function canSendUnsent(e) {
    return e.synced && e.id != null && !e.pending && e.sendStatus !== "pending" && e.sendStatus !== "sent";
  }
  function canResendSent(e) { return e.synced && e.id != null && e.sendStatus === "sent"; }
  function renderBulkSendState(list) {
    const show = isBulkSection();
    els.entriesActions.hidden = !show;
    if (!show) return;
    const unsent = list.filter(canSendUnsent).length;
    const sent = list.filter(canResendSent).length;
    const selected = list.filter((e) => e.synced && e.id != null && selectedEntryIds.has(String(e.id))).length;
    els.entriesSendUnsentBtn.disabled = sendingBulk || unsent === 0;
    els.entriesResendSentBtn.disabled = sendingBulk || sent === 0;
    els.entriesSendSelectedBtn.disabled = sendingBulk || selected === 0;
    els.entriesSendUnsentBtn.textContent = sendingBulk
      ? "Yuborishga tayyorlanmoqda..."
      : unsent
        ? `Yuborish (${unsent})`
        : "Yo'q";
    els.entriesResendSentBtn.textContent = sent
      ? `Qayta (${sent})`
      : "Qayta yo'q";
    els.entriesSendSelectedBtn.textContent = selected
      ? `Tanlangan (${selected})`
      : "Tanlangan yo'q";
  }

  async function sendEntriesBulk(mode) {
    if (sendingBulk || !isBulkSection()) return;
    const list = state.entries[viewerSection];
    const targets = list.filter(mode === "sent" ? canResendSent : canSendUnsent);
    if (!targets.length) return;
    sendingBulk = true;
    renderBulkSendState(list);
    try {
      const res = await fetch("/api/send-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          init_data: inTelegram ? tg.initData : "",
          report_id: state.reportId,
          kind: viewerSection,
          mode,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Yuborib bo'lmadi");
      targets.forEach((e) => { e.sendStatus = "pending"; });
      showToast(`${json.queued || targets.length} ta yozuv kanalga yuborishga qo'shildi`);
      renderEntries();
      startSendStatusPolling(viewerSection);
    } catch (e) {
      showToast(e.message || "Yuborib bo'lmadi", true);
    } finally {
      sendingBulk = false;
      renderBulkSendState(state.entries[viewerSection]);
    }
  }

  async function sendEntriesSelected() {
    if (sendingBulk || !isBulkSection()) return;
    const list = state.entries[viewerSection];
    const targets = list.filter((e) => e.synced && e.id != null && selectedEntryIds.has(String(e.id)));
    if (!targets.length) return;
    sendingBulk = true;
    renderBulkSendState(list);
    try {
      const res = await fetch("/api/send-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          init_data: inTelegram ? tg.initData : "",
          report_id: state.reportId,
          kind: viewerSection,
          mode: "sent",
          entry_ids: targets.map((e) => e.id),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Yuborib bo'lmadi");
      targets.forEach((e) => { e.sendStatus = "pending"; });
      selectedEntryIds = new Set();
      showToast(`${json.queued || targets.length} ta tanlangan yozuv yuborishga qo'shildi`);
      renderEntries();
      startSendStatusPolling(viewerSection);
    } catch (e) {
      showToast(e.message || "Yuborib bo'lmadi", true);
    } finally {
      sendingBulk = false;
      renderBulkSendState(state.entries[viewerSection]);
    }
  }

  function hasChannelPending(kind) {
    return (state.entries[kind] || []).some((e) => e.synced && e.id != null && e.sendStatus === "pending");
  }

  function stopSendStatusPolling() {
    if (sendStatusPollTimer) clearInterval(sendStatusPollTimer);
    sendStatusPollTimer = null;
    sendStatusPollKind = null;
  }

  async function refreshEntryStatuses(kind) {
    if (!state.reportId || !isBackendSection(kind)) return;
    try {
      const res = await fetch(`/api/entries/status?report_id=${state.reportId}&kind=${kind}`, { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.entries) return;
      const byId = new Map((json.entries || []).map((r) => [String(r.id), r]));
      (state.entries[kind] || []).forEach((e) => {
        if (!e.synced || e.id == null) return;
        const row = byId.get(String(e.id));
        if (!row) return;
        e.sendStatus = row.send_status || null;
        e.sendError = row.send_error || null;
        e.sendErrorAt = row.send_error_at || null;
        e.sendLastAttemptAt = row.send_last_attempt_at || null;
        e.sendAttempts = row.send_attempts || null;
        e.sendNextAt = row.send_next_at || null;
      });
      if (!els.entriesScreen.hidden && viewerSection === kind) renderEntries();
      if (!hasChannelPending(kind) && sendStatusPollKind === kind) stopSendStatusPolling();
    } catch (_) {}
  }

  function startSendStatusPolling(kind) {
    if (!isBackendSection(kind)) return;
    if (sendStatusPollTimer && sendStatusPollKind === kind) return;
    stopSendStatusPolling();
    sendStatusPollKind = kind;
    refreshEntryStatuses(kind);
    sendStatusPollTimer = setInterval(() => {
      if (els.entriesScreen.hidden || viewerSection !== kind) { stopSendStatusPolling(); return; }
      refreshEntryStatuses(kind);
    }, 2500);
  }

  function entryCard(e) {
    const files = e.files || [];
    const card = document.createElement("div");
    const selected = e.synced && e.id != null && selectedEntryIds.has(String(e.id));
    card.className = "entry-card" + (e.sendStatus === "sent" ? " is-sent" : "") + (selected ? " is-selected" : "");
    const entryKey = e.id != null ? e.id : e.localId;
    if (entryKey != null) card.dataset.entryId = String(entryKey);

    const head = document.createElement("div");
    head.className = "entry-card__head";
    if (isBulkSection() && e.synced && e.id != null) {
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "entry-card__pick" + (selected ? " is-on" : "");
      pick.setAttribute("aria-label", selected ? "Tanlovdan olish" : "Tanlash");
      pick.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-8.1 13.3-4.2-4.2 1.4-1.4 2.8 2.8 5.6-5.6 1.4 1.4-7 7Z"/></svg>';
      pick.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = String(e.id);
        if (selectedEntryIds.has(id)) selectedEntryIds.delete(id);
        else selectedEntryIds.add(id);
        renderEntries();
      });
      head.appendChild(pick);
    }
    const code = document.createElement("div");
    code.className = "entry-card__code";
    // Label by entry shape: transfer "from → to", reys tovar turi, or karobka kodi.
    code.textContent = e.from && e.to ? `${e.from} → ${e.to}` : (e.type || e.code || "—");
    const titleWrap = document.createElement("div");
    titleWrap.className = "entry-card__title";
    const coefTxt = e.type && e.boxWeight ? `karobka ${e.boxWeight}` : (e.type && e.coefficient ? `koef ${e.coefficient}` : "");
    const metaTop = document.createElement("div");
    metaTop.className = "entry-card__meta";
    metaTop.textContent = [coefTxt, fmtTs(e.ts / 1000), `${files.length} rasm`].filter(Boolean).join(" · ");
    titleWrap.append(code, metaTop);
    const val = document.createElement("div");
    val.className = "entry-card__val";
    val.innerHTML = `${(Math.round(Number(e.weight) * 100) / 100).toLocaleString("en-US")}<span> kg</span>`;
    const menu = document.createElement("button");
    menu.className = "entry-card__menu";
    menu.type = "button";
    menu.setAttribute("aria-label", "Amallar");
    menu.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>';
    menu.addEventListener("click", (ev) => { ev.stopPropagation(); openEntryActions(e); });
    head.append(titleWrap, val, menu);
    card.appendChild(head);

    const foot = document.createElement("div");
    foot.className = "entry-card__foot";
    const thumbs = document.createElement("div");
    thumbs.className = "entry-card__thumbs";
    files.slice(0, 5).forEach((f, idx) => {
      const url = URL.createObjectURL(f);
      entryUrls.push(url);
      const img = document.createElement("img");
      img.className = "entry-thumb";
      img.src = url;
      img.alt = "";
      img.addEventListener("click", () => viewEntryPhotos(e, idx));
      thumbs.appendChild(img);
    });
    if (files.length > 5) {
      const more = document.createElement("span");
      more.className = "entry-more";
      more.textContent = `+${files.length - 5}`;
      more.addEventListener("click", () => viewEntryPhotos(e, 5));
      thumbs.appendChild(more);
    }
    const badges = document.createElement("div");
    badges.className = "entry-card__badges";
    const statusBadge = document.createElement("span");
    statusBadge.className = "entry-status";
    const statusTxt = e.error
      ? `xato: ${e.error}`
      : e.sendError
        ? "yuborilmadi"
      : e.pending || e.syncing
        ? "yuklanmoqda"
        : e.sendStatus === "pending"
          ? "kanal kutilmoqda"
          : e.sendStatus === "sent"
            ? "yuborilgan"
            : isBulkSection() && e.synced
              ? "yuborilmagan"
              : "";
    foot.append(thumbs);
    if (e.editedAt) {
      const editedBadge = document.createElement("span");
      editedBadge.className = "entry-status entry-status--edited";
      editedBadge.textContent = "tahrirlangan";
      badges.appendChild(editedBadge);
    }
    if (statusTxt) {
      statusBadge.textContent = statusTxt;
      statusBadge.classList.toggle("entry-status--sent", e.sendStatus === "sent");
      statusBadge.classList.toggle("entry-status--pending", e.pending || e.syncing || e.sendStatus === "pending");
      statusBadge.classList.toggle("entry-status--err", !!e.error || !!e.sendError);
      if (e.sendError) {
        const errAt = e.sendErrorAt ? ` (${fmtTs(e.sendErrorAt)})` : "";
        const errorText = `${e.sendError}${errAt}`;
        statusBadge.title = errorText;
        statusBadge.setAttribute("aria-label", errorText);
        statusBadge.addEventListener("click", (ev) => {
          ev.stopPropagation();
          showToast(errorText, true);
        });
      }
      badges.appendChild(statusBadge);
    }
    card.appendChild(foot);
    if (badges.childNodes.length) card.appendChild(badges);
    return card;
  }

  // ---- Entry actions (kebab → edit / delete) ----
  let actionEntry = null;
  function openEntryActions(entry) {
    actionEntry = entry;
    els.entryActBackdrop.hidden = false;
    els.entryActSheet.hidden = false;
    syncBackButton();
  }
  function closeEntryActions() {
    els.entryActSheet.hidden = true;
    els.entryActBackdrop.hidden = true;
    syncBackButton();
  }
  function startEditEntry(entry) {
    if (viewerSection === "reys") { startEditReys(entry); return; }
    if (viewerSection === "adjust") { startEditAdjust(entry); return; }
    editingEntry = entry;
    resetTop(false); // clear the form (revokes any current form-photo URLs)
    // Numeric-only unless the saved code contains non-digits → unlock free text.
    state.topCodeFree = false;
    els.topCodePencil.classList.remove("is-on");
    els.topCode.inputMode = "numeric";
    if (entry.code && /\D/.test(entry.code)) {
      state.topCodeFree = true;
      els.topCodePencil.classList.add("is-on");
      els.topCode.inputMode = "text";
    }
    (entry.files || []).forEach((f) => state.topPhotos.push({ id: ++photoSeq, file: f, url: URL.createObjectURL(f) }));
    renderPhotos("topPhotos");
    els.topCode.value = entry.code || "";
    const boxWeight = entry.boxWeight || entry.coefficient || 0;
    setTopCoefUI(entry.coefMode || (boxWeight ? "fixed" : "none"), boxWeight);
    els.topWeight.value = String(entry.weight);
    state.topWeightRaw = String(entry.weight);
    els.topSave.textContent = "Yangilash";
    closeEntries(); // reveal the form (still under the entries screen)
  }

  // Restore a coefficient into the chips row (none / fixed 0.94 / fixed 1.22 /
  // custom). A fixed value with no matching chip falls back to custom.
  function ensureCoefBoxMenu() {
    if (els.coefBoxMenu) return els.coefBoxMenu;
    const menu = document.createElement("div");
    menu.className = "coef-menu";
    menu.id = "coefBoxMenu";
    menu.hidden = true;
    menu.innerHTML = [
      '<button type="button" class="coef-menu__item" data-box-value="0">Ayirilmasin</button>',
      '<button type="button" class="coef-menu__item" data-box-value="1">Ayirilmasin (1)</button>',
      '<button type="button" class="coef-menu__item" data-box-value="1.22">Ayirilmasin (1.22)</button>',
    ].join("");
    els.coefChips.insertAdjacentElement("afterend", menu);
    els.coefBoxMenu = menu;
    return menu;
  }

  function setCoefBoxMenu(open) {
    const menu = ensureCoefBoxMenu();
    if (!menu) return;
    if (open) {
      menu.hidden = false;
      menu.removeAttribute("hidden");
      menu.classList.add("is-open");
      menu.style.display = "block";
    } else {
      menu.classList.remove("is-open");
      menu.style.display = "none";
      menu.hidden = true;
    }
    els.coefBoxMenu.querySelectorAll("[data-box-value]").forEach((btn) => {
      const v = Number(btn.dataset.boxValue) || 0;
      btn.textContent = v > 0 ? `Ayirilmasin (${v})` : "Ayirilmasin";
      const on = (state.coef.mode === "none" && v === 0) ||
        (state.coef.mode === "box" && sameNum(v, state.coef.boxWeight || 0));
      btn.classList.toggle("is-active", on);
    });
  }

  function updateCoefNoneLabel() {
    const chip = els.coefChips.querySelector('.chip[data-mode="none"]');
    if (!chip) return;
    chip.textContent = state.coef.mode === "box" && Number(state.coef.boxWeight) > 0
      ? `Ayirilmasin (${Number(state.coef.boxWeight)})`
      : "Ayirilmasin";
  }

  function selectCoefBoxValue(rawValue) {
    const boxWeight = Number(rawValue) || 0;
    state.coef = boxWeight > 0
      ? { mode: "box", value: 0, boxWeight }
      : { mode: "none", value: 0, boxWeight: 0 };
    els.coefChips.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("is-active", c.dataset.mode === "none");
    });
    updateCoefNoneLabel();
    els.coefCustomWrap.hidden = true;
    setCoefBoxMenu(false);
    haptic("select");
  }

  function setCoefUI(mode, value) {
    const chips = [...els.coefChips.querySelectorAll(".chip")];
    let boxWeight = 0;
    if (mode === "box") boxWeight = Number(value) || 0;
    let target = null;
    if (mode === "none") target = chips.find((c) => c.dataset.mode === "none");
    else if (mode === "box") target = chips.find((c) => c.dataset.mode === "none");
    else if (mode === "fixed") target = chips.find((c) => c.dataset.mode === "fixed" && parseFloat(c.dataset.value) === value);
    if (!target) { mode = "custom"; boxWeight = 0; target = chips.find((c) => c.dataset.mode === "custom"); }
    chips.forEach((c) => c.classList.toggle("is-active", c === target));
    state.coef = { mode, value: mode === "fixed" || mode === "custom" ? value : 0, boxWeight };
    updateCoefNoneLabel();
    setCoefBoxMenu(false);
    els.coefCustomWrap.hidden = mode !== "custom";
    els.coefCustom.value = mode === "custom" ? String(value) : "";
  }

  // Edit a saved reys entry: load it into tab 1; save PUTs to the backend
  // (inventory delta is compensated server-side).
  function startEditReys(entry) {
    if (saving) { showToast("Avval joriy saqlash tugashini kuting", true); return; }
    if (entry.pending || !entry.synced || entry.id == null) { showToast("Avval yuklanish tugasin", true); return; }
    rememberEditReturn(entry);
    editingReys = entry;
    resetForm(true);
    state.type = entry.type;
    els.typeValue.textContent = entry.type;
    setCoefUI(entry.boxWeight ? "box" : (entry.coefMode || "none"), entry.boxWeight || entry.coefficient || 0);
    els.weight.value = String(entry.weight);
    state.weightRaw = String(entry.weight);
    (entry.files || []).forEach((f) => state.photos.push({ id: ++photoSeq, file: f, url: URL.createObjectURL(f) }));
    renderPhotos("photos");
    els.saveBtn.textContent = "Yangilash";
    closeEntries();
    setTab("report");
  }

  // Edit a saved transfer: load it into tab 2; save PUTs to the backend
  // (old transfer reversed, new one applied).
  function startEditAdjust(entry) {
    if (adjusting) { showToast("Avval joriy saqlash tugashini kuting", true); return; }
    if (entry.pending || !entry.synced || entry.id == null) { showToast("Avval yuklanish tugasin", true); return; }
    rememberEditReturn(entry);
    editingAdj = entry;
    resetAdjust(true);
    state.adjFrom = entry.from;
    state.adjTo = entry.to;
    els.adjWeight.value = String(entry.weight);
    state.adjWeightRaw = String(entry.weight);
    (entry.files || []).forEach((f) => state.adjPhotos.push({ id: ++photoSeq, file: f, url: URL.createObjectURL(f) }));
    renderPhotos("adjPhotos");
    renderAdjust();
    closeEntries();
    setTab("lost");
  }

  async function deleteEntry(entry) {
    // Snapshot: the user can switch viewers while the DELETE is in flight —
    // the local removal must target the list the entry actually lives in.
    const sec = viewerSection;
    if (entry.localId && (!entry.synced || entry.id == null)) {
      // Still-pending (not uploaded) reys/adjust → just drop it from the outbox.
      await idbDelete(entry.localId);
    } else if (isBackendSection(sec)) {
      // Uploaded rows live on the backend — delete there first (the inventory
      // effect is undone server-side; 409 if later transfers depend on it).
      try {
        const res = await fetch(`/api/entry/${entry.id}?report_id=${state.reportId}`,
          { method: "DELETE", headers: authHeaders() });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) throw new Error(json.detail || "O'chirib bo'lmadi");
        state.inventory = json.balances || state.inventory;
        renderBalances();
        renderAdjust();
      } catch (e) {
        showToast(e.message || "O'chirib bo'lmadi", true);
        return;
      }
    }
    const list = state.entries[sec];
    const i = list.indexOf(entry);
    if (i === -1) return;
    list.splice(i, 1);
    if (editingEntry === entry) { editingEntry = null; els.topSave.textContent = "Saqlash"; }
    if (editingReys === entry) { editingReys = null; els.saveBtn.textContent = "Saqlash"; }
    if (editingAdj === entry) { editingAdj = null; renderAdjust(); }
    updateViewCount();
    if (viewerSection === sec) renderEntries(); // viewer may now show another section
    haptic("light");
  }

  // ================= Durable offline outbox (IndexedDB) =================
  // Every reys/adashgan CREATE is written to IndexedDB *before* the upload, so a
  // dropped connection or an app close never loses photos/data. A retry loop
  // (on interval, on reconnect, on next launch) flushes anything still pending;
  // once the server accepts it, it persists to disk. The channel send is queued
  // later from the Yuklanganlar bulk button.
  const IDB_NAME = "reys-outbox", IDB_STORE = "outbox";
  let _idb = null;
  let _idbLastError = "";
  function idbOpen() {
    return new Promise((resolve) => {
      if (_idb) return resolve(_idb);
      if (!("indexedDB" in window)) {
        _idbLastError = "indexedDB unavailable";
        return resolve(null);
      }
      let req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) {
        _idbLastError = e && e.message ? e.message : "indexedDB open failed";
        return resolve(null);
      }
      req.onupgradeneeded = () => { try { req.result.createObjectStore(IDB_STORE, { keyPath: "localId" }); } catch (_) {} };
      req.onsuccess = () => { _idb = req.result; resolve(_idb); };
      req.onerror = () => {
        _idbLastError = (req.error && req.error.message) || "indexedDB open error";
        resolve(null);
      };
      req.onblocked = () => {
        _idbLastError = "indexedDB blocked";
        resolve(null);
      };
    });
  }
  function idbReq(mode, fn) {
    return idbOpen().then((d) => new Promise((resolve) => {
      if (!d) return resolve(null);
      let out = null;
      try {
        const tx = d.transaction(IDB_STORE, mode);
        const r = fn(tx.objectStore(IDB_STORE));
        if (r) r.onsuccess = () => { out = r.result; };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => {
          _idbLastError = (tx.error && tx.error.message) || "indexedDB transaction error";
          resolve(null);
        };
        tx.onabort = () => {
          _idbLastError = (tx.error && tx.error.message) || "indexedDB transaction aborted";
          resolve(null);
        };
      } catch (e) {
        _idbLastError = e && e.message ? e.message : "indexedDB request failed";
        resolve(null);
      }
    }));
  }
  const idbPut = (item) => idbReq("readwrite", (s) => s.put(item));
  const idbDelete = (localId) => idbReq("readwrite", (s) => s.delete(localId));
  const idbAll = () => idbReq("readonly", (s) => s.getAll()).then((v) => v || []);

  let _uidSeq = 0;
  const uid = () => `${Date.now().toString(36)}-${(_uidSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Build a display entry from raw fields (optimistic save + outbox replay).
  function outboxEntry(item) {
    const f = item.fields;
    const files = (item.blobs || []).map((b, i) =>
      b instanceof File ? b : new File([b], (b && b.name) || `photo_${i}.jpg`, { type: (b && b.type) || "image/jpeg" }));
    const base = { localId: item.localId, files, ts: item.ts, synced: false, pending: true };
    if (item.kind === "adjust") return { ...base, from: f.from_type, to: f.to_type, weight: Number(f.weight) };
    if (OBSHIY_SECTIONS.includes(item.kind)) {
      const boxWeight = Number(f.box_weight) || Number(f.coefficient) || 0;
      const w = Number(f.weight) || 0;
      return { ...base, code: f.code || "", coefMode: f.coefficient_mode || (boxWeight ? "fixed" : "none"),
        coefficient: 0, boxWeight, weight: w, net: w };
    }
    const coef = Number(f.coefficient) || 0, w = Number(f.weight) || 0;
    return {
      ...base,
      type: f.type,
      coefMode: f.coefficient_mode,
      coefficient: coef,
      boxWeight: Number(f.box_weight) || 0,
      weight: w,
      net: Math.round((w - coef) * 1e4) / 1e4,
    };
  }

  function findByLocalId(localId) {
    for (const k of ["top", "topchiqgan", "bizda", "chiqgan", "reys", "adjust"]) {
      const e = state.entries[k].find((x) => x.localId === localId);
      if (e) return e;
    }
    return null;
  }

  async function uploadCreateRaw(item) {
    const fd = new FormData();
    fd.append("init_data", inTelegram ? tg.initData : "");
    fd.append("report_id", String(item.reportId));
    Object.entries(item.fields).forEach(([k, v]) => fd.append(k, String(v)));
    (item.blobs || []).forEach((b, i) => fd.append("photos", b, (b && b.name) || `photo_${i}.jpg`));
    const path = item.kind === "adjust" ? "/api/adjust" : (OBSHIY_SECTIONS.includes(item.kind) ? "/api/obshiy" : "/api/report");
    const res = await fetch(path, { method: "POST", body: fd });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  }

  function markEntrySynced(entry, item, json) {
    entry.id = json.entry_id;
    entry.pending = false;
    entry.synced = true;
    entry.sendStatus = null;
    if (item.reportId === state.reportId) {
      state.inventory = json.inventory || json.balances || state.inventory;
      renderBalances();
      renderAdjust();
    }
  }

  function refreshViewer(kind) {
    updateViewCount();
    if (!els.entriesScreen.hidden && viewerSection === kind) renderEntries();
  }

  // Persist + optimistically show a new entry, then try to upload it now.
  async function enqueueCreate(kind, fields, files) {
    const item = { localId: uid(), kind, reportId: state.reportId, fields, blobs: files, ts: Date.now() };
    const storedKey = await idbPut(item);
    const entry = outboxEntry(item);
    if (storedKey == null) {
      try {
        const { res, json } = await uploadCreateRaw(item);
        if (!res.ok || !json.ok) throw new Error(json.detail || "Serverga saqlab bo'lmadi");
        markEntrySynced(entry, item, json);
        state.entries[kind].push(entry);
        updateViewCount();
        refreshViewer(kind);
        return entry;
      } catch (e) {
        const detail = _idbLastError ? ` (${_idbLastError})` : "";
        throw new Error((e && e.message ? e.message : "Serverga saqlab bo'lmadi") + `. Qurilmada vaqtincha saqlab bo'lmadi${detail}`);
      }
    }
    state.entries[kind].push(entry);
    updateViewCount();
    trySync(item, entry); // fire-and-forget; retry loop is the safety net
    return entry;
  }

  let _syncing = false;
  const _syncingLocalIds = new Set();
  async function trySync(item, entry) {
    if (_syncingLocalIds.has(item.localId)) return;
    if (entry && entry.syncing) return;
    _syncingLocalIds.add(item.localId);
    if (entry) entry.syncing = true;
    try {
      const { res, json } = await uploadCreateRaw(item);
      if (!res.ok || !json.ok) {
        // 4xx (not 429) = permanent rejection → stop retrying, surface it.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          await idbDelete(item.localId);
          if (entry) { entry.pending = false; entry.error = json.detail || "xato"; }
          showToast(json.detail || "Saqlashda xato", true);
          refreshViewer(item.kind);
        }
        return; // 5xx/429/other → keep pending for retry
      }
      await idbDelete(item.localId); // uploaded → server owns it now
      if (entry) markEntrySynced(entry, item, json);
      refreshViewer(item.kind);
    } catch (_) {
      if (entry) entry.pending = true; // network error → retry loop will pick it up
    } finally {
      if (entry) entry.syncing = false;
      _syncingLocalIds.delete(item.localId);
    }
  }

  // Flush every pending outbox item (boot, reconnect, interval, save).
  async function syncOutbox() {
    if (_syncing || (typeof navigator.onLine === "boolean" && !navigator.onLine)) return;
    _syncing = true;
    try {
      const items = await idbAll();
      for (const item of items) await trySync(item, findByLocalId(item.localId));
    } finally { _syncing = false; }
  }

  let _outboxLoopStarted = false;
  function startOutboxLoop() {
    if (_outboxLoopStarted) return;
    _outboxLoopStarted = true;
    syncOutbox();
    window.addEventListener("online", syncOutbox);
    window.setInterval(syncOutbox, 15000);
  }

  function outboxKindTitle(kind) {
    return (SECTIONS[kind] && SECTIONS[kind].title) || kind || "noma'lum";
  }

  function outboxItemPhotos(item) {
    return (item.blobs || []).map((b) => ({
      name: b && b.name ? b.name : "",
      type: b && b.type ? b.type : "",
      size: b && b.size ? b.size : 0,
    }));
  }

  function outboxSummaryText(items) {
    if (!items.length && _idbLastError) return `Qurilma xotirasini ochib bo'lmadi: ${_idbLastError}`;
    if (!items.length) return "Pending yozuv yo'q. Bu qurilmada serverga tushmagan outbox bo'sh.";
    const groups = {};
    items.forEach((it) => {
      const key = `report ${it.reportId || "?"} · ${outboxKindTitle(it.kind)}`;
      groups[key] = (groups[key] || 0) + 1;
    });
    return `${items.length} ta pending yozuv: ` + Object.entries(groups).map(([k, n]) => `${k}: ${n}`).join("; ");
  }

  async function renderOutboxDiag() {
    els.outboxSummary.textContent = "Yuklanmoqda…";
    els.outboxList.innerHTML = "";
    const items = await idbAll();
    items.sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    els.outboxSummary.textContent = outboxSummaryText(items);
    els.outboxSync.disabled = !items.length;
    if (!items.length) return;

    const frag = document.createDocumentFragment();
    items.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "outbox-row";

      const title = document.createElement("div");
      title.className = "outbox-row__title";
      title.textContent = `${idx + 1}. ${outboxKindTitle(item.kind)} · report_id=${item.reportId || "?"}`;

      const meta = document.createElement("div");
      meta.className = "outbox-row__meta";
      const ts = item.ts ? new Date(item.ts) : null;
      const photos = outboxItemPhotos(item);
      const photoBytes = photos.reduce((s, p) => s + (Number(p.size) || 0), 0);
      meta.textContent = [
        ts ? ts.toLocaleString("uz-UZ") : "vaqt yo'q",
        `${photos.length} rasm`,
        photoBytes ? `${Math.round(photoBytes / 1024)} KB` : "",
      ].filter(Boolean).join(" · ");

      const pre = document.createElement("pre");
      pre.className = "outbox-row__fields";
      pre.textContent = JSON.stringify({
        localId: item.localId,
        fields: item.fields || {},
        photos,
      }, null, 2);

      row.append(title, meta, pre);
      frag.appendChild(row);
    });
    els.outboxList.appendChild(frag);
  }

  function openOutboxDiag() {
    if (!els.setSheet.hidden) closeSettings();
    els.outboxBackdrop.hidden = false;
    els.outboxSheet.hidden = false;
    renderOutboxDiag();
    syncBackButton();
  }

  function closeOutboxDiag() {
    els.outboxSheet.hidden = true;
    els.outboxBackdrop.hidden = true;
    syncBackButton();
  }

  async function syncOutboxFromDiag() {
    const items = await idbAll();
    if (!items.length) { renderOutboxDiag(); return; }
    const ok = await confirmDialog(`${items.length} ta pending yozuv serverga qayta yuborilsinmi?`);
    if (!ok) return;
    els.outboxSync.disabled = true;
    let sent = 0, failed = 0;
    for (const item of items) {
      try {
        const { res, json } = await uploadCreateRaw(item);
        if (!res.ok || !json.ok) {
          failed += 1;
          continue;
        }
        await idbDelete(item.localId);
        sent += 1;
      } catch (_) {
        failed += 1;
      }
    }
    showToast(failed ? `${sent} ta yuborildi, ${failed} ta xato` : `${sent} ta yuborildi`);
    await renderOutboxDiag();
    if (state.reportId) {
      OBSHIY_SECTIONS.forEach(loadEntries);
      loadEntries("reys");
      loadEntries("adjust");
      loadInventory();
    }
  }

  // ---- Load saved entries from the server (history survives a reload) ----
  function serverEntry(kind, r, files) {
    const base = {
      id: r.id,
      files,
      ts: (r.ts || 0) * 1000,
      editedAt: r.edited_at ? r.edited_at * 1000 : null,
      sendStatus: r.send_status || null,
      sendError: r.send_error || null,
      sendErrorAt: r.send_error_at || null,
      sendLastAttemptAt: r.send_last_attempt_at || null,
      sendAttempts: r.send_attempts || null,
      sendNextAt: r.send_next_at || null,
      synced: true,
    };
    if (kind === "adjust") return { ...base, from: r.from_type, to: r.to_type, weight: r.weight };
    if (OBSHIY_SECTIONS.includes(kind)) {
      const boxWeight = Number(r.box_weight) || Number(r.coefficient) || 0;
      const w = Number(r.weight) || 0;
      const net = r.net == null ? w : Number(r.net);
      return { ...base, code: r.tovar_turi || "", coefMode: boxWeight ? "fixed" : "none",
        coefficient: 0, boxWeight, weight: w, net };
    }
    const coef = Number(r.coefficient) || 0;
    const boxWeight = Number(r.box_weight) || 0;
    return {
      ...base,
      type: r.tovar_turi,
      coefMode: boxWeight ? "box" : (coef ? "fixed" : "none"),
      coefficient: coef,
      boxWeight,
      weight: r.weight,
      net: r.net,
    };
  }
  async function fetchEntryFiles(entryId, idxs) {
    const files = [];
    for (const i of idxs) {
      try {
        const res = await fetch(`/api/entry/${entryId}/photo/${i}`, { headers: authHeaders() });
        if (res.ok) {
          const blob = await res.blob();
          files.push(new File([blob], `p${i}.jpg`, { type: blob.type || "image/jpeg" }));
        }
      } catch (_) {}
    }
    return files;
  }
  async function loadEntries(kind) {
    const rid = state.reportId;
    let rows = [];
    try {
      const res = await fetch(`/api/entries?report_id=${rid}&kind=${kind}`, { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      rows = (res.ok && json.entries) || [];
    } catch (_) { return; }
    const loaded = [];
    for (const r of rows) loaded.push(serverEntry(kind, r, await fetchEntryFiles(r.id, r.photo_idxs || [])));
    if (state.reportId !== rid) return; // report changed while loading → discard
    // Server rows are newest-first; store oldest-first (renderEntries reverses),
    // then append any still-pending outbox items for this report.
    const items = await idbAll();
    const pend = items.filter((it) => it.kind === kind && it.reportId === rid).map(outboxEntry);
    state.entries[kind] = loaded.reverse().concat(pend);
    refreshViewer(kind);
    if (!els.entriesScreen.hidden && viewerSection === kind && hasChannelPending(kind)) startSendStatusPolling(kind);
  }

  async function deleteReport(rep) {
    if (!(await confirmDialog(`"${rep.name}" hisoboti o'chirilsinmi?`))) return;
    try {
      const res = await fetch(`/api/reports/${rep.id}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) throw new Error();
      loadReports();
    } catch (_) { showToast("O'chirib bo'lmadi", true); }
  }

  // Naming sheet
  function openNameSheet() {
    els.nameError.hidden = true;
    els.nameInput.value = "";
    els.nameBackdrop.hidden = false;
    els.nameSheet.hidden = false;
    syncBackButton();
    setTimeout(() => els.nameInput.focus(), 80);
  }
  function closeNameSheet() { els.nameSheet.hidden = true; els.nameBackdrop.hidden = true; syncBackButton(); }
  async function createReport() {
    const name = els.nameInput.value.trim();
    if (!name) { els.nameError.textContent = "Nom kiriting"; els.nameError.hidden = false; return; }
    els.nameSave.disabled = true;
    els.nameError.hidden = true;
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ init_data: inTelegram ? tg.initData : "", name }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Xatolik");
      closeNameSheet();
      openReport(json.report);
    } catch (e) {
      els.nameError.textContent = e.message || "Xatolik";
      els.nameError.hidden = false;
    } finally {
      els.nameSave.disabled = false;
    }
  }
  els.newReportBtn.addEventListener("click", openNameSheet);
  els.nameSave.addEventListener("click", createReport);
  els.nameClose.addEventListener("click", closeNameSheet);
  els.nameBackdrop.addEventListener("click", closeNameSheet);
  els.nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); createReport(); } });
  els.backHomeBtn.addEventListener("click", showMenu); // work area → section menu

  function filenameFromDisposition(header, fallback) {
    const m = /filename\*=UTF-8''([^;]+)/i.exec(header || "");
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (_) {}
    }
    return fallback || `${state.reportName || "Hisobot"} KARGOLARGA TARQATISH.xlsx`;
  }

  async function downloadKargoExcel() {
    if (!state.reportId) return;
    els.menuDistXls.disabled = true;
    try {
      const res = await fetch(`/api/export/kargo?report_id=${state.reportId}`, { headers: authHeaders() });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.detail || "Excel yuklab bo'lmadi");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFromDisposition(
        res.headers.get("content-disposition"),
        `${state.reportName || "Hisobot"} KARGOLARGA TARQATISH.xlsx`
      );
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Excel tayyor");
    } catch (e) {
      showToast(e.message || "Excel yuklab bo'lmadi", true);
    } finally {
      els.menuDistXls.disabled = false;
    }
  }

  async function downloadObshiyExcel() {
    if (!state.reportId) return;
    els.menuTotalXls.disabled = true;
    try {
      const res = await fetch(`/api/export/obshiy?report_id=${state.reportId}`, { headers: authHeaders() });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.detail || "Excel yuklab bo'lmadi");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFromDisposition(
        res.headers.get("content-disposition"),
        `${state.reportName || "Hisobot"} OBSHIY VES.xlsx`
      );
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("Excel tayyor");
    } catch (e) {
      showToast(e.message || "Excel yuklab bo'lmadi", true);
    } finally {
      els.menuTotalXls.disabled = false;
    }
  }

  // ---- Report section menu ----
  els.menuBackBtn.addEventListener("click", showHome);
  els.menuDistBtn.addEventListener("click", () => openWork("report"));
  els.menuDistXls.addEventListener("click", downloadKargoExcel);
  els.menuTotalBtn.addEventListener("click", showObshiy);
  els.menuTotalXls.addEventListener("click", downloadObshiyExcel);

  // ---- Obshiy ves submenu ----
  els.obshiyBackBtn.addEventListener("click", showMenu);
  els.obshiyTopBtn.addEventListener("click", () => openForm("top"));
  els.obshiyTopChiqganBtn.addEventListener("click", () => openForm("topchiqgan"));
  els.obshiyBizdaBtn.addEventListener("click", () => openForm("bizda"));
  els.obshiyChiqganBtn.addEventListener("click", () => openForm("chiqgan"));

  // ---- Shared Obshiy-ves form ----
  els.topBackBtn.addEventListener("click", formBack);
  els.topViewBtn.addEventListener("click", () => openEntries(state.formSection));
  els.reysViewBtn.addEventListener("click", () => openEntries("reys", editingReys && editingReys.id));
  els.adjViewBtn.addEventListener("click", () => openEntries("adjust", editingAdj && editingAdj.id));
  els.topBtnGallery.addEventListener("click", () => { activePk = "topPhotos"; els.inGallery.click(); });
  els.topBtnCamera.addEventListener("click", () => { activePk = "topPhotos"; openCamera(); });
  // Keep the focused input above the on-screen keyboard (it was covering the
  // weight field). Runs after the keyboard's open animation.
  [els.topCode, els.topWeight].forEach((inp) => {
    inp.addEventListener("focus", () => {
      setTimeout(() => { try { inp.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {} }, 250);
    });
  });
  // ---- Saved-entries viewer ----
  els.entriesBackBtn.addEventListener("click", closeEntries);
  els.entriesPrev.addEventListener("click", () => { entriesPage -= 1; renderEntries(); });
  els.entriesNext.addEventListener("click", () => { entriesPage += 1; renderEntries(); });
  els.entriesSendUnsentBtn.addEventListener("click", () => sendEntriesBulk("unsent"));
  els.entriesResendSentBtn.addEventListener("click", () => sendEntriesBulk("sent"));
  els.entriesSendSelectedBtn.addEventListener("click", sendEntriesSelected);
  els.entryActBackdrop.addEventListener("click", closeEntryActions);
  els.entryEditBtn.addEventListener("click", () => { const e = actionEntry; closeEntryActions(); if (e) startEditEntry(e); });
  els.entryDeleteBtn.addEventListener("click", async () => {
    const e = actionEntry;
    closeEntryActions();
    if (e && (await confirmDialog("Ushbu yozuv o'chirilsinmi?"))) deleteEntry(e);
  });
  els.topCode.addEventListener("input", (e) => {
    if (!state.topCodeFree) e.target.value = e.target.value.replace(/\D/g, "");
  });
  els.topCodePencil.addEventListener("click", () => {
    state.topCodeFree = !state.topCodeFree;
    els.topCodePencil.classList.toggle("is-on", state.topCodeFree);
    els.topCode.inputMode = state.topCodeFree ? "text" : "numeric";
    els.topCode.setAttribute("aria-label", state.topCodeFree ? "Karobka kodi (erkin)" : "Karobka kodi (raqam)");
    if (!state.topCodeFree) els.topCode.value = els.topCode.value.replace(/\D/g, "");
    els.topCode.focus();
    haptic("select");
  });
  els.topWeight.addEventListener("input", (e) => {
    const v = cleanDecimal(e.target.value);
    if (v !== e.target.value) e.target.value = v;
    state.topWeightRaw = v;
  });
  els.topFast.addEventListener("change", () => {
    state.topFast = els.topFast.checked;
    try { localStorage.setItem("reys-top-fast", state.topFast ? "1" : "0"); } catch (_) {}
  });
  els.topSave.addEventListener("click", onFormSave);

  // ---- Settings (remember toggle) ----
  function openSettings() {
    els.rememberToggle.checked = remember;
    if (els.reysFastToggle) els.reysFastToggle.checked = state.reysFast;
    els.setBackdrop.hidden = false;
    els.setSheet.hidden = false;
    syncBackButton();
  }
  function closeSettings() { els.setSheet.hidden = true; els.setBackdrop.hidden = true; syncBackButton(); }
  els.settingsBtn.addEventListener("click", openSettings);
  els.setClose.addEventListener("click", closeSettings);
  els.setBackdrop.addEventListener("click", closeSettings);
  els.rememberToggle.addEventListener("change", () => {
    remember = els.rememberToggle.checked;
    try { localStorage.setItem("reys-remember", remember ? "1" : "0"); } catch (_) {}
  });
  if (els.reysFastToggle) els.reysFastToggle.addEventListener("change", () => {
    state.reysFast = els.reysFastToggle.checked;
    try { localStorage.setItem("reys-fast", state.reysFast ? "1" : "0"); } catch (_) {}
  });

  function zeroLocalTopCoefficients() {
    (state.entries.top || []).forEach((e) => {
      if (!e || e.pending || !e.synced) return;
      e.coefficient = 0;
      e.coefMode = "none";
      if (e.weight != null) e.net = Number(e.weight) || 0;
      e.editedAt = Date.now();
    });
    refreshViewer(viewerSection);
  }

  async function zeroTopCoefficients() {
    if (!state.reportId) { showToast("Avval hisobotni tanlang", true); return; }
    const ok = await confirmDialog("Obshiy ves ichidagi Top yuklanganlari sof og'irlikka o'tkazilsinmi?");
    if (!ok) return;
    els.zeroCoefBtn.disabled = true;
    try {
      const res = await fetch(`/api/reports/${state.reportId}/zero-top-coefficients`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ init_data: inTelegram ? tg.initData : "" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Top yozuvlarini sof og'irlikka o'tkazib bo'lmadi");
      zeroLocalTopCoefficients();
      showToast(`${json.changed || 0} ta Top yozuvi sof og'irlikka o'tdi`);
    } catch (e) {
      showToast(e.message || "Top yozuvlarini sof og'irlikka o'tkazib bo'lmadi", true);
    } finally {
      els.zeroCoefBtn.disabled = false;
    }
  }
  els.zeroCoefBtn.addEventListener("click", zeroTopCoefficients);
  els.outboxDiagBtn.addEventListener("click", openOutboxDiag);
  els.outboxClose.addEventListener("click", closeOutboxDiag);
  els.outboxBackdrop.addEventListener("click", closeOutboxDiag);
  els.outboxRefresh.addEventListener("click", renderOutboxDiag);
  els.outboxSync.addEventListener("click", syncOutboxFromDiag);

  // ---- Adashgan reset ----
  function resetAdjust(full) {
    state.adjPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    state.adjPhotos = [];
    if (full || !remember) { state.adjFrom = ""; state.adjTo = ""; }
    state.adjWeightRaw = "";
    els.adjWeight.value = "";
    renderPhotos("adjPhotos");
    renderAdjust();
  }

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
    syncBackButton();
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

    syncBackButton();
  }

  // Default types stay fixed; custom types can be removed from the selector
  // without deleting historical report rows.
  function isDeletable(t) {
    return state.customTypes.includes(t);
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

  async function addType(value) {
    value = (value || "").trim();
    if (!value) return;
    // Prefer the canonical casing of an existing option; only add if new.
    const existing = allTypes().find((t) => t.toLowerCase() === value.toLowerCase());
    if (existing) { selectValue(existing); return; }
    try {
      const res = await fetch("/api/types", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ init_data: inTelegram ? tg.initData : "", name: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Tovar turini qo'shib bo'lmadi");
      state.customTypes = Array.isArray(json.custom) ? json.custom : state.customTypes;
      selectValue(json.name || value.toLowerCase());
    } catch (e) {
      showToast(e.message || "Tovar turini qo'shib bo'lmadi", true);
    }
  }

  async function deleteType(t) {
    const idx = state.customTypes.indexOf(t);
    if (idx === -1) return;
    if (!(await confirmDialog(`"${t}" tovar turi ro'yxatdan o'chirilsinmi?`))) return;
    try {
      const res = await fetch(`/api/types/${encodeURIComponent(t)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "O'chirib bo'lmadi");
      state.customTypes = Array.isArray(json.custom) ? json.custom : state.customTypes.filter((x) => x !== t);
      // If any selector currently points at the deleted type, reset it.
      if (state.type === t) reysTypeTarget.onSelect(reysTypeTarget.fallback);
      if (state.adjFrom === t) adjFromTarget.onSelect("");
      if (state.adjTo === t) adjToTarget.onSelect("");
      renderSheet(els.sheetInput.value); // keep the sheet open
      haptic("light");
    } catch (e) {
      showToast(e.message || "O'chirib bo'lmadi", true);
    }
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
  // Escape closes the topmost overlay; Left/Right page the lightbox or the
  // entries list (hardware keyboards / desktop / browser).
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const t = document.activeElement && document.activeElement.tagName;
      if (t === "INPUT" || t === "TEXTAREA") return; // don't hijack the text caret
      const d = e.key === "ArrowLeft" ? -1 : 1;
      if (!els.lightbox.hidden) { lbNav(d); return; }
      if (!els.entriesScreen.hidden && !els.entriesPager.hidden) {
        const btn = d < 0 ? els.entriesPrev : els.entriesNext;
        if (!btn.disabled) btn.click();
      }
      return;
    }
    if (e.key !== "Escape") return;
    if (!els.lightbox.hidden) closeLightbox();
    else if (!els.camModal.hidden) closeCamera();
    else if (!els.entryActSheet.hidden) closeEntryActions();
    else if (!els.nameSheet.hidden) closeNameSheet();
    else if (!els.setSheet.hidden) closeSettings();
    else if (sheetOpen) closeSheet();
    else if (!els.activityScreen.hidden) closeActivity();
    else if (!els.entriesScreen.hidden) closeEntries();
    else if (!els.topScreen.hidden) formBack();
    else if (!els.obshiyScreen.hidden) showMenu();
    else if (!els.menuScreen.hidden) showHome();
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
  els.coefChips.addEventListener("click", (ev) => {
    const chip = closestNode(ev.target, '.chip[data-mode="none"]');
    if (!chip || !els.coefChips.contains(chip)) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    els.coefCustomWrap.hidden = true;
    const menu = ensureCoefBoxMenu();
    setCoefBoxMenu(menu ? menu.hidden : true);
    haptic("select");
  }, true);

  els.coefChips.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", (ev) => {
      ev.stopPropagation();
      els.coefChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const mode = chip.dataset.mode;
      if (mode === "none") {
        state.coef = { mode: "none", value: 0, boxWeight: 0 };
        updateCoefNoneLabel();
        els.coefCustomWrap.hidden = true;
        setCoefBoxMenu(els.coefBoxMenu ? els.coefBoxMenu.hidden : false);
        haptic("select");
        return;
      }
      state.coef.mode = mode;
      setCoefBoxMenu(false);
      if (mode === "custom") {
        els.coefCustomWrap.hidden = false;
        state.coef.boxWeight = 0;
        updateCoefNoneLabel();
        setTimeout(() => els.coefCustom.focus(), 60);
      } else {
        els.coefCustomWrap.hidden = true;
        const value = parseFloat(chip.dataset.value);
        state.coef.value = mode === "fixed" ? value : 0;
        state.coef.boxWeight = mode === "box" ? value : 0;
        updateCoefNoneLabel();
      }
      haptic("select");
    });
  });
  ensureCoefBoxMenu();
  if (els.coefBoxMenu) {
    let coefBoxPointerHandledAt = 0;
    const onCoefBoxPick = (ev, fromPointer) => {
      const btn = closestNode(ev.target, "[data-box-value]");
      if (!btn || !els.coefBoxMenu.contains(btn)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      if (fromPointer) coefBoxPointerHandledAt = Date.now();
      else if (Date.now() - coefBoxPointerHandledAt < 400) return;
      selectCoefBoxValue(btn.dataset.boxValue);
    };
    els.coefBoxMenu.addEventListener("pointerup", (ev) => onCoefBoxPick(ev, true), true);
    els.coefBoxMenu.addEventListener("touchend", (ev) => onCoefBoxPick(ev, true), true);
    els.coefBoxMenu.addEventListener("click", (ev) => onCoefBoxPick(ev, false), true);
    document.addEventListener("click", (ev) => {
      if (els.coefBoxMenu.hidden) return;
      if (closestNode(ev.target, "#coefBoxMenu") || closestNode(ev.target, "#coefChips")) return;
      setCoefBoxMenu(false);
    });
  }
  els.coefCustom.addEventListener("input", (e) => {
    state.coef.mode = "custom";
    state.coef.value = parseFloat(e.target.value.replace(",", "."));
    state.coef.boxWeight = 0;
    updateCoefNoneLabel();
  });

  els.topCoefChips.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      els.topCoefChips.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      const mode = chip.dataset.mode;
      state.topCoef.mode = mode;
      if (mode === "custom") {
        els.topCoefCustomWrap.hidden = false;
        setTimeout(() => els.topCoefCustom.focus(), 60);
      } else {
        els.topCoefCustomWrap.hidden = true;
        state.topCoef.value = mode === "none" ? 0 : parseFloat(chip.dataset.value);
      }
      haptic("select");
    });
  });
  els.topCoefCustom.addEventListener("input", (e) => {
    state.topCoef.value = parseFloat(e.target.value.replace(",", "."));
  });

  // ---- Weight ----
  els.weight.addEventListener("input", (e) => { state.weightRaw = e.target.value; });

  // ---- Inventory / balances ----
  const balanceOf = (t) => Number(state.inventory[t] || 0);
  const fmtKg = (n) => `${(Math.round(n * 100) / 100).toLocaleString("en-US")} kg`;

  async function loadInventory() {
    if (!state.reportId) return;
    try {
      const res = await fetch(`/api/inventory?report_id=${state.reportId}`, { headers: authHeaders() });
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
    const base = state.adjFrom && state.adjTo ? `${state.adjFrom} → ${state.adjTo}` : "Saqlash";
    els.adjSaveBtn.textContent = editingAdj && state.adjFrom && state.adjTo ? `Yangilash: ${base}` : base;
  }

  els.adjWeight.addEventListener("input", (e) => { state.adjWeightRaw = e.target.value; });

  let adjusting = false;
  async function onAdjustSave() {
    if (adjusting) return;
    if (!state.reportId) { showToast("Hisobot tanlanmagan", true); return; }
    const weight = parseFloat(String(state.adjWeightRaw).replace(",", "."));
    if (!state.adjFrom || !state.adjTo) { showToast("Ikkala tovar turini tanlang", true); haptic("rigid"); return; }
    if (state.adjFrom === state.adjTo) { showToast("Tovar turlari bir xil bo'lmasin", true); haptic("rigid"); return; }
    if (!isFinite(weight) || weight <= 0) { showToast("Og'irlikni to'g'ri kiriting", true); haptic("rigid"); return; }

    adjusting = true;
    els.adjSaveBtn.disabled = true;
    const restoreText = els.adjSaveBtn.textContent;
    els.adjSaveBtn.textContent = "Saqlanmoqda…";
    const editing = editingAdj; // snapshot: cleared before finally runs
    const from = state.adjFrom, to = state.adjTo;
    const files = state.adjPhotos.map((p) => p.file);
    try {
      if (!editing) {
        await enqueueCreate("adjust", { from_type: from, to_type: to, weight }, files);
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
        showToast("Saqlandi ✓");
        resetAdjust();
        return;
      }

      if (sameText(editing.from, from) && sameText(editing.to, to) && sameNum(editing.weight, weight)) {
        const stillCurrent = editingAdj === editing;
        if (stillCurrent) editingAdj = null;
        showToast("O'zgarish yo'q");
        updateViewCount();
        if (stillCurrent) resetAdjust();
        renderBalances();
        returnToEditedEntry("adjust", editing);
        return;
      }

      const fd = new FormData();
      fd.append("init_data", inTelegram ? tg.initData : "");
      fd.append("report_id", String(state.reportId));
      fd.append("from_type", from);
      fd.append("to_type", to);
      fd.append("weight", String(weight));
      const res = await fetch(`/api/adjust/${editing.id}`, { method: "PUT", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Xatolik");
      state.inventory = json.balances || state.inventory;
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      Object.assign(editing, { from, to, weight });
      if (json.edited) editing.editedAt = Date.now();
      const stillCurrent = editingAdj === editing;
      if (stillCurrent) editingAdj = null; // may have been cancelled/replaced mid-flight
      showToast("Yangilandi ✓");
      updateViewCount();
      if (stillCurrent) resetAdjust(); // clears photos + weight (keeps from/to if "remember" on)
      renderBalances();
      returnToEditedEntry("adjust", editing);
    } catch (e) {
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
      showToast(e.message || "Xatolik", true);
    } finally {
      adjusting = false;
      els.adjSaveBtn.disabled = false;
      els.adjSaveBtn.textContent = editingAdj ? restoreText : (state.adjFrom && state.adjTo ? `${state.adjFrom} → ${state.adjTo}` : "Saqlash");
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
        sub.textContent = a.photos ? `${fmtKg(a.weight)} · ${a.photos} rasm` : fmtKg(a.weight);
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
      const res = await fetch(
        `/api/activity?report_id=${state.reportId}&start=${start}&end=${end}`,
        { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      renderActivity((res.ok && json.activity) || []);
    } catch (_) {
      renderActivity([]);
    }
  }

  function openActivity() {
    if (!state.reportId) return;
    const current = location.hash || "";
    activityReturnRoute = parseRoute().page === "activity" ? `#/report/${state.reportId}/menu` : current;
    els.activityScreen.hidden = false;
    document.body.classList.add("locked");
    setRoute(`/report/${state.reportId}/activity`);
    syncBackButton();
    loadActivityFor(todayStr()); // default: today only
  }

  els.actDate.addEventListener("change", () => loadActivityFor(els.actDate.value || todayStr()));
  els.actPrev.addEventListener("click", () => loadActivityFor(shiftDay(els.actDate.value || todayStr(), -1)));
  els.actNext.addEventListener("click", () => loadActivityFor(shiftDay(els.actDate.value || todayStr(), 1)));
  function closeActivity() {
    els.activityScreen.hidden = true;
    if (state.reportId) {
      const fallback = `#/report/${state.reportId}/menu`;
      const target = activityReturnRoute || fallback;
      activityReturnRoute = "";
      if (target.startsWith("#")) history.replaceState(null, "", target);
      else setRoute(`/report/${state.reportId}/menu`, true);
    }
    syncLock();
    syncBackButton();
  }
  els.activityBtn.addEventListener("click", openActivity);
  els.activityClose.addEventListener("click", closeActivity);

  // ---- Save ----
  function collect() {
    const weight = parseFloat(state.weightRaw.replace(",", "."));
    let coefValue = 0;
    if (state.coef.mode === "none") coefValue = 0;
    else if (state.coef.mode === "box") coefValue = 0;
    else if (state.coef.mode === "fixed") coefValue = state.coef.value;
    else coefValue = parseFloat(String(els.coefCustom.value).replace(",", "."));

    return {
      type: state.type,
      coefficient_mode: state.coef.mode,
      coefficient: coefValue,
      box_weight: state.coef.mode === "box" ? Number(state.coef.boxWeight) || 0 : 0,
      weight,
      photos: state.photos.map((p) => p.file),
    };
  }

  function validate(data) {
    if (!data.photos.length) return "Kamida 1 ta rasm qo'shing";
    if (!isFinite(data.weight) || data.weight <= 0) return "Og'irlikni to'g'ri kiriting";
    if (state.coef.mode === "box" && (!isFinite(data.box_weight) || data.box_weight <= 0))
      return "Karobka og'irligini tanlang";
    if (state.coef.mode === "custom" && (!isFinite(data.coefficient) || data.coefficient <= 0))
      return "Koeffitsientni kiriting";
    return null;
  }

  let saving = false;
  async function onSave() {
    if (saving) return;
    if (!state.reportId) { showToast("Hisobot tanlanmagan", true); return; }
    const data = collect();
    const err = validate(data);
    if (err) {
      showToast(err, true);
      haptic("rigid");
      return;
    }

    saving = true;
    setBusy(true);

    const editing = editingReys; // snapshot: cleared before finally runs

    if (!editing) {
      try {
        await enqueueCreate("reys", {
          type: data.type,
          coefficient: data.coefficient,
          coefficient_mode: data.coefficient_mode,
          box_weight: data.box_weight,
          weight: data.weight,
        }, data.photos);
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
        showToast("Saqlandi ✓");
        resetForm();
        if (state.reysFast) { activePk = "photos"; openCamera(); }
      } catch (e) {
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
        showToast(e.message || "Xatolik", true);
      } finally {
        saving = false;
        setBusy(false);
      }
      return;
    }

    if (
      sameText(editing.type, data.type) &&
      sameText(editing.coefMode || "none", data.coefficient_mode || "none") &&
      sameNum(editing.coefficient, data.coefficient) &&
      sameNum(editing.boxWeight || 0, data.box_weight || 0) &&
      sameNum(editing.weight, data.weight)
    ) {
      const stillCurrent = editingReys === editing;
      if (stillCurrent) editingReys = null;
      showToast("O'zgarish yo'q");
      updateViewCount();
      if (stillCurrent) resetForm();
      loadInventory();
      returnToEditedEntry("reys", editing);
      saving = false;
      setBusy(false);
      return;
    }

    const fd = new FormData();
    fd.append("init_data", tg ? tg.initData : "");
    fd.append("report_id", String(state.reportId));
    fd.append("type", data.type);
    fd.append("coefficient", String(data.coefficient));
    fd.append("coefficient_mode", data.coefficient_mode);
    fd.append("box_weight", String(data.box_weight || 0));
    fd.append("weight", String(data.weight));

    try {
      const res = await fetch(`/api/report/${editing.id}`, { method: "PUT", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Server xatosi");

      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      Object.assign(editing, {
        type: data.type, coefMode: data.coefficient_mode,
        coefficient: data.coefficient, boxWeight: data.box_weight || 0, weight: data.weight,
      });
      if (json.edited) editing.editedAt = Date.now();
      // Only clear if the edit session still belongs to this request (it may
      // have been cancelled/replaced while the PUT was in flight).
      const stillCurrent = editingReys === editing;
      if (stillCurrent) editingReys = null;
      showToast(json.balance != null ? `Yangilandi ✓  ${data.type}: ${fmtKg(json.balance)}` : "Yangilandi ✓");
      updateViewCount();
      if (stillCurrent) resetForm();
      loadInventory();
      returnToEditedEntry("reys", editing);
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
    if (els.weightQuickSave) els.weightQuickSave.disabled = busy;
    els.saveBtn.textContent = busy ? "Saqlanmoqda…" : (editingReys ? "Yangilash" : "Saqlash");
  }

  function resetForm(full) {
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    state.weightRaw = "";
    els.weight.value = "";
    // Keep the type + coefficient when "remember" is on (unless a full reset,
    // e.g. opening a report — each report starts from 0).
    if (full || !remember) {
      state.type = "akb";
      state.coef = { mode: "none", value: 0, boxWeight: 0 };
      els.typeValue.textContent = "akb";
      els.coefCustom.value = "";
      els.coefCustomWrap.hidden = true;
      setCoefBoxMenu(false);
      els.coefChips.querySelectorAll(".chip").forEach((c, i) => c.classList.toggle("is-active", i === 0));
      updateCoefNoneLabel();
    }
    renderPhotos("photos");
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

  // Browser user is authenticated → reveal the "add passkey" action + go home.
  function onAuthed() {
    if (!inTelegram && hasWebAuthn) els.passkeyAddBtn.hidden = false;
    showHome();
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
    if (!username) { showLoginError("Foydalanuvchi nomini kiriting"); return; }
    if (!/^\d{4}$/.test(password)) { showLoginError("4 xonali PIN kiriting"); return; }
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
  // PIN: digits only, max 4.
  if (els.loginPass) els.loginPass.addEventListener("input", (e) => {
    const v = e.target.value.replace(/\D/g, "").slice(0, 4);
    if (v !== e.target.value) e.target.value = v;
  });
  if (els.passkeyLoginBtn) els.passkeyLoginBtn.addEventListener("click", loginWithPasskey);
  if (els.passkeyAddBtn) els.passkeyAddBtn.addEventListener("click", registerPasskey);
  window.addEventListener("hashchange", () => {
    if (routeRestoring) return;
    if (parseRoute().kind === "reports") {
      showHome();
      return;
    }
    if (!reportsLoaded) {
      loadReports();
      return;
    }
    applyRouteFromHash();
  });

  // ---- Boot ----
  initTelegram();
  renderAllPhotos();
  renderAdjust();
  renderBalances();
  gateAccess();
})();
