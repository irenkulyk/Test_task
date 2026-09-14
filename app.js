/* Delivery Audit — client-side prototype
 * Vanilla JS, no build step. Calls the Anthropic API directly from the browser
 * using a user-supplied API key (see README for why, and the production caveat).
 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ---- pricing assumptions (VERIFY against each provider's live pricing page before quoting externally) ----
const PRICING = {
  anthropic: {
    model: "claude-sonnet-4-6",
    inputPerMTok: 3.0,   // USD per 1M input tokens — placeholder, confirm current rate
    outputPerMTok: 15.0, // USD per 1M output tokens — placeholder, confirm current rate
    keyPlaceholder: "sk-ant-...",
  },
  gemini: {
    model: "gemini-2.0-flash",
    inputPerMTok: 0.10,  // USD per 1M input tokens on the paid tier — the free tier is $0 within quota
    outputPerMTok: 0.40, // USD per 1M output tokens on the paid tier
    keyPlaceholder: "AIzaSy...",
  },
};

const state = {
  pdfText: "",
  pdfName: "",
  images: [], // {name, dataUrl, base64, mediaType}
  result: null,
  selectedRowId: null,
  activePhoto: 0,
};

const els = {
  pdfDrop: document.getElementById("pdf-drop"),
  pdfInput: document.getElementById("pdf-input"),
  pdfParsed: document.getElementById("pdf-parsed"),
  imgDrop: document.getElementById("img-drop"),
  imgInput: document.getElementById("img-input"),
  imgThumbs: document.getElementById("img-thumbs"),
  provider: document.getElementById("provider"),
  apiKeyLabel: document.getElementById("api-key-label"),
  apiKey: document.getElementById("api-key"),
  runBtn: document.getElementById("run-btn"),
  statusLine: document.getElementById("status-line"),
  resultsZone: document.getElementById("results-zone"),
};

function setStatus(text, cls) {
  els.statusLine.textContent = text || "";
  els.statusLine.className = "status-line" + (cls ? " " + cls : "");
}

function updateRunEnabled() {
  els.runBtn.disabled = !(state.pdfText && state.images.length > 0 && els.apiKey.value.trim());
}

// ---------- PDF intake ----------
async function handlePdfFile(file) {
  state.pdfName = file.name;
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }
  state.pdfText = text.trim();
  els.pdfParsed.innerHTML = `<div class="item"><span>${escapeHtml(file.name)}</span><span>${state.pdfText.split(/\s+/).length} слів</span></div>
    <div class="item" style="border-bottom:none;color:var(--ink-soft);font-size:11px;">Текст буде переданий моделі як є — розбір рядків виконує сама модель, без окремого regex-парсера.</div>`;
  updateRunEnabled();
}

// ---------- Image intake ----------
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function handleImgFiles(fileList) {
  const files = Array.from(fileList).slice(0, 3 - state.images.length);
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    const base64 = dataUrl.split(",")[1];
    state.images.push({ name: file.name, dataUrl, base64, mediaType: file.type || "image/jpeg" });
  }
  renderThumbs();
  updateRunEnabled();
}

function renderThumbs() {
  els.imgThumbs.innerHTML = state.images
    .map((img, i) => `<img src="${img.dataUrl}" title="Фото ${i + 1}: ${escapeHtml(img.name)}" />`)
    .join("");
}

// ---------- wiring intake UI ----------
[els.pdfDrop].forEach((zone) => {
  zone.addEventListener("click", () => els.pdfInput.click());
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    if (e.dataTransfer.files[0]) handlePdfFile(e.dataTransfer.files[0]);
  });
});
els.pdfInput.addEventListener("change", (e) => { if (e.target.files[0]) handlePdfFile(e.target.files[0]); });

[els.imgDrop].forEach((zone) => {
  zone.addEventListener("click", () => els.imgInput.click());
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    handleImgFiles(e.dataTransfer.files);
  });
});
els.imgInput.addEventListener("change", (e) => handleImgFiles(e.target.files));
els.apiKey.addEventListener("input", updateRunEnabled);

function syncProviderUI() {
  const p = els.provider.value;
  els.apiKeyLabel.textContent = p === "gemini" ? "Gemini API key:" : "Anthropic API key:";
  els.apiKey.placeholder = PRICING[p].keyPlaceholder;
}
els.provider.addEventListener("change", syncProviderUI);
syncProviderUI();

// ---------- Claude call ----------
const SYSTEM_PROMPT = `Ти проводиш аудит доставки: звіряєш фотографії розпакованого товару з пакувальним листом, витягнутим із PDF.
Відповідай ЛИШЕ строгим JSON без жодного маркдауну, пояснень чи прелюдії, за такою схемою:

{
  "manifest_rows": [
    {"row_id": "r1", "document_reference": "дослівний або близький до дослівного рядок з PDF", "sku": "SKU або null", "name": "назва товару", "expected_qty": число або null}
  ],
  "findings": [
    {"row_id": "r1", "status": "confirmed" | "mismatch" | "unverified", "reason": "коротке пояснення українською",
     "evidence": [{"photo_index": 0, "bbox": [x, y, width, height]}]}
  ],
  "extra_items": [
    {"description": "що це за предмет", "photo_index": 0, "bbox": [x, y, width, height]}
  ],
  "capture_convention_used": "опис припущеної конвенції зйомки"
}

Правила:
- Кожен рядок пакувального листа стає одним об'єктом у manifest_rows.
- status="confirmed" лише якщо на фото чітко видно етикетку/ідентичність і кількість збігається з очікуваною.
- status="mismatch" якщо видно товар, але назва/SKU відрізняється від заявленого, або кількість не збігається.
- status="unverified" якщо етикетка затулена, немає потрібного ракурсу, або доказів недостатньо для впевненого висновку. НІКОЛИ не вважай товар відсутнім лише через це — став "unverified" і поясни, яке додаткове фото потрібне.
- Усі фото — це різні ракурси ОДНІЄЇ доставки. Не рахуй один і той самий фізичний предмет двічі, якщо він потрапив у кілька кадрів. Припусти таку конвенцію зйомки (якщо очевидне протилежне): перше фото — загальний план, кожне наступне — окремий, унікальний предмет чи етикетка.
- bbox — нормалізовані координати [x, y, width, height] у діапазоні 0..1 відносно розмірів відповідного фото (photo_index рахується з 0, у порядку, в якому фото надані).
- Для кожного findings-запису (крім суто "unverified" без жодного видимого сліду) додай хоча б один evidence з photo_index і bbox навколо релевантного об'єкта/етикетки.
- Товари, яких немає в списку, але видно на фото — у extra_items.
- Будь консервативним: не вигадуй, чого не бачиш.`;

function buildUserText() {
  return {
    intro: `Текст пакувального листа (витягнутий з PDF "${state.pdfName}"):\n\n${state.pdfText}`,
    outro: `Фото надані вище в порядку photo_index 0..${state.images.length - 1}. Поверни лише JSON за схемою з системного промпту.`,
  };
}

async function callAnthropic(apiKey) {
  const { intro, outro } = buildUserText();
  const userContent = [
    { type: "text", text: intro },
    ...state.images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    })),
    { type: "text", text: outro },
  ];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: PRICING.anthropic.model,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`API ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await resp.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Відповідь не містить текстового блоку з JSON.");

  const usage = data.usage || {};
  return {
    rawText: textBlock.text,
    usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 },
  };
}

async function callGemini(apiKey) {
  const { intro, outro } = buildUserText();
  const parts = [
    { text: intro },
    ...state.images.map((img) => ({
      inline_data: { mime_type: img.mediaType, data: img.base64 },
    })),
    { text: outro },
  ];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${PRICING.gemini.model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: { response_mime_type: "application/json" },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`API ${resp.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await resp.json();
  const candidate = (data.candidates || [])[0];
  const text = candidate?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error("Відповідь не містить тексту з JSON. Можливо, спрацював safety-фільтр.");

  const usage = data.usageMetadata || {};
  return {
    rawText: text,
    usage: { input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || 0 },
  };
}

async function runAudit() {
  const apiKey = els.apiKey.value.trim();
  const provider = els.provider.value;
  if (!apiKey || !state.pdfText || state.images.length === 0) return;

  els.runBtn.disabled = true;
  setStatus("Обробка... надсилаємо фото та накладну моделі", "active");
  els.resultsZone.innerHTML = "";

  const start = performance.now();
  try {
    const { rawText, usage } = provider === "gemini" ? await callGemini(apiKey) : await callAnthropic(apiKey);
    const elapsedMs = performance.now() - start;

    const cleaned = rawText.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new Error("Не вдалося розпарсити JSON від моделі: " + e.message);
    }

    const rates = PRICING[provider];
    const cost = (usage.input_tokens / 1e6) * rates.inputPerMTok + (usage.output_tokens / 1e6) * rates.outputPerMTok;

    state.result = parsed;
    state.metrics = { elapsedMs, usage, cost, provider };
    state.selectedRowId = null;
    state.activePhoto = 0;

    setStatus(`Готово за ${(elapsedMs / 1000).toFixed(1)} с (${provider})`, "");
    renderResults();
  } catch (err) {
    console.error(err);
    setStatus("Помилка: " + err.message, "err");
    els.resultsZone.innerHTML = `<div class="empty">Не вдалося отримати результат. Перевірте ключ API та спробуйте ще раз.</div>`;
  } finally {
    els.runBtn.disabled = false;
  }
}

els.runBtn.addEventListener("click", runAudit);

// ---------- Rendering results ----------
function statusLabel(s) {
  return { confirmed: "ПІДТВЕРДЖЕНО", mismatch: "РОЗБІЖНІСТЬ", unverified: "НЕ ПЕРЕВІРЕНО" }[s] || s.toUpperCase();
}

function renderResults() {
  const r = state.result;
  if (!r) return;

  const findingsByRow = new Map((r.findings || []).map((f) => [f.row_id, f]));
  const rows = (r.manifest_rows || []).map((m) => ({ ...m, finding: findingsByRow.get(m.row_id) }));

  const photoTabs = state.images
    .map((img, i) => `<button class="${i === state.activePhoto ? "active" : ""}" data-photo="${i}">Фото ${i + 1}</button>`)
    .join("");

  const activeImg = state.images[state.activePhoto];

  // gather boxes to draw on the active photo: all findings + extra_items pointing to it
  const boxes = [];
  rows.forEach((row) => {
    (row.finding?.evidence || []).forEach((ev) => {
      if (ev.photo_index === state.activePhoto) {
        boxes.push({ bbox: ev.bbox, status: row.finding.status, label: row.name, rowId: row.row_id });
      }
    });
  });
  (r.extra_items || []).forEach((ex, i) => {
    if (ex.photo_index === state.activePhoto) {
      boxes.push({ bbox: ex.bbox, status: "mismatch", label: "зайвий: " + ex.description, rowId: "extra-" + i });
    }
  });

  const boxesHtml = boxes
    .map((b) => {
      const [x, y, w, h] = b.bbox;
      const selected = b.rowId === state.selectedRowId;
      return `<div class="bbox ${b.status}" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%;${selected ? "border-width:3px;" : ""}">
        <div class="tag">${escapeHtml(b.label)}</div>
      </div>`;
    })
    .join("");

  const tableRows = rows
    .map((row) => {
      const f = row.finding;
      const status = f?.status || "unverified";
      const selected = row.row_id === state.selectedRowId ? "selected" : "";
      return `<tr class="row ${selected}" data-row="${row.row_id}">
        <td>${escapeHtml(row.sku || "—")}</td>
        <td>${escapeHtml(row.name)}<div class="reason">${escapeHtml(f?.reason || "")}</div></td>
        <td>${row.expected_qty ?? "—"}</td>
        <td><span class="stamp ${status}">${statusLabel(status)}</span></td>
      </tr>`;
    })
    .join("");

  const extraHtml = (r.extra_items || []).length
    ? `<div class="extra-note"><b>Помічено ${r.extra_items.length} зайвих позицій</b> поза пакувальним листом: ${r.extra_items.map((e) => escapeHtml(e.description)).join(", ")}.</div>`
    : "";

  const m = state.metrics;
  const costNote = m?.provider === "gemini" ? " (на безкоштовному рівні — реальні $0)" : "";
  const metricsHtml = m
    ? `<div class="metrics">
        <div class="m"><b>${(m.elapsedMs / 1000).toFixed(1)} с</b><span>час до результату</span></div>
        <div class="m"><b>$${m.cost.toFixed(4)}</b><span>оцінка вартості${costNote}</span></div>
        <div class="m"><b>${(m.usage.input_tokens || 0) + (m.usage.output_tokens || 0)}</b><span>токенів (in+out) · ${PRICING[m.provider].model}</span></div>
      </div>`
    : "";

  els.resultsZone.innerHTML = `
    <div class="results">
      <div>
        <div class="section-title"><span class="num">03</span> Маніфест</div>
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
          <img src="${activeImg.dataUrl}" />
          ${boxesHtml}
        </div>
        <div style="font-size:11px;color:var(--ink-soft);margin-top:8px;">Конвенція зйомки, застосована моделлю: ${escapeHtml(r.capture_convention_used || "—")}</div>
      </div>
    </div>
  `;

  els.resultsZone.querySelectorAll("tr.row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const rowId = tr.dataset.row;
      state.selectedRowId = rowId;
      const row = rows.find((x) => x.row_id === rowId);
      const firstEv = row?.finding?.evidence?.[0];
      if (firstEv) state.activePhoto = firstEv.photo_index;
      renderResults();
    });
  });

  els.resultsZone.querySelectorAll(".photo-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activePhoto = Number(btn.dataset.photo);
      renderResults();
    });
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
