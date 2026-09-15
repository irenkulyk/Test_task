/* Delivery Audit — client-side prototype
 * Vanilla JS, no build step. Gemini Vision, called directly from the browser.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ============================================================
// CONFIG
// ============================================================

const MODEL = {
  id: "gemini-3.6-flash",
  // Pricing assumptions — verify at ai.google.dev/pricing before quoting these externally.
  inputPerMTok: 1.5,
  outputPerMTok: 7.5,
};

const MAX_PHOTOS = 3;
const MAX_IMAGE_EDGE = 1568; // downscale before upload: cuts latency and token cost

// ============================================================
// STATE
// ============================================================

const state = {
  pdfText: "",
  pdfName: "",
  images: [],
  result: null,
  selectedRowId: null,
  hoverRowId: null,
  activePhoto: 0,
  metrics: null,
};

// ============================================================
// ELEMENTS
// ============================================================

const els = {
  pdfDrop: document.getElementById("pdf-drop"),
  pdfDropLabel: document.getElementById("pdf-drop-label"),
  pdfInput: document.getElementById("pdf-input"),
  pdfParsed: document.getElementById("pdf-parsed"),
  imgDrop: document.getElementById("img-drop"),
  imgInput: document.getElementById("img-input"),
  imgThumbs: document.getElementById("img-thumbs"),
  imgCount: document.getElementById("img-count"),
  apiKey: document.getElementById("api-key"),
  runBtn: document.getElementById("run-btn"),
  statusLine: document.getElementById("status-line"),
  resultsZone: document.getElementById("results-zone"),
};

// ============================================================
// HELPERS
// ============================================================

function setStatus(text, cls = "") {
  if (!els.statusLine) return;
  els.statusLine.textContent = text || "";
  els.statusLine.className = "status-line" + (cls ? " " + cls : "");
}

function updateRunEnabled() {
  if (!els.runBtn) return;
  els.runBtn.disabled = !(
    state.pdfText &&
    state.images.length > 0 &&
    els.apiKey?.value.trim()
  );
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
  );
}

const clamp = (v) => Math.min(1, Math.max(0, v));

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const v = bbox.map(Number);
  if (v.some((n) => !Number.isFinite(n))) return null;
  const box = [clamp(v[0]), clamp(v[1]), clamp(v[2]), clamp(v[3])];
  if (box[2] <= 0 || box[3] <= 0) return null;
  return box;
}

// ============================================================
// PDF INTAKE
// ============================================================

async function handlePdfFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error("Потрібно завантажити PDF-файл.");
  }

  state.pdfName = file.name;

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  let text = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((i) => i.str).join(" ") + "\n";
  }

  state.pdfText = text.trim();
  if (!state.pdfText) {
    throw new Error("У PDF не знайдено тексту — схоже, це скан без текстового шару.");
  }

  const words = state.pdfText.split(/\s+/).filter(Boolean).length;

  els.pdfDrop.classList.add("filled");
  if (els.pdfDropLabel) els.pdfDropLabel.textContent = "Пакувальний лист завантажено";
  els.pdfParsed.innerHTML = `
    <div class="item"><span>${escapeHtml(file.name)}</span><span>${words} слів</span></div>
    <div class="item" style="color:var(--ink-faint);font-size:11px;">
      Рядки розбирає сама модель — локального парсера немає, тому розкладка листа може бути довільною.
    </div>`;

  updateRunEnabled();
}

// ============================================================
// IMAGE INTAKE (with downscaling)
// ============================================================

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Не вдалося прочитати ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function downscale(dataUrl, mediaType) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longest = Math.max(img.width, img.height);
      if (longest <= MAX_IMAGE_EDGE) {
        resolve({ dataUrl, w: img.width, h: img.height });
        return;
      }
      const scale = MAX_IMAGE_EDGE / longest;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const type = mediaType === "image/png" ? "image/png" : "image/jpeg";
      resolve({ dataUrl: canvas.toDataURL(type, 0.9), w: canvas.width, h: canvas.height });
    };
    img.onerror = () => resolve({ dataUrl, w: 0, h: 0 });
    img.src = dataUrl;
  });
}

async function handleImgFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const remaining = MAX_PHOTOS - state.images.length;
  if (remaining <= 0) {
    setStatus(`Максимум ${MAX_PHOTOS} фото. Видаліть зайве, щоб додати інше.`, "err");
    return;
  }

  const valid = files
    .filter((f) => ["image/jpeg", "image/png", "image/webp"].includes(f.type))
    .slice(0, remaining);

  if (!valid.length) throw new Error("Підтримуються тільки JPG, PNG та WebP.");

  for (const file of valid) {
    const original = await fileToDataUrl(file);
    const { dataUrl } = await downscale(original, file.type);
    const mediaType = dataUrl.slice(5, dataUrl.indexOf(";"));
    state.images.push({
      name: file.name,
      dataUrl,
      base64: dataUrl.split(",")[1],
      mediaType,
    });
  }

  renderThumbs();
  updateRunEnabled();
}

function renderThumbs() {
  if (!els.imgThumbs) return;

  els.imgThumbs.innerHTML = state.images
    .map(
      (img, i) => `
        <div class="thumb">
          <img src="${img.dataUrl}" alt="Фото ${i + 1}" title="${escapeHtml(img.name)}" />
          <span class="idx">${i + 1}</span>
          <button class="kill" data-kill="${i}" title="Прибрати">×</button>
        </div>`
    )
    .join("");

  els.imgCount.textContent = `${state.images.length} / ${MAX_PHOTOS}`;
  els.imgDrop.classList.toggle("filled", state.images.length > 0);

  els.imgThumbs.querySelectorAll("[data-kill]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.images.splice(Number(btn.dataset.kill), 1);
      state.activePhoto = 0;
      renderThumbs();
      updateRunEnabled();
    });
  });
}

// ============================================================
// DRAG & DROP
// ============================================================

function setupDropZone(zone, input, handler, accepted = []) {
  if (!zone) return;
  let counter = 0;

  zone.addEventListener("click", (e) => {
    if (e.target.closest("button") || e.target.closest("a")) return;
    input?.click();
  });

  zone.addEventListener("dragenter", (e) => {
    e.preventDefault(); e.stopPropagation();
    counter++; zone.classList.add("drag");
  });

  zone.addEventListener("dragover", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });

  zone.addEventListener("dragleave", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (--counter <= 0) { counter = 0; zone.classList.remove("drag"); }
  });

  zone.addEventListener("drop", async (e) => {
    e.preventDefault(); e.stopPropagation();
    counter = 0; zone.classList.remove("drag");

    const files = Array.from(e.dataTransfer?.files || []).filter((f) => {
      if (!accepted.length) return true;
      return accepted.includes(f.type) ||
        (accepted.includes("application/pdf") && f.name.toLowerCase().endsWith(".pdf"));
    });

    if (!files.length) {
      setStatus(
        accepted.includes("application/pdf") ? "Перетягніть PDF-файл." : "Перетягніть JPG, PNG або WebP.",
        "err"
      );
      return;
    }

    try { await handler(files); setStatus(""); }
    catch (err) { console.error(err); setStatus("Помилка: " + err.message, "err"); }
  });
}

setupDropZone(els.pdfDrop, els.pdfInput, async (f) => handlePdfFile(f[0]), ["application/pdf"]);
setupDropZone(els.imgDrop, els.imgInput, handleImgFiles, ["image/jpeg", "image/png", "image/webp"]);

els.pdfInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (file) {
    try { await handlePdfFile(file); setStatus(""); }
    catch (err) { console.error(err); setStatus("Помилка: " + err.message, "err"); }
  }
  e.target.value = "";
});

els.imgInput?.addEventListener("change", async (e) => {
  try { await handleImgFiles(e.target.files || []); setStatus(""); }
  catch (err) { console.error(err); setStatus("Помилка: " + err.message, "err"); }
  e.target.value = "";
});

els.apiKey?.addEventListener("input", updateRunEnabled);

// ============================================================
// PROMPT
// ============================================================

const SYSTEM_PROMPT = `
Ти проводиш аудит доставки: звіряєш фотографії розпакованого товару
з пакувальним листом, витягнутим із PDF.

Відповідай ЛИШЕ строгим JSON без markdown і пояснень.

Схема:
{
  "manifest_rows": [
    { "row_id": "r1", "document_reference": "рядок з PDF", "sku": "SKU або null",
      "name": "назва товару", "expected_qty": число або null }
  ],
  "findings": [
    { "row_id": "r1", "status": "confirmed" | "mismatch" | "unverified",
      "reason": "коротке пояснення українською",
      "observed_qty": число або null,
      "needed_photo": "який знімок потрібен — лише для unverified, інакше null",
      "evidence": [ { "photo_index": 0, "bbox": [x, y, width, height] } ] }
  ],
  "extra_items": [
    { "description": "що це за предмет", "photo_index": 0, "bbox": [x, y, width, height] }
  ],
  "capture_convention_used": "опис припущеної конвенції зйомки"
}

Правила:
- Кожен рядок пакувального листа стає одним об'єктом manifest_rows.
- "confirmed" — лише якщо етикетку/ідентичність видно чітко І кількість збігається.
- "mismatch" — товар видно, але назва/SKU відрізняється, або кількість не збігається.
  Вкажи observed_qty.
- "unverified" — етикетка затулена, немає ракурсу або доказів недостатньо.
  НІКОЛИ не роби висновок, що товару немає, лише через брак доказів.
  Для кожного unverified заповни needed_photo: конкретно опиши, який
  додатковий знімок дозволить зробити висновок.
- Усі фото — різні ракурси ОДНІЄЇ доставки. Не рахуй один і той самий
  фізичний предмет двічі, якщо він потрапив у кілька кадрів.
- Якщо немає доказів протилежного, припусти: фото 0 — загальний план,
  наступні фото — окремі предмети або етикетки.
- bbox — нормалізовані координати [x, y, width, height] у діапазоні 0..1.
- photo_index починається з 0.
- Для кожного висновку з видимим доказом додай щонайменше один evidence.
- Товари, яких немає в списку, але видно на фото, додай до extra_items.
- Будь консервативним. Не вигадуй інформацію.
`;

function buildUserParts() {
  return [
    { text: `Текст пакувального листа (з PDF "${state.pdfName}"):\n\n${state.pdfText}` },
    ...state.images.map((img) => ({
      inline_data: { mime_type: img.mediaType, data: img.base64 },
    })),
    {
      text: `Фото надані в порядку photo_index 0..${state.images.length - 1}.
Поверни лише JSON за схемою з системного промпту.`,
    },
  ];
}

// ============================================================
// GEMINI CALL
// ============================================================

async function callGemini(apiKey) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL.id}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: buildUserParts() }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    let friendly = `Gemini API ${response.status}`;
    if (response.status === 429) friendly += " — вичерпано квоту або кредити акаунта";
    if (response.status === 403) friendly += " — ключ відхилено";
    if (response.status === 404) friendly += ` — модель ${MODEL.id} недоступна`;
    const err = new Error(friendly);
    err.detail = body.slice(0, 400);
    throw err;
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text || "").join("").trim();

  if (!text) {
    throw new Error(
      "Gemini не повернув JSON" +
        (candidate?.finishReason ? ` (${candidate.finishReason})` : "")
    );
  }

  const usage = data.usageMetadata || {};
  return {
    rawText: text,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    },
  };
}

function cleanJsonText(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeResult(result) {
  return {
    manifest_rows: Array.isArray(result?.manifest_rows) ? result.manifest_rows : [],
    findings: Array.isArray(result?.findings) ? result.findings : [],
    extra_items: Array.isArray(result?.extra_items) ? result.extra_items : [],
    capture_convention_used: result?.capture_convention_used || "—",
  };
}

// ============================================================
// LOADING STATE
// ============================================================

const STEPS = [
  "Читаю пакувальний лист",
  `Надсилаю ${0} фото моделі`,
  "Звіряю позиції з кадрами",
  "Збираю посилання на докази",
];

function renderLoading(stepIndex) {
  const steps = [...STEPS];
  steps[1] = `Надсилаю ${state.images.length} фото моделі`;

  els.resultsZone.innerHTML = `
    <div class="loading">
      <div class="steps">
        ${steps
          .map((label, i) => {
            const cls = i < stepIndex ? "done" : i === stepIndex ? "now" : "queued";
            const mark = i < stepIndex ? "✓" : i === stepIndex ? "→" : "·";
            return `<div class="${cls}">${mark} ${escapeHtml(label)}</div>`;
          })
          .join("")}
      </div>
      <div class="results">
        <div>
          <div class="sk sk-row"></div><div class="sk sk-row"></div>
          <div class="sk sk-row"></div><div class="sk sk-row"></div>
        </div>
        <div><div class="sk sk-img"></div></div>
      </div>
    </div>`;
}

// ============================================================
// RUN
// ============================================================

let loadingTimers = [];

function clearLoadingTimers() {
  loadingTimers.forEach(clearTimeout);
  loadingTimers = [];
}

async function runAudit() {
  const apiKey = els.apiKey?.value.trim() || "";
  if (!state.pdfText || !state.images.length || !apiKey) return;

  els.runBtn.disabled = true;
  setStatus("Обробка…", "active");

  renderLoading(0);
  clearLoadingTimers();
  loadingTimers.push(setTimeout(() => renderLoading(1), 400));
  loadingTimers.push(setTimeout(() => renderLoading(2), 1800));
  loadingTimers.push(setTimeout(() => renderLoading(3), 5000));

  const start = performance.now();

  try {
    const response = await callGemini(apiKey);
    clearLoadingTimers();

    let parsed;
    try {
      parsed = JSON.parse(cleanJsonText(response.rawText));
    } catch (err) {
      const e = new Error("Модель повернула не-JSON відповідь.");
      e.detail = response.rawText.slice(0, 400);
      throw e;
    }

    const elapsedMs = performance.now() - start;
    const { input_tokens, output_tokens } = response.usage;
    const cost =
      (input_tokens / 1e6) * MODEL.inputPerMTok +
      (output_tokens / 1e6) * MODEL.outputPerMTok;

    state.result = normalizeResult(parsed);
    state.metrics = { elapsedMs, usage: response.usage, cost };
    state.selectedRowId = null;
    state.hoverRowId = null;
    state.activePhoto = 0;

    setStatus(`Готово за ${(elapsedMs / 1000).toFixed(1)} с`, "");
    renderResults();
  } catch (error) {
    clearLoadingTimers();
    console.error(error);
    setStatus("Не вдалося завершити перевірку", "err");
    els.resultsZone.innerHTML = `
      <div class="errbox">
        <b>${escapeHtml(error.message)}</b>
        ${error.detail ? `<pre>${escapeHtml(error.detail)}</pre>` : ""}
      </div>`;
  } finally {
    updateRunEnabled();
  }
}

els.runBtn?.addEventListener("click", runAudit);

// ============================================================
// RENDER RESULTS
// ============================================================

const STATUS_LABEL = {
  confirmed: "ПІДТВЕРДЖЕНО",
  mismatch: "РОЗБІЖНІСТЬ",
  unverified: "НЕ ПЕРЕВІРЕНО",
};

function statusLabel(status) {
  return STATUS_LABEL[status] || String(status || "").toUpperCase();
}

function renderResults() {
  const result = state.result;
  if (!result || !els.resultsZone || !state.images.length) return;

  const findingsByRow = new Map(result.findings.map((f) => [f.row_id, f]));
  const rows = result.manifest_rows.map((r) => ({
    ...r,
    finding: findingsByRow.get(r.row_id),
  }));

  // ---------- verdict counts ----------
  const counts = { confirmed: 0, mismatch: 0, unverified: 0 };
  rows.forEach((r) => {
    const s = r.finding?.status || "unverified";
    if (counts[s] === undefined) counts.mismatch++;
    else counts[s]++;
  });

  const verdictHtml = `
    <div class="verdict">
      <div class="v ok"><b>${counts.confirmed}</b><span>ПІДТВЕРДЖЕНО</span></div>
      <div class="v bad"><b>${counts.mismatch}</b><span>РОЗБІЖНОСТЕЙ</span></div>
      <div class="v warn"><b>${counts.unverified}</b><span>НЕ ПЕРЕВІРЕНО</span></div>
      <div class="v neutral"><b>${result.extra_items.length}</b><span>ЗАЙВИХ ПОЗИЦІЙ</span></div>
    </div>`;

  // ---------- boxes for active photo ----------
  const boxes = [];
  rows.forEach((row) => {
    (row.finding?.evidence || []).forEach((ev) => {
      if (Number(ev.photo_index) !== state.activePhoto) return;
      const bbox = normalizeBbox(ev.bbox);
      if (!bbox) return;
      boxes.push({ bbox, status: row.finding.status, label: row.name, rowId: row.row_id });
    });
  });
  result.extra_items.forEach((item, i) => {
    if (Number(item.photo_index) !== state.activePhoto) return;
    const bbox = normalizeBbox(item.bbox);
    if (!bbox) return;
    boxes.push({
      bbox,
      status: "extra",
      label: "поза листом: " + item.description,
      rowId: "extra-" + i,
    });
  });

  const focusId = state.hoverRowId || state.selectedRowId;
  const boxesHtml = boxes
    .map((box) => {
      const [x, y, w, h] = box.bbox;
      const hot = focusId && box.rowId === focusId;
      const dim = focusId && box.rowId !== focusId;
      return `
        <div class="bbox ${escapeHtml(box.status)}${hot ? " hot" : ""}${dim ? " dim" : ""}"
             style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;">
          <div class="tag">${escapeHtml(box.label)}</div>
        </div>`;
    })
    .join("");

  // ---------- photo tabs ----------
  const boxCountPerPhoto = state.images.map((_, idx) => {
    let n = 0;
    rows.forEach((r) =>
      (r.finding?.evidence || []).forEach((ev) => {
        if (Number(ev.photo_index) === idx && normalizeBbox(ev.bbox)) n++;
      })
    );
    result.extra_items.forEach((it) => {
      if (Number(it.photo_index) === idx && normalizeBbox(it.bbox)) n++;
    });
    return n;
  });

  const photoTabs = state.images
    .map(
      (_, i) => `
      <button type="button"
              class="${i === state.activePhoto ? "active" : ""}${boxCountPerPhoto[i] ? " has-boxes" : ""}"
              data-photo="${i}">
        Фото ${i + 1}<span class="dot"></span>
      </button>`
    )
    .join("");

  const activeImg = state.images[state.activePhoto] || state.images[0];

  // ---------- table ----------
  const tableRows = rows
    .map((row) => {
      const f = row.finding;
      const status = f?.status || "unverified";
      const selected = row.row_id === state.selectedRowId ? " selected" : "";
      const observed =
        f?.observed_qty !== undefined && f?.observed_qty !== null && f.observed_qty !== row.expected_qty
          ? ` <span style="color:var(--bad);">→ ${escapeHtml(f.observed_qty)}</span>`
          : "";

      const askMore =
        status === "unverified" && f?.needed_photo
          ? `<div class="askmore">
               <button class="ghost" data-ask="${escapeHtml(row.row_id)}">Потрібне ще фото →</button>
             </div>`
          : "";

      return `
        <tr class="row${selected}" data-row="${escapeHtml(row.row_id)}">
          <td>${escapeHtml(row.sku || "—")}</td>
          <td>
            <div class="name">${escapeHtml(row.name || "—")}</div>
            ${f?.reason ? `<div class="reason">${escapeHtml(f.reason)}</div>` : ""}
            ${row.document_reference ? `<div class="docref">${escapeHtml(row.document_reference)}</div>` : ""}
            ${askMore}
          </td>
          <td>${row.expected_qty ?? "—"}${observed}</td>
          <td><span class="stamp ${escapeHtml(status)}">${statusLabel(status)}</span></td>
        </tr>`;
    })
    .join("");

  const extraHtml = result.extra_items.length
    ? `<div class="extra-note">
         <b>${result.extra_items.length} позицій поза пакувальним листом</b>
         ${result.extra_items.map((i) => escapeHtml(i.description)).join(", ")}.
       </div>`
    : "";

  // ---------- metrics ----------
  const m = state.metrics;
  const metricsHtml = m
    ? `<div class="metrics">
         <div class="m"><b>${(m.elapsedMs / 1000).toFixed(1)} с</b><span>ЧАС ДО РЕЗУЛЬТАТУ</span></div>
         <div class="m"><b>$${m.cost.toFixed(4)}</b><span>ОЦІНКА ВАРТОСТІ ПЕРЕВІРКИ</span></div>
         <div class="m"><b>${m.usage.input_tokens + m.usage.output_tokens}</b><span>ТОКЕНІВ · ${MODEL.id}</span></div>
         <div class="m" style="align-self:center;"><button class="ghost" id="print-btn">Зберегти звіт (PDF)</button></div>
       </div>`
    : "";

  els.resultsZone.innerHTML = `
    ${verdictHtml}
    <div class="results">
      <div>
        <div class="section-title"><span class="num">03</span> Маніфест<span class="aside">натисніть рядок, щоб побачити доказ</span></div>
        <table class="ledger">
          <thead><tr><th>SKU</th><th>Товар</th><th>К-сть</th><th>Статус</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
        ${extraHtml}
        ${metricsHtml}
      </div>
      <div class="evidence-col">
        <div class="section-title"><span class="num">04</span> Докази</div>
        <div class="photo-tabs">${photoTabs}</div>
        <div class="photo-frame">
          <img src="${activeImg.dataUrl}" alt="Фото доставки ${state.activePhoto + 1}" />
          ${boxesHtml}
        </div>
        <div class="evidence-hint">
          <span>${boxes.length ? `${boxes.length} позначених ділянок` : "На цьому фото немає позначених ділянок"}</span>
          <span>Фото ${state.activePhoto + 1} з ${state.images.length}</span>
        </div>
        <div class="convention-used">
          <b>Конвенція, застосована моделлю:</b> ${escapeHtml(result.capture_convention_used)}
        </div>
      </div>
    </div>`;

  attachResultHandlers(rows);
}

// ============================================================
// RESULT INTERACTIONS
// ============================================================

function attachResultHandlers(rows) {
  els.resultsZone.querySelectorAll("tr.row").forEach((tr) => {
    const rowId = tr.dataset.row;

    tr.addEventListener("mouseenter", () => {
      if (state.hoverRowId === rowId) return;
      state.hoverRowId = rowId;
      repaintBoxes();
    });

    tr.addEventListener("mouseleave", () => {
      state.hoverRowId = null;
      repaintBoxes();
    });

    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-ask]")) return;
      state.selectedRowId = rowId;
      const row = rows.find((r) => r.row_id === rowId);
      const ev = row?.finding?.evidence?.[0];
      const idx = Number(ev?.photo_index);
      if (Number.isInteger(idx) && idx >= 0 && idx < state.images.length) {
        state.activePhoto = idx;
      }
      renderResults();
    });
  });

  els.resultsZone.querySelectorAll("[data-ask]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const row = rows.find((r) => r.row_id === btn.dataset.ask);
      const needed = row?.finding?.needed_photo;
      if (!needed) return;
      btn.outerHTML = `
        <div style="font-size:11px;color:var(--warn);padding:7px 9px;background:var(--warn-bg);border-left:2px solid var(--warn);">
          <b>Потрібен знімок:</b> ${escapeHtml(needed)}<br/>
          <span style="color:var(--ink-soft);">Додайте його вище і запустіть перевірку ще раз.</span>
        </div>`;
    });
  });

  els.resultsZone.querySelectorAll(".photo-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activePhoto = Number(btn.dataset.photo) || 0;
      renderResults();
    });
  });

  document.getElementById("print-btn")?.addEventListener("click", () => window.print());
}

// Repaint only the bbox overlay, so hover doesn't rebuild the whole table.
function repaintBoxes() {
  const focusId = state.hoverRowId || state.selectedRowId;
  els.resultsZone.querySelectorAll(".bbox").forEach((el) => {
    el.classList.remove("hot", "dim");
  });
  if (!focusId) return;

  const result = state.result;
  if (!result) return;

  const order = [];
  result.manifest_rows.forEach((r) => {
    const f = result.findings.find((x) => x.row_id === r.row_id);
    (f?.evidence || []).forEach((ev) => {
      if (Number(ev.photo_index) === state.activePhoto && normalizeBbox(ev.bbox)) {
        order.push(r.row_id);
      }
    });
  });
  result.extra_items.forEach((item, i) => {
    if (Number(item.photo_index) === state.activePhoto && normalizeBbox(item.bbox)) {
      order.push("extra-" + i);
    }
  });

  els.resultsZone.querySelectorAll(".bbox").forEach((el, i) => {
    el.classList.add(order[i] === focusId ? "hot" : "dim");
  });
}

// ============================================================
// INIT
// ============================================================

updateRunEnabled();

// Test hook: inert in the browser, used by test-render.js under Node.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { state, renderResults, normalizeBbox, normalizeResult, statusLabel };
}
