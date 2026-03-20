// ============================================================================
// Factory client — shared front-end module for all Receipt views
// Self-initializes based on DOM markers:
//   [data-factory-chat]    → chat composer, scroll, prompt-fill
//   [data-factory-control] → SPA nav, EventSource, island refresh
//   [data-receipt-browser]  → receipt row expand/collapse
// ============================================================================

(function () {
  "use strict";

  // ── Chat surface ──────────────────────────────────────────────────────────

  function initChat() {
    var shouldStickToBottom = true;

    var chatInput = function () {
      var input = document.getElementById("factory-prompt");
      return input instanceof HTMLTextAreaElement ? input : null;
    };

    var chatScroll = function () {
      var scroll = document.getElementById("factory-chat-scroll");
      return scroll instanceof HTMLElement ? scroll : null;
    };

    var composerForm = function () {
      var form = document.getElementById("factory-composer");
      return form instanceof HTMLFormElement ? form : null;
    };

    var composerStatus = function () {
      var node = document.getElementById("factory-composer-status");
      return node instanceof HTMLElement ? node : null;
    };

    var composerSubmit = function () {
      var button = document.getElementById("factory-composer-submit");
      return button instanceof HTMLButtonElement ? button : null;
    };

    var setComposerStatus = function (message) {
      var node = composerStatus();
      if (!node) return;
      if (!message) {
        node.textContent = "";
        node.classList.add("hidden");
        return;
      }
      node.textContent = message;
      node.classList.remove("hidden");
    };

    var setComposerBusy = function (busy) {
      var input = chatInput();
      var submit = composerSubmit();
      if (input) input.disabled = busy;
      if (submit) {
        submit.disabled = busy;
        submit.textContent = busy ? "Sending..." : "Send";
      }
    };

    var autoResizeInput = function () {
      var input = chatInput();
      if (!input) return;
      input.style.height = "0px";
      input.style.height = Math.min(Math.max(input.scrollHeight, 132), 320) + "px";
    };

    var isNearBottom = function () {
      var scroll = chatScroll();
      if (!scroll) return true;
      return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
    };

    var scrollChatToBottom = function (behavior) {
      var scroll = chatScroll();
      if (!scroll) return;
      if (typeof scroll.scrollTo === "function") {
        scroll.scrollTo({ top: scroll.scrollHeight, behavior: behavior || "auto" });
      } else {
        scroll.scrollTop = scroll.scrollHeight;
      }
      shouldStickToBottom = true;
    };

    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof HTMLElement)) return;
      var chip = target.closest("[data-prompt-fill]");
      if (!(chip instanceof HTMLElement)) return;
      var prompt = chip.getAttribute("data-prompt-fill");
      var input = chatInput();
      if (!input || !prompt) return;
      input.value = prompt;
      autoResizeInput();
      input.focus();
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
    });

    var input = chatInput();
    if (input) {
      input.addEventListener("input", autoResizeInput, { passive: true });
      input.addEventListener("keydown", function (event) {
        if (!event || !(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
        event.preventDefault();
        var form = composerForm();
        if (form) form.requestSubmit();
      });
      autoResizeInput();
    }

    var form = composerForm();
    if (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var activeForm = composerForm();
        if (!activeForm) return;
        var activeInput = chatInput();
        var payload = activeInput && activeInput.value ? activeInput.value.trim() : "";
        if (!payload) {
          setComposerStatus("Enter a chat message or slash command.");
          return;
        }
        var formData = new window.FormData(activeForm);
        setComposerBusy(true);
        setComposerStatus("");
        window.fetch(activeForm.action, {
          method: activeForm.method || "POST",
          body: formData,
          headers: { Accept: "application/json" },
          credentials: "same-origin",
        }).then(function (response) {
          var contentType = response.headers.get("content-type") || "";
          var bodyPromise = contentType.indexOf("application/json") >= 0
            ? response.json().catch(function () { return {}; })
            : response.text().catch(function () { return "Request failed."; }).then(function (t) { return { error: t }; });
          return bodyPromise.then(function (body) {
            if (!response.ok) {
              setComposerStatus(typeof body.error === "string" && body.error.trim() ? body.error : "Request failed.");
              return;
            }
            if (typeof body.location === "string" && body.location.trim()) {
              window.location.assign(body.location);
              return;
            }
            window.location.reload();
          });
        }).catch(function (error) {
          setComposerStatus(error instanceof Error ? error.message : "Request failed.");
        }).finally(function () {
          setComposerBusy(false);
        });
      });
    }

    var scroll = chatScroll();
    if (scroll) {
      scroll.addEventListener("scroll", function () {
        shouldStickToBottom = isNearBottom();
      }, { passive: true });
    }
    window.requestAnimationFrame(function () {
      scrollChatToBottom("auto");
    });

    document.addEventListener("htmx:afterSwap", function (event) {
      var target = event && event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.id !== "factory-chat") return;
      if (!shouldStickToBottom) return;
      window.requestAnimationFrame(function () {
        scrollChatToBottom("auto");
      });
    });
  }

  // ── Mission control ───────────────────────────────────────────────────────

  function initControl() {
    var controlSource = null;

    var getState = function () {
      return {
        objective: document.body.dataset.objective || "",
        panel: document.body.dataset.panel || "overview",
        focusKind: document.body.dataset.focusKind || "mission",
        focusId: document.body.dataset.focusId || "",
      };
    };

    var query = function () {
      var state = getState();
      var params = new URLSearchParams();
      if (state.objective) params.set("objective", state.objective);
      if (state.panel) params.set("panel", state.panel);
      if (state.focusKind) params.set("focusKind", state.focusKind);
      if (state.focusId) params.set("focusId", state.focusId);
      var built = params.toString();
      return built ? "?" + built : "";
    };

    var updateIslandUrls = function () {
      var q = query();
      var rail = document.getElementById("factory-mission-rail");
      var main = document.getElementById("factory-mission-main");
      var inspector = document.getElementById("factory-mission-inspector");
      if (rail) rail.setAttribute("hx-get", "/factory/control/island/rail" + q);
      if (main) main.setAttribute("hx-get", "/factory/control/island/main" + q);
      if (inspector) inspector.setAttribute("hx-get", "/factory/control/island/inspector" + q);
    };

    var refreshRail = function () {
      document.body.dispatchEvent(new CustomEvent("factory-rail-refresh", { bubbles: true }));
    };

    var refreshMain = function () {
      document.body.dispatchEvent(new CustomEvent("factory-main-refresh", { bubbles: true }));
    };

    var refreshInspector = function () {
      document.body.dispatchEvent(new CustomEvent("factory-inspector-refresh", { bubbles: true }));
    };

    var refreshLive = function () {
      document.body.dispatchEvent(new CustomEvent("factory-live-refresh", { bubbles: true }));
    };

    var hasLiveFocus = function () {
      var focusKind = document.body.dataset.focusKind || "mission";
      var focusId = document.body.dataset.focusId || "";
      return (focusKind === "task" || focusKind === "job") && Boolean(focusId);
    };

    var refreshFromStream = function () {
      refreshRail();
      refreshMain();
      refreshInspector();
      if (hasLiveFocus()) refreshLive();
    };

    var connectControl = function () {
      if (controlSource) controlSource.close();
      controlSource = new EventSource("/factory/control/events" + query());
      controlSource.addEventListener("factory-refresh", refreshFromStream);
      controlSource.addEventListener("receipt-refresh", refreshFromStream);
      controlSource.addEventListener("job-refresh", function () {
        refreshRail();
        refreshMain();
        refreshInspector();
        if (hasLiveFocus()) refreshLive();
      });
    };

    var applyUrl = function (url) {
      document.body.dataset.objective = url.searchParams.get("objective") || "";
      document.body.dataset.panel = url.searchParams.get("panel") || "overview";
      document.body.dataset.focusKind = url.searchParams.get("focusKind") || "mission";
      document.body.dataset.focusId = url.searchParams.get("focusId") || "";
      history.replaceState({}, "", url.pathname + url.search);
      updateIslandUrls();
      connectControl();
    };

    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof HTMLElement)) return;
      var link = target.closest("[data-factory-nav]");
      if (!(link instanceof HTMLAnchorElement)) return;
      event.preventDefault();
      var url = new URL(link.href, window.location.origin);
      applyUrl(url);
      var mode = link.getAttribute("data-factory-nav") || "";
      if (mode === "objective") {
        refreshRail();
        refreshMain();
        refreshInspector();
        return;
      }
      refreshMain();
      refreshInspector();
    });

    updateIslandUrls();
    connectControl();

    document.addEventListener("htmx:afterRequest", function (event) {
      var detail = event && event.detail;
      var elt = detail && detail.elt;
      if (!elt || !(elt instanceof HTMLElement) || detail.failed) return;
      if (elt.tagName === "FORM") {
        refreshMain();
        refreshInspector();
        if (hasLiveFocus()) refreshLive();
      }
    });

    window.addEventListener("beforeunload", function () {
      if (controlSource) controlSource.close();
    });
  }

  // ── Receipt browser ───────────────────────────────────────────────────────

  function initReceipt() {
    document.addEventListener("click", function (event) {
      var row = event.target.closest("[data-receipt-row]");
      if (!row) return;
      row.classList.toggle("receipt-expanded");
    });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  function boot() {
    if (document.querySelector("[data-factory-chat]")) initChat();
    if (document.querySelector("[data-factory-control]")) initControl();
    if (document.querySelector("[data-receipt-browser]")) initReceipt();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
