// Shared in-page driver for the reel templates (plain browser script, loaded after common.js from file://;
// design.md §10, plan D17, FEAT-201). engine/render/video.js injects window.__DRAFT__ (reel.scenes[]),
// window.__BRAND__, window.__TOKENS__ and, for the capture style, window.__FRAMES__ = [{ dataUrl, caption }]
// (one pre-captured 1080×1920 product screenshot per scene), then calls:
//
//   window.ready()          → Promise: fonts loaded and every frame image decoded
//   window.layout()         → the render-guard measurement over EVERY scene shown in full (overflow, runs,
//                             minTextU, minContrast, canvas) — common.js's layout() run once per scene and merged
//   window.setProgress(t)   → paints the frame at t ∈ [0, 1]; a pure function of t (no timers, no CSS
//                             animation), so video.js can step it at 30 fps and screenshot each frame.
//
// Timeline: scene i occupies [start_i, start_i + seconds_i) of the total (the sum of reel.scenes[].seconds).
//   kinetic — scene 0 is the hook card and is shown in full from frame 0 (frame 0 is the poster, so it must
//             carry the hook); every later scene types on grapheme by grapheme over the first TYPE_FRACTION of
//             its time, then holds. A painted caret (no glyph) sits after the typed text while typing.
//   capture — the scene's product frame fills the phone screen with a slow push-in (scale 1 → 1 + PUSH) across
//             the scene; the last CROSSFADE_SEC of a scene blend into the next frame. The caption bar shows the
//             scene text (static — a caption, not kinetic type).
(function () {
  "use strict";
  var H = window.HOSHLAB;
  var TYPE_FRACTION = 0.55;
  var PUSH = 0.06;
  var CROSSFADE_SEC = 0.4;

  function clamp01(t) {
    var n = Number(t);
    if (!(n >= 0)) return 0;
    return n > 1 ? 1 : n;
  }

  // Grapheme clusters (Intl.Segmenter in Chromium), so a Devanagari conjunct is never split mid-glyph.
  function clusters(text) {
    var s = String(text == null ? "" : text);
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      var out = [];
      var it = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s);
      for (var seg of it) out.push(seg.segment);
      return out;
    }
    return Array.from(s);
  }

  function timeline(scenes) {
    var starts = [];
    var total = 0;
    for (var i = 0; i < scenes.length; i++) {
      starts.push(total);
      total += Number(scenes[i].seconds) || 0;
    }
    return { starts: starts, total: total };
  }

  // sceneAt(t) → { index, local (0..1 within the scene), time }
  function sceneAt(scenes, tl, t) {
    var time = clamp01(t) * tl.total;
    var index = scenes.length - 1;
    for (var i = 0; i < scenes.length; i++) {
      var end = tl.starts[i] + (Number(scenes[i].seconds) || 0);
      if (time < end) {
        index = i;
        break;
      }
    }
    var seconds = Number(scenes[index].seconds) || 1;
    var local = (time - tl.starts[index]) / seconds;
    if (local < 0) local = 0;
    if (local > 1) local = 1;
    return { index: index, local: local, time: time };
  }

  // Merges one common.js layout() result per scene into the shape render.js's applyGuards reads.
  function mergeLayouts(results, extra) {
    var runs = [];
    var overflows = [];
    for (var i = 0; i < results.length; i++) {
      runs = runs.concat(results[i].runs);
      for (var j = 0; j < results[i].overflows.length; j++) overflows.push(Object.assign({ scene: i }, results[i].overflows[j]));
    }
    var sizes = runs.map(function (r) { return r.sizeU; });
    var contrasts = runs.map(function (r) { return r.contrast; });
    return Object.assign(
      {
        variant: results.length ? results[0].variant : null,
        palette: results.length ? results[0].palette : null,
        overflow: overflows.length > 0,
        overflows: overflows,
        runs: runs,
        minTextU: sizes.length ? Math.min.apply(null, sizes) : null,
        minContrast: contrasts.length ? Math.min.apply(null, contrasts) : null,
        canvas: results.length ? results[0].canvas : null,
        scenes: results.length,
      },
      extra || {},
    );
  }

  function setBar(el, t) {
    if (el) el.style.width = (clamp01(t) * 100).toFixed(3) + "%";
  }

  function setCounter(el, index, count) {
    if (el) el.textContent = index + 1 + " / " + count;
  }

  // initKinetic({ textEl, caretEl, counterEl, barEl }) — scenes from window.__DRAFT__.reel.scenes
  function initKinetic(opts) {
    var draft = window.__DRAFT__ || {};
    var scenes = (draft.reel && Array.isArray(draft.reel.scenes) ? draft.reel.scenes : []).map(function (s) {
      return { text: String((s && s.text) || ""), seconds: Number(s && s.seconds) || 0, clusters: clusters((s && s.text) || "") };
    });
    var tl = timeline(scenes);
    var textEl = opts.textEl;
    var caretEl = opts.caretEl;
    var longest = scenes.reduce(function (m, s) { return s.text.length > m.length ? s.text : m; }, "");
    var tier = H.pickVariant(longest);

    function paint(index, visible, caret) {
      var s = scenes[index];
      if (!s) return;
      textEl.setAttribute("data-variant", tier);
      textEl.setAttribute("data-scene", String(index));
      H.setText(textEl, s.clusters.slice(0, visible).join(""));
      if (caretEl) {
        textEl.appendChild(caretEl);
        caretEl.hidden = !caret;
      }
      setCounter(opts.counterEl, index, scenes.length);
    }

    function setProgress(t) {
      if (!scenes.length) return;
      var at = sceneAt(scenes, tl, t);
      var s = scenes[at.index];
      var n;
      var typing;
      if (at.index === 0) {
        n = s.clusters.length; // the hook card: full from frame 0 (the poster)
        typing = false;
      } else {
        var p = at.local / TYPE_FRACTION;
        if (p >= 1) {
          n = s.clusters.length;
          typing = false;
        } else {
          n = Math.floor(p * s.clusters.length);
          typing = true;
        }
      }
      paint(at.index, n, typing);
      setBar(opts.barEl, t);
    }

    function layout() {
      var results = [];
      for (var i = 0; i < scenes.length; i++) {
        paint(i, scenes[i].clusters.length, false);
        results.push(H.layout());
      }
      setProgress(0);
      return mergeLayouts(results, { style: "kinetic", durationSec: tl.total });
    }

    function ready() {
      return document.fonts.ready.then(function () { return true; });
    }

    window.setProgress = setProgress;
    window.layout = layout;
    window.ready = ready;
    window.__REEL__ = { style: "kinetic", scenes: scenes.length, durationSec: tl.total };
    setProgress(0);
  }

  // initCapture({ imgA, imgB, captionEl, counterEl, barEl }) — frames from window.__FRAMES__, timing from the scenes
  function initCapture(opts) {
    var draft = window.__DRAFT__ || {};
    var scenes = (draft.reel && Array.isArray(draft.reel.scenes) ? draft.reel.scenes : []).map(function (s) {
      return { text: String((s && s.text) || ""), seconds: Number(s && s.seconds) || 0 };
    });
    var frames = Array.isArray(window.__FRAMES__) ? window.__FRAMES__ : [];
    var tl = timeline(scenes);
    var captionEl = opts.captionEl;
    var imgA = opts.imgA;
    var imgB = opts.imgB;
    var tier = "B";

    function frameFor(index) {
      if (!frames.length) return null;
      return frames[Math.min(index, frames.length - 1)];
    }

    function paintCaption(index) {
      var s = scenes[index];
      if (!s) return;
      var f = frameFor(index);
      captionEl.setAttribute("data-variant", tier);
      captionEl.setAttribute("data-scene", String(index));
      H.setText(captionEl, (f && f.caption) || s.text);
      setCounter(opts.counterEl, index, scenes.length);
    }

    function setProgress(t) {
      if (!scenes.length) return;
      var at = sceneAt(scenes, tl, t);
      var cur = frameFor(at.index);
      var next = at.index + 1 < scenes.length ? frameFor(at.index + 1) : null;
      var seconds = scenes[at.index].seconds || 1;
      var remaining = (1 - at.local) * seconds;
      var blend = next && remaining < CROSSFADE_SEC ? 1 - remaining / CROSSFADE_SEC : 0;
      if (imgA) {
        if (cur && imgA.getAttribute("src") !== cur.dataUrl) imgA.setAttribute("src", cur.dataUrl);
        imgA.style.transform = "scale(" + (1 + PUSH * at.local).toFixed(4) + ")";
        imgA.style.opacity = "1";
      }
      if (imgB) {
        if (next && blend > 0) {
          if (imgB.getAttribute("src") !== next.dataUrl) imgB.setAttribute("src", next.dataUrl);
          imgB.style.transform = "scale(1)";
          imgB.style.opacity = blend.toFixed(4);
          imgB.hidden = false;
        } else {
          imgB.style.opacity = "0";
          imgB.hidden = true;
        }
      }
      paintCaption(at.index);
      setBar(opts.barEl, t);
    }

    function layout() {
      var results = [];
      for (var i = 0; i < scenes.length; i++) {
        paintCaption(i);
        results.push(H.layout());
      }
      setProgress(0);
      return mergeLayouts(results, { style: "capture", durationSec: tl.total, frames: frames.length });
    }

    // Decode every frame once so no screenshot catches a half-loaded image.
    function ready() {
      var decodes = frames.map(function (f) {
        var img = new Image();
        img.src = f.dataUrl;
        return img.decode();
      });
      return Promise.all(decodes.concat([document.fonts.ready])).then(function () { return true; });
    }

    window.setProgress = setProgress;
    window.layout = layout;
    window.ready = ready;
    window.__REEL__ = { style: "capture", scenes: scenes.length, durationSec: tl.total, frames: frames.length };
    setProgress(0);
  }

  window.HOSHLAB_REEL = { initKinetic: initKinetic, initCapture: initCapture, clusters: clusters, sceneAt: sceneAt, timeline: timeline, TYPE_FRACTION: TYPE_FRACTION, PUSH: PUSH, CROSSFADE_SEC: CROSSFADE_SEC };
})();
