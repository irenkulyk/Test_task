/* Delivery Audit — client-side prototype
 * Vanilla JS, no build step.
 * Gemini API + Demo mode.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ============================================================
// PRICING
// ============================================================

const PRICING = {
  gemini: {
    model: "gemini-3.6-flash",
    inputPerMTok: 1.5,
    outputPerMTok: 7.5,
    keyPlaceholder: "AIzaSy...",
  },
};

// ============================================================
// STATE
// ============================================================

const state = {
  pdfText: "",
  pdfName: "",
  images: [],
  result: null,
  selectedRowId: null,
  activePhoto: 0,
  metrics: null,
};

// ============================================================
// ELEMENTS
// ============================================================

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

// ============================================================
// HELPERS
// ============================================================

function setStatus(text, cls = "") {
  if (!els.statusLine) return;

  els.statusLine.textContent = text || "";
  els.statusLine.className =
    "status-line" + (cls ? " " + cls : "");
}

function isDemoMode() {
  return els.provider?.value === "demo";
}

function updateRunEnabled() {
  if (!els.runBtn) return;

  const hasKey =
    isDemoMode() || Boolean(els.apiKey?.value.trim());

  els.runBtn.disabled = !(
    state.pdfText &&
    state.images.length > 0 &&
    hasKey
  );
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]
  );
}

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    return [0, 0, 0, 0];
  }

  const values = bbox.map(Number);

  return [
    clamp(Number.isFinite(values[0]) ? values[0] : 0),
    clamp(Number.isFinite(values[1]) ? values[1] : 0),
    clamp(Number.isFinite(values[2]) ? values[2] : 0),
    clamp(Number.isFinite(values[3]) ? values[3] : 0),
  ];
}

// ============================================================
// PDF
// ============================================================

async function handlePdfFile(file) {
  if (!file) return;

  if (
    file.type !== "application/pdf" &&
    !file.name.toLowerCase().endsWith(".pdf")
  ) {
    throw new Error("Потрібно завантажити PDF-файл.");
  }

  state.pdfName = file.name;

  const buffer = await file.arrayBuffer();

  const pdf = await pdfjsLib
    .getDocument({ data: buffer })
    .promise;

  let text = "";

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);

    const content = await page.getTextContent();

    const pageText = content.items
      .map((item) => item.str)
      .join(" ");

    text += pageText + "\n";
  }

  state.pdfText = text.trim();

  if (!state.pdfText) {
    throw new Error(
      "У PDF не знайдено тексту. Перевірте, що PDF містить текстовий шар."
    );
  }

  const wordCount = state.pdfText
    .split(/\s+/)
    .filter(Boolean)
    .length;

  els.pdfParsed.innerHTML = `
    <div class="item">
      <span>${escapeHtml(file.name)}</span>
      <span>${wordCount} слів</span>
    </div>

    <div
      class="item"
      style="
        border-bottom:none;
        color:var(--ink-soft);
        font-size:11px;
      "
    >
      Текст буде переданий Gemini як є.
    </div>
  `;

  updateRunEnabled();
}

// ============================================================
// FILE TO DATA URL
// ============================================================

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);

    reader.onerror = () =>
      reject(
        new Error(`Не вдалося прочитати файл ${file.name}.`)
      );

    reader.readAsDataURL(file);
  });
}

// ============================================================
// IMAGE INTAKE
// ============================================================

async function handleImgFiles(fileList) {
  const files = Array.from(fileList || []);

  if (!files.length) return;

  const remaining =
    3 - state.images.length;

  if (remaining <= 0) {
    setStatus(
      "Можна завантажити максимум 3 фото.",
      "err"
    );
    return;
  }

  const validFiles = files
    .filter((file) =>
      [
        "image/jpeg",
        "image/png",
        "image/webp",
      ].includes(file.type)
    )
    .slice(0, remaining);

  if (!validFiles.length) {
    throw new Error(
      "Підтримуються тільки JPG, PNG та WebP."
    );
  }

  for (const file of validFiles) {
    const dataUrl = await fileToDataUrl(file);

    const base64 = dataUrl.split(",")[1];

    state.images.push({
      name: file.name,
      size: file.size,
      dataUrl,
      base64,
      mediaType:
        file.type || "image/jpeg",
    });
  }

  renderThumbs();
  updateRunEnabled();
}

// ============================================================
// IMAGE THUMBNAILS
// ============================================================

function renderThumbs() {
  if (!els.imgThumbs) return;

  els.imgThumbs.innerHTML = state.images
    .map(
      (image, index) => `
        <img
          src="${image.dataUrl}"
          title="Фото ${index + 1}: ${escapeHtml(
            image.name
          )}"
          alt="Фото ${index + 1}"
        />
      `
    )
    .join("");
}

// ============================================================
// DRAG & DROP
// ============================================================

function setupDropZone(
  zone,
  input,
  handler,
  acceptedTypes = []
) {
  if (!zone) return;

  let dragCounter = 0;

  zone.addEventListener("click", (event) => {
    if (
      event.target.closest("input") ||
      event.target.closest("button") ||
      event.target.closest("a")
    ) {
      return;
    }

    input?.click();
  });

  zone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    event.stopPropagation();

    dragCounter++;

    zone.classList.add("drag");
  });

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }

    zone.classList.add("drag");
  });

  zone.addEventListener("dragleave", (event) => {
    event.preventDefault();
    event.stopPropagation();

    dragCounter--;

    if (dragCounter <= 0) {
      dragCounter = 0;
      zone.classList.remove("drag");
    }
  });

  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    dragCounter = 0;
    zone.classList.remove("drag");

    const files = Array.from(
      event.dataTransfer?.files || []
    );

    if (!files.length) return;

    const validFiles = files.filter((file) => {
      if (!acceptedTypes.length) return true;

      return (
        acceptedTypes.includes(file.type) ||
        (
          acceptedTypes.includes("application/pdf") &&
          file.name.toLowerCase().endsWith(".pdf")
        )
      );
    });

    if (!validFiles.length) {
      setStatus(
        acceptedTypes.includes("application/pdf")
          ? "Перетягніть PDF-файл."
          : "Перетягніть JPG, PNG або WebP.",
        "err"
      );

      return;
    }

    try {
      await handler(validFiles);
      setStatus("");
    } catch (error) {
      console.error(error);

      setStatus(
        "Помилка: " + error.message,
        "err"
      );
    }
  });
}

// ============================================================
// INPUT EVENTS
// ============================================================

setupDropZone(
  els.pdfDrop,
  els.pdfInput,
  async (files) => {
    await handlePdfFile(files[0]);
  },
  ["application/pdf"]
);

setupDropZone(
  els.imgDrop,
  els.imgInput,
  async (files) => {
    await handleImgFiles(files);
  },
  [
    "image/jpeg",
    "image/png",
    "image/webp",
  ]
);

els.pdfInput?.addEventListener(
  "change",
  async (event) => {
    const file = event.target.files?.[0];

    if (!file) return;

    try {
      await handlePdfFile(file);
      setStatus("");
    } catch (error) {
      console.error(error);

      setStatus(
        "Помилка: " + error.message,
        "err"
      );
    }

    event.target.value = "";
  }
);

els.imgInput?.addEventListener(
  "change",
  async (event) => {
    try {
      await handleImgFiles(
        event.target.files || []
      );

      setStatus("");
    } catch (error) {
      console.error(error);

      setStatus(
        "Помилка: " + error.message,
        "err"
      );
    }

    event.target.value = "";
  }
);

els.apiKey?.addEventListener(
  "input",
  updateRunEnabled
);

// ============================================================
// PROVIDER UI
// ============================================================

function syncProviderUI() {
  if (!els.provider) return;

  const demo = isDemoMode();

  if (els.apiKeyLabel) {
    els.apiKeyLabel.textContent = demo
      ? "API key:"
      : "Gemini API key:";
  }

  if (els.apiKey) {
    els.apiKey.disabled = demo;

    els.apiKey.placeholder = demo
      ? "Не потрібен у Demo"
      : PRICING.gemini.keyPlaceholder;

    if (demo) {
      els.apiKey.value = "";
    }
  }

  updateRunEnabled();
}

els.provider?.addEventListener(
  "change",
  syncProviderUI
);

syncProviderUI();

// ============================================================
// SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `
Ти проводиш аудит доставки: звіряєш фотографії
розпакованого товару з пакувальним листом,
витягнутим із PDF.

Відповідай ЛИШЕ строгим JSON без markdown,
пояснень чи прелюдії.

Схема:

{
  "manifest_rows": [
    {
      "row_id": "r1",
      "document_reference": "рядок з PDF",
      "sku": "SKU або null",
      "name": "назва товару",
      "expected_qty": число або null
    }
  ],

  "findings": [
    {
      "row_id": "r1",
      "status": "confirmed" | "mismatch" | "unverified",
      "reason": "коротке пояснення українською",
      "evidence": [
        {
          "photo_index": 0,
          "bbox": [x, y, width, height]
        }
      ]
    }
  ],

  "extra_items": [
    {
      "description": "що це за предмет",
      "photo_index": 0,
      "bbox": [x, y, width, height]
    }
  ],

  "capture_convention_used":
    "опис припущеної конвенції зйомки"
}

Правила:

- Кожен рядок пакувального листа стає
  одним об'єктом manifest_rows.

- status="confirmed" лише якщо на фото чітко
  видно етикетку/ідентичність і кількість
  збігається з очікуваною.

- status="mismatch" якщо видно товар,
  але назва/SKU відрізняється від заявленого,
  або кількість не збігається.

- status="unverified" якщо етикетка затулена,
  немає потрібного ракурсу або доказів
  недостатньо для впевненого висновку.

- НІКОЛИ не вважай товар відсутнім лише
  через недостатність доказів.

- Для unverified поясни, яке додаткове фото
  потрібно.

- Усі фото — це різні ракурси ОДНІЄЇ доставки.

- Не рахуй один і той самий фізичний предмет
  двічі, якщо він потрапив у кілька кадрів.

- Якщо немає очевидного протилежного доказу,
  припусти:
  фото 0 — загальний план,
  наступні фото — окремі предмети
  або етикетки.

- bbox — нормалізовані координати
  [x, y, width, height]
  у діапазоні 0..1.

- photo_index починається з 0.

- Для findings із видимим доказом додай
  хоча б один evidence.

- Товари, яких немає в списку,
  але видно на фото, додай в extra_items.

- Будь консервативним.
  Не вигадуй інформацію.
`;

// ============================================================
// USER TEXT
// ============================================================

function buildUserText() {
  return {
    intro: `
Текст пакувального листа
(витягнутий з PDF "${state.pdfName}"):

${state.pdfText}
`,

    outro: `
Фото надані в порядку
photo_index 0..${state.images.length - 1}.

Поверни лише JSON за схемою
з системного промпту.
`,
  };
}

// ============================================================
// GEMINI API
// ============================================================

async function callGemini(apiKey) {
  const { intro, outro } =
    buildUserText();

  const parts = [
    {
      text: intro,
    },

    ...state.images.map((image) => ({
      inline_data: {
        mime_type: image.mediaType,
        data: image.base64,
      },
    })),

    {
      text: outro,
    },
  ];

  const url =
    "https://generativelanguage.googleapis.com/" +
    "v1beta/models/" +
    PRICING.gemini.model +
    ":generateContent?key=" +
    encodeURIComponent(apiKey);

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      system_instruction: {
        parts: [
          {
            text: SYSTEM_PROMPT,
          },
        ],
      },

      contents: [
        {
          role: "user",
          parts,
        },
      ],

      generationConfig: {
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const errorBody =
      await response.text();

    throw new Error(
      `Gemini API ${response.status}: ` +
      errorBody.slice(0, 500)
    );
  }

  const data =
    await response.json();

  const candidate =
    data.candidates?.[0];

  const text =
    candidate?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();

  if (!text) {
    const reason =
      candidate?.finishReason
        ? ` Причина: ${candidate.finishReason}.`
        : "";

    throw new Error(
      "Gemini не повернув JSON." +
      reason
    );
  }

  const usage =
    data.usageMetadata || {};

  return {
    rawText: text,

    usage: {
      input_tokens:
        usage.promptTokenCount || 0,

      output_tokens:
        usage.candidatesTokenCount || 0,
    },
  };
}

// ============================================================
// DEMO MODE
// ============================================================

function parseDemoManifest(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const filtered = lines.filter(
    (line) =>
      !/^(packing|packing list|invoice|delivery|manifest|shipment)/i.test(
        line
      )
  );

  const items =
    filtered.length
      ? filtered.slice(0, 12)
      : [
          "Demo product from packing list",
        ];

  return items.map((line, index) => {
    const quantityMatch =
      line.match(
        /\b(?:x|qty|quantity|к[-\s]?сть)\s*[:=]?\s*(\d+)\b/i
      );

    const skuMatch =
      line.match(
        /\b[A-Z0-9][A-Z0-9._/-]{2,}\b/
      );

    return {
      row_id: `r${index + 1}`,

      document_reference:
        line.slice(0, 180),

      sku:
        skuMatch
          ? skuMatch[0]
          : null,

      name:
        line.slice(0, 120),

      expected_qty:
        quantityMatch
          ? Number(quantityMatch[1])
          : null,
    };
  });
}

function makeDemoResult() {
  const rows =
    parseDemoManifest(
      state.pdfText
    );

  return {
    manifest_rows: rows,

    findings: rows.map((row) => ({
      row_id: row.row_id,

      status: "unverified",

      reason:
        "Demo-режим: AI-перевірка фото не виконується.",

      evidence: [],
    })),

    extra_items: [],

    capture_convention_used:
      "Demo-режим без AI-аналізу. " +
      "Позиції з PDF показані як неперевірені.",
  };
}

// ============================================================
// JSON CLEANUP
// ============================================================

function cleanJsonText(text) {
  return String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// ============================================================
// RESULT NORMALIZATION
// ============================================================

function normalizeResult(result) {
  return {
    manifest_rows:
      Array.isArray(result?.manifest_rows)
        ? result.manifest_rows
        : [],

    findings:
      Array.isArray(result?.findings)
        ? result.findings
        : [],

    extra_items:
      Array.isArray(result?.extra_items)
        ? result.extra_items
        : [],

    capture_convention_used:
      result?.capture_convention_used ||
      "—",
  };
}

// ============================================================
// RUN AUDIT
// ============================================================

async function runAudit() {
  const provider =
    els.provider?.value || "gemini";

  const apiKey =
    els.apiKey?.value.trim() || "";

  if (
    !state.pdfText ||
    state.images.length === 0
  ) {
    return;
  }

  if (!isDemoMode() && !apiKey) {
    return;
  }

  els.runBtn.disabled = true;

  els.resultsZone.innerHTML = "";

  setStatus(
    isDemoMode()
      ? "Demo-режим: готуємо результат..."
      : "Обробка... надсилаємо фото та накладну Gemini",
    "active"
  );

  const start =
    performance.now();

  try {
    let parsed;

    let usage = {
      input_tokens: 0,
      output_tokens: 0,
    };

    // -------------------------
    // DEMO
    // -------------------------

    if (isDemoMode()) {
      await new Promise(
        (resolve) =>
          setTimeout(resolve, 500)
      );

      parsed =
        makeDemoResult();
    }

    // -------------------------
    // GEMINI
    // -------------------------

    else {
      const response =
        await callGemini(apiKey);

      usage =
        response.usage;

      const cleaned =
        cleanJsonText(
          response.rawText
        );

      try {
        parsed =
          JSON.parse(cleaned);
      } catch (error) {
        throw new Error(
          "Не вдалося розпарсити JSON " +
          "від Gemini: " +
          error.message
        );
      }
    }

    const elapsedMs =
      performance.now() -
      start;

    const cost =
      isDemoMode()
        ? 0
        : (
            (usage.input_tokens /
              1e6) *
              PRICING.gemini.inputPerMTok
          ) +
          (
            (usage.output_tokens /
              1e6) *
              PRICING.gemini.outputPerMTok
          );

    state.result =
      normalizeResult(parsed);

    state.metrics = {
      elapsedMs,
      usage,
      cost,
      provider:
        isDemoMode()
          ? "demo"
          : "gemini",
    };

    state.selectedRowId = null;
    state.activePhoto = 0;

    setStatus(
      isDemoMode()
        ? `Demo готово за ${(elapsedMs / 1000).toFixed(1)} с`
        : `Готово за ${(elapsedMs / 1000).toFixed(1)} с (Gemini)`,
      ""
    );

    renderResults();
  } catch (error) {
    console.error(error);

    setStatus(
      "Помилка: " +
        error.message,
      "err"
    );

    els.resultsZone.innerHTML = `
      <div class="empty">
        Не вдалося отримати результат.
        Перевірте API key та спробуйте ще раз.
      </div>
    `;
  } finally {
    updateRunEnabled();
  }
}

els.runBtn?.addEventListener(
  "click",
  runAudit
);

// ============================================================
// STATUS LABEL
// ============================================================

function statusLabel(status) {
  return (
    {
      confirmed:
        "ПІДТВЕРДЖЕНО",

      mismatch:
        "РОЗБІЖНІСТЬ",

      unverified:
        "НЕ ПЕРЕВІРЕНО",
    }[status] ||
    String(status || "")
      .toUpperCase()
  );
}

// ============================================================
// RENDER RESULTS
// ============================================================

function renderResults() {
  const result =
    state.result;

  if (
    !result ||
    !els.resultsZone ||
    !state.images.length
  ) {
    return;
  }

  const findingsByRow =
    new Map(
      result.findings.map(
        (finding) => [
          finding.row_id,
          finding,
        ]
      )
    );

  const rows =
    result.manifest_rows.map(
      (manifestRow) => ({
        ...manifestRow,

        finding:
          findingsByRow.get(
            manifestRow.row_id
          ),
      })
    );

  // ==========================================================
  // PHOTO TABS
  // ==========================================================

  const photoTabs =
    state.images
      .map(
        (image, index) => `
          <button
            type="button"
            class="${
              index ===
              state.activePhoto
                ? "active"
                : ""
            }"
            data-photo="${index}"
          >
            Фото ${index + 1}
          </button>
        `
      )
      .join("");

  const activeImg =
    state.images[
      state.activePhoto
    ] ||
    state.images[0];

  // ==========================================================
  // BBOXES
  // ==========================================================

  const boxes = [];

  rows.forEach((row) => {
    (
      row.finding?.evidence ||
      []
    ).forEach((evidence) => {
      if (
        Number(
          evidence.photo_index
        ) ===
        state.activePhoto
      ) {
        boxes.push({
          bbox:
            normalizeBbox(
              evidence.bbox
            ),

          status:
            row.finding.status,

          label:
            row.name,

          rowId:
            row.row_id,
        });
      }
    });
  });

  result.extra_items.forEach(
    (extraItem, index) => {
      if (
        Number(
          extraItem.photo_index
        ) ===
        state.activePhoto
      ) {
        boxes.push({
          bbox:
            normalizeBbox(
              extraItem.bbox
            ),

          status:
            "mismatch",

          label:
            "зайвий: " +
            extraItem.description,

          rowId:
            "extra-" + index,
        });
      }
    }
  );

  const boxesHtml =
    boxes
      .map((box) => {
        const [
          x,
          y,
          width,
          height,
        ] = box.bbox;

        const selected =
          box.rowId ===
          state.selectedRowId;

        return `
          <div
            class="bbox ${escapeHtml(
              box.status
            )}"
            style="
              left:${x * 100}%;
              top:${y * 100}%;
              width:${width * 100}%;
              height:${height * 100}%;
              ${
                selected
                  ? "border-width:3px;"
                  : ""
              }
            "
          >
            <div class="tag">
              ${escapeHtml(
                box.label
              )}
            </div>
          </div>
        `;
      })
      .join("");

  // ==========================================================
  // TABLE
  // ==========================================================

  const tableRows =
    rows
      .map((row) => {
        const finding =
          row.finding;

        const status =
          finding?.status ||
          "unverified";

        const selected =
          row.row_id ===
          state.selectedRowId
            ? "selected"
            : "";

        return `
          <tr
            class="row ${selected}"
            data-row="${escapeHtml(
              row.row_id
            )}"
          >
            <td>
              ${escapeHtml(
                row.sku || "—"
              )}
            </td>

            <td>
              ${escapeHtml(
                row.name || "—"
              )}

              <div class="reason">
                ${escapeHtml(
                  finding?.reason ||
                    ""
                )}
              </div>
            </td>

            <td>
              ${
                row.expected_qty ??
                "—"
              }
            </td>

            <td>
              <span
                class="stamp ${escapeHtml(
                  status
                )}"
              >
                ${statusLabel(
                  status
                )}
              </span>
            </td>
          </tr>
        `;
      })
      .join("");

  // ==========================================================
  // EXTRA ITEMS
  // ==========================================================

  const extraHtml =
    result.extra_items.length
      ? `
        <div class="extra-note">
          <b>
            Помічено
            ${result.extra_items.length}
            зайвих позицій
          </b>

          поза пакувальним листом:

          ${result.extra_items
            .map(
              (item) =>
                escapeHtml(
                  item.description
                )
            )
            .join(", ")}.
        </div>
      `
      : "";

  // ==========================================================
  // METRICS
  // ==========================================================

  const metrics =
    state.metrics;

  const costNote =
    metrics?.provider ===
    "demo"
      ? " (Demo)"
      : " (оцінка за тарифом моделі)";

  const metricsHtml =
    metrics
      ? `
        <div class="metrics">

          <div class="m">
            <b>
              ${(
                metrics.elapsedMs /
                1000
              ).toFixed(1)}
              с
            </b>

            <span>
              час до результату
            </span>
          </div>

          <div class="m">
            <b>
              $${metrics.cost.toFixed(
                4
              )}
            </b>

            <span>
              оцінка вартості${costNote}
            </span>
          </div>

          <div class="m">
            <b>
              ${
                (metrics.usage
                  .input_tokens ||
                  0) +
                (metrics.usage
                  .output_tokens ||
                  0)
              }
            </b>

            <span>
              токенів (in+out) ·
              ${
                metrics.provider ===
                "demo"
                  ? "Demo"
                  : PRICING.gemini
                      .model
              }
            </span>
          </div>

        </div>
      `
      : "";

  // ==========================================================
  // FINAL HTML
  // ==========================================================

  els.resultsZone.innerHTML = `
    <div class="results">

      <div>

        <div class="section-title">
          <span class="num">
            03
          </span>
          Маніфест
        </div>

        <table class="ledger">

          <thead>
            <tr>
              <th>SKU</th>
              <th>Товар</th>
              <th>К-сть</th>
              <th>Статус</th>
            </tr>
          </thead>

          <tbody>
            ${tableRows}
          </tbody>

        </table>

        ${extraHtml}

        ${metricsHtml}

      </div>

      <div class="evidence-col">

        <div class="section-title">
          <span class="num">
            04
          </span>
          Докази
        </div>

        <div class="photo-tabs">
          ${photoTabs}
        </div>

        <div class="photo-frame">

          <img
            src="${activeImg.dataUrl}"
            alt="Фото доставки"
          />

          ${boxesHtml}

        </div>

        <div
          style="
            font-size:11px;
            color:var(--ink-soft);
            margin-top:8px;
          "
        >
          Конвенція зйомки,
          застосована моделлю:

          ${escapeHtml(
            result.capture_convention_used
          )}
        </div>

      </div>

    </div>
  `;

  // ==========================================================
  // TABLE CLICK
  // ==========================================================

  els.resultsZone
    .querySelectorAll(
      "tr.row"
    )
    .forEach((rowElement) => {
      rowElement.addEventListener(
        "click",
        () => {
          const rowId =
            rowElement.dataset
              .row;

          state.selectedRowId =
            rowId;

          const row =
            rows.find(
              (item) =>
                item.row_id ===
                rowId
            );

          const firstEvidence =
            row?.finding
              ?.evidence?.[0];

          if (
            firstEvidence &&
            Number.isInteger(
              Number(
                firstEvidence.photo_index
              )
            ) &&
            Number(
              firstEvidence.photo_index
            ) <
              state.images.length
          ) {
            state.activePhoto =
              Number(
                firstEvidence.photo_index
              );
          }

          renderResults();
        }
      );
    });

  // ==========================================================
  // PHOTO TAB CLICK
  // ==========================================================

  els.resultsZone
    .querySelectorAll(
      ".photo-tabs button"
    )
    .forEach((button) => {
      button.addEventListener(
        "click",
        () => {
          state.activePhoto =
            Number(
              button.dataset.photo
            ) || 0;

          renderResults();
        }
      );
    });
}