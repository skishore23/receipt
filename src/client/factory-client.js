// ============================================================================
// Factory client — shared front-end module for all Receipt views
// Self-initializes based on DOM markers:
//   [data-factory-chat]   → chat composer, scroll, prompt-fill
//   [data-receipt-browser] → receipt row expand/collapse
// ============================================================================

(function () {
  "use strict";

  var DEFAULT_COMMANDS = [];

  var parseCommands = function (node) {
    if (!node) return DEFAULT_COMMANDS;
    var raw = node.getAttribute("data-composer-commands");
    if (!raw) return DEFAULT_COMMANDS;
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : DEFAULT_COMMANDS;
    } catch (_err) {
      return DEFAULT_COMMANDS;
    }
  };

  var escapeHtml = function (value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  // ── Chat surface ──────────────────────────────────────────────────────────

  function initChat() {
    var shouldStickToBottom = true;
    var isComposing = false;
    var activeCommandIndex = 0;

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

    var composerCompletions = function () {
      var node = document.getElementById("factory-composer-completions");
      return node instanceof HTMLElement ? node : null;
    };

    var composerCommands = function () {
      var form = composerForm();
      return parseCommands(form);
    };

    var getSlashContext = function (value, caret) {
      var safeCaret = Math.max(0, Math.min(caret, value.length));
      var start = value.lastIndexOf("/", safeCaret - 1);
      if (start < 0) return null;
      var before = value.slice(0, start);
      if (before && !/\s$/.test(before)) return null;
      var tokenEnd = value.indexOf(" ", start + 1);
      var end = tokenEnd === -1 ? value.length : tokenEnd;
      if (safeCaret < start + 1 || safeCaret > end) return null;
      return {
        before: before,
        after: value.slice(end),
        query: value.slice(start + 1, safeCaret),
      };
    };

    var filterCommands = function (query) {
      var normalized = query.trim().toLowerCase();
      var commands = composerCommands();
      if (!normalized) return commands;
      return commands.filter(function (command) {
        return [command.name, command.label, command.usage, command.description].concat(command.aliases || []).join(" ").toLowerCase().indexOf(normalized) >= 0;
      });
    };

    var setExpanded = function (expanded) {
      var input = chatInput();
      if (input) input.setAttribute("aria-expanded", expanded ? "true" : "false");
      var popup = composerCompletions();
      if (popup) popup.classList.toggle("hidden", !expanded);
    };

    var renderCommands = function (query, selectedIndex) {
      var popup = composerCompletions();
      if (!popup) return [];
      var matches = filterCommands(query);
      activeCommandIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, matches.length - 1)));
      if (!matches.length) {
        popup.innerHTML = '<div class="px-3 py-2 text-xs text-muted-foreground">No matching commands.</div>';
        setExpanded(true);
        return matches;
      }
      popup.innerHTML = matches.map(function (command, index) {
        var active = index === activeCommandIndex;
        return '<button type="button" role="option" aria-selected="' + (active ? 'true' : 'false') + '" data-command-index="' + index + '" class="flex w-full items-start gap-3 px-3 py-2 text-left transition ' + (active ? 'bg-primary/10 text-foreground' : 'hover:bg-muted text-foreground') + '">' +
          '<span class="min-w-0 flex-1">' +
          '<span class="block text-sm font-medium">' + escapeHtml(command.label) + '</span>' +
          '<span class="block text-xs text-muted-foreground">' + escapeHtml(command.description) + '</span>' +
          '</span>' +
          '<span class="shrink-0 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">' + escapeHtml(command.usage) + '</span>' +
        '</button>';
      }).join("");
      setExpanded(true);
      return matches;
    };

    var insertCommand = function (command) {
      var input = chatInput();
      if (!input) return;
      var context = getSlashContext(input.value, input.selectionStart || 0);
      if (!context) return;
      var replacement = "/" + command.name + " ";
      input.value = context.before + replacement + context.after;
      var caret = (context.before + replacement).length;
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      setExpanded(false);
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

    var input = chatInput();
    if (input) {
      input.addEventListener("input", autoResizeInput, { passive: true });
      input.addEventListener("compositionstart", function () { isComposing = true; });
      input.addEventListener("compositionend", function () { isComposing = false; refreshAutocomplete(); });
      input.addEventListener("click", function () { refreshAutocomplete(); });
      input.addEventListener("keyup", function () { refreshAutocomplete(); });
      input.addEventListener("keydown", function (event) {
        if (isComposing) return;
        var popup = composerCompletions();
        var matches = filterCommands((getSlashContext(input.value, input.selectionStart || 0) || { query: "" }).query);
        if (popup && !popup.classList.contains("hidden") && matches.length) {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            activeCommandIndex = (activeCommandIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
            renderCommands((getSlashContext(input.value, input.selectionStart || 0) || { query: "" }).query, activeCommandIndex);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            insertCommand(matches[activeCommandIndex] || matches[0]);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setExpanded(false);
            return;
          }
        }
        if (!event || !(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
        event.preventDefault();
        var form = composerForm();
        if (form) form.requestSubmit();
      });
      autoResizeInput();

      var refreshAutocomplete = function () {
        var context = getSlashContext(input.value, input.selectionStart || 0);
        if (!context) {
          setExpanded(false);
          return;
        }
        renderCommands(context.query, 0);
      };

      input.addEventListener("input", function () {
        refreshAutocomplete();
      });
      input.addEventListener("blur", function () {
        window.setTimeout(function () { setExpanded(false); }, 100);
      });
      input.addEventListener("focus", refreshAutocomplete);

      var popup = composerCompletions();
      if (popup) {
        popup.addEventListener("mousedown", function (event) {
          var button = event.target instanceof Element ? event.target.closest("[data-command-index]") : null;
          if (!button) return;
          event.preventDefault();
          var index = Number(button.getAttribute("data-command-index") || "0");
          var matches = renderCommands((getSlashContext(input.value, input.selectionStart || 0) || { query: "" }).query, index);
          if (matches[index]) insertCommand(matches[index]);
        });
        popup.addEventListener("mousemove", function (event) {
          var button = event.target instanceof Element ? event.target.closest("[data-command-index]") : null;
          if (!button) return;
          var index = Number(button.getAttribute("data-command-index") || "0");
          activeCommandIndex = index;
          renderCommands((getSlashContext(input.value, input.selectionStart || 0) || { query: "" }).query, index);
        });
      }
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

    document.addEventListener("mousedown", function (event) {
      var form = composerForm();
      if (!form || !(event.target instanceof Node)) return;
      if (form.contains(event.target)) return;
      setExpanded(false);
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
    if (document.querySelector("[data-receipt-browser]")) initReceipt();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
