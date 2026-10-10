// Hoshlab public site — the one piece of behaviour: the Published page filter (?page=<handle>).
// Clicking a filter hides the other cards, updates aria-pressed and the URL; a page load with ?page=
// applies the same filter. Nothing else runs here: no keyboard chords, no theme toggle (review N15).
(function () {
  "use strict";
  var group = document.querySelector('[role="group"][aria-label="Filter by page"]');
  if (!group) return;
  var buttons = Array.prototype.slice.call(group.querySelectorAll("[data-filter]"));
  var cards = Array.prototype.slice.call(document.querySelectorAll(".post-card[data-page]"));
  var status = document.querySelector(".filter-status");
  var known = buttons.map(function (b) { return b.getAttribute("data-filter"); });

  function apply(handle, push) {
    if (known.indexOf(handle) < 0) handle = "";
    var shown = 0;
    cards.forEach(function (card) {
      var on = !handle || card.getAttribute("data-page") === handle;
      if (on) { card.removeAttribute("hidden"); shown++; } else { card.setAttribute("hidden", ""); }
    });
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-filter") === handle ? "true" : "false");
    });
    if (status) {
      status.textContent = handle ? "Showing " + shown + " for @" + handle + "." : "";
    }
    if (push && window.history && window.history.replaceState) {
      var url = window.location.pathname + (handle ? "?page=" + encodeURIComponent(handle) : "") + window.location.hash;
      window.history.replaceState(null, "", url);
    }
  }

  buttons.forEach(function (b) {
    b.addEventListener("click", function (event) {
      event.preventDefault();
      apply(b.getAttribute("data-filter") || "", true);
    });
  });

  var params = new URLSearchParams(window.location.search);
  var initial = params.get("page") || "";
  if (initial) apply(initial, false);
})();
