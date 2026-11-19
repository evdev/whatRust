/* Local first-page previews. The separately bundled renderer is instantiated on demand. */
(function () {
  'use strict';
  if (window.__wrSchedulePdfPreview) return;
  const MAX_FILE = 20 * 1024 * 1024;
  const MAX_OUTPUT = 256 * 1024;
  let busy = false;
  window.__wrSchedulePdfPreview = async function (file) {
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size) ||
        file.size < 5 || file.size > MAX_FILE) throw new Error('PDF preview size limit');
    if (busy) throw new Error('PDF preview busy');
    busy = true;
    let loading, render, canvas, timer, expired = false;
    const work = async () => {
      const data = new Uint8Array(await file.arrayBuffer());
      if (expired) throw new Error('PDF preview timed out');
      if (data.byteLength > MAX_FILE || String.fromCharCode(...data.subarray(0, 5)) !== '%PDF-') {
        throw new Error('Invalid PDF');
      }
      const pdfjs = window.__wrSchedulePdfJs();
      loading = pdfjs.getDocument({
        data, isEvalSupported: false, enableScripting: false, enableXfa: false,
        useWasm: false, useWorkerFetch: false, disableFontFace: true,
        useSystemFonts: true, isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false, maxImageSize: 8 * 1024 * 1024,
        canvasMaxAreaInBytes: 16 * 1024 * 1024, stopAtErrors: true,
        disableAutoFetch: true, disableStream: true, disableRange: true,
        verbosity: 0,
        // No URLs are supplied; optional fonts/CMaps/codecs must never fetch.
        BinaryDataFactory: class {
          fetch() { return Promise.reject(new Error('External PDF assets disabled')); }
        },
      });
      loading.onPassword = () => { void loading.destroy(); };
      const pdf = await loading.promise;
      if (expired) throw new Error('PDF preview timed out');
      const page = await pdf.getPage(1);
      const original = page.getViewport({ scale: 1 });
      if (![original.width, original.height].every(v => Number.isFinite(v) && v > 0)) {
        throw new Error('Invalid PDF page size');
      }
      const viewport = page.getViewport({ scale: Math.min(1, 480 / Math.max(original.width, original.height)) });
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('PDF canvas unavailable');
      render = page.render({ canvasContext: context, viewport,
        annotationMode: pdfjs.AnnotationMode.DISABLE, background: 'rgb(255,255,255)' });
      await render.promise;
      if (expired) throw new Error('PDF preview timed out');
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.78));
      if (!blob || blob.size > MAX_OUTPUT || blob.type !== 'image/jpeg') throw new Error('PDF thumbnail unavailable');
      return blob;
    };
    try {
      return await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error('PDF preview timed out')); }, 12000);
      })]);
    } finally {
      expired = true;
      clearTimeout(timer);
      try { render?.cancel(); } catch (_) {}
      try { await loading?.destroy(); } catch (_) {}
      if (canvas) canvas.width = canvas.height = 0;
      busy = false;
    }
  };
})();
