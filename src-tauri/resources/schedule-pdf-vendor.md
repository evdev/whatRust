PDF.js 6.5.438, pinned from Mozilla's official `pdfjs-dist` npm release:
https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz

Archive SHA-256: `7461aefcd27c4ef0dd76f9ca5760f09466eb6b3f934432670c12132e7b3d6faa`.
Upstream: https://github.com/mozilla/pdf.js/releases/tag/v6.5.438
API: https://mozilla.github.io/pdf.js/api/draft/api.js.html
License: Apache-2.0, reproduced in schedule-pdf-vendor.LICENSE.

The vendor file contains `legacy/build/pdf.worker.min.mjs` followed by
`legacy/build/pdf.min.mjs`, each in a function scope, instantiated once on first
preview. Changes to the upstream minified files are limited to:

- Remove each final ESM `export{...};` declaration.
- Replace `import.meta.url` with `"about:blank"` (unused Node/Wasm paths).
- In the worker, replace `globalThis.pdfjsWorker=` with `return `.
- In the main library, replace `globalThis.pdfjsLib=` with
  `const __wrMainExports=`, `globalThis._pdfjsTestingUtils=` with
  `const __wrTestingUtils=`, and references to `globalThis.pdfjsWorker` with the
  local `__wrWorkerExports` containing the worker factory's return value.

The wrapper exposes only a cached `window.__wrSchedulePdfJs()` factory. This
selects PDF.js's built-in loopback/fake-worker path without fetching or executing
an external module. No viewer, scripting manager, annotation layer, or XFA UI is
used. The caller explicitly disables evaluation, scripting, external binary
assets, Wasm, and annotations. Inputs, raster dimensions, image decoding size,
and JPEG output are bounded. Missing optional CMap/font/codec data can make an
unusual PDF unrenderable; the schedule editor retains its document card.

The fake worker permits operation under WebView2 pages whose CSP disallows blob
workers/modules. Parsing therefore runs on the UI thread. A timeout cancels
asynchronous rendering; it cannot interrupt synchronous parser work. This is a
thumbnail renderer, not a security boundary for hostile documents.

Verification: `node --test src-tauri/resources/schedule-pdf-preview.test.mjs`.
On Windows with Edge installed this includes a real browser render with
`worker-src 'none'`, `connect-src 'none'`, and `font-src 'none'`. No live WhatsApp
session is used. `WR_EDGE_PATH` can select another Chromium executable.
