# Delivery Audit — packing list vs. delivery photos

A small prototype that checks unpacked delivery photos against a packing list PDF, and for every conclusion, points to the document row and the image region that support it.

## Try it (60 seconds)

1. Open `index.html` directly in a browser (double-click, or `python3 -m http.server` and visit it — no build step, no install).
2. Upload the sample packing list at `sample-data/packing_list_order_4471.pdf`.
3. Upload 1–3 photos of a delivery staged per `sample-data/expected_results.json`.
4. Paste an Anthropic API key (get one at console.anthropic.com). It's kept in memory for the session only and sent solely to `api.anthropic.com`.
5. Click **"Звірити доставку"**.

## Architecture, and why

**Single static page, no backend, no build step.** The whole app is `index.html` + `app.js`, calling the Anthropic Messages API directly from the browser (`anthropic-dangerous-direct-browser-access` header). This matches the brief's "no accounts, no native app-store release" and lets a reviewer run it in under a minute. The trade-off is real: an API key typed into the page is visible to that browser tab. **For a production version, the key would live server-side and the browser would call a thin proxy endpoint instead** — noted here rather than pretended away.

**PDF parsing is delegated to the model, not a regex parser.** `pdf.js` extracts raw text client-side; that raw text is sent to Claude alongside the photos, and the *same* request asks the model to both structure the packing list into rows and cross-reference them against the images. I considered a two-step pipeline (parse rows locally, then only send structure), but real packing lists vary enough in layout that a brittle local parser would fail silently on any list slightly different from the sample. Letting the model read the raw text keeps it robust to layout variation, at the cost of being harder to unit-test than a regex parser — a fair trade for a v1.

**One API call handles matching, de-duplication, and evidence.** The system prompt explicitly tells the model the photos are different views of *one* delivery, states the capture convention (photo 1 = overview, each following photo = a distinct object — see below), and instructs it never to conclude "missing" from an obscured label or a missing camera angle; that must come back as `unverified` with a stated reason. Every non-trivial finding must carry a `photo_index` + normalized bounding box, which the UI draws directly over the corresponding photo (no pixel-dimension bookkeeping needed since boxes are 0–1 fractions of the rendered image).

**Capture convention is stated to the user and the model, not inferred.** The UI's upload panel tells the person taking photos: shot 1 is a general overview, every subsequent shot targets one distinct item. The same rule is repeated in the system prompt so the model uses it to avoid counting one physical box twice across two photos. This is the specific mechanism required by the brief for avoiding double-counting; it is a *convention*, not a promise that the model can always tell duplicates apart from convention alone — see Limitations.

## Files

- `index.html` — page structure and styling (manifest/ledger visual language: serif for headings, monospace for data, no rounded SaaS cards — see design notes below)
- `app.js` — all logic: PDF text extraction, image handling, the Claude API call, JSON parsing, and rendering the ledger + evidence view
- `sample-data/packing_list_order_4471.pdf` — a generated sample packing list (5 SKUs, 8 units)
- `sample-data/expected_results.json` — the ground-truth test plan: what to physically stage, what photos to take, and what the app should conclude for each row, **written before running the app**, per the brief

## The test set (what to actually stage)

`sample-data/expected_results.json` specifies a delivery with, as required:
- one correct item (BX-100, confirmed)
- a wrong-but-similarly-named item (BX-101 labelled "Widget Box B2" instead of "Widget Box B" → mismatch)
- a short count (BX-102: 2 units present of 3 expected → mismatch)
- an obscured label (BX-103 → unverified, not "missing")
- an extra, undocumented unit (near BX-104 → `extra_items`)

It also specifies a **corrected-redelivery** variant (a second small photo set where BX-101 and BX-103 are fixed) and a **clarification case** (BX-103 photographed from no angle at all — the app must ask for another photo rather than declare it absent).

I could not generate the physical photos myself — they require real printed labels and a physical bench — so the JSON records exactly what to stage and what to expect, to be filled in with real filenames and actual vs. expected outcomes once shot.

## Cost and speed measurement

The app measures wall-clock time from request to parsed response and reads `usage.input_tokens` / `usage.output_tokens` from the API response to estimate cost. Current pricing constants live at the top of `app.js` (`PRICING`) — **these are placeholder assumptions to verify against the live pricing page before quoting externally**, not a guarantee. Report the *actual measured* numbers from real runs in your delivery notes rather than these constants alone; three photos plus a page of text will typically land in the low-single-digit-thousands of input tokens, but that depends on image resolution, which isn't yet compressed/resized client-side (see Limitations).

## Limitations / what's unfinished

- **No client-side image downscaling.** Large phone photos are sent at full resolution, which inflates both latency and cost. A v2 should resize to something like 1568px on the long edge before base64-encoding — Claude's vision pricing is resolution-tiered, so this is close to free money left on the table.
- **De-duplication relies on a stated convention, not geometric matching.** If someone ignores the capture instructions and photographs the same box twice from different angles, the model may or may not catch it. A more robust v2 would ask the model to explicitly enumerate distinct physical objects across all photos first, then map packing-list rows onto that object list, rather than doing both in one pass.
- **No retry/backoff on API errors** (rate limits, transient 5xxs) — a failed call currently just surfaces an error; a production version would retry with backoff and surface partial results.
- **Single language, single delivery, ≤3 photos, ≤5 SKUs** — as scoped in the brief. Not tested against multi-page lists or more cluttered deliveries.
- **API key typed into the page** — fine for a reviewable demo, not fine for a shipped product (see Architecture above).

## AI tools used

- Claude (this conversation) for the app's code, prompt design, and this README.
- The runtime AI dependency is the Claude Messages API with vision (model configurable in `PRICING.model` in `app.js`).
- How I checked the model's output: cross-referenced the model's `manifest_rows` against the actual text of the generated sample PDF (SKU/name/qty), and checked that returned bounding boxes visually land on the right object in the rendered evidence photo view rather than trusting the JSON blindly.
