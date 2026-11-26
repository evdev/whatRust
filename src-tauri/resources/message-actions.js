(function init() {
  "use strict";
  if (location.origin !== "https://web.whatsapp.com") return;
  if (!window.__WHATRUST_TEST && !document.documentElement) {
    document.addEventListener("DOMContentLoaded", init, { once: true });
    return;
  }
  var enabled = !!window.__WR_MESSAGE_ACTIONS;
  var pending = null;
  var panel = null;
  var anchor = null;
  var timer = 0;
  function diagnostic(message) {
    try {
      var tauri = window.__TAURI__;
      if (tauri && tauri.core) tauri.core.invoke("dlog", { msg: "message actions: " + message }).catch(function () {});
    } catch (_) {}
  }
  function label(pt, en) { return window.__WR_LANG === "en" ? en : pt; }
  function close() {
    clearTimeout(timer);
    pending = null;
    anchor = null;
    if (panel) panel.remove();
    panel = null;
  }
  function unavailable() {
    return !enabled || window.__whatrustLocked || document.documentElement.getAttribute("data-wr-privacy") === "on";
  }
  function classify(text) {
    text = String(text || "").trim();
    if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(text)) return { kind: "email", value: text };
    if (/^\+?[\d\s().-]{10,25}$/.test(text)) {
      var digits = text.replace(/\D/g, "");
      if (digits.length === 10 || (digits.length === 11 && digits[0] === "1") || (text[0] === "+" && digits.length >= 10 && digits.length <= 15)) return { kind: "phone", value: text, digits: digits };
    }
    if (text.length <= 300 && /\b\d+\s+[\w .'-]+\s(?:st(?:reet)?|ave(?:nue)?|rd|road|blvd|boulevard|dr(?:ive)?|ln|lane|way|ct|court|pkwy|parkway)\b/i.test(text)) return { kind: "address", value: text };
    return null;
  }
  if (window.__WHATRUST_TEST) { window.__wrMessageActionClassify = classify; return; }
  // Custom highlights decorate WhatsApp's existing text without replacing its
  // nodes, so its own links, selection, and context menus keep working.
  var highlightName = "whatrust-message-actions";
  var bodySelector = "[data-id] [data-pre-plain-text] .selectable-text";
  var calendar = window.__wrCalendarActions;
  var canHighlight = !!(window.CSS && window.CSS.highlights && window.Highlight);
  var canTrack = !!((canHighlight || calendar) && window.IntersectionObserver && document.createTreeWalker);
  var main = null;
  var highlight = null;
  var messageObserver = null;
  var viewportResize = null;
  var bodies = new Map();
  var viewports = new Map();

  function scan(body, record) {
    var matches = [];
    record.needsSent = false;
    var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var value = node.nodeValue || "";
      var dates = [];
      if (calendar && !node.parentElement.closest("a, button, [role=button], [contenteditable=true]")) {
        var parsed = calendar.matches(value, label("pt", "en"), record.sent);
        record.needsSent ||= parsed.needsSent;
        dates = parsed.found;
        for (var date of dates) matches.push(Object.assign({ node: node }, date));
      }
      if (!canHighlight) continue;
      var addresses = value.matchAll(/\b\d+\s+[\w .'-]+\s(?:st(?:reet)?|ave(?:nue)?|rd|road|blvd|boulevard|dr(?:ive)?|ln|lane|way|ct|court|pkwy|parkway)\b(?:,\s*[a-z][a-z .'-]{1,40},\s*[a-z]{2}(?:\s+\d{5}(?:-\d{4})?)?)?/ig);
      for (var address of addresses) matches.push({ node: node, start: address.index, end: address.index + address[0].length, value: address[0] });
      var numbers = value.matchAll(/\+?\d[\d(). -]{8,23}\d/g);
      for (var number of numbers) {
        if (dates.some(function (date) { return date.start < number.index + number[0].length && date.end > number.index; })) continue;
        var type = classify(number[0]);
        if (type && type.kind === "phone") matches.push({ node: node, start: number.index, end: number.index + number[0].length });
      }
    }
    return matches;
  }

  function showMatches(body, record) {
    if (!record.matches) record.matches = scan(body, record);
    record.marks = record.matches.map(function (match) {
      if (!highlight) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = label("Calendário", "Calendar") + ": " + match.phrase;
        Object.assign(button.style, {
          display: "inline-block", margin: "2px 4px", padding: "2px 6px", borderRadius: "6px",
          border: "1px solid currentColor", background: "transparent", color: "inherit", cursor: "pointer"
        });
        button.addEventListener("click", function (event) {
          event.stopPropagation();
          reviewDate(match);
        });
        body.after(button);
        return { button: button };
      }
      var range = document.createRange();
      range.setStart(match.node, match.start);
      range.setEnd(match.node, match.end);
      highlight.add(range);
      return { match: match, range: range };
    });
    resolveSent(body, record);
  }

  function resolveSent(body, record) {
    if (!calendar || !window.WPP?.chat || !record.needsSent || record.request) return;
    record.request = calendar.sentDate(body).then(function (sent) {
      record.request = null;
      if (!sent || unavailable() || bodies.get(body) !== record) return;
      record.sent = sent;
      record.matches = null;
      if (!record.marks) return;
      hideMatches(record);
      showMatches(body, record);
    });
  }

  function reviewDate(match) {
    calendar.review(match, function () { return !unavailable() && match.node.isConnected; });
  }

  function hideMatches(record) {
    if (!record.marks) return;
    for (var mark of record.marks) {
      if (mark.button) mark.button.remove();
      else highlight.delete(mark.range);
    }
    record.marks = null;
  }

  function observeViewport(viewport) {
    var height = viewport.root ? viewport.root.clientHeight : window.innerHeight;
    if (viewport.observer && height === viewport.height) return;
    if (viewport.observer) viewport.observer.disconnect();
    viewport.height = height;
    // Observe the chat's own scroll container. Expanding the outer window's
    // bounds alone wouldn't look past the scroll container's clipping edge.
    var observer = new window.IntersectionObserver(function (entries) {
      if (viewport.observer !== observer || unavailable()) return;
      for (var entry of entries) {
        var record = bodies.get(entry.target);
        if (!record || record.viewport !== viewport || !main.contains(entry.target)) continue;
        if (entry.isIntersecting) {
          if (!record.marks) showMatches(entry.target, record);
        } else {
          hideMatches(record);
        }
      }
    }, { root: viewport.root, rootMargin: height + "px 0px" });
    viewport.observer = observer;
    for (var body of viewport.bodies) observer.observe(body);
  }

  function scrollRoot(body, cache) {
    var visited = [];
    var root = null;
    for (var element = body.parentElement; element && main.contains(element); element = element.parentElement) {
      if (cache.has(element)) { root = cache.get(element); break; }
      visited.push(element);
      if (/^(auto|scroll|overlay)$/.test(window.getComputedStyle(element).overflowY)) { root = element; break; }
    }
    for (var element of visited) cache.set(element, root);
    return root;
  }

  function watchBody(body, cache) {
    if (bodies.has(body) || !main.contains(body) || !body.matches(bodySelector) || body.parentElement.closest(bodySelector)) return;
    var root = scrollRoot(body, cache);
    var viewport = viewports.get(root);
    if (!viewport) {
      viewport = { root: root, bodies: new Set() };
      viewports.set(root, viewport);
      observeViewport(viewport);
      if (root && viewportResize) viewportResize.observe(root);
    }
    bodies.set(body, { viewport: viewport, matches: null, marks: null });
    viewport.bodies.add(body);
    viewport.observer.observe(body);
  }

  function unwatchBody(body) {
    var record = bodies.get(body);
    if (!record) return;
    hideMatches(record);
    var viewport = record.viewport;
    viewport.observer.unobserve(body);
    viewport.bodies.delete(body);
    bodies.delete(body);
    if (viewport.bodies.size) return;
    viewport.observer.disconnect();
    if (viewport.root && viewportResize) viewportResize.unobserve(viewport.root);
    viewports.delete(viewport.root);
  }

  function visitBodies(node, visit) {
    if (node.nodeType !== 1) return;
    if (node.matches(".selectable-text")) visit(node);
    for (var body of node.querySelectorAll(".selectable-text")) visit(body);
  }

  function clearBodies() {
    if (calendar) calendar.dismiss();
    for (var record of bodies.values()) hideMatches(record);
    for (var viewport of viewports.values()) viewport.observer.disconnect();
    viewports.clear();
    bodies.clear();
    if (viewportResize) viewportResize.disconnect();
  }

  function updateMain() {
    var next = document.getElementById("main");
    if (main === next) return false;
    clearBodies();
    main = next;
    if (main) {
      var cache = new WeakMap();
      for (var body of main.querySelectorAll(bodySelector)) watchBody(body, cache);
    }
    return true;
  }

  function updateBodies(changes) {
    if (unavailable() || updateMain() || !main) return;
    var added = [];
    var edited = new Set();
    for (var change of changes) {
      var target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      if (!target || !main.contains(target)) continue;
      for (var body = target.closest(bodySelector); body; body = body.parentElement.closest(bodySelector)) {
        if (bodies.has(body)) edited.add(body);
      }
      if (change.type !== "childList") continue;
      for (var node of change.removedNodes) visitBodies(node, unwatchBody);
      for (var node of change.addedNodes) added.push(node);
    }
    var cache = new WeakMap();
    for (var node of added) visitBodies(node, function (body) { watchBody(body, cache); });
    for (var body of edited) {
      var record = bodies.get(body);
      if (!record) continue;
      record.matches = null;
      if (!record.marks) continue;
      hideMatches(record);
      showMatches(body, record);
    }
  }

  function resizeViewports() {
    for (var viewport of viewports.values()) observeViewport(viewport);
  }

  function syncHighlights() {
    if (!canTrack) return;
    if (unavailable()) {
      if (!messageObserver) return;
      messageObserver.disconnect();
      messageObserver = null;
      clearBodies();
      main = null;
      highlight = null;
      if (canHighlight) window.CSS.highlights.delete(highlightName);
      return;
    }
    if (!messageObserver) {
      if (canHighlight) {
        highlight = new window.Highlight();
        window.CSS.highlights.set(highlightName, highlight);
      }
      messageObserver = new MutationObserver(updateBodies);
      messageObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    updateMain();
  }

  if (canTrack && canHighlight) {
    var highlightStyle = document.createElement("style");
    highlightStyle.textContent = "::highlight(" + highlightName + ") { text-decoration: underline; text-underline-offset: 2px; }";
    document.documentElement.appendChild(highlightStyle);
  }
  if (canTrack) {
    if (window.ResizeObserver) viewportResize = new window.ResizeObserver(resizeViewports);
    window.addEventListener("resize", resizeViewports);
    if (calendar) window.addEventListener("whatrust-calendar-source-ready", function () {
      for (var entry of bodies) if (entry[1].marks) resolveSent(entry[0], entry[1]);
    });
    syncHighlights();
  }
  function open(url) { window.open(url, "_blank", "noopener"); }
  function openMaps(value) { open("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(value)); }
  document.addEventListener("click", function (event) {
    if (unavailable() || !highlight || event.button !== 0 || event.detail > 1 || !document.caretRangeFromPoint) return;
    var target = event.target;
    if (!target || !target.closest || !target.closest("#main [data-id]") || target.closest("a, button, [role=button], [contenteditable=true]")) return;
    var selection = window.getSelection();
    if (selection && !selection.isCollapsed && String(selection)) return;
    var point = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (!point) return;
    var parent = point.startContainer.parentElement;
    var body = parent && parent.closest(bodySelector);
    while (body && !bodies.has(body)) body = body.parentElement.closest(bodySelector);
    var record = bodies.get(body);
    if (!record || !record.marks) return;
    for (var mark of record.marks) {
      var item = mark.match;
      if ((!item.value && item.kind !== "calendar") || point.startContainer !== item.node || point.startOffset < item.start || point.startOffset >= item.end || !item.node.isConnected) continue;
      var boxes = mark.range.getClientRects();
      for (var j = 0; j < boxes.length; j++) {
        var box = boxes[j];
        if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) {
          if (item.kind === "calendar") reviewDate(item);
          else openMaps(item.value);
          return;
        }
      }
    }
  }, true);
  function phoneMenuOpen() {
    var nodes = document.querySelectorAll('button, [role="button"], [role="menuitem"], span');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (/^\s*(copy\s+(?:phone\s+)?number|copiar\s+(?:número(?:\s+de\s+telefone)?|telefone))\s*$/i.test(node.textContent || "") && node.getClientRects().length) return true;
    }
    return false;
  }
  function show(menu, item) {
    if (!menu || !menu.isConnected || unavailable()) return;
    if (panel) panel.remove();
    panel = document.createElement("div");
    panel.id = "__whatrust_message_actions";
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", label("Ações de mensagem", "Message actions"));
    Object.assign(panel.style, { position: "fixed", zIndex: "2147483647", display: "flex", gap: "4px", padding: "6px", borderRadius: "8px", background: "#233138", boxShadow: "0 2px 8px #0007" });
    function button(text, action) {
      var element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      Object.assign(element.style, { color: "white", background: "#374c55", border: "0", borderRadius: "5px", padding: "8px", cursor: "pointer" });
      function run(event) {
        if (event.type === "pointerdown" && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (!unavailable() && anchor && anchor.isConnected) action();
        close();
      }
      element.addEventListener("pointerdown", run);
      element.addEventListener("click", run);
      panel.appendChild(element);
    }
    if (item.kind === "phone") {
      button(label("Abrir telefone", "Open dialer"), function () { open("tel:" + (item.value.trim().startsWith("+") ? "+" : "") + item.digits); });
    } else if (item.kind === "email") {
      button(label("Escrever email", "Compose email"), function () { open("mailto:" + encodeURIComponent(item.value).replace(/%40/i, "@")); });
    }
    document.body.appendChild(panel);
    anchor = menu;
    var rect = menu.getBoundingClientRect();
    var panelRect = panel.getBoundingClientRect();
    // WhatsApp may put a reaction strip immediately above its menu.
    // Prefer the space below, and leave room for the strip when using the top.
    var top = rect.bottom + 8;
    if (top + panelRect.height > innerHeight - 8) top = rect.top - panelRect.height - 64;
    var left = Math.max(8, Math.min(rect.left, innerWidth - panelRect.width - 8));
    if (top < 8 || top + panelRect.height > innerHeight - 8) {
      top = Math.max(8, Math.min(rect.top, innerHeight - panelRect.height - 8));
      if (rect.right + 8 + panelRect.width <= innerWidth - 8) left = rect.right + 8;
      else if (rect.left - 8 - panelRect.width >= 8) left = rect.left - 8 - panelRect.width;
      else { panel.remove(); panel = null; anchor = null; return; }
    }
    panel.style.top = top + "px";
    panel.style.left = left + "px";
  }
  function findMenu() {
    if (!pending || unavailable() || Date.now() - pending.time > 1500) { if (pending) diagnostic("menu not found"); close(); return; }
    var menus = Array.from(document.querySelectorAll('ul, [role="menu"], [role="listbox"]'));
    if (pending.item.kind === "phone") {
      var candidates = document.querySelectorAll('button, [role="button"], [role="menuitem"], span');
      for (var c = 0; c < candidates.length; c++) {
        var node = candidates[c];
        if (!/^\s*(copy\s+(?:phone\s+)?number|copiar\s+(?:número(?:\s+de\s+telefone)?|telefone))\s*$/i.test(node.textContent || "")) continue;
        for (var parent = node, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
          var box = parent.getBoundingClientRect();
          if (box.width >= 100 && box.width <= 560 && box.height >= 32 && box.height <= 400) {
            menus.push(parent);
          }
        }
      }
    }
    for (var i = 0; i < menus.length; i++) {
      var menu = menus[i];
      if (menu.closest("#__whatrust_message_actions") || !menu.getBoundingClientRect().width) continue;
      if (pending.item.kind === "phone" && pending.previousMenus.indexOf(menu) !== -1) continue;
      var text = String(menu.textContent || "");
      if (pending.item.kind === "phone" && !/copy\s+(?:phone\s+)?number|copiar\s+(?:número|telefone)/i.test(text)) continue;
      if (pending.item.kind !== "phone" && !/(copy|reply|forward|copiar|responder|encaminhar)/i.test(text)) continue;
      var r = menu.getBoundingClientRect();
      if (Math.abs(r.left - pending.x) > 600 || Math.abs(r.top - pending.y) > 600) continue;
      var matched = pending;
      timer = setTimeout(function () {
        if (pending !== matched || !menu.isConnected || !menu.getClientRects().length || unavailable()) return;
        show(menu, matched.item);
        diagnostic("menu found");
        pending = null;
      }, 350);
      return;
    }
    timer = setTimeout(findMenu, 80);
  }
  document.addEventListener("pointerdown", function (event) {
    if (panel && panel.contains(event.target)) return;
    close();
    if (unavailable()) return;
    var target = event.target;
    if (!target || !target.closest || !target.closest("#main [data-id]")) {
      if (target && target.closest && target.closest("#main") && target.closest("a")) diagnostic("link outside identified message");
      return;
    }
    var selected = window.getSelection();
    var row = target.closest("[data-id]");
    var selection = selected && row.contains(selected.anchorNode) && row.contains(selected.focusNode)
      ? String(selected).trim() : "";
    var item = classify(selection);
    if (event.button === 0) item = classify(target.textContent);
    if (!item || item.kind === "address" || (item.kind !== "phone" && event.button !== 2)) return;
    if (item.kind === "phone" && phoneMenuOpen()) return;
    diagnostic("recognized " + item.kind);
    pending = { item: item, x: event.clientX, y: event.clientY, time: Date.now(), previousMenus: Array.from(document.querySelectorAll('ul, [role="menu"], [role="listbox"]')).filter(function (menu) { return menu.getClientRects().length > 0; }) };
    timer = setTimeout(findMenu, 50);
  }, true);
  document.addEventListener("scroll", function () { if (panel) close(); }, true);
  document.addEventListener("keydown", function (event) { if (event.key === "Escape") close(); }, true);
  new MutationObserver(function (changes) {
    if (anchor && (!anchor.isConnected || !anchor.getClientRects().length || window.__whatrustLocked || document.documentElement.getAttribute("data-wr-privacy") === "on")) close();
    if (changes.some(function (change) { return change.attributeName === "data-wr-privacy"; })) syncHighlights();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "style", "data-wr-privacy"] });
  window.__wrMessageActionsPrefs = function (on) { enabled = !!on; if (!enabled) close(); syncHighlights(); };
  window.__wrMessageActionsLockChanged = function () { if (window.__whatrustLocked) close(); syncHighlights(); };
})();
