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
  const DEFAULT_TYPES = ["akb", "triton", "izi", "navo", "xabib", "jet", "jon"];

  // Obshiy ves sub-sections that share one photo+code+weight form. `codeRequired`
  // toggles whether karobka kodi is mandatory (Bizda qoladigan lets it be blank).
  const SECTIONS = {
    top: { title: "Top", codeRequired: true },
    topchiqgan: { title: "Topdan chiqgan", codeRequired: false },
    bizda: { title: "Bizda qoladigan", codeRequired: false },
    chiqgan: { title: "Bizdan chiqgan", codeRequired: false },
  };
  const ENTRIES_PAGE = 6;

  // ---- App state ----
  const state = {
    activeTab: "report",
    reportId: null,
    reportName: "",
    photos: [], // reys photos { id, file, url }
    adjPhotos: [], // adashgan photos
    topPhotos: [], // shared Obshiy-ves form photos (one section open at a time)
    topWeightRaw: "",
    topCodeFree: false, // pencil unlocked → karobka kodi accepts any character
    topFast: false, // fast-mode capture loop
    formSection: "top", // which SECTIONS entry the form is currently editing
    entries: { top: [], topchiqgan: [], bizda: [], chiqgan: [] }, // saved rows (client-side until backend)
    type: "akb",
    customTypes: [], // user-added types not yet persisted to inventory
    inventory: {}, // tovar_turi -> weight (from server)
    coef: { mode: "none", value: 0 }, // mode: none | fixed | custom
    weightRaw: "",
    adjFrom: "",
    adjTo: "",
    adjWeightRaw: "",
  };

  let remember = false;
  try { remember = localStorage.getItem("reys-remember") === "1"; } catch (_) {}
  try { state.topFast = localStorage.getItem("reys-top-fast") === "1"; } catch (_) {}

  // iOS numeric keyboards can emit a comma as the decimal separator — normalize
  // to a dot and drop stray chars / extra dots so parseFloat works.
  function cleanDecimal(v) {
    v = String(v == null ? "" : v).replace(/,/g, ".").replace(/[^\d.]/g, "");
    const i = v.indexOf(".");
    if (i !== -1) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, "");
    return v;
  }

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
    topWeight: $("#topWeight"),
    topFast: $("#topFast"),
    topSave: $("#topSave"),
    // Saved-entries viewer
    entriesScreen: $("#entriesScreen"),
    entriesBackBtn: $("#entriesBackBtn"),
    entriesTitle: $("#entriesTitle"),
    entriesList: $("#entriesList"),
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
      !els.nameSheet.hidden || !els.setSheet.hidden;
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
      !els.nameSheet.hidden || !els.setSheet.hidden || !els.entryActSheet.hidden
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
    haptic("select");
  }

  els.tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  // ---- Photos (two independent sets: reys "photos", adashgan "adjPhotos") ----
  let activePk = "photos"; // which set the gallery/camera currently targets
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
      // Fast mode: jump straight to the karobka kodi input after each shot.
      if (pk === "topPhotos" && state.topFast) {
        setTimeout(() => { try { els.topCode.focus(); } catch (_) {} }, 60);
      }
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

  // ---- Photo lightbox ----
  let lightboxId = null;
  let lightboxPk = "photos";
  let lightboxTempUrl = null; // ephemeral URL when viewing a saved-entry photo
  function openLightbox(photo, pk) {
    lightboxId = photo.id;
    lightboxPk = pk || "photos";
    lightboxTempUrl = null;
    els.lightboxDel.hidden = false; // form photos are deletable from the lightbox
    els.lightboxImg.src = photo.url;
    els.lightbox.hidden = false;
    document.body.classList.add("locked");
    syncBackButton();
  }
  // View-only: a saved-entry photo (a File with no persistent object URL).
  function viewEntryPhoto(file) {
    lightboxId = null;
    lightboxTempUrl = URL.createObjectURL(file);
    els.lightboxDel.hidden = true; // no delete here — edit/delete live in the kebab
    els.lightboxImg.src = lightboxTempUrl;
    els.lightbox.hidden = false;
    document.body.classList.add("locked");
    syncBackButton();
  }
  function closeLightbox() {
    els.lightbox.hidden = true;
    els.lightboxImg.src = "";
    lightboxId = null;
    if (lightboxTempUrl) { URL.revokeObjectURL(lightboxTempUrl); lightboxTempUrl = null; }
    els.lightboxDel.hidden = false;
    syncLock(); // keep the lock if a .screen (entries viewer / top form) is still open
    syncBackButton();
  }
  function deleteFromLightbox() {
    if (lightboxId != null) removePhoto(lightboxId, lightboxPk);
    closeLightbox();
  }
  els.lightbox.addEventListener("click", (e) => { if (e.target === els.lightbox) closeLightbox(); });
  els.lightboxClose.addEventListener("click", closeLightbox);
  els.lightboxDel.addEventListener("click", deleteFromLightbox);

  // ---- Reports (home) ----
  function confirmDialog(msg) {
    return new Promise((resolve) => {
      if (inTelegram && tg.showConfirm) tg.showConfirm(msg, (ok) => resolve(!!ok));
      else resolve(window.confirm(msg));
    });
  }

  function reportItem(rep) {
    const li = document.createElement("li");
    li.className = "report-item";
    const main = document.createElement("div");
    main.className = "report-item__main";
    const name = document.createElement("div");
    name.className = "report-item__name";
    name.textContent = rep.name;
    const sub = document.createElement("div");
    sub.className = "report-item__sub";
    sub.textContent = `${fmtTs(rep.created_at)} · ${rep.entries || 0} yozuv`;
    main.append(name, sub);
    const xls = document.createElement("button");
    xls.className = "report-item__xls";
    xls.type = "button";
    xls.setAttribute("aria-label", "Excel yuklash");
    xls.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M12 3 7 8h3v6h4V8h3l-5-5ZM5 18h14v2H5z"/></svg>';
    xls.addEventListener("click", (e) => { e.stopPropagation(); showToast("Excel funksiyasi tez orada", false); });
    const del = document.createElement("button");
    del.className = "report-item__del";
    del.type = "button";
    del.setAttribute("aria-label", "O'chirish");
    del.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M9 3h6l1 2h4v2H4V5h4l1-2ZM6 8h12l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8Z"/></svg>';
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteReport(rep); });
    const go = document.createElement("span");
    go.className = "report-item__go";
    go.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6-1.4-1.4L12.2 12 7.6 7.4z"/></svg>';
    li.append(main, xls, del, go);
    li.addEventListener("click", () => openReport(rep));
    return li;
  }

  async function loadReports() {
    els.reportList.innerHTML = "";
    els.homeHint.textContent = "Yuklanmoqda…";
    try {
      const res = await fetch("/api/reports", { headers: authHeaders() });
      const json = await res.json().catch(() => ({}));
      const reports = (res.ok && json.reports) || [];
      els.homeHint.textContent = reports.length
        ? `Saqlangan hisobotlar (${reports.length}/${json.max || 5})`
        : "Hali hisobot yo'q. Yangi hisobot qo'shing.";
      reports.forEach((rep) => els.reportList.appendChild(reportItem(rep)));
    } catch (_) {
      els.homeHint.textContent = "Yuklashda xatolik";
    }
  }

  function showHome() {
    state.reportId = null;
    els.reportName.textContent = "";
    showScreen(null);          // hide menu / obshiy / top
    els.homeScreen.hidden = false;
    document.body.classList.add("locked");
    syncBackButton(); // home is the root → no back button
    loadReports();
  }

  // Only one report-level screen is visible at a time: 'menu' | 'obshiy' |
  // 'top' (or null to reveal the work area behind them).
  function showScreen(which) {
    els.menuScreen.hidden = which !== "menu";
    els.obshiyScreen.hidden = which !== "obshiy";
    els.topScreen.hidden = which !== "top";
    els.entriesScreen.hidden = true; // leaf overlay — drop it on any nav change
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
    loadInventory();
    els.homeScreen.hidden = true;
    showMenu();
  }

  // Report section menu (Obshiy ves / Kargolarga tarqatish).
  function showMenu() {
    els.menuTitle.textContent = state.reportName;
    showScreen("menu");
    document.body.classList.add("locked");
    syncBackButton();
  }

  // Obshiy ves → Top / Bizda qoladigan / Adashgan yuklar.
  function showObshiy() {
    showScreen("obshiy");
    document.body.classList.add("locked");
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
    syncBackButton();
  }

  function updateViewCount() {
    els.topViewCount.textContent = String(state.entries[state.formSection].length);
  }

  // "Kargolarga tarqatish" → reveal the reys/adashgan tab work area.
  function openWork() {
    showScreen(null);
    document.body.classList.remove("locked");
    setTab("report");
    syncBackButton();
  }

  function resetTop(full) {
    state.topPhotos.forEach((p) => URL.revokeObjectURL(p.url));
    state.topPhotos = [];
    els.topCode.value = "";
    state.topWeightRaw = "";
    els.topWeight.value = "";
    renderPhotos("topPhotos");
    if (full) {
      // Opening a report resets the free-text unlock back to numeric-only;
      // fast mode is a persisted workflow preference, so it's kept.
      state.topCodeFree = false;
      els.topCodePencil.classList.remove("is-on");
      els.topCode.inputMode = "numeric";
    }
  }

  let savingTop = false;
  let editingEntry = null; // the entry currently being edited (null = creating)
  function onFormSave() {
    if (savingTop) return;
    const cfg = SECTIONS[state.formSection];
    const code = els.topCode.value.trim();
    const weight = parseFloat(cleanDecimal(state.topWeightRaw));
    if (cfg.codeRequired && !code) { showToast("Karobka kodini kiriting", true); haptic("rigid"); return; }
    if (!isFinite(weight) || weight <= 0) { showToast("Og'irlikni to'g'ri kiriting", true); haptic("rigid"); return; }

    savingTop = true;
    els.topSave.disabled = true;
    // Entries hold the actual File objects (so photos can be viewed later);
    // object URLs are created on demand at render time. Backend isn't wired yet.
    const files = state.topPhotos.map((p) => p.file);
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    if (editingEntry) {
      editingEntry.code = code;
      editingEntry.weight = weight;
      editingEntry.files = files;
      editingEntry = null;
      els.topSave.textContent = "Saqlash";
      showToast("Yangilandi ✓");
      resetTop(false);
      updateViewCount();
      savingTop = false;
      els.topSave.disabled = false;
      return; // no fast-mode camera reopen while editing
    }
    state.entries[state.formSection].push({ code, weight, files, ts: Date.now() });
    updateViewCount();
    showToast("Saqlandi ✓");
    resetTop(false);
    savingTop = false;
    els.topSave.disabled = false;
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
    actionEntry = null;
    els.topSave.textContent = "Saqlash";
    state.entries = { top: [], topchiqgan: [], bizda: [], chiqgan: [] };
  }

  // ---- Saved-entries viewer (cards, paginated) ----
  let entriesPage = 0;
  let entryUrls = []; // object URLs created for the current render; revoked on re-render
  function clearEntryUrls() { entryUrls.forEach((u) => URL.revokeObjectURL(u)); entryUrls = []; }

  function openEntries() {
    entriesPage = 0;
    els.entriesTitle.textContent = SECTIONS[state.formSection].title + " — yuklanganlar";
    els.entriesScreen.hidden = false;
    document.body.classList.add("locked");
    renderEntries();
    syncBackButton();
  }
  function closeEntries() {
    clearEntryUrls();
    els.entriesScreen.hidden = true;
    syncBackButton(); // Top form stays visible underneath
  }
  function renderEntries() {
    const list = state.entries[state.formSection];
    const pages = Math.max(1, Math.ceil(list.length / ENTRIES_PAGE));
    entriesPage = Math.min(Math.max(entriesPage, 0), pages - 1);
    clearEntryUrls();
    els.entriesList.innerHTML = "";
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "entries__empty";
      p.textContent = "Hali yozuv yo'q";
      els.entriesList.appendChild(p);
      els.entriesPager.hidden = true;
      return;
    }
    const ordered = list.slice().reverse(); // newest first
    const start = entriesPage * ENTRIES_PAGE;
    ordered.slice(start, start + ENTRIES_PAGE).forEach((e) => els.entriesList.appendChild(entryCard(e)));
    els.entriesPager.hidden = pages <= 1;
    els.entriesPageLabel.textContent = `${entriesPage + 1}/${pages}`;
    els.entriesPrev.disabled = entriesPage <= 0;
    els.entriesNext.disabled = entriesPage >= pages - 1;
  }

  function entryCard(e) {
    const files = e.files || [];
    const card = document.createElement("div");
    card.className = "entry-card";

    const head = document.createElement("div");
    head.className = "entry-card__head";
    const code = document.createElement("div");
    code.className = "entry-card__code";
    code.textContent = e.code || "—";
    const val = document.createElement("div");
    val.className = "entry-card__val";
    val.innerHTML = `${(Math.round(Number(e.weight) * 100) / 100).toLocaleString("en-US")}<span> kg</span>`;
    const menu = document.createElement("button");
    menu.className = "entry-card__menu";
    menu.type = "button";
    menu.setAttribute("aria-label", "Amallar");
    menu.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>';
    menu.addEventListener("click", (ev) => { ev.stopPropagation(); openEntryActions(e); });
    head.append(code, val, menu);
    card.appendChild(head);

    const foot = document.createElement("div");
    foot.className = "entry-card__foot";
    const thumbs = document.createElement("div");
    thumbs.className = "entry-card__thumbs";
    files.slice(0, 5).forEach((f) => {
      const url = URL.createObjectURL(f);
      entryUrls.push(url);
      const img = document.createElement("img");
      img.className = "entry-thumb";
      img.src = url;
      img.alt = "";
      img.addEventListener("click", () => viewEntryPhoto(f));
      thumbs.appendChild(img);
    });
    if (files.length > 5) {
      const more = document.createElement("span");
      more.className = "entry-more";
      more.textContent = `+${files.length - 5}`;
      thumbs.appendChild(more);
    }
    const sub = document.createElement("div");
    sub.className = "entry-card__sub";
    sub.textContent = `${fmtTs(e.ts / 1000)} · ${files.length} rasm`;
    foot.append(thumbs, sub);
    card.appendChild(foot);
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
    els.topWeight.value = String(entry.weight);
    state.topWeightRaw = String(entry.weight);
    els.topSave.textContent = "Yangilash";
    closeEntries(); // reveal the form (still under the entries screen)
  }
  function deleteEntry(entry) {
    const list = state.entries[state.formSection];
    const i = list.indexOf(entry);
    if (i === -1) return;
    list.splice(i, 1);
    if (editingEntry === entry) { editingEntry = null; els.topSave.textContent = "Saqlash"; }
    updateViewCount();
    renderEntries();
    haptic("light");
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

  // ---- Report section menu ----
  els.menuBackBtn.addEventListener("click", showHome);
  els.menuDistBtn.addEventListener("click", openWork);
  els.menuTotalBtn.addEventListener("click", showObshiy);
  els.menuTotalXls.addEventListener("click", () => showToast("Excel funksiyasi tez orada", false));

  // ---- Obshiy ves submenu ----
  els.obshiyBackBtn.addEventListener("click", showMenu);
  els.obshiyTopBtn.addEventListener("click", () => openForm("top"));
  els.obshiyTopChiqganBtn.addEventListener("click", () => openForm("topchiqgan"));
  els.obshiyBizdaBtn.addEventListener("click", () => openForm("bizda"));
  els.obshiyChiqganBtn.addEventListener("click", () => openForm("chiqgan"));

  // ---- Shared Obshiy-ves form ----
  els.topBackBtn.addEventListener("click", formBack);
  els.topViewBtn.addEventListener("click", openEntries);
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
    els.adjSaveBtn.textContent = state.adjFrom && state.adjTo ? `${state.adjFrom} → ${state.adjTo}` : "Saqlash";
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
    try {
      const fd = new FormData();
      fd.append("init_data", inTelegram ? tg.initData : "");
      fd.append("report_id", String(state.reportId));
      fd.append("from_type", state.adjFrom);
      fd.append("to_type", state.adjTo);
      fd.append("weight", String(weight));
      state.adjPhotos.forEach((p, i) => fd.append("photos", p.file, p.file.name || `photo_${i}.jpg`));
      const res = await fetch("/api/adjust", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.detail || "Xatolik");
      state.inventory = json.balances || state.inventory;
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
      showToast("Saqlandi ✓");
      resetAdjust(); // clears photos + weight (keeps from/to if "remember" on)
      renderBalances();
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
    els.activityScreen.hidden = false;
    document.body.classList.add("locked");
    syncBackButton();
    loadActivityFor(todayStr()); // default: today only
  }

  els.actDate.addEventListener("change", () => loadActivityFor(els.actDate.value || todayStr()));
  els.actPrev.addEventListener("click", () => loadActivityFor(shiftDay(els.actDate.value || todayStr(), -1)));
  els.actNext.addEventListener("click", () => loadActivityFor(shiftDay(els.actDate.value || todayStr(), 1)));
  function closeActivity() {
    els.activityScreen.hidden = true;
    document.body.classList.remove("locked");
    syncBackButton();
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

    const fd = new FormData();
    fd.append("init_data", tg ? tg.initData : "");
    fd.append("report_id", String(state.reportId));
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

  function resetForm(full) {
    state.photos.forEach((p) => URL.revokeObjectURL(p.url));
    state.photos = [];
    state.weightRaw = "";
    els.weight.value = "";
    // Keep the type + coefficient when "remember" is on (unless a full reset,
    // e.g. opening a report — each report starts from 0).
    if (full || !remember) {
      state.type = "akb";
      state.coef = { mode: "none", value: 0 };
      els.typeValue.textContent = "akb";
      els.coefCustom.value = "";
      els.coefCustomWrap.hidden = true;
      els.coefChips.querySelectorAll(".chip").forEach((c, i) => c.classList.toggle("is-active", i === 0));
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

  // ---- Boot ----
  initTelegram();
  renderAllPhotos();
  renderAdjust();
  renderBalances();
  gateAccess();
})();
