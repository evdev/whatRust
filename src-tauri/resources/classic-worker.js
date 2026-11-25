// whatRust: WhatsApp's backend socket runs in a dedicated worker. On Safari
// 15 and newer (this app's WKWebView reports Version/27) WhatsApp treats the
// browser as module-worker capable and loads its bootstrap with
// {type:"module"}. That bootstrap calls importScripts, which a module worker
// rejects ("importScripts cannot be used if worker type is module"), so the
// worker never posts "worker_started". The page then stays on the startup
// splash with the socket left UNLAUNCHED.
//
// Only the bootstrap URL is rewritten. Other module workers are unchanged,
// and WhatsApp's module loader is left alone.
(function () {
  "use strict";
  if (window.__wrClassicWorker) return;
  var current = window.Worker;
  function workerUrl(url) {
    try {
      if (typeof url === "string") return url;
      return (url && url.href) || "";
    } catch (e) {
      return "";
    }
  }
  function isBootstrap(url) {
    return /webworker|init_script/i.test(workerUrl(url));
  }
  function note() {
    if (window.__wrClassicWorkerLogged) return;
    window.__wrClassicWorkerLogged = true;
    try {
      var tauri = window.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
        tauri.core.invoke("dlog", { msg: "worker: WhatsApp bootstrap forced to a classic worker" }).catch(function () {});
      }
    } catch (e) {}
  }
  function install(Orig) {
    if (typeof Orig !== "function" || Orig.__wrWrapped) return Orig;
    function ClassicWorker(url, opts) {
      var next = opts;
      if (opts && opts.type === "module" && isBootstrap(url)) {
        next = {};
        for (var k in opts) {
          if (Object.prototype.hasOwnProperty.call(opts, k)) next[k] = opts[k];
        }
        next.type = "classic";
        note();
      }
      return new Orig(url, next);
    }
    ClassicWorker.prototype = Orig.prototype;
    ClassicWorker.__wrWrapped = true;
    try { Object.setPrototypeOf(ClassicWorker, Orig); } catch (e) {}
    return ClassicWorker;
  }
  try {
    Object.defineProperty(window, "Worker", {
      configurable: true,
      enumerable: true,
      get: function () { return current; },
      set: function (v) { current = install(v); },
    });
    if (current) current = install(current);
    window.__wrClassicWorker = true;
  } catch (e) { /* leave the native constructor alone */ }
})();
