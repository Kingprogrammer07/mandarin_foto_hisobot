export const meta = {
  name: 'review-entry-crud-lightbox',
  description: 'Adversarially review the entry backend-CRUD + Telegram-lightbox diff',
  phases: [
    { title: 'Review' },
    { title: 'Verify' },
  ],
}

const CONTEXT = `
Repo: C:/Users/Admin/Desktop/mandarin_reys_hisobot — Telegram Mini App: FastAPI backend (app/db.py, app/server.py) + vanilla-JS frontend (webapp/js/app.js, webapp/index.html, webapp/css/styles.css). Run "git diff" to see the change under review.

The diff adds:
BACKEND
- db.py: add_reys/adjust now return entry_id (lastrowid). New: _get_entry, _apply_balances (all-or-nothing per-type deltas, raises InsufficientStock if any balance would drop below -1e-9), edit_reys (reverse old net, apply new), edit_adjust (reverse old transfer, apply new), delete_entry (undo effect + delete row), ActivityNotFound.
- server.py: PUT /api/report/{entry_id}, PUT /api/adjust/{entry_id} (multipart, same validation as the POSTs), DELETE /api/entry/{entry_id}?report_id= (auth _auth_or_403 state_changing, rate-limited). 404 ActivityNotFound, 409 InsufficientStock.
FRONTEND
- Entries lists per section: {top, topchiqgan, bizda, chiqgan, reys, adjust}; reys/adjust saves push {id: json.entry_id, ..., files, ts}.
- "Yuklanganlar" buttons on both work-area tabs (reysViewBtn/adjViewBtn) → shared paginated viewer keyed by new viewerSection var (was state.formSection).
- Kebab edit: startEditReys (loads type/coef via setCoefUI/weight/photos into tab 1; editingReys; save PUTs), startEditAdjust (tab 2; editingAdj; save PUTs; adjSaveBtn shows "Yangilash: from → to"). deleteEntry is now async: for reys/adjust it DELETEs /api/entry first, updates balances, then splices locally.
- onSave/onAdjustSave: editing branches (snapshot const editing = editingReys/editingAdj before await; Object.assign entry on success; setBusy shows Yangilash while editingReys).
- Lightbox rework: lb state {mode:'form'|'entry', pk?, files?, caption?, i}; lbShow/lbNav; prev/next buttons; counter; caption (entryCaption from entry fields); swipe (touchstart/touchend dx>48); ArrowLeft/ArrowRight keyboard (skipped when focus in INPUT/TEXTAREA; also pages the entries viewer); deleteFromLightbox only in form mode (removes current, clamps index, closes when empty); entry mode uses one ephemeral object URL (lbTempUrl) revoked on switch/close.

Focus ONLY on the changed behavior. Read the files (and git diff) yourself. The Obshiy sections being session-memory-only is BY DESIGN. Backend already passes a 15-case TestClient suite (create/edit/delete/409 guards/404s/cross-report scoping) — look for what those tests DON'T cover.
`;

const DIMENSIONS = [
  { key: 'backend-consistency', prompt: 'Hunt for backend correctness bugs in db.edit_reys/edit_adjust/delete_entry/_apply_balances and the new endpoints: float accumulation vs the -1e-9 epsilon; same-type collisions in edit_adjust deltas (e.g. new from == old to); editing an adjust so from_type==old from; concurrent-lock assumptions; activity row fields left stale (ts/actor); DELETE /api/entry auth path (header initData vs cookie origin) vs how the frontend calls it; rate-limit key choice; report_id type coercion; whether PUT validation diverges from POST anywhere that matters.' },
  { key: 'frontend-state', prompt: 'Hunt for frontend state-machine bugs: editingReys/editingAdj lifecycle (failed PUT leaves what state? navigating away mid-edit? deleting the entry being edited? switching tabs mid-edit? starting an Obshiy edit while a reys edit is pending?); viewerSection vs state.formSection divergence (openEntries from topViewBtn vs reysViewBtn; kebab edit/delete routed by viewerSection after the viewer was reopened for a different section); entry object identity after Object.assign; badge counts; setCoefUI chip restoration for custom and unmatched fixed values; remember-mode interaction with resetForm after edit.' },
  { key: 'lightbox-nav', prompt: 'Hunt for lightbox bugs: lb index vs live array mutation (deleteFromLightbox while grid re-renders; photos added while lightbox open); ephemeral URL leaks or use-after-revoke (lbTempUrl on rapid nav; entryUrls vs lbShow); swipe handler conflicts with existing pinch/drag handlers or scrolling; ArrowLeft/Right hijack cases (focus in a button? select sheet open? entries pager while lightbox open takes precedence — correct?); counter/arrow states with 0 or 1 items; viewEntryPhotos on an entry whose files were replaced by a concurrent edit; closing via backdrop click hitting nav buttons.' },
]

phase('Review')
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(`${CONTEXT}\n\nYou are a skeptical reviewer. ${d.prompt}\n\nReport concrete, real defects only (file:line, failing scenario reachable through real UI/API paths, and why). If nothing solid, return an empty list.`,
    { label: `review:${d.key}`, phase: 'Review', schema: {
      type: 'object', additionalProperties: false,
      required: ['findings'],
      properties: { findings: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['summary', 'file', 'line', 'scenario'],
        properties: {
          summary: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          scenario: { type: 'string' },
        } } } } } }),
  (review, d) => parallel((review.findings || []).map((f) => () =>
    agent(`${CONTEXT}\n\nAnother reviewer claims this defect in the CHANGED code:\nSummary: ${f.summary}\nLocation: ${f.file}:${f.line}\nScenario: ${f.scenario}\n\nRead the actual code and try to REFUTE it. Real only if reachable through the app's real navigation/handlers or real API calls (not synthetic). Default to real=false if uncertain or guarded elsewhere.`,
      { label: `verify:${d.key}`, phase: 'Verify', schema: {
        type: 'object', additionalProperties: false,
        required: ['real', 'verdict'],
        properties: {
          real: { type: 'boolean' },
          verdict: { type: 'string' },
        } } })
      .then((v) => ({ ...f, ...v }))
  )),
)

const confirmed = results.flat().filter(Boolean).filter((f) => f.real)
return { totalRaw: results.flat().filter(Boolean).length, confirmed }
