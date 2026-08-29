const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

/* Fast coordinate-key parser, used everywhere a "x,y" string key needs to become numbers.
   Equivalent to `k.split(',').map(Number)` (used throughout this file for exactly that), but
   avoids the two intermediate array allocations that pattern creates per call (the array from
   split(), then a second array from map()) -- indexOf+slice+Number covers the same single-comma
   "x,y" format this file's keys always use, at a fraction of the allocation cost. This runs on
   every neighbor-counted cell, every drawn cell, and every selection/RLE/export cell -- i.e.
   potentially many times per frame/generation -- so trimming its per-call cost adds up. Pure
   drop-in replacement: identical [x, y] result for every key this file ever produces.
   parseKeyX/parseKeyY are also exposed for call sites that only need one coordinate, saving the
   array allocation entirely in those cases. */
function parseKey(k) {
  const comma = k.indexOf(',');
  return [Number(k.slice(0, comma)), Number(k.slice(comma + 1))];
}
function parseKeyX(k) { return Number(k.slice(0, k.indexOf(','))); }
function parseKeyY(k) { return Number(k.slice(k.indexOf(',') + 1)); }


// Prevent native browser touch scroll/pan/zoom gestures across the whole page. Without this,
// a touch-drag on the canvas (used for direct touch-to-draw on mobile) could be hijacked by
// the browser's default touch-scroll/zoom behavior instead of being read as drawing input.
try {
  document.documentElement.style.touchAction = 'none';
  document.body.style.touchAction = 'none';
  canvas.style.touchAction = 'none';
} catch (e) {}

// Native form controls (<button>, <input>, <select>, <textarea>) don't inherit font-family
// from their parent by default in most browsers -- they use the browser's own UA-stylesheet
// font instead. That's why real <button> elements throughout the game (the Ancestor Finder's
// "Find Ancestors" button, the intro's Mobile/PC choice buttons, various modal action buttons)
// could visibly render in a different font than the surrounding div-based UI even when the
// modal/panel's own fontFamily was set correctly -- the button just wasn't inheriting it.
// This one rule fixes every such control across the whole game at once.
try {
  const fontFixStyle = document.createElement('style');
  fontFixStyle.textContent = 'button, input, select, textarea { font-family: inherit; }';
  document.head.appendChild(fontFixStyle);
} catch (e) {}

// The main menu title uses a custom font ("TitleFront", loaded from /Titlefont.otf) that is
// normally declared via @font-face in the project's separate Style.css/Index.html files. Since
// this JS file has no guarantee those are correctly linked in every environment it runs in,
// the @font-face rule is injected directly here too -- if the external stylesheet already
// defines it, this is a harmless duplicate; if it doesn't (or the asset path differs), the
// title still gets its intended custom font instead of silently falling back to the generic
// system font stack, which is what "TitleFront" looks like when this rule is missing.
try {
  const titleFontFace = document.createElement('style');
  titleFontFace.textContent = `
    @font-face {
      font-family: "TitleFront";
      src: url("/Titlefont.otf") format("opentype");
      font-weight: 700;
      font-style: normal;
      font-display: swap;
    }
  `;
  document.head.appendChild(titleFontFace);
} catch (e) {}

// Animated tab favicon: cycles through 4 uploaded Websim assets
// (Favicon1.ico -> Favicon2.ico -> Favicon3.ico -> Favicon4.ico -> back to 1)
(function setAnimatedFavicon() {
  const frames = ['favicon1.ico', 'favicon2.ico', 'favicon3.ico', 'favicon4.ico'];
  const FRAME_INTERVAL_MS = 310; // adjust animation speed here

  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }

  let frameIndex = 0;
  link.href = frames[frameIndex];

  setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    link.href = frames[frameIndex];
  }, FRAME_INTERVAL_MS);
})();

let DPR = Math.max(1, window.devicePixelRatio || 1);

function resize() {
  canvas.width = Math.floor(innerWidth * DPR);
  canvas.height = Math.floor(innerHeight * DPR);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener('resize', () => { DPR = Math.max(1, window.devicePixelRatio || 1); resize(); });
resize();

/* World state: sparse set of alive cells stored as "x,y" strings */
const alive = new Set();
/* Per-cell birth timestamps (performance.now()) to compute ages; removed when cell dies.
   Each birth entry stores { t: timestamp, p: pausedAccumAtBirth } so ages exclude paused time. */
const birth = new Map();
/* Track paused durations so ages freeze while the sim is paused */
let pausedAccum = 0; // total ms spent paused before current pause
let pauseStart = null; // when current pause began (null if running)

// Reverse-time support: when enabled we step backward through a bounded history of saved generations.
// Rewinding restores previous alive/birth snapshots and decrements generation.
let reverseTime = false;
const HISTORY_MAX = 500; // maximum number of saved generations for rewind
const historyStack = []; // each entry: { alive: Array<string>, birth: Array<[key,rec]>, generation: number, pendingPlacement: Array<string>, invincible: Array<string> };

/* Seed with a small random scatter so simulation does something immediately */
(function seedRandom(density = 0.008) {
  const R = 60;
  const now = performance.now();
  for (let x = -R; x <= R; x++) {
    for (let y = -R; y <= R; y++) {
      if (Math.random() < density) {
        const k = `${x},${y}`;
        alive.add(k);
        // record birth time and pausedAccum at birth (initially pausedAccum is 0)
        birth.set(k, { t: now, p: pausedAccum });
      }
    }
  }
})();

/* STARTUP SEQUENCE: Lock input, blur canvas, auto-load Fader rule and auto-press J, then reset.
   Rewritten as a segment array so segments can be inserted/skipped individually.
   Space and click-on-overlay both advance exactly ONE segment at a time (via advanceStartupSegment()).
   One segment (the mobile/PC question) is unskippable and only advances when a choice button is tapped.
   finishStartupNow() is kept as a full-sequence "jump to end" helper, used only by Shift+Escape (return to menu). */
let startupActive = true;
let _startupOverlay = null;
let controlsLockedUntil = 0; // ms timestamp until which player controls are disabled

// Records the player's answer to the mobile/PC question ('mobile' | 'pc' | null until answered)
let playerPlatformChoice = null;

// Global function to immediately finish and clean up the startup overlay and reset state.
// Used as a hard "skip everything" (e.g. Shift+Escape back to main menu), NOT by normal Space/click.
function finishStartupNow() {
  if (!startupActive) return;
  startupActive = false;
  controlsLockedUntil = performance.now() + 1200;

  if (_startupOverlay) {
    try {
      _startupOverlay.style.transition = 'opacity 200ms ease';
      _startupOverlay.style.opacity = '0';
    } catch (e) {}
  }
  canvas.style.filter = '';

  setTimeout(() => {
    if (_startupOverlay && _startupOverlay.parentElement) _startupOverlay.remove();
    _startupOverlay = null;

    const FADE_STEPS = 6;
    const fadeTargetStates = Math.max(3, FADE_STEPS);
    for (const k of Array.from(alive)) {
      const st = 2 + Math.floor(Math.random() * Math.max(1, fadeTargetStates - 2));
      states.set(k, st);
      alive.delete(k);
      birth.delete(k);
    }
    for (const k of Array.from(pendingPlacement)) {
      const st = 2 + Math.floor(Math.random() * Math.max(1, fadeTargetStates - 2));
      states.set(k, st);
      pendingPlacement.delete(k);
      birth.delete(k);
    }
    cellStatesCount = fadeTargetStates;
    for (const k of Array.from(invincible)) {
      const st = 2 + Math.floor(Math.random() * Math.max(1, fadeTargetStates - 2));
      states.set(k, st);
      invincible.delete(k);
    }

    const FADE_DURATION_MS = 900;
    setTimeout(() => {
      alive.clear();
      birth.clear();
      states.clear();
      invincible.clear();
      pendingPlacement.clear();
      activatePendingOnly = false;
      pendingPlacementStart = 0;
      generation = 0;
      historyStack.length = 0;

      birthRules = new Set([3]);
      survivalRules = new Set([2,3]);
      cellStatesCount = 2;
      ltlMode = false;
      __ltlPrevBirthRules = null;
      __ltlPrevSurvivalRules = null;
      __ltlPrevCellStatesCount = null;

      try { deadLanding.clear(); landingMapVisible = false; } catch (e) {}

      // Bring up the virtual keyboard if the player told us they're on mobile, for keys that
      // have no touch equivalent (Escape, Ctrl/Alt combos, mode toggles, etc.). Placement
      // itself doesn't need it -- a direct touch on the canvas draws right where the finger is
      // (see the touchstart/touchmove handlers right after the real-mouse mousemove listener).
      try { if (playerPlatformChoice === 'mobile') showVirtualKeyboard(); } catch (e) {}

      flashTinyToast('Ready');
      flashTinyToast('Press U for controls', 3200);
    }, FADE_DURATION_MS);
  }, 220);
}

function startStartupSequence() {
  startupActive = true;
  playerPlatformChoice = null;
  canvas.style.filter = 'blur(6px)';

  const overlay = document.createElement('div');
  _startupOverlay = overlay;
  Object.assign(overlay.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '100vw',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20000,
    pointerEvents: 'auto',
    background: 'rgba(0,0,0,0.35)',
    color: '#fff',
    fontSize: '28px',
    fontFamily: 'Times New Roman, Times, serif',
    letterSpacing: '0.5px',
    textAlign: 'center',
    cursor: 'pointer'
  });
  const textEl = document.createElement('div');
  textEl.style.whiteSpace = 'pre';
  overlay.appendChild(textEl);

  // Container for the mobile/PC choice buttons (hidden/empty except during that segment)
  const choiceEl = document.createElement('div');
  Object.assign(choiceEl.style, {
    display: 'flex',
    gap: '16px',
    marginTop: '22px',
    cursor: 'default'
  });
  overlay.appendChild(choiceEl);

  const hintEl = document.createElement('div');
  hintEl.textContent = 'Spacebar or click to continue';
  Object.assign(hintEl.style, {
    color: 'rgba(200,200,200,0.7)',
    fontSize: '12px',
    position: 'absolute',
    bottom: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    pointerEvents: 'none'
  });
  overlay.appendChild(hintEl);

  document.body.appendChild(overlay);

  // set Fader rule immediately (B2/S2/G5)
  birthRules = new Set([2]);
  survivalRules = new Set([2]);
  cellStatesCount = 5; // Fader generational 5-state

  // auto-press J behaviour: spawn 15x15 noise centered
  (function autoJSpawn() {
    const center = screenToWorld(window.innerWidth/2, window.innerHeight/2);
    const now = performance.now();
    const half = 7;
    for (let dx = -half; dx <= half; dx++) {
      for (let dy = -half; dy <= half; dy++) {
        if (Math.random() < 0.5) {
          const x = center.wx + dx;
          const y = center.wy + dy;
          const k = `${x},${y}`;
          if (!alive.has(k)) {
            alive.add(k);
            birth.set(k, { t: now, p: pausedAccum });
          }
        }
      }
    }
  })();

  // ---- Segment definitions ----
  // Each segment is { text, durationMs, skippable, onEnter?, isQuestion? }
  // Every segment types its text out with the same typewriter effect for visual consistency
  // (including the question, which types its prompt before revealing the two choice buttons).
  const PHASE_MS = 2000;
  const LEAD_MS = 1000;

  const segments = [
    { text: '...', durationMs: LEAD_MS, skippable: true },
    { text: 'Welcome to the Game of Life!', durationMs: PHASE_MS, skippable: true },
    { text: 'In this game, you just mess around with cells and watch', durationMs: PHASE_MS, skippable: true },
    { text: 'Now let me ask you a question', durationMs: PHASE_MS, skippable: true },
    {
      text: 'Are you on mobile or on PC?',
      durationMs: PHASE_MS,
      skippable: false, // the question itself cannot be skipped with Space/click
      isQuestion: true,
      onEnter: (advance) => {
        choiceEl.innerHTML = '';
        // Type the question out the same way every other segment types its text, then
        // reveal the two choice buttons once typing finishes.
        typeOut('Are you on mobile or on PC?', PHASE_MS, () => {
          function makeChoiceBtn(label, value) {
            const btn = document.createElement('button');
            btn.type = 'button'; // prevent any implicit form-submit behavior
            btn.textContent = label;
            Object.assign(btn.style, {
              fontSize: '18px',
              padding: '12px 28px',
              borderRadius: '10px',
              border: '2px solid rgba(255,255,255,0.8)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              cursor: 'pointer',
              fontFamily: 'inherit',
              pointerEvents: 'auto',
              touchAction: 'manipulation'
            });
            btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.2)'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.08)'; });

            let alreadyAnswered = false;
            function choose(ev) {
              if (ev) { ev.preventDefault(); ev.stopPropagation(); }
              if (alreadyAnswered) return; // guard against a duplicate click+touchend firing twice
              alreadyAnswered = true;
              playerPlatformChoice = value;
              choiceEl.innerHTML = '';
              advance();
            }
            btn.addEventListener('click', choose);
            btn.addEventListener('touchend', choose);
            return btn;
          }

          choiceEl.appendChild(makeChoiceBtn('Mobile', 'mobile'));
          choiceEl.appendChild(makeChoiceBtn('PC', 'pc'));
        });
      }
    },
    {
      text: null,
      durationMs: PHASE_MS,
      skippable: true,
      onEnter: () => {
        choiceEl.innerHTML = '';
        const label = playerPlatformChoice === 'mobile' ? 'Mobile' : 'PC';
        typeOut(`I see, you're on ${label}`, PHASE_MS, () => scheduleAutoAdvance(PHASE_MS));
      }
    },
    { text: 'Now go do whatever', durationMs: PHASE_MS, skippable: true }
  ];

  let segIndex = -1;
  let autoAdvanceTimer = null;
  let typingIntervalId = null;

  function clearTimers() {
    if (autoAdvanceTimer) { clearTimeout(autoAdvanceTimer); autoAdvanceTimer = null; }
    if (typingIntervalId) { clearInterval(typingIntervalId); typingIntervalId = null; }
  }

  function scheduleAutoAdvance(ms) {
    clearTimers();
    autoAdvanceTimer = setTimeout(() => { advanceStartupSegment(); }, ms + 500);
  }

  // Typing helper: types text into textEl over durationMs, then calls done().
  function typeOut(text, durationMs, done) {
    textEl.textContent = '';
    const perChar = Math.max(5, Math.floor(durationMs / Math.max(1, text.length)));
    let i = 0;
    typingIntervalId = setInterval(() => {
      i++;
      textEl.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(typingIntervalId);
        typingIntervalId = null;
        if (done) done();
      }
    }, perChar);
  }

  function enterSegment(idx) {
    clearTimers();
    const seg = segments[idx];
    if (!seg) { endStartupSequence(); return; }

    if (seg.isQuestion) {
      choiceEl.innerHTML = '';
      // The button's own callback advances directly by index (bypassing the
      // skip-guard in advanceStartupSegment, since answering isn't a "skip" --
      // it's the one and only way this segment is allowed to end).
      seg.onEnter(() => {
        segIndex++;
        if (segIndex >= segments.length) {
          endStartupSequence();
        } else {
          enterSegment(segIndex);
        }
      });
      return; // no auto-advance, no typing -- waits for button click
    }

    if (seg.onEnter) {
      choiceEl.innerHTML = '';
      seg.onEnter();
      return; // segment's onEnter is responsible for its own typing/auto-advance
    }

    choiceEl.innerHTML = '';
    typeOut(seg.text, seg.durationMs, () => scheduleAutoAdvance(seg.durationMs));
  }

  // Advances exactly one segment. Called by Space, by click, or by auto-advance timers.
  // No-ops while the current segment is the unskippable question (it advances only via its buttons).
  function advanceStartupSegment() {
    if (!startupActive) return;
    const current = segments[segIndex];
    if (current && current.isQuestion) return; // question can't be skipped
    segIndex++;
    if (segIndex >= segments.length) {
      endStartupSequence();
    } else {
      enterSegment(segIndex);
    }
  }
  // expose for the keydown handler / click handler to call
  window.advanceStartupSegment = advanceStartupSegment;

  function endStartupSequence() {
    clearTimers();
    if (_startupOverlay) {
      _startupOverlay.style.transition = 'opacity 360ms ease';
      _startupOverlay.style.opacity = '0';
    }
    canvas.style.filter = '';

    const FADE_STEPS = 6;
    const fadeTargetStates = Math.max(3, FADE_STEPS);
    for (const k of Array.from(alive)) {
      const st = 2 + Math.floor(Math.random() * Math.max(1, fadeTargetStates - 2));
      states.set(k, st);
      alive.delete(k);
      birth.delete(k);
    }
    for (const k of Array.from(pendingPlacement)) {
      const st = 2 + Math.floor(Math.random() * Math.max(1, fadeTargetStates - 2));
      states.set(k, st);
      pendingPlacement.delete(k);
      birth.delete(k);
    }
    for (const k of Array.from(invincible)) {
      const st = 2 + Math.floor(Math.random() * Math.max(1, fadeTargetStates - 2));
      states.set(k, st);
      invincible.delete(k);
    }
    cellStatesCount = fadeTargetStates;

    const FADE_DURATION_MS = 900;
    setTimeout(() => {
      if (_startupOverlay && _startupOverlay.parentElement) _startupOverlay.remove();
      _startupOverlay = null;

      alive.clear();
      birth.clear();
      states.clear();
      invincible.clear();
      pendingPlacement.clear();
      activatePendingOnly = false;
      pendingPlacementStart = 0;
      generation = 0;
      historyStack.length = 0;

      birthRules = new Set([3]);
      survivalRules = new Set([2,3]);
      cellStatesCount = 2;

      controlsLockedUntil = performance.now() + 1200;
      startupActive = false;

      try { deadLanding.clear(); landingMapVisible = false; } catch (e) {}

      // Bring up the virtual keyboard if the player told us they're on mobile, for keys that
      // have no touch equivalent (Escape, Ctrl/Alt combos, mode toggles, etc.). Placement
      // itself doesn't need it -- a direct touch on the canvas draws right where the finger is
      // (see the touchstart/touchmove handlers right after the real-mouse mousemove listener).
      try { if (playerPlatformChoice === 'mobile') showVirtualKeyboard(); } catch (e) {}

      flashTinyToast('Ready');
      flashTinyToast('Press U for controls', 3200);
      flashTopBannerToast('Need help? Just do Alt + D for important instructions');
    }, FADE_DURATION_MS);
  }

  // Click anywhere on the overlay advances one segment (same rule as Space: no-op on the
  // question). Guarded to only fire when the overlay ITSELF is the click target (not a
  // bubbled click from a child like the choice buttons) -- belt-and-suspenders alongside
  // stopPropagation() on the buttons themselves, since some mobile browsers fire an extra
  // synthetic click on touch that can behave unpredictably with bubbling.
  overlay.addEventListener('click', (ev) => {
    if (ev.target !== overlay) return;
    advanceStartupSegment();
  });

  // Kick off the first segment.
  advanceStartupSegment();
}


/* View parameters */
const DEFAULT_STEP_INTERVAL = 120;
let cellSize = 12; // pixels per cell at zoom=1
let offsetX = 0; // world coordinate at canvas center (float)
let offsetY = 0;
let running = true;
let lastStep = 0;
let stepInterval = DEFAULT_STEP_INTERVAL; // ms per generation
let generation = 0; // counts completed generations (increments each tick)
// superStepMultiplier: when >1, stepLife will be invoked repeatedly per animation frame.
// Ctrl+R toggles this multiplier (super-speed mode). Default 1 == normal single-step behavior.
let superStepMultiplier = 1;

// FPS overlay state (toggle with Tab)
let fpsVisible = false;
let __fpsLast = performance.now();
let __fpsFrames = 0;
let __fpsValue = 0;

/* Rules: arrays of allowed neighbor counts for birth and survival (default B3/S23)
   and optional generational state count (cells take values 0..(cellStatesCount-1)).
   If cellStatesCount === 2: classic binary life (0 dead, 1 alive). */
let birthRules = new Set([3]);
let survivalRules = new Set([2,3]);
let cellStatesCount = 2; // C in B#/S#(/C); default 2 -> binary life

/* ================= Larger-than-Life Mode (Alt+H) =================
   A toggleable alternate rule model: instead of the fixed 8-neighbor Moore neighborhood,
   births/survivals are decided by a neighbor count over a much larger (2*radius+1) square
   window, per an "R,C,S,B" rule string (e.g. the default below). Cells are still stored the
   same sparse "x,y" way; only the neighbor-counting math and the rule string format differ --
   see ltlStepLife() near stepLife() for the actual stepping algorithm. Entering LTL mode
   remembers whatever B/S rule was active so Alt+H can restore it on exit. Mutually exclusive
   with Hex Mode (the Hex Mode key-allowlist below blocks all Alt combos, including Alt+H, so
   the two can never be entered at the same time), and a dedicated key-block further down
   disables several controls that don't make sense under LTL's rule model (FastForward, the
   Ancestor Finder, Hex Mode, the B-key rule prompt, reverse-time rewind, rule presets, and
   Portal mode). */
let ltlMode = false;
let ltlRadius = 5;
let ltlSurvivalMin = 34, ltlSurvivalMax = 58;
let ltlBirthMin = 34, ltlBirthMax = 45;
let ltlNeighborhood = 'M'; // only Moore ("M", a square window) is currently implemented
// Whether the neighbor-count sum includes the cell's own state (an "inner totalistic" count) or
// excludes it (the ordinary "outer totalistic" count, same convention as classic Life's
// 8-neighbor rule). LTL rule strings in this app never carry an M token (see
// parseLTLRuleString()'s doc note -- Golly's own LTL rule strings don't use one either), so this
// is always false: every rule, including the default, runs center-excluded/outer-totalistic.
// Kept as a named flag (rather than hardcoding the exclusion inline in the stepper) so the
// stepper's math stays self-documenting and this could be revisited later without touching it.
let ltlIncludeCenter = false;
// LTL's own C (state count), used identically to classic mode's cellStatesCount/G: >=3 means
// a cell that fails survival fades through states 2..C-1 (immune to neighbor counts while
// fading, auto-advancing each generation) instead of dying outright, rolling to fully dead only
// once it passes state C-1. B/Ctrl+B (see the B-key branch further down) is how the player sets
// this while in LTL mode, the same way plain B's /G section does for classic mode.
let ltlCellStatesCount = 2;
const LTL_DEFAULT_RULE_STRING = 'R5,C0,S33-57,B34-45';
// Remembers the pre-LTL rule so Alt+H can restore it when LTL mode is turned back off.
let __ltlPrevBirthRules = null;
let __ltlPrevSurvivalRules = null;
let __ltlPrevCellStatesCount = null;

/* Returns the maximum possible neighbor count for a given radius/M combination -- the size of
   the (2*radius+1) square window, minus 1 if the center is excluded (M0/outer-totalistic).
   Used both to validate S/B ranges when parsing a rule string (their max can never legitimately
   exceed this) and to bound the B-key prompt's UI for LTL mode, so the player can't type a
   range the radius can't actually produce. */
function ltlMaxNeighborCount(radius, includeCenter) {
  const windowSize = (2 * radius + 1) * (2 * radius + 1);
  return includeCenter ? windowSize : windowSize - 1;
}

/* Parses an LTL rule string of comma-separated tokens: R<radius>, C<states>, S<min>-<max> or
   S<n>, and B<min>-<max> or B<n> (a single number for S or B is shorthand for min==max --
   requiring a min-max pair even for a single valid count was needless friction). Tokens may
   appear in any order.
   There is deliberately no M token. Golly's own LTL rule strings don't carry one (its
   documented HROT-style "R,C,S,B,N" notation has no M at all and is "always outer totalistic"),
   so this parser follows suit: the center cell is always EXCLUDED from the neighbor sum
   (outer-totalistic / what an M0 flag would mean if this parser still had one). An earlier
   version of this parser accepted an M token and defaulted to including the center for the
   Bugs rule specifically (Bugs is M1 in Golly) -- that's been removed for consistency with how
   Golly rule strings for this app are actually written, so this app's own default rule is
   plain R5,C0,S33-57,B34-45 with no M anywhere, and runs center-excluded like every other rule.
   S and B's max values are bounded by the radius: a (2*radius+1) square window can only ever
   contain so many neighbors (see ltlMaxNeighborCount()), so a max above that ceiling can never
   be satisfied and almost certainly indicates a rule meant for a different radius.
   C here is the TOTAL state count, identical to classic mode's /G convention: C0/C1/C2 all mean
   no fading (2 total states, binary alive/dead), C3 means 1 extra fading state beyond
   alive/dead, C4 means 2, and so on, up to the same 256 cap classic mode's /G uses.
   Returns a plain object on success, or null if the string doesn't parse into a usable rule. */
function parseLTLRuleString(str) {
  if (!str || typeof str !== 'string') return null;
  const tokens = str.split(',').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  let radius = null, states = null, sMin = null, sMax = null, bMin = null, bMax = null, neighborhood = 'M';
  for (const tok of tokens) {
    // Only the FIRST letter is the token type (R/C/S/B/N) -- everything after it is the value.
    // This matters for the "N" token specifically: its value is itself a letter (e.g. "NM"'s
    // value is "M"), so a greedy multi-letter match here would swallow both letters as the
    // token type and leave the value empty, silently failing to recognize N tokens.
    const m = tok.match(/^([A-Za-z])(.*)$/);
    if (!m) return null;
    const letter = m[1].toUpperCase();
    const rest = m[2];
    if (letter === 'R') {
      const n = parseInt(rest, 10);
      if (!Number.isFinite(n) || n < 1) return null;
      radius = n;
    } else if (letter === 'C') {
      // C is the TOTAL state count, same convention as classic mode's /G. Unlike G, C is
      // allowed to be entered as 0 or 1 -- both are accepted and preserved as-typed (not
      // silently bumped up to 2) since the stepper and renderer already treat anything below 3
      // as "no fading" identically; there's no reason to reject a player's literal C0 or C1 just
      // because 2 is the smallest value that's functionally meaningful. The upper bound (256,
      // matching G's own cap) IS enforced by rejecting the string outright, not by silently
      // clamping -- clamping would let a mistyped C1000 silently become "whatever C256 does"
      // instead of telling the player their value was out of range.
      const n = parseInt(rest, 10);
      if (!Number.isFinite(n) || n < 0 || n > 256) return null;
      states = n;
    } else if (letter === 'S') {
      // A bare number (no dash) is shorthand for min==max, e.g. "S40" means the same thing as
      // "S40-40" -- a single valid survival count rather than a range.
      const rm = rest.match(/^(\d+)-(\d+)$/);
      if (rm) {
        sMin = parseInt(rm[1], 10);
        sMax = parseInt(rm[2], 10);
      } else {
        const single = rest.match(/^(\d+)$/);
        if (!single) return null;
        sMin = sMax = parseInt(single[1], 10);
      }
    } else if (letter === 'B') {
      // Same bare-number shorthand as S above.
      const rm = rest.match(/^(\d+)-(\d+)$/);
      if (rm) {
        bMin = parseInt(rm[1], 10);
        bMax = parseInt(rm[2], 10);
      } else {
        const single = rest.match(/^(\d+)$/);
        if (!single) return null;
        bMin = bMax = parseInt(single[1], 10);
      }
    } else if (letter === 'N') {
      const nl = rest.trim().toUpperCase();
      if (nl) neighborhood = nl[0];
    } else {
      return null; // unrecognized token (including M -- no longer accepted, see doc note above)
    }
  }
  if (radius == null || sMin == null || sMax == null || bMin == null || bMax == null) return null;
  if (sMin > sMax || bMin > bMax) return null;
  // No separate flat radius cap here (there used to be a `radius > 60` rejection) -- it was
  // redundant with, and stricter than, the actual affordability limit: ltlStepLife() already
  // checks the live pattern's bounding box against LTL_MAX_GRID_CELLS every generation (a
  // ~2000x2000 dense-grid cap), which is what actually determines whether a given radius is
  // affordable to simulate, based on how much of the board is actually alive -- not the radius
  // alone. A big radius with a small/sparse live pattern (e.g. R100 with a modest glider) is
  // perfectly cheap to step; that flat cap rejected it anyway just for naming R100, well before
  // the real per-generation size check ever got a chance to look at the actual pattern.
  const maxCount = ltlMaxNeighborCount(radius, false); // always center-excluded -- see doc note above
  if (sMax > maxCount || bMax > maxCount) return null; // range exceeds what this radius can produce
  return {
    radius, states: states == null ? 0 : states,
    survivalMin: sMin, survivalMax: sMax,
    birthMin: bMin, birthMax: bMax,
    neighborhood, includeCenter: false
  };
}

/* Parses `str` and, on success, applies it to the ltl* globals (radius/survival/birth/
   neighborhood/includeCenter/cellStatesCount). C is the total state count, identical to classic
   mode's /G. Returns true if applied, false (globals left untouched) if it didn't parse. */
function applyLTLRuleString(str) {
  const parsed = parseLTLRuleString(str);
  if (!parsed) return false;
  ltlRadius = parsed.radius;
  ltlSurvivalMin = parsed.survivalMin;
  ltlSurvivalMax = parsed.survivalMax;
  ltlBirthMin = parsed.birthMin;
  ltlBirthMax = parsed.birthMax;
  ltlNeighborhood = parsed.neighborhood;
  ltlIncludeCenter = parsed.includeCenter;
  ltlCellStatesCount = parsed.states;
  return true;
}

/* Alt+H: toggles Larger-than-Life mode on/off. Entering it stashes the current B/S rule and
   applies LTL_DEFAULT_RULE_STRING; leaving it restores the stashed rule. */
function toggleLTLMode() {
  if (ltlMode) {
    ltlMode = false;
    birthRules = __ltlPrevBirthRules || new Set([3]);
    survivalRules = __ltlPrevSurvivalRules || new Set([2, 3]);
    cellStatesCount = __ltlPrevCellStatesCount != null ? __ltlPrevCellStatesCount : 2;
    __ltlPrevBirthRules = null;
    __ltlPrevSurvivalRules = null;
    __ltlPrevCellStatesCount = null;
    // Leaving LTL mode always returns to binary alive/dead -- purge any cells left mid-fade
    // under LTL's own C/fading (ltlCellStatesCount), same as classic Ctrl+B's reset behavior.
    for (const [k] of Array.from(states.entries())) {
      states.delete(k);
      alive.delete(k);
      birth.delete(k);
    }
    ltlCellStatesCount = 2;
    flashTinyToast('Larger-than-Life mode: OFF', 1600);
    return;
  }
  __ltlPrevBirthRules = birthRules;
  __ltlPrevSurvivalRules = survivalRules;
  __ltlPrevCellStatesCount = cellStatesCount;
  const ok = applyLTLRuleString(LTL_DEFAULT_RULE_STRING);
  if (!ok) {
    __ltlPrevBirthRules = null;
    __ltlPrevSurvivalRules = null;
    __ltlPrevCellStatesCount = null;
    flashTinyToast('Failed to start Larger-than-Life mode', 1800);
    return;
  }
  reverseTime = false; // LTL mode keeps no rewind history
  cellStatesCount = 2; // the underlying classic-mode field stays binary -- LTL uses its own
                        // separate ltlCellStatesCount (set by applyLTLRuleString() above) for
                        // its own C/fading, so the two never fight over the same counter
  ltlMode = true;
  flashTinyToast(`Larger-than-Life mode: ON (${LTL_DEFAULT_RULE_STRING}) — Alt+J to seed noise`, 2400);
}

/* Same pattern as blockedInHexMode(): call at the top of a feature that doesn't make sense
   under LTL's rule model. Returns true (and toasts) if it should be blocked. */
function blockedInLTLMode(featureLabel) {
  if (!ltlMode) return false;
  flashTinyToast(`${featureLabel} isn't available in Larger-than-Life mode. Press Alt+H to leave LTL mode.`, 2200);
  return true;
}

/* ================= Hex Mode (Ctrl+I) =================
   A toggleable alternate topology: square grid <-> hexagonal grid. Cells are still stored
   as sparse "x,y" keys (axial coordinates when hexMode is on), but neighbor counting uses a
   6-direction axial neighborhood instead of the usual 8-direction Moore neighborhood, and
   rendering draws pointy-top hexagon tiles (via an axial->pixel projection) instead of squares.
   Entering hex mode swaps the default rule to B2/S34 (a lively hex-life analog of Conway's
   B3/S23); leaving it restores B3/S23. Features that fundamentally assume an axis-aligned
   square grid (Rule Spots' rectangular regions, the Live Cluster convex-hull overlay which
   uses an 8-neighbor expansion kernel) are disabled while hex mode is active. */
let hexMode = false;
/* hexTransition drives the Ctrl+I animated swap between square and hex topology.
   Phases, in order:
     'pixelate'   - screen pixelates (blocky downsample look) and current cells fade out
     'swap'       - instantaneous: actually flips hexMode + rules + clears the board
     'unpixelate' - pixelation eases back to normal, revealing the new grid style
   direction: 'toHex' | 'toSquare' -- which way we're transitioning, for messaging/rules.
   All timing is driven off performance.now() timestamps rather than frame counts, so it
   stays smooth regardless of framerate. */
let hexTransition = null; // null when idle, else { phase, direction, startedAt, phaseStartedAt }
const HEX_TRANSITION_PIXELATE_MS = 550;   // fade-out + pixelate-in duration
const HEX_TRANSITION_HOLD_MS = 200;       // brief hold at max pixelation while board swaps
const HEX_TRANSITION_UNPIXELATE_MS = 550; // pixelate-out duration revealing new grid
const HEX_TRANSITION_MAX_PIXEL_SIZE = 26; // largest pixelation block size, in CSS px

const HEX_NEIGHBOR_OFFSETS = [ [1,0], [1,-1], [0,-1], [-1,0], [-1,1], [0,1] ]; // axial 6-neighborhood

// Axial (x,y) -> pixel center offset, pointy-top hexagons, in "cell units" (multiply by cellSize
// to get actual pixels). Standard axial-to-pixel formula for pointy-top layout:
//   px = size * (sqrt(3)*x + sqrt(3)/2*y)
//   py = size * (3/2*y)
// "size" here is the hex's center-to-corner radius; we derive it from cellSize so hex mode's
// tiles read as roughly the same on-screen scale as square mode's at the same zoom level.
const HEX_SQRT3 = Math.sqrt(3);
// Pointy-top hex tiling only has zero gaps when the circumradius equals the spacing unit used
// for colSpacing/rowSpacing below (both derived from cellSize) -- so radius must be a straight
// 1.0x of cellSize, not a fraction of it (a smaller factor is what caused visible gaps/black
// wedges between tiles).
const HEX_RADIUS_FACTOR = 1.0;
// Precompute the 6 unit-circle corner offsets once (pointy-top: first vertex straight up, 60deg
// apart) instead of calling Math.cos/Math.sin per vertex, per cell, every single frame -- this
// was one of the bigger avoidable costs in hex-mode rendering.
const HEX_UNIT_CORNERS = Array.from({ length: 6 }, (_, i) => {
  const angle = (Math.PI / 180) * (60 * i - 90);
  return [Math.cos(angle), Math.sin(angle)];
});
function hexAxialToPixel(x, y) {
  return {
    px: HEX_SQRT3 * x + (HEX_SQRT3 / 2) * y,
    py: 1.5 * y
  };
}

/* Rounds a fractional axial coordinate (ax, ay) to the integer axial coordinate of whichever
   hex actually CONTAINS that point. Simple per-component Math.floor() is wrong here: axial
   coordinate flooring corresponds to a rhombus/parallelogram tiling, not a hexagon tiling, so
   most of a given hex's own area floors to a DIFFERENT integer pair than its own -- this was
   the cause of clicks landing visibly off from the cursor (picking a nearby-but-wrong hex).
   The standard correct approach: convert to cube coordinates (x, y, z = -x-y), round each
   component independently, then fix up whichever component had the largest rounding error by
   deriving it from the other two (since cube coords must sum to zero). This guarantees the hex
   whose center is closest to the point is the one returned. */
function hexAxialRound(ax, ay) {
  const cx = ax, cz = ay, cy = -cx - cz; // axial -> cube (x + y + z == 0)
  let rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz);
  const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { x: rx, y: rz }; // cube -> axial
}

/* Pans the camera (offsetX/offsetY) so the view moves by a given SCREEN-space pixel delta
   (dsx, dsy), regardless of topology. In square mode this is trivial since offsetX/offsetY map
   directly to screen x/y with no cross-terms. In hex mode it is NOT trivial: the axial->pixel
   projection has a cross term (screen x depends on both axial x AND axial y -- see
   hexAxialToPixel above), so naively doing offsetY += dy/cellSize (as square mode does) also
   shifts the view horizontally, which is exactly why Up/Down felt diagonal. This solves the
   projection's partial derivatives for the (offsetX, offsetY) delta that produces PURELY the
   requested screen-space movement with no cross-axis drift. Derivation/verification: moving the
   camera by (dox, doy) shifts every point's screen position by
     d(sx) = -sqrt3*cellSize*dox - (sqrt3/2)*cellSize*doy
     d(sy) = -1.5*cellSize*doy
   Solving that system for (dox, doy) given a target (dsx, dsy) yields the formulas below. */
function panByScreenDelta(dsx, dsy) {
  if (hexMode) {
    // Solves for the (offsetX, offsetY) camera delta that reproduces the SAME on-screen
    // direction and magnitude as square mode's `offsetX += dsx/cellSize` convention, with zero
    // cross-axis drift. (Earlier version solved for "move rendered content by dsx,dsy" instead
    // of "move the camera by dsx,dsy" -- opposite sign relationship from square mode, which is
    // what caused movement to feel inverted.)
    const doy = (dsy / cellSize) / 1.5;
    const dox = (dsx / cellSize) / HEX_SQRT3 - doy / 2;
    offsetX += dox;
    offsetY += doy;
  } else {
    offsetX += dsx / cellSize;
    offsetY += dsy / cellSize;
  }
}

/* Shared guard for features that are fundamentally built around a square, 8-neighbor Moore
   grid and don't have a meaningful hex equivalent -- RLE import/export, the classic pattern
   preset library, rule presets tuned for Moore-neighbor dynamics, and the macrocell quadtree
   format (a quadtree is a square-subdivision structure with no hex analog). Rather than let
   these silently produce garbage under hex's 6-neighbor axial topology, block them at the
   point the player tries to invoke them and explain why. Returns true (and shows a toast) if
   the feature was blocked -- callers should bail out immediately when this returns true. */
function blockedInHexMode(featureLabel) {
  if (!hexMode) return false;
  flashTinyToast(`${featureLabel} isn't available in Hex Mode (built for the square grid). Press Ctrl+I to switch back.`, 2200);
  return true;
}

// Per-cell numeric state storage for generational rules (only non-zero states stored).
// state==1 => "alive" and participates as a neighbor; state>=2 => fading/ghost (ignored for neighbor counts)
// We keep alive Set for fast iteration of state==1 cells (backwards-compatible).
const states = new Map(); // key -> integer state (1..C-1)

// Rule Spots: player-placed rectangular regions with their own independent B/S rule string,
// overriding the global birthRules/survivalRules for any cell that falls inside them. Also
// carries its own genCount (from an optional /G section), overriding the global
// cellStatesCount for fading behavior within that region -- defaults to 2 (no fading) if /G is
// omitted. Placed with Ctrl+E. A default (freshly-placed) rule spot uses whatever the current
// global rule string is at the moment it's created, so it behaves exactly like the rest of the
// board until the player edits it. Later-placed spots take precedence where spots overlap
// (though overlap is normally prevented at placement time).
const ruleSpots = []; // each: { id, minx, miny, maxx, maxy, birthRules: Set, survivalRules: Set, genCount: number, ruleStr: string }
let __ruleSpotNextId = 1;

/* Return the rule spot (if any) whose rectangle contains world cell (x,y). Checked in reverse
   placement order so the most recently placed spot wins on overlaps. Returns null if the cell
   is not inside any rule spot, meaning the caller should fall back to the global rules. */
function getRuleSpotAt(x, y) {
  for (let i = ruleSpots.length - 1; i >= 0; i--) {
    const s = ruleSpots[i];
    if (x >= s.minx && x <= s.maxx && y >= s.miny && y <= s.maxy) return s;
  }
  return null;
}

// Rule Spot placement mode (Ctrl+E side panel): while true, X places a spot at the mouse
// instead of drawing, and draw() renders a live ghost-preview rectangle following the mouse
// sized by ruleSpotDraftWidth/Height, labeled with ruleSpotDraftRuleStr.
let ruleSpotPlacementMode = false;
let ruleSpotDraftWidth = 20;
let ruleSpotDraftHeight = 20;
let ruleSpotDraftRuleStr = 'B3/S23'; // updated to the live global rule string when the panel opens

/* ================= Live Cluster Highlight (Ctrl+V) =================
   A lightweight, always-on-canvas version of the Ctrl+F cluster scanner: no modal, just a
   small bottom-right sensitivity input and live highlight shapes drawn directly over the
   board. Uses the exact same grouping algorithm (spatial-bucketed union-find, same distance
   test) and the same convex-hull highlight rendering as the scanner, minus the per-cluster
   cell-count label. Recomputed on a short timer (not every animation frame) since the board
   only actually changes once per simulation step or on manual edits -- recalculating on every
   frame would be wasted work and a needless source of jank for large boards. */
let liveClusterOverlayEnabled = false;
let liveClusterSensitivity = 10; // same default/min/max as the Ctrl+F scanner: default 10, min 5, max 750
let __liveClusterCache = []; // last computed clusters: Array<Array<{x,y}>>
let __liveClusterLastComputeTime = 0;
const LIVE_CLUSTER_RECOMPUTE_INTERVAL_MS = 200; // throttle: recompute at most 5x/sec

function liveClusterUfInit(n) { const p = new Array(n); for (let i = 0; i < n; i++) p[i] = i; return p; }
function liveClusterUfFind(p, a) { if (p[a] === a) return a; p[a] = liveClusterUfFind(p, p[a]); return p[a]; }
function liveClusterUfUnion(p, a, b) { const ra = liveClusterUfFind(p, a), rb = liveClusterUfFind(p, b); if (ra === rb) return; p[rb] = ra; }

function liveClusterCollectCoords() {
  const coords = [];
  for (const k of alive) { const [x, y] = parseKey(k); coords.push({ x, y }); }
  for (const k of states.keys()) { const [x, y] = parseKey(k); coords.push({ x, y }); }
  return coords;
}

/* Identical grouping logic to the Ctrl+F scanner's computeClusters(): grid-bucket by the
   sensitivity radius, then union any two cells within that radius of each other. */
function liveClusterCompute(coords, sensitivity) {
  const s = Math.max(1, Math.floor(sensitivity));
  const buckets = new Map();
  function bucketKey(ix, iy) { return ix + ',' + iy; }
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    const bx = Math.floor(c.x / s);
    const by = Math.floor(c.y / s);
    const key = bucketKey(bx, by);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(i);
  }
  const p = liveClusterUfInit(coords.length);
  const offsets = [-1, 0, 1];
  for (const [key, list] of buckets.entries()) {
    const parts = parseKey(key);
    const bx = parts[0], by = parts[1];
    for (const di of list) {
      const a = coords[di];
      for (const ox of offsets) for (const oy of offsets) {
        const nk = bucketKey(bx + ox, by + oy);
        const neighborList = buckets.get(nk);
        if (!neighborList) continue;
        for (const dj of neighborList) {
          if (di >= dj) continue;
          const b = coords[dj];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          if ((dx * dx + dy * dy) <= (s * s)) liveClusterUfUnion(p, di, dj);
        }
      }
    }
  }
  const comps = new Map();
  for (let i = 0; i < coords.length; i++) {
    const r = liveClusterUfFind(p, i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(coords[i]);
  }
  return Array.from(comps.values());
}

/* Recomputes __liveClusterCache if enabled and enough time has passed since the last compute.
   Called from draw() every frame, but the throttle means the expensive union-find pass itself
   only actually runs a few times per second. */
function liveClusterMaybeRecompute(now) {
  if (!liveClusterOverlayEnabled) return;
  if (now - __liveClusterLastComputeTime < LIVE_CLUSTER_RECOMPUTE_INTERVAL_MS) return;
  __liveClusterLastComputeTime = now;
  const coords = liveClusterCollectCoords();
  if (coords.length === 0) { __liveClusterCache = []; return; }
  // Same soft safety cap philosophy as elsewhere in the file: an extremely large live board
  // recomputing full clustering many times a second could itself become a performance problem,
  // so skip recomputation (but keep showing the last good result) above a generous cap.
  if (coords.length > 200000) return;
  __liveClusterCache = liveClusterCompute(coords, liveClusterSensitivity);
}

function toggleLiveClusterOverlay() {
  liveClusterOverlayEnabled = !liveClusterOverlayEnabled;
  if (liveClusterOverlayEnabled) {
    __liveClusterLastComputeTime = 0; // force an immediate compute on the next draw()
    createLiveClusterSensitivityInput();
    flashTinyToast(`Live Cluster Highlight: ON (sensitivity ${liveClusterSensitivity})`);
  } else {
    __liveClusterCache = [];
    removeLiveClusterSensitivityInput();
    flashTinyToast('Live Cluster Highlight: OFF');
  }
}

/* Small bottom-right sensitivity input -- intentionally not a menu: just a bare number field
   with a tiny caption, no other controls, matching the "one small UI" request. */
function createLiveClusterSensitivityInput() {
  if (document.getElementById('live-cluster-sensitivity-box')) return;
  const box = document.createElement('div');
  box.id = 'live-cluster-sensitivity-box';
  Object.assign(box.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: 12500,
    background: '#111', color: '#fff', padding: '6px 8px', borderRadius: '8px',
    display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'Times New Roman, Times, serif'
  });

  const label = document.createElement('div');
  label.textContent = 'Sensitivity';
  Object.assign(label.style, { fontSize: '11px', color: 'rgba(255,255,255,0.7)' });
  box.appendChild(label);

  const input = document.createElement('input');
  input.type = 'number';
  input.min = '5';
  input.max = '750';
  input.value = String(liveClusterSensitivity);
  Object.assign(input.style, { width: '56px', boxSizing: 'border-box', padding: '4px', fontSize: '12px' });
  input.addEventListener('input', () => {
    const v = Math.floor(Number(input.value));
    if (Number.isFinite(v)) {
      liveClusterSensitivity = Math.max(5, Math.min(750, v));
      __liveClusterLastComputeTime = 0; // force a fresh recompute right away with the new value
    }
  });
  box.appendChild(input);

  document.body.appendChild(box);
}

function removeLiveClusterSensitivityInput() {
  const box = document.getElementById('live-cluster-sensitivity-box');
  if (box) box.remove();
}

/* ================= Cluster Tracking (Alt+A) =================
   A hidden variant of the Ctrl+V Live Cluster Highlight: Alt+A silently computes the same
   spatial-bucketed union-find clustering (fixed sensitivity of 5, not player-adjustable) but
   draws NO polygons and shows no sensitivity box -- it exists purely so the player can press X
   on a cluster to have the camera follow it. While a cluster is being followed, arrow-key
   panning is disabled (the camera is driven by the tracked cluster's own centroid instead) and
   only A, S (zoom in/out, centered on the followed cluster so zooming doesn't fight the
   follow), Z (stop following), and X (retarget: pick whatever cluster is now under the mouse
   and follow that one instead) remain active; every other key is blocked for the duration,
   mirroring the existing keyboardLocked/legacyMode restricted-key-set pattern elsewhere in
   this file. */
let clusterTrackModeActive = false;   // Alt+A toggle: silent clustering computation is running
let clusterTrackFollowing = false;    // true while the camera is actively locked onto a cluster
const CLUSTER_TRACK_SENSITIVITY = 5;  // fixed distance-grouping radius for tracking mode, not adjustable
let __clusterTrackCache = [];         // last computed clusters while tracking mode is on: Array<Array<{x,y}>>
let __clusterTrackLastComputeTime = 0;
const CLUSTER_TRACK_RECOMPUTE_INTERVAL_MS = 200; // same throttle cadence as the Ctrl+V overlay
// Identity of the followed cluster is carried across generations by its centroid: each
// recompute, whichever newly-computed cluster has the centroid closest to the previously
// followed one (within a generous search radius) is treated as "the same" cluster continuing
// to evolve, since cluster membership itself can change cell-to-cell every generation.
let __clusterTrackFollowedCentroid = null; // {x,y} of the cluster currently being followed
let __clusterTrackFollowedCells = null;    // last known Array<{x,y}> member cells of the followed cluster

function __clusterTrackCentroid(cells) {
  let sx = 0, sy = 0;
  for (const c of cells) { sx += c.x; sy += c.y; }
  return { x: sx / cells.length, y: sy / cells.length };
}

function __clusterTrackMaybeRecompute(now) {
  if (!clusterTrackModeActive) return;
  if (now - __clusterTrackLastComputeTime < CLUSTER_TRACK_RECOMPUTE_INTERVAL_MS) return;
  __clusterTrackLastComputeTime = now;
  const coords = liveClusterCollectCoords();
  if (coords.length === 0) {
    __clusterTrackCache = [];
    // Board is now completely empty -- if a cluster was being followed, it has unambiguously
    // vanished (nothing left to match against at all), so stop following rather than silently
    // leaving the camera frozen on a cluster that no longer exists.
    if (clusterTrackFollowing) stopClusterTracking('Tracked cluster lost (board is empty)');
    return;
  }
  if (coords.length > 200000) return; // same soft safety cap as the Ctrl+V overlay
  __clusterTrackCache = liveClusterCompute(coords, CLUSTER_TRACK_SENSITIVITY);

  // If a cluster is currently being followed, re-resolve which of the freshly computed
  // clusters is "the same one" by nearest centroid, and update the camera target + stored
  // identity. If the followed cluster has vanished entirely (died out, or drifted further
  // than any plausible single-step distance), following stops automatically.
  if (clusterTrackFollowing && __clusterTrackFollowedCentroid) {
    let best = null, bestDist = Infinity;
    for (const cl of __clusterTrackCache) {
      const c = __clusterTrackCentroid(cl);
      const dx = c.x - __clusterTrackFollowedCentroid.x;
      const dy = c.y - __clusterTrackFollowedCentroid.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = { cluster: cl, centroid: c }; }
    }
    // generous reacquire radius: a genuinely fast-moving/large cluster can shift several cells
    // between recomputes, but this still rejects matching against a totally unrelated cluster
    // elsewhere on the board.
    const REACQUIRE_RADIUS = 40;
    if (best && bestDist <= REACQUIRE_RADIUS * REACQUIRE_RADIUS) {
      __clusterTrackFollowedCentroid = best.centroid;
      __clusterTrackFollowedCells = best.cluster;
    } else {
      stopClusterTracking('Tracked cluster lost (died out or moved too far)');
    }
  }
}

function toggleClusterTrackMode() {
  clusterTrackModeActive = !clusterTrackModeActive;
  if (clusterTrackModeActive) {
    __clusterTrackLastComputeTime = 0; // force an immediate compute on the next frame
    flashTinyToast('Cluster Tracking: ON -- press X on a cluster to follow it', 2000);
  } else {
    if (clusterTrackFollowing) stopClusterTracking();
    __clusterTrackCache = [];
    flashTinyToast('Cluster Tracking: OFF');
  }
}

// Finds whichever computed cluster (if any) contains a cell at or adjacent to the given world
// coordinate, so pressing X near -- not just exactly on -- a cluster's cells picks it up.
function __clusterTrackFindAt(wx, wy) {
  for (const cl of __clusterTrackCache) {
    for (const c of cl) {
      if (Math.abs(c.x - wx) <= 1 && Math.abs(c.y - wy) <= 1) return cl;
    }
  }
  return null;
}

// Starts (or retargets) following whatever cluster is under the current mouse position.
function startClusterTrackingAtMouse() {
  if (!mousePos) {
    flashTinyToast('Move the mouse over a cluster first');
    return;
  }
  __clusterTrackMaybeRecompute(performance.now()); // ensure the cache is fresh before hit-testing
  const { wx, wy } = screenToWorld(mousePos.x, mousePos.y);
  const cluster = __clusterTrackFindAt(wx, wy);
  if (!cluster) {
    flashTinyToast('No cluster under the mouse');
    return;
  }
  clusterTrackFollowing = true;
  __clusterTrackFollowedCells = cluster;
  __clusterTrackFollowedCentroid = __clusterTrackCentroid(cluster);
  flashTinyToast(`Following cluster (${cluster.length} cells) -- A/S zoom, Z to stop`, 2000);
}

function stopClusterTracking(customMessage) {
  clusterTrackFollowing = false;
  __clusterTrackFollowedCentroid = null;
  __clusterTrackFollowedCells = null;
  flashTinyToast(customMessage || 'Stopped following cluster');
}


/* Interaction: pan with arrow keys; zoom with A and S ; Q toggle; X/Z for draw/erase */
/* panStep is adjustable via C (decrease), V (increase), D (reset) */
const DEFAULT_PAN_STEP = 30;
let panStep = DEFAULT_PAN_STEP;

/* track P/O key state for continuous draw/erase and O-key selection */
let pDown = false;
let oDown = false;
 // P-mode: cycles between 'regular', 'shift', and 'ctrl' (virtual modifier state)
 // 'regular' -> no virtual modifier, 'shift' -> emulate Shift, 'ctrl' -> emulate Ctrl
 let pMode = 'regular'; // values: 'regular' | 'shift' | 'ctrl'
// invincible (permanent) pixels: placed while holding Shift+X; they never participate in life,
// never get birth records/ages, don't count as neighbors and only removed by player erase.
let invDown = false;              // true while Shift+X is held
const invincible = new Set();     // keys "x,y" of invincible pixels

/* ============================================================================
   PORTALS  (Alt+N to enter placement mode)
   ----------------------------------------------------------------------------
   A portal piece lives ON a grid line (an edge between two adjacent cells),
   not on a cell itself. Pieces are stored keyed by their edge; an edge key
   canonically identifies the two cells it separates so both "sides" of a
   line resolve to the same piece. Touching portal pieces (sharing a cell on
   either side) are merged into one connected group via union-find, so
   drawing/erasing pieces of a bigger structure keeps everything that's still
   physically touching working as a single portal. Two groups can be linked
   together (Alt+N mode, C key); a spaceship (or any pattern) that would step
   across a linked portal's edge is instead treated, for neighbor-counting
   purposes, as adjacent to the matching edge of the linked group -- so it
   passes through intact instead of just dying at the boundary.
*/
let altNMode = false;             // true while the player is in portal-editing mode (Alt+N)
let portalDrawDown = false;       // true while X is held inside Alt+N mode (draw portal piece)
let portalStraightDown = false;   // true while Shift+X is held inside Alt+N mode (draw a straight portal line)
let portalStraightAnchor = null;  // {x,y,nx,ny} edge where the current Shift+X straight line started
let portalStraightLastKeys = null; // Set of edge keys placed by the in-progress straight line, so live re-previewing can erase+redraw as the mouse moves without leaving stray pieces behind
let portalEraseDown = false;      // true while Z is held inside Alt+N mode (erase portal piece)
let portalLinkFirst = null;       // group id chosen by the first C press, awaiting a second C press
let portalShowLinks = false;      // true while link lines are visible (V, only inside Alt+N mode)
const portalEdges = new Map();    // edgeKey -> { a: "x,y", b: "x,y", group: groupId }
const portalGroupOf = new Map();  // groupId -> parent groupId (union-find, path-compressed)
const portalLinks = new Map();    // groupId -> linked groupId (symmetric: both directions stored)
const portalCornerIndex = new Map(); // cornerKey ("x,y" on the grid-line lattice) -> Set of edgeKeys touching that corner
let _portalGroupSeq = 1;          // next fresh group id to hand out
// Cache of per-group-pair coordinate transforms, rebuilt whenever the portal layout or links
// change (see _portalTransformDirty below). Keyed by "rootA|rootB" (both directions stored).
const _portalTransformCache = new Map();
let _portalTransformDirty = true;

// Canonical edge key for the grid line between cell (x1,y1) and its neighbor (x2,y2).
// Always orders the two cell keys the same way regardless of which side the caller
// approached from, so both sides of a line resolve to the identical edge key.
function portalEdgeKey(x1, y1, x2, y2) {
  const ka = `${x1},${y1}`;
  const kb = `${x2},${y2}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

// The two grid-corner-lattice endpoints of the edge between cells (x1,y1) and (x2,y2). Two
// portal pieces are physically "touching" (should merge into one group) when they share one
// of these corner points -- NOT when they share a cell, which is a different and much more
// restrictive relationship (e.g. a vertical stack of edges all on the same grid line, one row
// apart, never shares a cell between neighbors but obviously forms one continuous wall).
function portalEdgeCorners(x1, y1, x2, y2) {
  if (y1 === y2) {
    // vertical edge, separating two cells side-by-side -- runs along the shared vertical grid
    // line at x = max(x1,x2), from y1 to y1+1
    const ex = Math.max(x1, x2);
    return [`${ex},${y1}`, `${ex},${y1 + 1}`];
  } else {
    // horizontal edge, separating two cells stacked vertically -- runs along the shared
    // horizontal grid line at y = max(y1,y2), from x1 to x1+1
    const ey = Math.max(y1, y2);
    return [`${x1},${ey}`, `${x1 + 1},${ey}`];
  }
}

// The 4 grid-line edges belonging to cell (x,y): right, left, bottom, top -- i.e. the edge
// shared with each of its 4 orthogonal neighbors. Portals are square-grid only (an "edge
// between two cells" isn't a meaningful concept in Hex Mode's 6-neighbor topology).
function portalCellEdges(x, y) {
  return [
    portalEdgeKey(x, y, x + 1, y),
    portalEdgeKey(x, y, x - 1, y),
    portalEdgeKey(x, y, x, y + 1),
    portalEdgeKey(x, y, x, y - 1)
  ];
}

// Union-find find-with-path-compression over portal groups.
function portalFindGroup(gid) {
  let root = gid;
  while (portalGroupOf.has(root) && portalGroupOf.get(root) !== root) root = portalGroupOf.get(root);
  let cur = gid;
  while (portalGroupOf.has(cur) && portalGroupOf.get(cur) !== root) {
    const next = portalGroupOf.get(cur);
    portalGroupOf.set(cur, root);
    cur = next;
  }
  return root;
}

// Merge two portal groups into one (used when a newly-drawn piece touches an existing one).
// Returns the surviving group id. If either group was linked to another group, that link is
// preserved and now belongs to the merged group.
function portalMergeGroups(gidA, gidB) {
  const rootA = portalFindGroup(gidA);
  const rootB = portalFindGroup(gidB);
  if (rootA === rootB) return rootA;
  portalGroupOf.set(rootB, rootA);
  const linkedTo = portalLinks.get(rootA) !== undefined ? portalLinks.get(rootA) : portalLinks.get(rootB);
  portalLinks.delete(rootA);
  portalLinks.delete(rootB);
  if (linkedTo !== undefined) {
    const otherRoot = portalFindGroup(linkedTo);
    portalLinks.set(rootA, otherRoot);
    portalLinks.set(otherRoot, rootA);
  }
  return rootA;
}

// Place a portal piece on the edge of cell (x,y) facing (nx,ny) (must be orthogonally
// adjacent). Merges into any touching group automatically.
function placePortalPiece(x, y, nx, ny) {
  if (hexMode) return; // square-grid feature only
  const edgeKey = portalEdgeKey(x, y, nx, ny);
  if (portalEdges.has(edgeKey)) return; // already a piece here

  const corners = portalEdgeCorners(x, y, nx, ny);
  const newPieceVertical = (y === ny); // true if this new edge separates left/right cells

  // start this piece as its own fresh group, then merge with any group already touching
  // either of this edge's two corner points (this is the correct "physically touching"
  // relationship -- edges one row/column apart along the same line share a corner, not a cell)
  let group = _portalGroupSeq++;
  portalGroupOf.set(group, group);

  // Detect (before merging) whether this new piece's orientation matches every existing piece
  // it's about to touch. A group's own redirect-mapping logic (_rebuildPortalTransforms /
  // mapDirection) assumes every edge in a group shares one consistent orientation -- it derives
  // a single set of faces ('left'/'right' for vertical, 'top'/'bottom' for horizontal) from just
  // the group's first edge and applies that same face set to every edge in the group. A group
  // that ends up mixing vertical and horizontal pieces (an accidental L/T-shaped corner, e.g.
  // from a stray extra click while drawing) has no orientation-consistency guard anywhere else
  // in the placement code, so the mismatch would otherwise go unnoticed until a pattern actually
  // crosses near the mismatched piece and the player has no way to know why. This only warns --
  // it does not block placement or alter any teleport math -- since a player may have a valid
  // reason to build an L-shaped portal front and mixed groups don't corrupt indices that already
  // have a same-orientation counterpart on the linked side.
  let orientationMismatch = false;
  for (const corner of corners) {
    const touchingEdges = portalCornerIndex.get(corner);
    if (!touchingEdges) continue;
    for (const otherEdgeKey of touchingEdges) {
      const otherPiece = portalEdges.get(otherEdgeKey);
      if (!otherPiece) continue;
      const otherVertical = portalEdgeOrientation(otherPiece) === 'vertical';
      if (otherVertical !== newPieceVertical) orientationMismatch = true;
      group = portalMergeGroups(group, otherPiece.group);
    }
  }

  portalEdges.set(edgeKey, { a: `${x},${y}`, b: `${nx},${ny}`, group, corners });
  for (const corner of corners) {
    if (!portalCornerIndex.has(corner)) portalCornerIndex.set(corner, new Set());
    portalCornerIndex.get(corner).add(edgeKey);
  }
  _markPortalTransformsDirty();

  if (orientationMismatch) {
    flashTinyToast('Portal bends here (mixes vertical/horizontal pieces) -- crossings near the bend may not redirect as expected. Consider a straight run instead.', 2600);
  }
}

// Erase the portal piece at the edge of cell (x,y) facing (nx,ny), if one exists. Handles the
// "severing a linked portal into pieces" rule: if removing this piece splits its group into
// multiple disconnected pieces, the link (if any) stays with the biggest resulting piece; on
// an exact tie it's a 50/50 coin flip.
function erasePortalPiece(x, y, nx, ny) {
  const edgeKey = portalEdgeKey(x, y, nx, ny);
  const piece = portalEdges.get(edgeKey);
  if (!piece) return;

  const oldRoot = portalFindGroup(piece.group);
  const linkedTo = portalLinks.get(oldRoot);
  portalEdges.delete(edgeKey);
  for (const corner of piece.corners) {
    const set = portalCornerIndex.get(corner);
    if (set) { set.delete(edgeKey); if (set.size === 0) portalCornerIndex.delete(corner); }
  }

  // Recompute connectivity for every remaining piece that was in this group, via a fresh
  // flood-fill over the remaining edges (touching = sharing one of the edge's two grid-corner
  // endpoints -- see portalEdgeCorners; this is what lets a stacked run of edges along the
  // same line count as one continuous piece even though consecutive edges share no cell).
  // This is simplest and correct even though it's O(group size) -- portal groups are small
  // hand-drawn structures, not board-scale.
  const remaining = [];
  for (const [ek, p] of portalEdges.entries()) {
    if (portalFindGroup(p.group) === oldRoot) remaining.push(ek);
  }

  // clear old group bookkeeping for this root; we'll rebuild fresh groups for the pieces
  for (const ek of remaining) portalGroupOf.delete(portalEdges.get(ek).group);
  portalGroupOf.delete(oldRoot);
  portalLinks.delete(oldRoot);
  if (linkedTo !== undefined) portalLinks.delete(linkedTo);

  // adjacency helper: do two edges touch (share a grid-corner endpoint)?
  function edgesTouch(ekA, ekB) {
    const pA = portalEdges.get(ekA), pB = portalEdges.get(ekB);
    return pA.corners[0] === pB.corners[0] || pA.corners[0] === pB.corners[1] ||
           pA.corners[1] === pB.corners[0] || pA.corners[1] === pB.corners[1];
  }

  const visited = new Set();
  const newComponents = []; // arrays of edge keys, tagged with a ._gid after group assignment
  for (const startEk of remaining) {
    if (visited.has(startEk)) continue;
    const comp = [startEk];
    visited.add(startEk);
    const stack = [startEk];
    while (stack.length) {
      const cur = stack.pop();
      for (const ek of remaining) {
        if (visited.has(ek)) continue;
        if (edgesTouch(cur, ek)) {
          visited.add(ek);
          comp.push(ek);
          stack.push(ek);
        }
      }
    }
    newComponents.push(comp);
  }

  // assign each surviving component a fresh group id
  let biggestComp = null;
  for (const comp of newComponents) {
    const newGid = _portalGroupSeq++;
    portalGroupOf.set(newGid, newGid);
    for (const ek of comp) portalEdges.get(ek).group = newGid;
    comp._gid = newGid;
    if (!biggestComp || comp.length > biggestComp.length) biggestComp = comp;
  }

  // decide which surviving component (if any) keeps the old link
  if (linkedTo !== undefined && newComponents.length > 0) {
    const tiedLargest = newComponents.filter(c => c.length === biggestComp.length);
    const winner = tiedLargest.length > 1
      ? tiedLargest[Math.floor(Math.random() * tiedLargest.length)]
      : biggestComp;
    const otherRoot = portalFindGroup(linkedTo);
    portalLinks.set(winner._gid, otherRoot);
    portalLinks.set(otherRoot, winner._gid);
  }
  _markPortalTransformsDirty();
}

// Link two portal groups together. If either was already linked to something else, that old
// link is replaced (the old partner becomes unlinked), per the "re-linking" rule.
function portalLinkGroups(gidA, gidB) {
  const rootA = portalFindGroup(gidA);
  const rootB = portalFindGroup(gidB);
  if (rootA === rootB) return false; // can't link a portal to itself

  const oldPartnerA = portalLinks.get(rootA);
  const oldPartnerB = portalLinks.get(rootB);
  if (oldPartnerA !== undefined) portalLinks.delete(oldPartnerA);
  if (oldPartnerB !== undefined) portalLinks.delete(oldPartnerB);
  portalLinks.delete(rootA);
  portalLinks.delete(rootB);

  portalLinks.set(rootA, rootB);
  portalLinks.set(rootB, rootA);
  _markPortalTransformsDirty();
  return true;
}

// Remove every portal piece, group, and link -- a full reset of all portal state. Used by
// Alt+G (portal-only wipe, available outside Portal mode) and folded into Ctrl+G's hard wipe
// (portals are exactly the kind of persistent board structure a hard wipe is meant to clear,
// same as invincible walls and Rule Spots). Returns the number of pieces that were removed, so
// callers can report it.
function clearAllPortals() {
  const count = portalEdges.size;
  portalEdges.clear();
  portalGroupOf.clear();
  portalLinks.clear();
  portalCornerIndex.clear();
  portalCellRedirect.clear();
  portalLinkFirst = null;
  _markPortalTransformsDirty();
  return count;
}

// ----------------------------------------------------------------------------------------
// Coordinate-transform based portal teleport.
//
// A single-edge "redirect any neighbor vote that touches the line" approach cannot carry a
// multi-cell pattern (a glider, a spaceship, anything wider than one cell) through intact:
// each cell of the pattern needs to land on a *consistent, position-preserving* spot on the
// other side, in every direction (including diagonals), not just have its own isolated
// neighbor-vote nudged towards "somewhere near the other portal". So instead each linked
// group-pair gets one full 2D affine transform: position-along-the-portal is preserved
// (portal A's 1st segment connects to portal B's 1st segment, in the same order the pieces
// were drawn along the line -- like two mirrors facing each other), and perpendicular
// distance from the line is preserved and flipped in direction of travel, so a pattern
// approaching portal A from the "outside" emerges from portal B also heading "outside".
//
// The transform is built once per (dirty) portal-layout change and cached, since it's the
// same computation for every cell near the seam every generation.

// Build the ordered list of {edgeKey, piece, midX, midY} for a group, sorted along the
// portal's own line direction (works for straight-line portals, which is the common/expected
// case; an L-shaped or branching portal still gets *a* consistent order, just not necessarily
// a visually obvious one).
// Face labels for a portal edge: a "vertical" edge (its two flanking cells differ in x, i.e.
// the grid line itself runs top-to-bottom) has a 'left' face (the flanking cell with the
// smaller x) and a 'right' face (larger x). A "horizontal" edge (flanking cells differ in y,
// grid line runs left-to-right) has a 'top' face (smaller y) and a 'bottom' face (larger y).
function portalEdgeOrientation(p) {
  const [ax, ay] = parseKey(p.a);
  const [bx, by] = parseKey(p.b);
  return ay === by ? 'vertical' : 'horizontal';
}

// The world cell sitting on the given face of edge p.
function portalFaceCell(p, face) {
  const [ax, ay] = parseKey(p.a);
  const [bx, by] = parseKey(p.b);
  if (face === 'left')   return ax < bx ? { x: ax, y: ay } : { x: bx, y: by };
  if (face === 'right')  return ax > bx ? { x: ax, y: ay } : { x: bx, y: by };
  if (face === 'top')    return ay < by ? { x: ax, y: ay } : { x: bx, y: by };
  /* bottom */           return ay > by ? { x: ax, y: ay } : { x: bx, y: by };
}

// Which face of edge p is world cell (cx,cy) sitting on? (cx,cy) must be one of the edge's two
// flanking cells.
function portalFaceOfCell(p, cx, cy) {
  const orient = portalEdgeOrientation(p);
  const [ax, ay] = parseKey(p.a);
  const [bx, by] = parseKey(p.b);
  if (orient === 'vertical') return cx < Math.max(ax, bx) ? 'left' : 'right';
  return cy < Math.max(ay, by) ? 'top' : 'bottom';
}

// The exit-face rule requested: entering a vertical portal's left/right face exits the linked
// vertical portal's right/left face (straight through, as expected for two parallel walls
// facing each other). Entering a horizontal portal's top/bottom exits the linked horizontal
// portal's bottom/top. Crossing between a vertical and a horizontal portal is a 90-degree turn:
// vertical-right <-> horizontal-bottom ("right turns into down, and down turns into right"),
// and vertical-left <-> horizontal-top ("left turns into up, and up turns into left").
const PORTAL_FACE_MAP = {
  'vertical->vertical':     { left: 'right', right: 'left' },
  'horizontal->horizontal': { top: 'bottom', bottom: 'top' },
  'vertical->horizontal':   { right: 'bottom', left: 'top' },
  'horizontal->vertical':   { bottom: 'right', top: 'left' },
};

// Build the ordered list of edges for a group, sorted along the portal's own line direction --
// used only to pair up edge #i of one portal with edge #i of the linked portal (proportionally
// scaled if the two portals have different lengths), so a portal spanning multiple pieces
// links up consistently along its length rather than every piece routing to just one spot.
function _portalGroupOrderedEdges(root) {
  const list = [];
  for (const [ek, p] of portalEdges.entries()) {
    if (portalFindGroup(p.group) !== root) continue;
    const [ax, ay] = parseKey(p.a);
    const [bx, by] = parseKey(p.b);
    list.push({ ek, p, midX: (ax + bx) / 2, midY: (ay + by) / 2, vertical: ay === by });
  }
  if (list.length === 0) return list;
  const sampleVertical = list[0].vertical;
  list.sort((a, b) => sampleVertical ? (a.midY - b.midY) : (a.midX - b.midX));
  return list;
}

// portalCellRedirect: keyed by "sx,sy->nx,ny" (the EXACT source cell AND its raw stepped-to
// neighbor cell, both required) -> "x,y" of the redirected exit cell. Keying on the pair, not
// just the destination, is essential: a cell sitting on one face of a portal has its own
// perfectly normal same-side neighbors (e.g. the cell directly above/below it, still on the
// same side of the line) which must NOT be redirected just because they also happen to be
// flanking cells of some portal edge. Only a step that goes FROM one face TO the opposite face
// of the very same edge is a genuine "crossing the seam" step and gets redirected; every other
// neighbor relationship among cells near the line is left completely alone, so cells that have
// already arrived on the far side see each other normally and don't accidentally reach back
// through the portal or interact with anything before they've actually arrived.
const portalCellRedirect = new Map();

function _rebuildPortalTransforms() {
  portalCellRedirect.clear();
  const seenPairs = new Set();
  for (const [rootA, rootB] of portalLinks.entries()) {
    const pairKey = rootA < rootB ? `${rootA}|${rootB}` : `${rootB}|${rootA}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const edgesA = _portalGroupOrderedEdges(rootA);
    const edgesB = _portalGroupOrderedEdges(rootB);
    if (edgesA.length === 0 || edgesB.length === 0) continue;
    const orientA = edgesA[0].vertical ? 'vertical' : 'horizontal';
    const orientB = edgesB[0].vertical ? 'vertical' : 'horizontal';

    function mapDirection(fromEdges, toEdges, fromOrient, toOrient) {
      const faceMap = PORTAL_FACE_MAP[`${fromOrient}->${toOrient}`];
      const faces = fromOrient === 'vertical' ? ['left', 'right'] : ['top', 'bottom'];
      const oppositeFace = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
      for (let i = 0; i < fromEdges.length; i++) {
        // 1:1 index mapping only -- no proportional squeeze/stretch. Entry index i on this
        // portal connects ONLY to the exact same index i on the linked portal. If the linked
        // portal doesn't have an edge at index i (it's shorter), this particular row/column
        // simply has no crossing there -- it does NOT get rounded onto some other row, which
        // would compress or smear the pattern's shape and tear it apart mid-crossing. Two
        // portals of different lengths still work, but only the overlapping stretch (indices
        // both portals share) actually connects; the mismatched remainder of the longer one
        // behaves like a normal wall/edge with no link at those positions.
        if (i >= toEdges.length) continue;
        const toIndex = i;
        for (const face of faces) {
          const sourceCell = portalFaceCell(fromEdges[i].p, face);
          // A cell touching this face can step "into the wall" three ways: straight across
          // (landing on the opposite face of THIS SAME edge), or diagonally across while also
          // shifting one step along the portal's own length (landing on the opposite face of
          // the NEXT or PREVIOUS edge in the group). All three genuinely cross the seam and
          // must redirect -- restricting to only the straight-across case leaves diagonal
          // approach votes un-redirected, which starves a multi-cell pattern's birth count on
          // the far side (diagonal corner-adjacency matters for shapes that approach the
          // portal at an angle, like a glider). Each diagonal variant also uses a strict 1:1
          // index correspondence (i+alongOffset on both sides), for the same reason as above.
          for (const alongOffset of [-1, 0, 1]) {
            const fromNeighborIdx = i + alongOffset;
            const toNeighborIdx = toIndex + alongOffset;
            if (fromNeighborIdx < 0 || fromNeighborIdx >= fromEdges.length) continue;
            if (toNeighborIdx < 0 || toNeighborIdx >= toEdges.length) continue;
            const rawNeighborCell = portalFaceCell(fromEdges[fromNeighborIdx].p, oppositeFace[face]);
            const exitCell = portalFaceCell(toEdges[toNeighborIdx].p, faceMap[face]);

            const key = `${sourceCell.x},${sourceCell.y}->${rawNeighborCell.x},${rawNeighborCell.y}`;
            portalCellRedirect.set(key, `${exitCell.x},${exitCell.y}`);
          }
        }
      }
    }
    mapDirection(edgesA, edgesB, orientA, orientB);
    mapDirection(edgesB, edgesA, orientB, orientA);
  }
  _portalTransformDirty = false;
}

function _ensurePortalTransforms() {
  if (_portalTransformDirty) _rebuildPortalTransforms();
}

// Mark the transform cache stale. Called from every place that adds/removes a portal piece or
// changes a link.
function _markPortalTransformsDirty() { _portalTransformDirty = true; }

// Given a live cell key and a Moore-neighborhood offset (dx,dy, either may be non-zero,
// including diagonals), resolve which world cell that neighbor vote should land on -- redirected
// through a linked portal's face-mapping rule ONLY if this exact (source, raw-neighbor) pair is
// a genuine straight-through step across a linked edge. This replaces the plain
// `${sx+dx},${sy+dy}` computation inside stepLife()'s neighbor-counting loop.
//
// EXACT pair match only, by design: both the source cell AND the raw neighbor cell must be the
// two flanking cells of the very same linked edge for a redirect to fire -- a cell must
// actually be touching the portal AND stepping straight across it, never merely landing near a
// portal-adjacent cell for unrelated reasons (e.g. a normal same-side neighbor check).
function resolveNeighborKey(sx, sy, dx, dy) {
  if (portalEdges.size === 0 || portalLinks.size === 0) return `${sx + dx},${sy + dy}`;
  _ensurePortalTransforms();
  if (portalCellRedirect.size === 0) return `${sx + dx},${sy + dy}`;
  const nx = sx + dx, ny = sy + dy;
  const mapped = portalCellRedirect.get(`${sx},${sy}->${nx},${ny}`);
  return mapped || `${nx},${ny}`;
}

// Find which grid-line edge (if any) the mouse is currently closest to, within the cell it's
// hovering, and place/erase a portal piece there. World-space fractional position within the
// hovered cell decides which of its 4 edges is nearest -- whichever axis the pointer sits
// closest to its 0/1 boundary on wins (e.g. near the left edge of the cell picks the "left"
// edge, near the top picks "top", etc).
function _portalEdgeUnderMouse() {
  if (!mousePos) return null;
  const cx = mousePos.x - innerWidth / 2;
  const cy = mousePos.y - innerHeight / 2;
  const fx = cx / cellSize + offsetX; // fractional world x
  const fy = cy / cellSize + offsetY; // fractional world y
  const x = Math.floor(fx), y = Math.floor(fy);
  const localX = fx - x, localY = fy - y; // both in [0,1) -- position within the cell
  // distance to each of the 4 edges of this cell
  const distLeft = localX, distRight = 1 - localX, distTop = localY, distBottom = 1 - localY;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  if (minDist === distLeft) return { x, y, nx: x - 1, ny: y };
  if (minDist === distRight) return { x, y, nx: x + 1, ny: y };
  if (minDist === distTop) return { x, y, nx: x, ny: y - 1 };
  return { x, y, nx: x, ny: y + 1 };
}

// Given a straight-line-portal anchor edge and the current hover edge, return the ordered
// list of edges (each {x,y,nx,ny}) that make up a straight run of portal pieces connecting
// them, for Shift+X's straight-portal draw. The line is locked to the anchor edge's own
// orientation (vertical or horizontal) -- the far endpoint's position along the OTHER axis is
// ignored, so dragging the mouse anywhere just extends/shortens the line along the anchor's
// axis, the same way a shift-constrained straight-line tool works in ordinary drawing apps.
// Given a straight-line-portal anchor edge and the current raw mouse world position, return
// the ordered list of edges (each {x,y,nx,ny}) that make up a straight run of portal pieces
// from the anchor out to wherever the mouse currently is along the anchor's own axis.
//
// The anchor edge's own orientation (vertical vs horizontal) already fixes which axis the
// line can extend along -- a vertical edge (separating left/right cells) can only stack more
// pieces by varying y, a horizontal edge only by varying x, so "which axis" isn't a free
// choice. What "locking in the initial direction" means here is: the endpoint is read
// straight from the mouse's own continuous world coordinate along that fixed axis (rounded to
// the nearest cell-line position), completely ignoring the mouse's position on the OTHER
// axis. This is what makes the line truly straight and jitter-free -- if instead the endpoint
// were re-derived every frame from "which of the 4 edges of the currently-hovered cell is
// nearest" (as a naive per-frame edge-snap would), any small perpendicular wobble in the
// mouse's path could nudge that snap logic onto a different, unintended edge and make the
// line's far end hop around inconsistently. Sampling only the locked axis's raw coordinate
// avoids that entirely: perpendicular mouse movement, however far it wanders, has zero effect
// on where the line ends.
function _portalStraightLineEdges(anchor, mouseWorldX, mouseWorldY) {
  if (!anchor) return [];
  const anchorVertical = anchor.y === anchor.ny; // true if anchor's edge separates cells left/right (line runs top-to-bottom, extends along y)
  const edges = [];
  if (anchorVertical) {
    const fixedX = anchor.x, fixedNx = anchor.nx;
    const startY = anchor.y;
    const endY = Math.floor(mouseWorldY);
    const step = endY >= startY ? 1 : -1;
    for (let y = startY; ; y += step) {
      edges.push({ x: fixedX, y, nx: fixedNx, ny: y });
      if (y === endY) break;
    }
  } else {
    const fixedY = anchor.y, fixedNy = anchor.ny;
    const startX = anchor.x;
    const endX = Math.floor(mouseWorldX);
    const step = endX >= startX ? 1 : -1;
    for (let x = startX; ; x += step) {
      edges.push({ x, y: fixedY, nx: x, ny: fixedNy });
      if (x === endX) break;
    }
  }
  return edges;
}

// Resolve the (find-rooted) portal group under the mouse's currently-hovered edge, or null.
function portalGroupAtMouse() {
  const edge = _portalEdgeUnderMouse();
  if (!edge) return null;
  const edgeKey = portalEdgeKey(edge.x, edge.y, edge.nx, edge.ny);
  const piece = portalEdges.get(edgeKey);
  if (!piece) return null;
  return portalFindGroup(piece.group);
}

// Crosshair mode: toggled with Shift+Q. When active the crosshair starts centered and can be moved
// with Space+Arrow keys; X/Z operations target the crosshair instead of the mouse.
let crosshairMode = false;
// When true, the G key's actions are disabled until toggled back on with Shift+K
let gKeyDisabled = false;

// When true keyboard handling is locked: only A, S, Arrow keys, and Shift+H are allowed.
// Toggled with Shift+H (Shift+H disables; Shift+H again enables).
let keyboardLocked = false;
// Legacy mode: when true, only Arrow keys and plain a/s/x/z are allowed and nothing else (not even shifted versions).
let legacyMode = false;
let crosshairPos = null; // {x,y} in CSS pixels when crosshairMode is active
// crosshair movement helper: whether Space is currently held and per-press pixel step
let spaceDown = false;
const DEFAULT_CROSSHAIR_SPEED = 140; // default (slower) crosshair speed in pixels per second
let crosshairSpeed = DEFAULT_CROSSHAIR_SPEED; // pixels per second default (used when Space+Arrow moves the crosshair); adjustable with - and =

/* Selection (hold 'O' to drag-select using the mouse; release to open the selection menu)
   selectionActive remains true until the user selects an action in the modal.
   selectedSet holds keys of alive cells currently highlighted by the selection. */
let selectionActive = false;      // true while O is held and dragging (and until modal action clears)
let selStart = null;              // {x,y} in CSS pixels where selection started
let selCurrent = null;            // {x,y} current mouse pos while selecting
let selectedSet = new Set();      // keys of selected cells highlighted blue
let selectionFrozen = false;      // when true, selection rectangle is fixed (does not track mouse)

/* Toggle to show ages overlay */
let showAges = false;
 // Toggleable preview mode: when true, compute next-generation births/deaths and draw white (birth) and black (death) dots on affected cells
 let previewNextGenMode = false;
 let showGrid = true;
 let disableAgeBlend = false;
 let invertColors = false; // when true: white background, alive cells black, grid lines inverted

 // Landing-map: track how many times a dead spot has been "landed on" by an alive cell (births or direct placements).
 // This map persists even when the visual mode is off; Ctrl+A toggles the visual overlay mode.
 // It is intentionally NOT affected by startup/main-menu seeded placements (those occur while startupActive/menuInitialBoostActive).
 let landingMapVisible = false;            // toggled by Ctrl+A
 const deadLanding = new Map();            // key "x,y" -> integer count

 // helper to increment landing count for a dead coordinate (only when not in startup/menu boost)
 function incrementDeadLanding(key) {
   try {
     if (startupActive || menuInitialBoostActive) return; // do not record intro/menu placements
     const current = deadLanding.get(key) || 0;
     deadLanding.set(key, current + 1);
   } catch (e) { /* fail quietly */ }
 }

 // compute a color string for a dead cell based on its landing count (non-fading, persistent).
 // low counts -> bluish progression, after threshold -> red progression that intensifies with count.
 function getLandingColorFromCount(count) {
   // thresholds chosen to give perceptible blue->very-blue then red/pink/purple progression
   if (!count || count <= 0) return null;
   if (count <= 4) {
     // blue ramp: light blue -> mid blue
     const t = (count - 1) / Math.max(1, 4 - 1);
     return lerpColorHex('#cde8ff', '#3aa0ff', t); // soft -> stronger blue
   } else if (count <= 8) {
     // deeper blue -> cyan-ish before red switch
     const t = (count - 5) / Math.max(1, 8 - 5);
     return lerpColorHex('#3aa0ff', '#00d4ff', t);
   } else if (count <= 16) {
     // extended red-stage: pale red -> deeper red (now longer than blue)
     // map counts 9..16 into this red stage
     const capped = Math.min(count - 9, 7); // 0..7
     const t = capped / 7;
     return lerpColorHex('#ffbebf', '#ff6b6b', t); // pale red -> stronger red
   } else if (count <= 32) {
     // extended pink stage: red -> pink (longer than red)
     const capped = Math.min(count - 17, 15); // 0..15 for 17..32
     const t = capped / 15;
     return lerpColorHex('#ff6b6b', '#ff9ad0', t); // stronger red -> pink
   } else {
     // extended purple stage: pink -> purple for counts 33..
     // cap intensity mapping so colors saturate reasonably and last longest
     const capped = Math.min(count - 33, 31); // 0..31
     const t = capped / 31;
     return lerpColorHex('#ff9ad0', '#5b0066', t); // pink -> deep purple
   }
 }

// Cell brightness multiplier applied to rendered cell colours (clamped 0.1 .. 3.0)
let cellBrightness = 1.0;

/* RLE template state: templateCells is array of {x,y} relative coords; templateAttached true when attached to mouse */
let templateCells = null;
let templateAttached = false;
/* when placing a contraption we add its cell keys to pendingPlacement so they are inserted immediately
   but suppressed from participating in evolution until after the next generation */
let pendingPlacement = new Set();
/* When true the next simulation step will *only* activate pendingPlacement as a batch
   (no neighbor-based births/survivals) so contraptions always appear intact
   regardless of tick rate. This prevents partial evolution while placing.
   To make placement more robust at high tick rates we impose a short timed delay
   before the activation step actually commits the pending batch. */
let activatePendingOnly = false;
// timestamp when pending-placement protection began (ms)
let pendingPlacementStart = 0;
// how long to wait (ms) before committing pendingPlacement as active; tweak to taste
const PENDING_ACTIVATE_DELAY_MS = 120;

/* Presets: list of named RLEs (text kept exact). These are shown in a Y-key modal with a small visual preview and a Copy button. */
const presets = [
  {
    name: 'Copperhead',
    category: 'Spaceships',
    rle: `#N Copperhead
#O 'zdr'
#C An c/10 orthogonal spaceship found on March 5, 2016.
#C https://www.conwaylife.com/wiki/Copperhead
x = 8, y = 12, rule = B3/S23
b2o2b2o$3b2o$3b2o$obo2bobo$o6bo2$o6bo$b2o2b2o$2b4o2$3b2o$3b2o!
`
  },
  {
    name: 'Gosper Glider Gun',
    category: 'Guns',
    rle: `#N Gosper glider gun
#O Bill Gosper
#C A true period 30 glider gun.
#C The first known gun and the first known finite pattern with unbounded growth.
#C www.conwaylife.com/wiki/index.php?title=Gosper_glider_gun
x = 36, y = 9, rule = B3/S23
24bo11b$22bobo11b$12b2o6b2o12b2o$11bo3bo4b2o12b2o$2o8bo5bo3b2o14b$2o8b
o3bob2o4bobo11b$10bo5bo7bo11b$11bo3bo20b$12b2o!
`
  },
  {
    name: 'Fountain',
    category: 'Oscillators',
    rle: `#N Fountain
#O Dean Hickerson
#C A period 4 oscillator found in November 1994.
#C www.conwaylife.com/wiki/index.php?title=Fountain
x = 19, y = 15, rule = B3/S23
9bo9b2$3b2obo5bob2o3b$3bo5bo5bo3b$4b2ob2ob2ob2o4b2$6b2o3b2o6b$2o15b2o$
o2bo3bobobo3bo2bo$b3ob9ob3ob$4bo4bo4bo4b$3b2o9b2o3b$3bo11bo3b$5bo7bo5b
$4b2o7b2o!
`
  },
  {
    name: 'Simkin Glider Gun',
    category: 'Guns',
    rle: `#N Simkin glider gun
#O Michael Simkin
#C A true period 120 glider gun, found on April 28, 2015.
#C www.conwaylife.com/wiki/Simkin_glider_gun
x = 33, y = 21, rule = B3/S23
2o5b2o$2o5b2o2$4b2o$4b2o5$22b2ob2o$21bo5bo$21bo6bo2b2o$21b3o3bo3b2o$
26bo4$20b2o$20bo$21b3o$23bo!
`
  },
  {
    name: 'New Gun',
    category: 'Guns',
    rle: `#N newgun.rle
#O Bill Gosper, 1971
#C https://conwaylife.com/wiki/New_gun_1
#C https://www.conwaylife.com/patterns/newgun.rle
x = 36, y = 34, rule = B3/S23
25b2o5b2o$25b2o5b2o8$26bo5bo$25b3o3b3o$24b2obo3bob2o3$27bo3bo$27bo3bo
7$33bo$10b2o22b2o$2o7bobo21b2o$2o7bo$9b3o4$9b3o$2o7bo17b2o$2o7bobo15b
2o$10b2o!
`
  },
  {
    name: 'Pulsar',
    category: 'Oscillators',
    rle: `#N Pulsar
#O John Conway
#C A period 3 oscillator. Despite its size, this is the fourth most common oscillator (and by
#C far the most common of period greater than 2).
#C www.conwaylife.com/wiki/index.php?title=Pulsar
x = 13, y = 13, rule = B3/S23
2b3o3b3o2b2$o4bobo4bo$o4bobo4bo$o4bobo4bo$2b3o3b3o2b2$2b3o3b3o2b$o4bob
o4bo$o4bobo4bo$o4bobo4bo2$2b3o3b3o!
`
  },
  {
    name: 'Unix',
    category: 'Oscillators',
    rle: `#N Unix
#O David Buckingham
#C A period 6 oscillator that consists of two blocks eating a barge.
#C https://www.conwaylife.com/wiki/index.php?title=Unix
x = 8, y = 8, rule = B3/S23
b2o5b$b2o5b2$bo6b$obo5b$o2bo2b2o$4bob2o$2b2o!
`
  },
  {
    name: 'Figure Eight',
    category: 'Oscillators',
    rle: `#N Figure eight
#O Simon Norton
#C A period 8 oscillator found in 1970.
#C www.conwaylife.com/wiki/index.php?title=Figure_eight
x = 6, y = 6, rule = B3/S23
2o4b$2obo2b$4bob$bo4b$2bob2o$4b2o!
`
  },
  {
    name: "Achim's P16",
    category: 'Oscillators',
    rle: `#N Achim's p16
#O Achim Flammenkamp
#C A period 16 oscillator that was found in July 1994.
x = 13, y = 13, rule = B3/S23
7b2o4b$7bobo3b$2bo4bob2o2b$b2o5bo4b$o2bo9b$3o10b2$10b3o$9bo2bo$4bo5b2o
b$2b2obo4bo2b$3bobo7b$4b2o!
`
  },
  {
    name: "Kok's Galaxy",
    category: 'Oscillators',
    rle: `#N Kok's galaxy
#O Jan Kok
#C A period 8 oscillator that was found in 1971.
#C www.conwaylife.com/wiki/index.php?title=Kok's_galaxy
x = 9, y = 9, rule = 23/3
2bo2bobob$2obob3ob$bo6bo$2o5bob2$bo5b2o$o6bob$b3obob2o$bobo2bo!
`
  },
  {
    name: 'P48 HWSS Gun',
    category: 'Guns',
    rle: `#N smallp48hwssgun.rle
#C https://conwaylife.com/wiki/Kok%27s_galaxy
#C https://www.conwaylife.com/patterns/smallp48hwssgun.rle
x = 54, y = 49, rule = B3/S23
6b3o$7bob3o$6b2o2bo2bo$6b5o3bo$7bo4b3o30b3o$12bo29b3obo$7bo32bo2bo2b2o
$6bobo30bo3b5o$7bo31b3o4bo$13b2o26bo$13b2o31bo$45bobo$b2o43bo$b2o36b2o
$39b2o2$51b2o$8b3o40b2o$7bo3bo$6bo5bo$6bo5bo$6bo5bo30b3o$7bo3bo30bo3bo
$8b3o30bo5bo$41bo5bo$2b2o7b2o28bo5bo$3bo7bo30bo3bo$3o9b3o28b3o$o13bo9b
o$22bobo16b2o7b2o$23b2o17bo7bo$39b3o9b3o$29bo9bo13bo$29bobo$29b2o4$18b
2o$15bo$14bobo2b2o$12bobob3o2bo$12bo2b6o$15b2ob2o6b2o$14b6o2bo2bobo$
13bo2b3obobo3bo$14b2o2bobo$19bo$15b2o!
`
  },
  {
    name: 'HeavyWeight Spaceship',
    category: 'Spaceships',
    rle: `#N Heavyweight spaceship
#O John Conway
#C A very well-known period 4 c/2 orthogonal spaceship.
#C www.conwaylife.com/wiki/index.php?title=Heavyweight_spaceship
x = 7, y = 5, rule = B3/S23
3b2o2b$bo4bo$o6b$o5bo$6o!
`
  },
  {
    name: 'MiddleWeight Spaceship',
    category: 'Spaceships',
    rle: `#N Middleweight spaceship
#O John Conway
#C A very well-known period 4 c/2 orthogonal spaceship.
#C www.conwaylife.com/wiki/index.php?title=Middleweight_spaceship
x = 6, y = 5, rule = B3/S23
3bo2b$bo3bo$o5b$o4bo$5o!
`
  },
  {
    name: 'LightWeight Spaceship',
    category: 'Spaceships',
    rle: `#N Lightweight spaceship
#O John Conway
#C A very well-known period 4 c/2 orthogonal spaceship.
#C www.conwaylife.com/wiki/index.php?title=Lightweight_spaceship
x = 5, y = 4, rule = B3/S23
bo2bo$o4b$o3bo$4o!
`
  },
  {
    name: 'Glider',
    category: 'Spaceships',
    rle: `#N Glider
#O Richard K. Guy
#C The smallest, most common, and first discovered spaceship. Diagonal, has period 4 and speed c/4.
#C www.conwaylife.com/wiki/index.php?title=Glider
x = 3, y = 3, rule = B3/S23
bob$2bo$3o!
`
  },
  {
    name: 'Spaghetti Monster',
    category: 'Spaceships',
    rle: `#N Spaghetti monster
#O Tim Coe
#C The first 3c/7 orthogonal spaceship to be discovered.
#C https://conwaylife.com/wiki/Spaghetti_monster
x = 27, y = 137, rule = B3/S23
8b3o5b3o$8bobo5bobo$8bobo5bobo$6bob2o3bo3b2obo$6b2o4bobo4b2o$10b2obob
2o$9bo7bo$9bobo3bobo$5b5o7b5o$4bo2bo11bo2bo$5bob3o7b3obo$7bob2o5b2obo$
6b2obobo3bobob2o$6b3obo5bob3o2$10b2o3b2o$12bobo$9bo7bo$9b2o5b2o$6b2o
11b2o$4bob2o11b2obo$4b2o2b2o7b2o2b2o$4bo2bo2bo5bo2bo2bo$5bo4bo5bo4bo$
5bo2bo2bo3bo2bo2bo$2bo5bo9bo5bo$3bobo15bobo$7bo11bo$3bo3bobo7bobo3bo$
3bo2bo3bo5bo3bo2bo$4b2o2b2o7b2o2b2o$8bo9bo2$8b5ob5o$bo6b2ob2ob2ob2o6bo
$3o7bo5bo7b3o$o2b2o5bo5bo5b2o2bo$2bo3b5o5b5o3bo$7bob2o5b2obo$bo3bo15bo
3bo$bob2o2bo11bo2b2obo$bob4o13b4obo$4bo17bo2$2bo21bo$bobo19bobo$o25bo$
o3bo17bo3bo$5bo15bo$2o23b2o$2bo3bo2bo7bo2bo3bo$2bo3bobobo5bobobo3bo$2b
o5bob2o3b2obo5bo$2bo3b2obo7bob2o3bo$6b2o11b2o$4bo17bo$3bo19bo$3bo4bo9b
o4bo$2b2o3b2o9b2o3b2o$2b2o3bobo7bobo3b2o$2b2o3b2o3b3o3b2o3b2o$2b3o2b3o
bo3bob3o2b3o$6bob2obo3bob2obo$2b2o3b2obo5bob2o3b2o$3bob2o3bobobobo3b2o
bo$11bobobo$8bo9bo$8b3o5b3o$10b2obob2o$10b7o$8b3o5b3o$7b2obobobobob2o$
6bo3bo5bo3bo$11b2ob2o$5bo2bobobobobobo2bo$6b4o7b4o$9bo7bo$9bo7bo$6b2ob
o2bobo2bob2o2$9b2o5b2o3$9bo7bo$9b3o3b3o$8bo2bo3bo2bo$9bo7bo$8bo2bo3bo
2bo$11b2ob2o$12bobo$10bobobobo$9bo3bo3bo$9bo7bo$12bobo$7b2obo5bob2o$7b
2o2bo3bo2b2o$7bo11bo$8bo9bo$6bobo9bobo$5b4o9b4o$5b2obobo5bobob2o$4bo2b
o11bo2bo$9bobo3bobo$8b2obo3bob2o$4bo2bo3b2ob2o3bo2bo$9bo2bobo2bo$6bo2b
ob2ob2obo2bo$7bobobobobobobo$8b2o2bobo2b2o$9bobo3bobo$10b2o3b2o$7b2o9b
2o$7b3o7b3o$7bobo7bobo$5b2o2bo7bo2b2o$5b2o13b2o$11bo3bo$6bo4bo3bo4bo$
6b2o3bo3bo3b2o$7bo2bo5bo2bo$7b3o7b3o$6bobo9bobo$6b2o11b2o$6bobo4bo4bob
o$6b2o4b3o4b2o$6b2o3bo3bo3b2o$5b3o4b3o4b3o$3b2o17b2o$2bo5b2o2bobo2b2o
5bo2$2bo2bob3ob2ob2ob3obo2bo$8b3o5b3o$10b3ob3o$5bo4b2obob2o4bo$11bo3bo
2$11b2ob2o!
`
  },
  {
    name: 'P52 Glider Gun',
    category: 'Guns',
    rle: `#N period52gun.rle
#O Dave Greene, 2018
#C https://conwaylife.com/wiki/Period-52_glider_gun
#C https://www.conwaylife.com/patterns/period52gun.rle
x = 309, y = 298, rule = B3/S23
160b2o42b2o$82b2o77bo34bo7bo9bo$81bobo77bob2o31b3o2b2obo7b3o$75b2o4bo
68bo11bobo34bo3bo7bo$73bo2bo2b2ob4o64b3o11bob2o13b2o15bo12b2o$73b2obob
obobo2bo67bo9b2obo2bo3bo7bo9bo7b3o$76bobobobo69b2o14b2o3b3o3bobo7b3o
16b2o$76bobob2o74bo19bo2b2o7bo18bobo$77bo78b3o16bo12b2o10b2o5bo2bo$
144b2o2bo6b2o2bo6b2o8b2o22b2o6b2o$90b2o52bo2bobo4bo5bo5b2o9bo31bo$81b
2o7bo54bob2o8b2obo21b2o$63bo17b2o5bobo55bo5bo5bo2bo15b2o4bo20bo$43b2ob
2obo13b3o22b2o57b2o2bo7b2o16b2o5bo19bobo$44bobob2o16bo81bo34b2o19b2o$
42bobo20b2o79bo8bo111b2o$40b6o5bo94b2o3bo4bo109bobo$39bo9b3o31b2o67bo
107b2o4bo$35b2obob2o3bo2bo8b2o13bo9b2o69bo3bo57b2o41bo2bo2b2ob4o$35b2o
bobo5bo2bo7bo12b2o12bo69bo3bob2o9bo42b2o42b2obobobobo2bo$38bobob2ob4ob
o3b2obo13b2o5b2o81bo7bobo44bo44bobobobo$35b2obo3bobo5bo3bo2b3o4b2o13bo
66b3o10b2o9b2o89bobob2o$35bo2b2o5b5o5b2o3bo3b2o10b3o69bo4b6o2b3o98bo$
36bo4b4o12b4o15bo70bo5b2o5bo2bo$37b4ob2o3bo9bo15b2obob3o71b2o7b2o11bo
38b2o60b2o$44b6o8b3o12bobobobobo41b2o27bo19b2o17bo21bo52b2o7bo$39b2o2b
obo4bo10bo13bo6bo41bo48b2o16bobo17bobo51bo2bo4bobo$40bo3bo2b2obo5b5o
14b2o3b3o41bobo21b2o2b3o36b2o3b3o11bobo60b2o$40bob2o3b2ob2o4bo22bo45bo
bo20bo2bob2o2b2o37bo9b2o2bo54bo$39b2obo3b2obo2bo5bo20b2o46bo2b2o17bobo
4bobo38bo8b2o2bo2bo50b2o$36b2o3bob2o2bo2b3o4b2o12bo24b2o26bo2bo2b2o18b
o2bo2b2o55bo52bo$33bobo2b2o3bobob3o22b2o21b2o27bo26b2obobo55bo15b2o$
32bob2o2bob2o8bo20b2o14b2o8bo27bo26bobobobo25bo28b3o11b2o$32bo11bob2o
2bo37bo33b3o26bo2b2obobo22bobo22bo7bo13bo$25b2o3b2o2b2o3b3o6bob2o36bob
2o30bo10b3o15b2o4bobo23b2o21bobo54b2o$26bo2bo2b2obo2bobob2obo2bo2bo28b
2o4b3o2bo43bo21b2o47bo2bo44bo9bo26b2o$25bo3bobo7bo2bob2o3b2o29b2o3bo3b
2o38b2o3bo72b2o17b2o13bo10b2o7b3o27bo$24bob3obob2obo3bo6bo38b4o40bo31b
o39bo16b2o5bobo13b3o9b2o6bo26b2obo$22bo2bo2bobobob2o7b4o24b2o15bo40b3o
27b2o17bo22b2o15bobo4bo18bo40bo4bo$22b2obo7bo2bo8b2o23bobo12b3o72b2o
16bobo19bobo8b2o7bo2b2ob4o13b2o39bo4bo$25b2o2b2o2bobobo3bo28bo13bo40b
2o51b2o31bobo5b2obo3bo2bo54bo3b3o$22b2o2bo3b3o2b3o2bobo26b2o14b5o34bob
o86bo6bob4o52b2o5bo4b2o$22bo3b2ob2o3b4o3b2o2b2o29bo12bo34bo88b2o5bobob
o52b2o11bo$23b3obo2b4o11b2o27b2o11bo21b2o12b2o96bo57bo11b3o$25bo2b2o3b
obo39b2o10b2o19b2o32bo66b2o14bo14b2o51bo$bo2bo3b2ob2o13b2o2b2o2b2o74bo
30b2o54bo10bobo16bo6b2o5b2o2bo38b3o$b4o2bobobobo14bobo12b2o96bobo51bob
o10bo16bobo6bo7b4o7b2o29bobo$5b3o3bo2bo13bobo11b2o152b2o9b2o16b2o5bobo
8b2o8bobo29b2o$b4o4b2obobo14bo14bo187b2o9b2obo8bo$bo4b3o3bob2o191b4ob
2o5bo25b3o7b2o$3bob2obo3bo2bo132bo39bo18bo2bobo6bobo23bobo41b2o$2b2ob
2obobo2b2o131b2o17bo22b2o19bo2bo6b2o21b2obo43bobo$bo2bo3b5o134b2o16bob
o19bobo20b2o29bob4o28b3o13bo$2bo9bo152b2o74bobobob2o28bo13b2o$3bobo2b
4o226b2obobobo4bo25bo$7bobo20bo32bo138bo3bo15b2o14bo2bo2b2ob4o$3bo3bo
2b2o18bobo28b2o31bo2b2o23b2o6bo71bo4bo15bo7b2o7b2o4bo$3bo7bo18b2o30b2o
30b4obo6bo14b2o7b3o22bo46bo4bo12b3o8bobo12bobo$2b3ob2o2bo3b2o83bo5bobo
15bo9bo20b2o46bo17bo10bo15b2o$6b3obobo2bo40b2o36b2ob2ob2o3bobo4b2o18b
2o20bobo29b2o15bobo$4b2o4bob2o41b2o36bo2bo3bo3b2o2b2o2bo74b2o15bo$2o2b
2o2bobobo44bo34bobo2b2o3bo3bobobobo73bo67b2o$o2bo6bo3bob2o73bobob2obob
ob2ob2o2bobo38b2o6b3o45bo48bo$b4obob2ob4obo74bobo3bo10b3o24bo13bo2bo4b
o17bo30bobo44bo$6bo4bo4bo75bo2bo4b6o3bo23b2o22bo2bo14b2o29b2o45b5o6b3o
5b2o$b2o5b3o2b3o77b2ob2o7b3o26bo23b2o14bobo81bo4bo8bo$2b3obo4bobo81b2o
3b6o2bo33b2o4bo2bo52bo9b2o39b3o5bo2bo3bobo$bo2b8o81b2ob2ob2o5b2o26bo2b
o4bobo3bob2o9b2o40b2o9bo39bo6b2o3bo3b2o$bo4b2obo2bo4bo32bo43bo3bo2bob
2o7bo22b2o7bo4bob3o7bo41bobo6bobo39b4o2bo4bo$11b2o4bobo28b2o43bo2bob2o
2bo7b3o31bob3o3bobo7b3o47b2o30b2o6b2o3bo2bo3bobo$b2ob3o10b2o30b2o42b3o
5bob2obo2bo33b2obo7bo9bo62bo16bobo4bo2b3o3bo4bo$4b2o78bo11b2ob2obo7bo
20bo22b2o50b4o16bobo15bo6b2obo6b2o4bo$bo29bo37b2o7b2o3bobo7b2o2b2o3b3o
2b3o2bo17bobob2o37b2o30b3o2bo15bobo25bo8bo3bo$obo28b3o34b2o9bo3bo2bo4b
o2bob2o2bobo7b3o17bobobobo37b2o29bo3bo10b2o3b2ob2o24b2o7bo3bo$b2o31bo
35bo8bob2ob2o5b2obo3bo5bo3b2o17b2obobobobo2bo33bo32bo2bo10b2o2bo4bo34b
3o$6bo26b2o45bobo11bo5b2ob3o3bob2o14bo2bo2b2ob4o66b3o16b3o$5b2o75bo5bo
5bob2o2b4o3b3o2bo16b2o4bo26bo51b2o2b7o2b2o6bobobo3b2o17b2o$4bo2bo75bob
obobo3b2o2bo3b2o2bo2bobo24bobo24b2o50bo2bobo5bo8bob3obobobo18bo9b3o$5b
2o15b2ob2o57bo3bo3bo2bo6b2ob2o3b2o24b2o23bobo52b2o2bo3bob2obo4bo5bobo
17b3o10bo$9bobo10b2obo61b2o4b2ob4o4bo7bo106bo4bobo2b2o2b2ob2obobob4o
13bo13bo$10b2o13bo58b5obo4bo2bo2bob5o2b2o107bo4bobo2bo6bob2o3bo2bo$10b
o14b3o4b2o3bo46b2obo3bo3bo2bobob8obobo97b2o6bobo3b2o2b2obobo5b2o3bo$
23b2o3bo3b2ob2o50bo2bo3b2obo4bo9b2o5b2o74b2o14b2o7b3obo6bobo3b2o3bo14b
2o$22bo2b4o7b2o50bo5bo2bobo19bobo74bo24b5o2b3obo4bo4bo2b3ob2o6bobo$6b
2o14b2obo15b2o47bo5bobob3obob2o8b2obobo71b3o26b2obobob2ob2o3bo4b3o2b2o
bo6bo$7b2o14bo2b3o12bobo18b2o18b2o5bo5b2obob2o9b2o3bobobo39b2o31bo38bo
2b2ob2ob2o$7bobo13bo5bo13bo17bobo7b2o8b2o6bo7b2obo2b2o3bo2b2o5bo42b2o
69b2o7bo$8b2o14b5o14b2o6bo9bo10bob2o7bo13bo10bo8bo2bo9b2o28bo59b4o9bob
5obobo$6b2obobo14bo23bobo5b2obo10bob2o19b2obo2b3o3bo9bo7b2o2bo2bo87bo
3bo2b2o3bo2bo4bobobo$7bo3b3o36bobo5b2obobobo4b4o16bo5bobob3ob2o5b2o4bo
3bo3bo4b3o16bo59b2o8bo4bo2b2o3b3o2bo2bo3bo$12b2o35b2ob3o6bobo2b2o2b2o
2bobo12bobo4bobo5b2o5b2o4bo9b3o19b2o70b3o11b2obob4o8bo2bo30b3o17b2o$8b
o3bo42bo5bo2bo2b2o5b3o12bo2bo4b2obo3b2o11bo6bo5bo17bobo48b2o8b2o19b3o
2bo2bo5b3o3b3o2b3o28bo19bo$7bobob2o9bobo26b4o7bobob3o5b3o13b2o7bo4b2o
12bobo3bo3b3o69bo23bo2bobo3bobob2ob4o3bobo3b2o3bo28bo16bobo$8bo3bo2bo
7b2o17bo6b2obo8b2ob2obo6b3o22bob5o14bo5bo73bobo7bobo9bo7bobobo2bo2bo4b
3ob4o2b3obo43bobo$12bo3bo6bo19b2o23bobo4bo24bo20b4o3b2obo69b2o8bo14b3o
7bobo3bo5bo4b2o4bo39b2o2bo$11b2ob2obo24b2o3b2o20b2o23b2o5bo20b5obob2o
55bo23bo9bo2bob3obobobo5bob4obo2bo3b2o2bo11b2o27b2o2bo2bo$10bo2bo3bo
21bo41b3o10bobob3o26bo58bobo30b3ob2o4bob2ob4obo7bo2bobo2bobo12bobo33bo
$11bo3b2o20b3o43bo12bobo17bo7bobo59bobo29bo4bo5bobo3bobob2o12b2o2bobo
10bo34bo$12b3o21bo15b2o28bo6bo6b2o16bobo7b2o6bo14b2o36b2ob2o3b2o23b9ob
o2bob2o3bo15bobob2o46b3o$14bo21b2o14b2o35b3o23b2o13b3o15b2o35bo4bo2b2o
31bobobo2bo5b2o3bo4b2o3bobo43bo7bo$53b3o36bo36bo17bo39b3o21bo8b2obo2bo
bob2obo2b3o2bobobo3bo2bobobo7bo33bo2b2o$53bo37b2o36b2o39b2o3bobobo6b2o
2b7o2b2o10b2o6bo4b2o2bo4bobo4bob2obo5b3o2bobo4bobo32b2o$34b2o18bo2b2o
44b3o30bo33bobobob3obo4bo3bo7bo2bo8bo2b3o5bo3bo2b2o4bobob2obo4bob4o5bo
b3o2bo2bo$33bo2bo18bo9bobo37bo9b3o18b2o34bobo5bo6b2obob2o3b2o10b4ob2o
4bobo3b2o5bobobobob4obo4b5obo3bob2obo2bo$33bobo18b2o8bo2bo36b2o9bo4bo
14bobo30b4obobob2ob2o3b2obob5o8b2o4bobo3b2o3b2o7b2o4b2o2bobobo2bo2bo5b
o2bob2o4bobobo$33b3o17b3o4b2o3bo2bob2o44bo3b2o46bo2bo3b2obo4bobobo5b3o
6b3o17bob2o3b2o2bobo6bob3obo2b2o2bob2o2b2o3bo2bo34b2o$26b2o17bob2o12b
2o5bo2bo49b2o46bobo2bo3bob2obo2bobobo4bo6bo2bo6bobo6bo2b3o3bo2bo3bo4bo
b2o3bobo2b2o3b2o5bo37bobo$25bobo15b3obo12bo8b2o16bo30bo2bo48b3ob2ob3o
6b2o2bo3bo7b2obo7bo7bo2bo4b3o2bob3o2b2obob2o4bo2bob2o2b5o40bo$25bo16bo
4bobo19b2o17b2o11bo17b2o43b2ob3o2bob2o2b2obob4o3b4o9b2o7bo8bo2b2o2b2o
3b2ob2ob3o2b2o3bo3b2o3bo2bo21b2o21b2o$24b2o16b2o3b2obo38b2o10b2o29b3o
29bob2o3bo2b2o3bobo6bo36bo2bobo2bo3bo2b2o3bobo3bo3b3o5bo19bobo$50bo28b
o11bo8bo2bo31bo35bo2b2ob4o7bo38bo2bob2obobo7bob7obo6b2o19bo$38bo8b3o
16b2o11b2o5b5o10bob2o11b2o14bo2bo37bo7b2o47bobo2bobobobobob2o7bo$34b2o
bobo7bo19bo21bo11b3o13bo15bo37bobob5obo47b2ob4ob2o3b2o4b3obo$33bobobob
o24b3o7b2o26bo11b3o8b2o8bobo32bobobo4bo2bo3b2o2b2o39bo12b4o2bob2o30bo$
30bo2bobobobob2o21bo9bo39bo11bo8bo2bo31bo3bo2bo2b3o3b2o2b2o39bobo10bo
2bo36b2o$30b4ob2o2bo2bo33bo46b3o10b2o21bo2bo8b4obob2o52b2o49bobo$34bo
4b2o34b2o46bo33b3o2b3o3b3o5bo2bo2b3o17b3o9b2o9bo$32bobo39bo12bo7b2o59b
o3b2o3bobo3b4ob2obobobobob2o25bo8bobo78b2o$32b2o13b2o25bo3b2o7bobo4bob
o2bo34b2o19bob3o2bob2ob3obo2bo2bobo2bo2bob5o7bo3b2o7bobo9b2o78bo$37bo
10b2o21b2obo2b2obo6b2o5bobobobo33b2o19bobo3b2o7b2o3bo12bob3o7b2o10b2o
92bo$35b5o7bo6b2o15b2obob3o2bo11b2obob2ob3ob2o49bob2o2b3obobob2o5bo2bo
4bo4b2obo6bo6b3o76b2o14b5o$34bo5bo13bo19bob2o3bo10bo3bobob2o3b2o6bo43b
obo2bobobo6bobobo2b4obob2o4b3o10b4o77bo5b3o5bo$34bo2b3o12bobo19bo2bo3b
o4b2o3b3ob2ob2o3bobo8b2o39bobo2b2o12b2obo2bo2bobo5bo4bo7b2obo2bo76bob
2obo3bo5b3o$33b2obo15b2o18bobob2ob3o4b2o3b3o2bo2bo4b3o6b2o40b2obobo15b
o3b2obo2bob9o7b2ob2obo77bo8bo7bo$33bo2b4o31bobobo15bo4bo2bo2bo5bo49bob
o3b2o4bo3b2o5bo2bobobo16bo4bo83bo3bo3b4o$34b2o3bo3b2o24b3obo2b2obo2b2o
6b3obob3o5bobo2bo40bo7bobobo2bo3bobobo2b3o2bob2obobo2b4o10bo2bo84bobo
2bo3bo3b2o$36b3o4b2o23bo4b2obobobo5b2o2b2o2bo6b5o43bobo4bobo2b3o5bob2o
bo4bobobo2bo2b3obobo10b3o62bo18bo3bo3bo4b3o2bo$36bo32b3o2bo2bob3o4b2o
8b5ob2o2b3o39bo2bo2b3obo5b4obo4bob2obob6o5bobo76b2o18bo5bo7bob2o$33b2o
bo34b2o2bob2o2bo8b2ob3o4bo5bo3bo34bo2bob2obo3bob5o4bob4obobobobob2o2bo
4b2o76bobo19bo3bo8bo$33b2ob2o43bo7bo7b2ob2o2bo3b3o33bobobo4bo2bo2bo4bo
bobo2bo3bo3b2o5b2obo3bo44bo54b3o8b2o$53b2o23b2obo7b2o3b3ob4ob2o2bo3b2o
24bo7bo2bob2obo2bobo2b2o3bob2o3bob2o4b3o2b2o3bobo42bobo$52b2o30bob2obo
bo2bo5bo2b2o4b2o2bo21b3o10bo5b2o4b3o2bo5bo3b2o2bo2b3o2b2obo20b2o5bo18b
2o$44b2o8bo22bobob2ob2obo2bo3bob6obo3bo2bob2o20bo14b5o2b2o2bobo3b2obo
3bob2o10bo2b4o17b2o5b3o75b2o$45bo29b3obo3bo3bo5b4o5bo3b2o2bo23b2o17bo
2bo3b2o3b2o2bo3b2o3b3o4b2obobob2o27bo62b2o10bo$42b3o29bo5b4ob2ob4o7b4o
bobob3o15bo17bo6bo5b3o7bobo8bob2obo2bo33b2o61bobo11b3o$42bo32bob5obobo
2bo9bo7b2o19b2o15b3o4b2o6bob7obobo2bo2bobo4bobo2bo5bobo87bo13bo$74b2ob
o2bo2bobobo2b2ob3o2bob2o6b3o15b2o14b2o3bo12bo7b2obo2bo2bobo2bobo3bo6b
2o$75bo2bo6bo2b3o5bobobo2b3o4bo32bo2b2o7b2o4b6o4b2o3b2ob4ob2o10bo73bo
2bo$74bo2b2ob4obo6bob2obo3b5o37bobo9bo11b4o12bo40bo6bo3bo34b4o$75b2o2b
5o2b3ob2o3bobob2o5bob2o25b2o4b3o2b4o3bobo7b4o3bo10bobo38b2ob2o4b3ob2o
2bo18bo8bo$77bo6b2o2bobo3bo3bo2bobob2o28b2o3bo3b2o4bo2b2o7bo3bob2o11b
2o42b2o5bobo3bobo17b2o7b5o14b2o$75b2o3b2o4bobobo8bobo8bo29b4o2bo2bo12b
2o4bo41bo15b2o5b3o3bo17bobo12bo13bo$74bo2b4ob2obo2bob4o4b2ob2obo3b3o
15b2o15bob2o3b2o16bobo39b2o13b2o16bo7bo17b3o12bobo$66b2o6b2obo2bo5b2ob
o2b2o3bo3bo9b2o12bobo12b3o2bo5bo6bo10b2o38bo25b2o2bo2bobo4bobo16bo15b
2o$65b2o10bobobo7bobo6b3o2bob5obo13bo13bo5bo11bobo50b3o23b7o2bo4b2o16b
4o$67bo9b2o2bo7bobobo7b3o5bobo12b2o14b5o6b2o3bo2bo51bo24b2o5bobo20b2o
3bo3b2o3b2o$81b2o7b2o8bo4bob2o2b2o18bo10bo8b2o4bo84bo2b2o18bo2b3o4b2o
3bobo$82bo10b2o5bob2ob2obobo18b2o26bo2bo79bobobo20b2obo11bo$81bo8b2o5b
2obo3bobobobo19b2o28bo21bobo56bo2bo23bo$81b2o6bobob2o2bo2bobo5bob2o46b
o23b2o58b2o24b2o$89bo3bo5bobo6bo50bo23bo30b3o$88b2ob4o3b2obob3o2bob2o
94b2o8bo5bo75b2o$90bobo2bo3bobob2obobo2bo93bobo7bo4bobo22bo30b2o20bo$
90bo4b4o2bo2b3o2bo97bo13b2o15bo6b2o30bo22bo$88b2obob2o6b2o4b2o130b2o3b
obo27b3o3b2o14b5o$89bobobo2b5o2bo3bo130b2o24bo9bo6bo13bo$79b2o8bob2ob
2o5bo3bobo41bo112bobo16bobo12b3o$78b2o10bo2bo2bo2b2ob2ob2o40b2o114b2o
17b2o4b2o9bo$80bo10b2o2b2o3bo3bo43b2o137b3o6b4o$100bo3bo13bo160bo8bo2b
2o3bo3b2o$101b3ob2o9b2o159b3o11b2o4b3o2bo$105bo2bo8b2o50b3o104bo22bob
2o$99b3obobob2o55b2o2bo3bo103b2o21bo$98bo2bobobo58b2o2bob3o28b3o94b2o$
99bo5bo50b2o6b2o3b3o21b2o8bo$100b5o50bobo5b2o27bobo7bo31b2o38b2o$97b3o
49b2o4bo7b2o29bo38bo2bo3b2o9bo21bo2bo13b2o$97bo3b4o42bo2bo2b2ob4o2bobo
10b2o57bobo2bo2bo9b2o18b2ob2o13bo$98b3o3bo42b2obobobobo2bo3bo2b2o7bo
58bobo14b2o20bobo15b3o$92b2o7bo34bo13bobo3b2o2b3o3bobo7b3o87b2o6bo18bo
$91b2o7b2o32b2o14bob2obo12bo9bo61bo2bo21bobo$93bo41b2o14bo3bo4b2obo4b
2o59b2o9b2obo21bo$105bo54bob2o17bo48bo7b3obo21b2o$103b2o49b3o7b2o14bob
o44b3o7bobo3b3o$104b2o47bobobo6bo15bobo44bo9bo7bo32bo$152b2o8bobo11b2o
3bo54b2o36b2obobo$150bo2bo5bo2b2o12b2o8bob3o82bobobobo$110b2o38bo4bo3b
o25bo4bo79bo2bobobobob2o$103b2o5bobo36b2o4bo28b2obo8b2o8b2o62b4ob2o2bo
2bo$103b2o7bo45bo26bo3bo6bo3b2o4bobo55bo9bo4b2o$112b2o40bo2bo28b3o5bob
o3bo2b2obobo56b2o5bobo$155bo31bo6b2o5bobobobo56b2o6b2o$99bo23bo76b2o3b
o$98bobob2o17b2o29b2o45bo2bobobo$98bobobobo17b2o29bo27b2o15bob2o5bo$
95b2obobobobo2bo42b3o9b2o16bobo14bo2bob2o2b2o$95bo2bo2b2ob4o42bo11bobo
15bo16b2o3bo$97b2o4bo58bo16b2o$103bobo96bo$104b2o31bo54bobo5b2o9b2o$
137bobo51bo2bo7bo7bo2bo$137b2o51b2o3bo6b2o7b3o$195bo8b7o66bo$183b2o19b
5o2bo66b2o13b2o$182bobo5b3o2bo9b3o2b2o65b2o14bo$110bo71bo11b2o95bobo$
108b2o71b2o8b3o97b2o$109b2o4bo47b2o26b3o5bo13b2o21bo$115b3o31bo2bo10bo
bo9b2o20b2ob2o3b2o2b2o2bo2bo2b2ob2o2b2o6b3o$118bo24b2obo2b4o12bo9bobo
19b2ob2o3b2o2b2o3b2obo2bobo3bo6bo54bo$117b2o25bob3o4b2o3b2ob4ob2o7bo
21b2o2b2o12bob2o3bobobo4bo2bo52b2o$142bo7b2obobobobobo2bobo33bo13b2obo
3bobobo5bo3bo50b2o$124bo8b2o6bob7obo7bobob2obo2bo38bo4b2o3bo2bobo5b2ob
ob2o59bo$109b2o13bobo6bo5b3o3bo3bobo3b2o2bo3bo2bobo2bo36bobo2bo2bo2b2o
bobo3bob2o4b2o42bo12b3o$109bo14b2o9bo2bo3b2o3bo3b2o2b3ob2ob2o3b2o2b2o
2bo27b4o6bo3bobo8bo3b3o3bo41bobo9bo$106b2obo21b5o2b2obo2bo4b2obob2o2b
3obo2b3o4bo2bo17b2o7bo3bo3bo2bo3b5o2bobo4bobob3o42b2o10b2o$106bo2b3o4b
2o9b2obo5b2o3b2o2bobo3b2obo4bo3bo2bo3b3o2bo17b2o6bo5b2obo2bo7b2o6bobo
3bo50b3o$107b2o3bo3b2o10bobo3b2o2b2obo2b2o2bob3obo6bobo2b2o3b2obo13b3o
10b2obo2bo4bo4bo7bobobobobo52b6o$97bo11b4o15bobo4b2obo2bo5bo2bo2bobobo
2b2o4b2o7b2o10bo2bo11b2o7b3o3bo3b3o3bobobob2o54b2obo$95b2o12bo15b2obob
ob2obo3bob5o4bob4obobobobo5b2o3bobo9bo4bo8bob2o4b2o3bobobo4bo2b3obobob
o2bo54bobo$96b2o12b3o12bobo2bo2bo2b3obo5b4obo4bob2obobo4b2o2bo3bo11bo
10bobo3b3obo2bo2bo2bob2ob2obo2bo2bo2b2o56bo$113bo13bobobobo4bobo2b3o5b
ob2obo4bobo4bo2b2o4bo21bo2b2o3b2o3b3obo3b3obobob2o2b2o3b2o54b2o$108b5o
14bobo2bo7bobobo2bo3bobobo2b3o2bob2obobo2bob2o12b2o7b2o4b4ob3o2bobo9bo
b2o3b2obo2bo$108bo19b2o10bobo3b2o4bo3b2o5bo2bobobo17bo2bo5bo6bo7b3obob
4o2bobobob3o3bob2o$110bo12bo13b2obobo15bo3b2obo2bob9o9bo8b3o5b3o2b2o4b
o2bo2bobo2b2o4bob2obo$109b2o10bobo13bobo2b2o12b2obobo3bobo5bo4bo13bo7b
o6bo2bo2b3obo7bo5b3o2bobo$122b2o15bobo2bobo2bo7bob4ob2obo4b2ob3o12b3o
6b2o11b2o2bob6obob2obo3bobob2o27bo$138bo2b2o3bo2bob4obo5bobobob3obo2bo
40bobo4bob2obobob2obo31bobo$72b2o63bo4b2o4bo5bo3bobo7b3o23b2o6b2o13bo
3bo9bo2bo32b2o$72bobo62bob3o2b4ob3o4bo2bo2bobobo7bo4bobo12bobo5bobo9bo
6b2o9b2o$75bo2b2o58bo3b2o3bobo3b4ob2obobo3bobo2bo6b2o15bo4bo2bo5bo3bo$
73b2obo2bo4bo27b2o25b3o2b3o3b3o5bo2bo2b3o13bo15b2o4b2o6b3ob2ob2o$72bob
ob2o4b2o6b2o20bobo26bo2bo8b4obob2o40bo10bo5bo$73bo9b2o5bobo21bo4b2o31b
o3bo2bo2b3o3b2o2b2o39bo4bo$66b2o25bo16b4ob2o2bo2bo29bobobo4bo2bo3b2o2b
2o33bo5bo3bo4bo$67bo23b2obob2o12bo2bobobobob2o30bobob5obo20b3o18bobo
13bobo$67bobo17b4o3b2obo15bobobobo35bo7b2o19bo2bo18b2o6b5o2bo2bo$68b3o
14bo2bo3b2o20b2obobo16bo17b2ob2ob2o2bo18bo3bo30b2o2b2o$70b3o11bo2bo2b
3ob3o21bo15bobo9bob2o2b3o4bo3b2ob2obobob2o8b4o32b3o$70bo2bo10b2o5b2o3b
o38b2o9b2ob3o2bo4bo4bob3o2b5o8bo34bobo32bo$71b2o11b3o5b4o8b2o48bo3b2o
3bobo6bob3o18b2o23bo33bobo$76bo7b3o4bo4b3o6bo7b2o36bo3b2o5bobob2o2b2o
3bobo18b2o23b3o30b2o$76b2o6b2o5b2o2bo2bo6bobo5b2o35bo2bo3b2obo6bo2bobo
4bo17bo27bo$72bo5bo5bo11b2o8b2o42b4obobob2ob2o2b2o2bobo4bo11b2o12b2o$
63bo7bo3bobo4bobobo67bobo5bo4bob2obo3bo2b2o20bo3bo$63b3o6bo9b2obobo64b
obobob3obo8bo5bobo2bo18bo5b2o$66bo6b2o10bobo32bobo29b2o3bobobo6b2o2b7o
2b2o18bo3bo2bo$65bo2bo16b2o34b2o46b3o31b2o4bo10bo$65b4o52bo45bo4bo2b2o
31b2o8bobo$109bo57b2ob2o3b2o16bo15bo9b2o$67b2o3b2o35b2o5b2o31bo18bobo
21b2o6b2o3b2o$67bo4b2o34bobo5bo30bobo18bobo20bo2bo5bobob2o$69bo47b3o
28b2o19bo21bobo7bo3bo35bo$68b2o49bo63b2o6bo2bo10bo35bobo$182bobo6bo2bo
10b2o34b2o$83bobo10bo85bo9bobo7bo2bo$84b2o8b3o84b2o8b3o8b3obo$84bo8bo
111bo3b2o$93b2o107b2o6bo$133bobo66bob6o$134b2o97bo$134bo51b2o18b2o23bo
bo$96bo88bobo18b2o24b2o$96b2o64bo24bo$95bobo62bobo$83b2o76b2o12bo28bo
23bo$82bobo6bo81b3o27bobo22bobo$82bo7b2o80bo20bo9bobo22b2o$81b2o6b2o
81b2o18bobo7b2ob3o$91bo99b2ob2o12bo$91bo3bo89b2o4bo2bo7b2ob3o$94bobo
69b3o15bo2bo4b2o8b2obo$91bobo2bo49bobo16bo4bob2obo8bobo2bo$87bo2bobobo
bob2o47b2o16bo3bobo3bo7b2ob4o56bo$87b4ob2o2bo2bo47bo17bo4bo4bo20b3o45b
obo$91bo4b2o64b2o2b2o5b2o13b2o8bo8bo37b2o$89bobo69bobo4bo3bo15bo8bo9b
3o$89b2o70bo6bo3bo13bobo21bo$160b2o7b3o14b2o21b2o4bo$203b2o10bobo$174b
o28bobo9b2o$170b2obobo27bo$169bobobobo$166bo2bobobobob2o$166b4ob2o2bo
2bo$159bobo8bo4b2o42b2o$160b2o6bobo41b2o5bobo37bo$160bo7b2o13b3o26b2o
7bo35bobo$185bo35b2o35b2o$184bo$157bo32b2o16bo$157b3o29bo2bo14bobob2o$
144b2o7b2o5bo29bobo14bobobobo$142b3obo6bo3b2obo28b2o2b2o9b2obobobobo2b
o$141bo4bo8bo2bob2o22bo2b2o2bobo10bo2bo2b2ob4o$140bo2b3ob2o5b3obo4b2o
22b4o2bo12b2o4bo$140b3o2bo3bob2o5b5obo18b2o2bo2bobo19bobo$143bo2b2obob
ob5o2bo23bo6bo21b2o$140b4o5bo3bo4bobob2o17b3o3bo$140bo3b4obobob3obo15b
2o4bo4bobobo83bo$141b2o4bo2bobo4b2obo3bo8bo5bobob2o2bo82bobo$142bobobo
3bob2o7bo3b2o6b3o3bo2b3o86b2o$142bo4bo5bo2bob3o13b2o$140b2obo3b2obo2bo
bo2bo2b2o2b2o$141bobob2obo4bo2bobo6b2o$141bobo2bobo4bo4bobo3bobob2o$
140b2ob2o2bo8bobobobobob2obo$156b2o10bo!
`
  },
  {
    name: 'Twogun',
    category: 'Guns',
    rle: `#N twogun
#O V. Everett Boyer and Doug Petrie
#C At one point this was the smallest known period-60 gun.
#C It uses two copies of the Gosper glider gun.
x = 39, y = 27, rule = b3/s23
27bo11b$25bobo11b$15b2o6b2o12b2o$14bo3bo4b2o12b2o$3b2o8bo5bo3b2o14b$3b
2o8bo3bob2o4bobo11b$13bo5bo7bo11b$14bo3bo20b$15b2o22b$26bo12b$27b2o10b
$26b2o11b4$21b2o16b$9bobo10b2o15b$9bo2bo8bo17b$2o10b2o11b2o12b$2o8bo3b
2o8bobo12b$5b2o5b2o9bo6b2o7b$4bo4bo2bo10bo2bo2bo2bo6b$9bobo11bo6b3o6b$
24bobo5b3o4b$25b2o6bobo3b$35bo3b$35b2o!`
  },
  {
    name: 'Loaf',
    category: 'Still lifes',
    rle: `#N Loaf
#C A very common 7-cell still life.
#C www.conwaylife.com/wiki/index.php?title=Loaf
x = 4, y = 4, rule = B3/S23
b2ob$o2bo$bobo$2bo!
`
  },
  {
    name: 'Eater 1',
    category: 'Still lifes',
    rle: `#N Eater 1
#O Bill Gosper
#C The first discovered eater and a 7-cell still life.
#C https://www.conwaylife.com/wiki/index.php?title=Eater_1
x = 4, y = 4, rule = B3/S23
2o2b$obob$2bob$2b2o!
`
  },
  {
    name: 'Bi-Cap',
    category: 'Still lifes',
    rle: `#N mirroredcap.rle
#C https://conwaylife.com/wiki/Mirrored_cap
#C https://www.conwaylife.com/patterns/mirroredcap.rle
x = 7, y = 4, rule = B3/S23
b2ob2o$obobobo$obobobo$b2ob2o!
`
  },
  {
    name: 'Bakery',
    category: 'Still lifes',
    rle: `#N Bakery
#C A common 28-cell still life formation of two bi-loaves.
#C www.conwaylife.com/wiki/index.php?title=Bakery
x = 10, y = 10, rule = B3/S23
4b2o4b$3bo2bo3b$3bobo4b$b2obo3bob$o2bo3bobo$obo3bo2bo$bo3bob2ob$4bobo
3b$3bo2bo3b$4b2o!
`
  },
  {
    name: 'Shillelagh',
    category: 'Still lifes',
    rle: `#N Shillelagh
#C A common 8-cell still life.
#C https://www.conwaylife.com/wiki/index.php?title=Shillelagh
x = 5, y = 3, rule = B3/S23
2o3b$o2b2o$b2obo!
`
  },
  {
    name: 'BTS',
    category: 'Still lifes',
    rle: `#N BTS
#O enumerated by Mark Niemiec, use as catalyst found by Tanner Jacobi
#C 19-bit still life that's used as a catalyst in non-Spartan Herschel conduits.
#C https://conwaylife.com/wiki/BTS
x = 7, y = 8, rule = B3/S23
3b2o$3bo2bo$4b3o2$2obob2o$ob2obo$5bo$5b2o!
`
  },
  {
    name: 'Centinal',
    category: 'Oscillators',
    rle: `#N Centinal
#O Bill Gosper
#C A period 100 oscillator based on the p54 shuttle and the twin bees shuttle.
#C www.conwaylife.com/wiki/index.php?title=Centinal
x = 52, y = 17, rule = B3/S23
2o48b2o$bo48bob$bobo21b2o21bobob$2b2o8bo12b2o12b2o7b2o2b$11b2o26bobo
10b$10b2o29bo10b$11b2o2b2o22b3o10b4$11b2o2b2o22b3o10b$10b2o29bo10b$11b
2o26bobo10b$2b2o8bo12b2o12b2o7b2o2b$bobo21b2o21bobob$bo48bob$2o48b2o!
`
  },
  {
    name: 'Sir Robin',
    category: 'Spaceships',
    rle: `#N Sir Robin
#O Adam P. Goucher, Tom Rokicki; 2018
#C The first elementary knightship to be found in Conway's Game of Life.
#C https://conwaylife.com/wiki/Sir_Robin
x = 31, y = 79, rule = B3/S23
4b2o$4bo2bo$4bo3bo$6b3o$2b2o6b4o$2bob2o4b4o$bo4bo6b3o$2b4o4b2o3bo$o9b
2o$bo3bo$6b3o2b2o2bo$2b2o7bo4bo$13bob2o$10b2o6bo$11b2ob3obo$10b2o3bo2b
o$10bobo2b2o$10bo2bobobo$10b3o6bo$11bobobo3bo$14b2obobo$11bo6b3o2$11bo
9bo$11bo3bo6bo$12bo5b5o$12b3o$16b2o$13b3o2bo$11bob3obo$10bo3bo2bo$11bo
4b2ob3o$13b4obo4b2o$13bob4o4b2o$19bo$20bo2b2o$20b2o$21b5o$25b2o$19b3o
6bo$20bobo3bobo$19bo3bo3bo$19bo3b2o$18bo6bob3o$19b2o3bo3b2o$20b4o2bo2b
o$22b2o3bo$21bo$21b2obo$20bo$19b5o$19bo4bo$18b3ob3o$18bob5o$18bo$20bo$
16bo4b4o$20b4ob2o$17b3o4bo$24bobo$28bo$24bo2b2o$25b3o$22b2o$21b3o5bo$
24b2o2bobo$21bo2b3obobo$22b2obo2bo$24bobo2b2o$26b2o$22b3o4bo$22b3o4bo$
23b2o3b3o$24b2ob2o$25b2o$25bo2$24b2o$26bo!
`
  },
  {
    name: 'Space Rake',
    category: 'Special',
    tag: 'Rake',
    rle: `#N Space rake
#C An orthogonal period 20 c/2 forward glider rake.
#C www.conwaylife.com/wiki/index.php?title=Space_rake
x = 22, y = 19, rule = 23/3
11b2o5b4o$9b2ob2o3bo3bo$9b4o8bo$10b2o5bo2bob2$8bo13b$7b2o8b2o3b$6bo9bo
2bo2b$7b5o4bo2bo2b$8b4o3b2ob2o2b$11bo4b2o4b4$18b4o$o2bo13bo3bo$4bo16bo
$o3bo12bo2bob$b4o!
`
  },
  {
    name: 'Beehive',
    category: 'Still lifes',
    rle: `#N Beehive
#O John Conway
#C An extremely common 6-cell still life.
#C www.conwaylife.com/wiki/index.php?title=Beehive
x = 4, y = 3, rule = B3/S23
b2ob$o2bo$b2o!
`
  }
];

/* Separate preset library for Larger-than-Life mode (Alt+Y), kept apart from `presets` above
   since those are all classic square-grid Moore B3/S23-family patterns (gliders, oscillators,
   guns) that have no meaning under LTL's radius-based rule model. Same {name, category, rle,
   tag} shape as `presets` so openPresetModal() (parameterized below) can render either list
   with identical UI/behavior. */
const presetsLTL = [
  {
    name: 'Bug-Collection',
    category: 'Spaceships',
    tag: 'Collection',
    rle: `#CXRLE Pos=0,0
x = 123, y = 131, rule = R5,C0,S33-57,B34-45
11bo3bo78bo4bo$11bo9bo71b3o3bo$9b3o3bo3b3o3b3o53b3o3b3o4bo4b3o$9bobo3bo3bobo3bobo53bobo3bo6bo4bobo$9b3o3bo3b3o3b3o53b3o3bo6bo4bobo$27bo$25b3o6$42b3o70b3o$40b6o68b6o$40b7o66b9o$7b3o7bo3bo3b3o12b8o41bo7bo3bo10b2o3b6o$7bo8bo4bo3bobo11b4o2b5o39bo6bo4bo10bo5b5o$7b3o5bo5bo3bobo11b3o4b4o39bo5bo5bo9b2o6b4o$7bobo4bo6bo3bobo10b3o6b4o38bo4bo6bo10bo5b5o$7b3o3bo7bo3b3o11bo6b5o38bo3bo7bo10b2o3b6o$39b2o4b5o63b9o$40b2o2b6o64b6o$41b2ob5o66b3o$43b3o10$115b4o$43b4o67b7o$42b6o65b9o$41b8o36b3o7bo3b3o10b2o3b5o$b3o3b3o7bo3bobo3b3o11b9o37bo6bo6bo10bo5b5o$3bo5bo6bo4bobo5bo10b3o4b4o34b3o5bo5b3o10bo5b5o$b3o3b3o5bo5b3o3b3o10b2o5b4o34bo6bo6bo12b2o3b5o$bo7bo4bo8bo3bo12b2o5b4o34b3o3bo7b3o11b9o$b3o3b3o3bo9bo3b3o11bo4b5o63b7o$42bo2b5o65b4o$43b5o$44b2o9$116bo$115b4o$43b5o66b7o$42b6o37b3o7bo3b3o11b10o$42b7o36bo8bo4bo12b2o4b5o$9b3o7bo3bo3b3o11b10o34b3o5bo5b3o10bo6b4o$9bobo6bo4bo3bo13b3o3b4o36bo4bo6bobo10bo6b4o$9b3o5bo5bo3b3o10b3o4b4o34b3o3bo7b3o10b2o4b5o$9bobo4bo6bo3bobo11bo5b4o62b10o$9b3o3bo7bo3b3o11b2o3b5o63b7o$42b2ob5o65b4o$43b5o68bo$45bo10$116b2o$42b4o69b5o$41b6o67b8o$41b7o37bobo7bo3b3o11bob8o$15bo7bo3b3o11b8o36bobo6bo4bo12b2o4b5o$15bo6bo6bo10b4ob5o35b3o5bo5b3o10b2o4b5o$15bo5bo5b3o10b2o4b4o37bo4bo8bo10b2o4b5o$15bo4bo6bo12bo5b4o37bo3bo7b3o11bob8o$15bo3bo7b3o10b2o4b4o64b8o$41b2o2b5o65b5o$42b7o67b2o$43b3o10$116bo$115b3o$114b6o$113b8o$81b3o7bo3bo3b3o10b3o2b6o$81bobo6bo4bo5bo10bo5b5o$81b3o5bo5bo3b3o9b2o6b4o$81bobo4bo6bo3bo12bo5b5o$81b3o3bo7bo3b3o10b3o2b6o$113b8o$114b6o$115b3o$116bo11$116b2o$114b6o$43b4o66b9o$42b6o33b3o7bo3bo3b3o10b4o2b4o$bo2bo6b3o2bo7bo2bobo11b9o33bo6bo4bo5bo10b2o5b4o$o3bo8bo3bo5bo3bobo10b10o33bo5bo5bo3b3o10b2o5b4o$o3bo6b3o3bo4bo4b3o10b2o4b4o33bo4bo6bo5bo10b2o5b4o$o3bo2b2o2bo5bo3bo7bo10b2o4b4o33bo3bo7bo3b3o10b3o4b4o$bo2bo2b2o2b3o2bo3bo8bo10b2o3b5o62b4o2b4o$8bo32b2ob6o63b9o$7bo34b7o65b6o$44b2o70b2o!
`
  },
  {
    name: 'Soldier Bugs',
    category: 'Oscillators',
    tag: 'Will Change Rule!',
    rle: `#CXRLE Pos=0,0
x = 113, y = 113, rule = R7,C0,S64-113,B65-95
49b4o$47b7o$46b10o$45b12o$45b13o19b2o$44b3o5b6o17b6o$22b3o19b3o5b6o16b9o$20b7o17b3o5b6o15b11o$19b9o16b3o5b6o14b3ob9o$18b12o15b3o2b8o14b3o4b7o$18b13o14b12o14b3o6b6o$17b5o3b6o15b10o15b3o6b6o$17b2o7b5o16b7o17b3o6b6o$17b2o7b5o18b3o20b3obo2b7o$17b3o5b6o41b13o$17b3o2b9o42b11o$18b3ob8o44b8o$19b10o46b6o16b5o$20b7o50b2o17b8o$21b5o69b4o2b4o$94b3o4b5o$93b3o5b5o$93b5o4b5o$93b5o4b5o$93b5o4b5o$93b6o2b5o$94b12o$9b5o81b10o$8b7o80b9o$7b9o80b8o$6b10o81b6o$6b11o$5b13o$5b5o3b5o$4b5o5b5o$4b5o5b5o$5b4o4b5o$5b3o6b4o$6b4o3b4o$7b9o$8b7o$10b3o3$104b4o$102b8o$101b10o$100b4o4b4o$100b3o5b4o$99b4o5b5o$99b5o4b5o$99b5o4b5o$100b13o$100b12o$101b10o$4b6o91b10o$3b8o91b8o$2b10o91b6o$2b10o$b12o$13o$5o4b5o$5o4b5o$5o5b4o$b4o5b3o$b4o4b4o$2b10o$3b8o$5b4o3$100b3o$98b7o$97b9o$96b4o3b4o$95b4o6b3o$95b5o4b4o$94b5o5b5o$94b5o5b5o$95b5o3b5o$95b13o$96b11o$10b6o81b10o$9b8o80b9o$9b9o80b7o$8b10o81b5o$7b12o$7b5o2b6o$6b5o4b5o$6b5o4b5o$6b5o4b5o$7b5o5b3o$7b5o4b3o$8b4o2b4o69b5o$9b8o17b2o50b7o$11b5o16b6o46b10o$31b8o44b8ob3o$29b11o42b9o2b3o$28b13o41b6o5b3o$27b7o2bob3o20b3o18b5o7b2o$27b6o6b3o17b7o16b5o7b2o$27b6o6b3o15b10o15b6o3b5o$27b6o6b3o14b12o14b13o$27b7o4b3o14b8o2b3o15b12o$28b9ob3o14b6o5b3o16b9o$29b11o15b6o5b3o17b7o$30b9o16b6o5b3o19b3o$32b6o17b6o5b3o$34b2o19b13o$56b12o$57b10o$59b7o$60b4o!
`
  },
  {
    name: 'Bug Gun',
    category: 'Guns',
    rle: `#CXRLE Pos=0,0
x = 28, y = 90, rule = R5,C0,S33-57,B34-45
4b2o15b3o$2b6o12b5o$b2o2b4o10b7o$2o3b5o9b8o$o5b4o8b4o2b4o$3o3b4o8b2o4b4o$10o7b2o6b3o$b8o9bo5b4o$b7o11bo3b5o$2b5o13b7o$4b2o15b3o32$19b6o$19b6o$19b6o$19b6o$19b6o$19b6o32$4b2o15b3o$2b5o13b7o$b7o11bo3b5o$b8o9bo5b4o$10o7b2o6b3o$3o3b4o8b2o4b4o$o5b4o8b4o2b4o$2o3b5o9b8o$b2o2b4o10b7o$2b6o12b5o$4b2o15b3o!
`
  }
];

/* Add new presets: amphisbaena (still life) and Toad (oscillator) so they appear in the identification/presets menus */
presets.push({
  name: 'Amphisbaena',
  category: 'Still lifes',
  rle: `x = 7, y = 6, rule = B3/S23
5b2o$4bobo$4bo2b$b2obo2b$o2bo3b$2o5b!`
});

presets.push({
  name: 'Toad',
  category: 'Oscillators',
  rle: `x = 4, y = 4, rule = B3/S23
2bob$o2bo$o2bo$bo2b!`
});

/* V-Gun preset: use the repository text file for download/load and for preview.
   Store a filePath so the UI knows to fetch the .txt and render its RLE for the thumbnail. */
presets.push({
  name: 'V-Gun',
  category: 'Guns',
  // small fallback RLE is kept for environments without fetch; primary source is filePath
  rle: `x = 9, y = 9, rule = B3/S23
bo3bo3b$obo3bobo$2b3o3b$3b3o3$3b3o$2b3o3b$obo3bobo$bo3bo3b!`,
  filePath: '/V-Gun.txt'
});

presets.push({
  name: 'Backrake',
  category: 'Special',
  tag: 'Rake',
  rle: `#N backrake1puffer2phase.rle
#C https://conwaylife.com/wiki/Backrake_1
#C https://www.conwaylife.com/patterns/backrake1puffer2phase.rle
x = 27, y = 15, rule = B3/S23
5b3o11b3o$4bo3bo9bo3bo$3b2o4bo7bo4b2o$2bobob2ob2o5b2ob2obobo$b2obo4bo
b2ob2obo4bob2o$o4bo3bo2bobo2bo3bo4bo$12bobo$2o7b2obobob2o7b2o$12bobo$
6b3o9b3o$6bo3bo5bo3bo$6bobo8bo3bo$21bo$17bo2bo$18b3o!`
});

presets.push({
  name: 'Sparce Cordership Part',
  category: 'Special',
  tag: 'Rake',
  rle: `x = 37, y = 30, rule = B3/S23
2o2bo32b$3bobo31b$2bo16bo17b$19bo17b$4b2o13bo17b$37b$5b2o12b2o16b$4bo13bo2bo15b$2b2ob2o11bobo6b2o8b$5b2o10b2o8b2o8b$3bo13bo19b$20b2o15b$20b2o15b$20b2o15b$17b2obo16b$18b3o16b$19bo3bo11b2o$22bobo10b2o$22bobo12b$23bo13b$7b2o28b$7b2o28b$20b2o15b$18b2o2bo14b$18b2ob2o14b$19b3o15b$37b$37b$15b2o20b$15b2o20b!`
});

presets.push({
  name: 'Wilma',
  category: 'Special',
  tag: 'Methuselah',
  rle: `#N Wilma
#O Rob Liston
#C 2018-10-28
#C As of late October 2018, the longest-lived known methuselah in a 20x20 bounding box.
#C Lifespan: 39693 generations; initial population: 197; final population: 3524.
#C https://conwaylife.com/wiki/Wilma
x = 20, y = 20, rule = B3/S23
o2bob2o2bobo2bo$2o2b2ob3obob2o2b3o$b2o2bo3bob6o$2obo4b4obo3b2o$obob2ob
o2b3ob5o$b2ob3ob4o2b2ob3o$b2o6bo2b5ob2o$bo6bobob3obo2bo$o3bob3ob3o3bob
o$b2o2b2obob3o$b4o3bo4b2obo$2o2b6obo5bobo$bob3ob3obobo4bo$obobobobo3b
3o3b2o$2obobob2o3b2ob4o$ob2ob2o6bobo2bo$o3b2ob2ob2obo4bo$7o6bo4bo$2b2o
bo7b2o2b3o$o3b3o2bo3b3o2bo!`
});

presets.push({
  name: 'Acorn',
  category: 'Special',
  tag: 'Methuselah',
  rle: `#N Acorn
#O Charles Corderman
#C A methuselah with lifespan 5206.
#C www.conwaylife.com/wiki/index.php?title=Acorn
x = 7, y = 3, rule = B3/S23
bo5b$3bo3b$2o2b3o!`
});

presets.push({
  name: 'Iwona',
  category: 'Special',
  tag: 'Methuselah',
  rle: `#N Iwona
#O Andrew Okrasinski
#C A methuselah with lifespan 28786. Found on August 20, 2004.
#C www.conwaylife.com/wiki/index.php?title=Iwona
x = 20, y = 21, rule = B3/S23
14b3o3b6$2bo17b$3b2o15b$3bo14bob$18bob$18bob$19bo$18b2o$7b2o11b$8bo11b
5$2o18b$bo!`
});

presets.push({
  name: '52513M',
  category: 'Special',
  tag: 'Methuselah',
  rle: `#N 52513m.rle
#O Dylan Chen, 2021
#C https://conwaylife.com/wiki/52513M
#C https://www.conwaylife.com/patterns/52513m.rle
x = 16, y = 16, rule = B3/S23
3o2b2obob2ob3o$2obob3o4bobo$bo2bo2bobob3obo$2bo2b2o3bo2bo$2bo5bobo3b2o
$o4b2o3b3obo$3b2o2bo2bobo2bo$2b4obo2bob2o$2ob2o2b2o5b2o$ob4obo4b3o$o3b
4o2b3o$b10o2b3o$2o3bob3obob3o$b2ob6o3bobo$obo5b4obo$3obobob2o5bo!`
});

/* Sparce Cordership preset (exact RLE provided by user) */
presets.push({
  name: 'Sparce Cordership',
  category: 'Spaceships',
  rle: `#N sparsecordership.rle
#N s#N sparsecordership.rle
#C https://conwaylife.com/wiki/Cordership
#C https://www.conwaylife.com/patterns/sparsecordership.rle
x = 537, y = 669, rule = B3/S23
307b3o$306bo2bo$305bo4bo$305bo2b3o$305bo5bo$306b7o$312bo$312bo$310b2o
12b2o$324b2o3$309bo$308bobo$307b2obo$307b2o$308b3o21b2o$309bo22b2o$310b
o2bo$307bo6bo$307bo6bo$307bo4b3o5$320b2o$322bo$312b2o7bo$312b2o5b2o$318b
3o$317bo2bo$317bobo$317b3o2$295b3o$297bo22b2o$296bo23b2o14$263b3o$265b
o$264bo10$301bobo$301b2o$302bo2$231b3o$233bo$232bo14$199b3o$201bo$200b
o10$285bobo$285b2o$286bo2$167b3o$169bo$168bo7$325b2o3b4o$320b3obo2bo6b
o$324bo2bo2b5o$324bo2bo$326bo$323bobo17b2o$324bo18b2o$135b3o$137bo$136b
o4$351b2o$351b2o$338bo$329b3o7bo$324b2o3b4o7b2o$323b2o3bo4bo6b2o$269b
obo56b2ob2o4bo$269b2o57b4o3b4o2bo3bo$270bo58bo5bo9bo3b5o5b2o$335bobo3b
o5bobobo2bo4b2o$103b3o230b2obo4b2o5bo2bo$105bo244b2ob2o$104bo240b2o4b
2o$331b3obo8bo2bo$333b2o9bobo$335bo9bo4$314bo$314b2o$313bobo4$335b3o$
71b3o261bo2bo$73bo264bo$5bo66bo262b2o15b2o$4bob2o326bobo15b2o$8bo326b
o2b3o$2bo3bo2bo326b2o2bo$o9bo11b3o311bo3bo$o4b2o2b2o326bobo10bobo62b3o
$9b2o328bo12bo61bo3bo$2bo5bo273bo53bo2bo16bo56bo3b2o$3bo4b3o271b2o52b
o13b3o7b2o52bo$4bo4b2o12b3o5b2o248bobo67b2o7b2o53b4o$6b4o12b2ob2o4b2o
220bobo79b2o2bo11b2o64bob2o$21bobob2o226b2o81b3o13b2o63bo2bo$21bo3bo11b
obo214bo98bo64b2o12b2o$22bo2bo11bo2bo391b2o$22b3o14b2o$40bo277bo$316b
2o99bo$317b2o98bo$40bobo373bobo$346b3o3bo64bo$340b2o4bobo2bobo63b2o21b
2o$11b2o275bobo49b2o5b3o4bo62b3o20b2o$11b2o214b3o58b3o60bo$227bobo20b
o37b2o15bo44bo2bo61bo4b2o$226bo3bo19b2o53bo109bo5bo13bo$226bo3bo18bob
o52bo110bo5bo12bo2bo$45b3o178bo64bo13b2o113bo12b2ob2o$45bo180bo4b2o56b
obo12bo2bo126bo2bo$46bo179bo6bo55b3o12bobo41b2o83b4o11b2o$19b2o206bo5b
o58bo20b2o33b2o81b3o14b2o$19b2o206b2o59b5o12bo7b2o115bo$229bo3bo69bo2b
o12b3o106b2o3bo$230bobo71b4o13bo98b2o6b2o$240b2o64b2o12bo99b2o5b2o2b2o
$239bo2bo61bo122bob2o$227b3o10b2o61b2o121b2ob2o$226bo3bo72bo2bo120bob
o$227bo2bo73b3o121bo$229b2o74bo3$293b2o$61b3o229b2o$61bo$62bo2$232b2o
162bo$232b2o12bo149b2o25b2o$245b3o14b2o131bobo24bo$244bo10bo2bo4bo37b
2o119bo2bo$245b2ob2o6b3o2bo2bo36b2o117b2ob4o$246b3ob2o5b2o2bo2bo68bob
o83bo20b3o$248b4o9bo2bo68b2o84bo3b3o2bo$262b3o6b2o61bo84bo2bo2bob3o3b
obo$240b2o29b2o148b2o4b3o4bo$240b2o181b2obobo$414bo9b2obo14bo6b2o$412b
2o13bo12b4o5b2o$77b3o333b2o24bo3bo$77bo361bo2bo$78bo361b3o6bo$279b2o167b
ob2ob3o$248b2o23b2o4b2o83bo85b4o$248b2o23b2o89b2o81b3o2bo4b2o$363bobo
88bo$277b2o172b2o4b2o$256bo2bo13bob2ob2o173b3o$256b4o12b3obobo$271bo157b
2o$256bo2bo10b5o2bo151b2o11bobo$259bo9bo7bo155b3o6bo2bo$256bobo10bobo
2b3o106bo51bo6bo2bo$256b2o12b2o107b4ob2o5b3o40bo8b2o$378b2ob3ob2o4b3o
$93b3o184b3o96bob3obo7b2o$93bo286bo3b4o4b2o102b3o$94bo288b2ob3o48b2o56b
o3bo$384b5o13b2o33b2o55bo4bo$274bo57bo52bo16b2o89bo3bo$276bo55b2o159b
o2bob3o$331bobo159bo7bo$495bo3bobo$272bobo220bo3bob2o$271bo2bo22b2o18b
obo81b2o94b3ob2o$271bo28b2o4bo10b2o81bo2bo109b2o$271b2ob2o21b2ob4o3bo
10bo82bob2o5b2o101b2o$271b2o21b5o4b4o96b2o5b2o$272bobo22b3o6bo83bo12b
2o$273bo24bo88b2o4bo103b2o$297b3o82b2o5b2o3bo6b3o93b2o$109b3o192bo77b
2o7bob2o7bo95bo$109bo168bo25bo$110bo166bobo149bobo66bo22b2o$277b2o150b
2o90b2o$430bo$496bo5b3o11b2o$496bo7bo10b4o$390b2o104bo5bobo10b3ob2o$390b
2o110b2o15b2o$286bo231b2o$285bobo229b2o10b2o$285b2o227b2ob2o10b2o$299b
ob2obo209b3o$298bo4b3o204b5o$299bo5bo195b2o9bo$300bo3bo196b2o7b3o$125b
3o173bobo204bobo$125bo168bo211b2ob2o$126bo166bobo211bo2bo$293b2o213bo
bo$305b2o201b3o$305b2o3$328bo$302bo23b2ob2o$301bobo25b2o$301b2o23b3o15b
2o132bo$313b2o13bo3bo10bo2bo131b2o$313b2o12bo3bo145bobo24bobo$328b3ob
o170bo$330b2o172bo2bo$141b3o185bobo10b2o162bobo$141bo168bo19bo11b3o2b
2o160bo11b3o$142bo166bobo17b2o12bo69bobo92b3o$309b2o17b3o11b2o5bo2b2o
59b2o93bo$321b2o5bob2o11bo4bo3b2o60bo91b2o$321b2o4b5o11bo164bo13b3o$344b
obo159bo2bo12b3o5b2o$345bo8bo139bo11bobo13b2o6b2o$354bo137b2o12bo14bo
$318bo174b2o24b2o2bo$317bobo22b3o16bo158bo3bo9bo$317b2o23b3o15b2o84bo
73bo2bo10bo$329b2o14b2o3bo7bo2bo84b2o73b3o7bo$329b2o10b3o2bo13bo84bob
o79b2o6bo$359b2o167b4o$346bo185bo3bo$157b3o181b2o3bo7bo178bo$157bo168b
o15bo2bo7b3o178bobo$158bo166bobo15bobo7b3o154b2o11b3o9bo$325b2o25b2ob
2o153b2o3b3o5b4o$353b3o161bo4b2o2b2o$353b3o116bo43bo6b2obo$458b2o7b2o
2bobo49b3o$458b3o6b4o3bo49bo$458b2obobo7bo$334bo126b2o10bob2o$333bobo
137bobo42b2o$333b2o79bo59bo8b2o33b2o$414b2o67b2o$413bobo3$173b3o307bo
$173bo177bo130bobo$174bo175bobo44bobo82bo2bo$350b2o28b2o3b4o8b2o85bo6b
2o$375b3obo2bo6bo8bo85b2o5b2o$379bo2bo2b5o$379bo2bo89b3o8bo$381bo81b2o
5bo4bo7b3o$378bobo82b2o6b2o2bo6bo2bo$359bo19bo91bo11bo$358bobo$358b2o
149bobo$509b2o$510bo2$471b2o$189b3o134bobo142b2o$189bo136b2o39bo$190b
o136bo38bobo$366b2o16b3o$379b2o3b4o$378b2o3bo4bo$383b2ob2o$383b4o$384b
o$375bo$374bobo$374b2o$386b2o$386b2o3$205b3o$205bo177bo$206bo175bobo$
382b2o$394b2o$394b2o26bo$408bobo6bo2b4o$407bo9bob4o$408bo2bo6b3o3b2o$
391bo18b3o9bo2b2o$390bobo30bob2o$390b2o32bo8b2o58bobo$402b2o29b2o58b2o
$402b2o90bo3$221b3o86bobo$221bo88b2o87bo$222bo88bo86bobo$398b2o41b2o$
410b2o23bo5b2o$410b2o22bobo$436bo$418b2o13b2ob3o$420bo8bob2o2b2ob2o$407b
o13bo7bobo2b2o2bo$406bobo9bobo7bo3bo2b3o$406b2o11bo9bob2o3bo$430b3o2b
o$435bo$418b3o14bo2$237b3o202b3o$237bo177bo$238bo175bobo$414b2o17bobo
2bo$434b2o2bo$433b2o3bo$435bo2bo$438bo$437bo$434bob2o$434b3o$435bo41b
obo$477b2o$418bo59bo$417bo$417b3o$253b3o38bobo$253bo40b2o144bo$254bo40b
o143bobo$439b2o6$448bo$447bobo$447b2o5$269b3o$269bo186bo$270bo184bobo
$455b2o10$402bo$401bo$401b3o23bo$278bobo4b3o125b2o7b2o2bobo$278b2o5bo
127b3o6b4o3bo$279bo6bo126b2obobo7bo$416b2o10bob2o$428bobo$429bo8b2o$438b
2o7$446b2o$432bo13b2o$432b2o$301b3o129bo$301bo116b2o12bo$302bo115b2o24b
o$444bo2$433bo$452bo$431bo2bo16bobo4$425bo$425bobo$386bo38b2o$385bo25b
3o$385b3o25bo$262bobo52b3o92bo$262b2o53bo$263bo54bo11$358b3o$358bobo18b
3o$358bobo20bo$333b3o22bo4b2o15bo$333bo23b3o3b2o$334bo28bo$359b4o$360b
2o$360bo$371b2o$361bo8bo2bo$359bobo9b2o$358b4o$358b3o$360bo48bo$409bo
bo$409b2o3$246bobo100b3o29bobo$246b2o101bo30bo2bo$247bo102bo30bobo$363b
2o32b2o$363b2o32bobo$383bo13b3o$382bob2o11bo2bo$382bob2o12bo$381bo3bo
12bo7b2o$382b4o20b2o$382b3o15bo$371b2o24bo$371b2o24bo2bo$396b3o$396b3o
$396bo2bo$365b3o29bobo$365bo31b3o$366bo$379b2o$379b2o5b2o$386b2o6$387b
2o$387b2o5b2o$394b2o3$230bobo148b3o$230b2o149bo$231bo150bo$395b2o6bo$
395b2o5bobo$402bobo$403bo2$398b2o$397bo2bo$398b2o6$397b3o$397bo$398bo
14$214bobo152b2o$214b2o154b2o$215bo153bo14$337b2o$338b2o$337bo14$198b
obo104b2o$198b2o106b2o$199bo105bo14$273b2o$274b2o$273bo14$182bobo56b2o
$182b2o58b2o$183bo57bo14$209b2o$210b2o$209bo8$148bo$140b3o3b4o$140bob
o3b2ob2o$140b3o2bo$145b2o3bo$146b4o$147b3o10b2o4bobo8b2o$160b2o4b2o10b
2o$167bo9bo7$155bo$144b2o9b3o$143bobobo7b3o$143bo3b2o5bo3bo$144b2o8b4o
$144b3o7bob2o6$148b2o$148b2o7$156b2o$156b2o!
`
});

/* Utility to create a small thumbnail canvas rendering of an RLE (no textual code shown) */
function renderThumbnailFromRLE(rleText, size = 96) {
  try {
    const cells = parseRLE(rleText);
    const thumb = document.createElement('canvas');
    thumb.width = size; thumb.height = size;
    const tctx = thumb.getContext('2d');
    tctx.fillStyle = '#000';
    tctx.fillRect(0,0,size,size);
    if (!cells || cells.length === 0) return thumb;
    // compute bounds
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const c of cells) {
      if (c.x < minx) minx = c.x;
      if (c.x > maxx) maxx = c.x;
      if (c.y < miny) miny = c.y;
      if (c.y > maxy) maxy = c.y;
    }
    const w = maxx - minx + 1;
    const h = maxy - miny + 1;
    const pad = 2;

    // Use a fractional cell size so even very large patterns fit inside the thumbnail
    const cellPxFloat = (size - pad*2) / Math.max(w, h);
    const cellPx = Math.max(0.5, cellPxFloat); // allow subpixel but avoid zero
    const totalW = cellPx * w;
    const totalH = cellPx * h;
    const offX = (size - totalW) / 2;
    const offY = (size - totalH) / 2;

    tctx.fillStyle = '#0f0';
    // draw each cell using fractional coordinates to preserve all cells (no cropping)
    for (const c of cells) {
      const cx = c.x - minx;
      const cy = c.y - miny;
      tctx.fillRect(offX + cx*cellPx, offY + cy*cellPx, Math.max(0.5, cellPx), Math.max(0.5, cellPx));
    }
    return thumb;
  } catch (err) {
    const thumb = document.createElement('canvas');
    thumb.width = size; thumb.height = size;
    const tctx = thumb.getContext('2d');
    tctx.fillStyle = '#111'; tctx.fillRect(0,0,size,size);
    tctx.fillStyle = '#f00'; tctx.fillText('err', 4, 12);
    return thumb;
  }
}

addEventListener('keydown', (e) => {
  // Let normal typing/pasting/editing work in any focused text field (textarea, text input,
  // or contenteditable element) -- e.g. the Ctrl+X RLE paste box, Shift+M's RLE box, rule
  // prompts, etc. Without this guard, single-letter and Ctrl+key game shortcuts below would
  // intercept and preventDefault() on ordinary keystrokes typed into those fields, breaking
  // typing and paste. We only skip the game's shortcut handling here -- the browser's native
  // paste/typing/undo/select-all behavior for the focused field is left completely alone.
  const __activeEl = document.activeElement;
  const __activeTag = __activeEl && __activeEl.tagName;
  const __isTypingTarget = __activeEl && (
    __activeTag === 'TEXTAREA' ||
    (__activeTag === 'INPUT' && !['checkbox','radio','button','submit','range'].includes((__activeEl.type || '').toLowerCase())) ||
    __activeEl.isContentEditable
  );
  if (__isTypingTarget) {
    // Still allow Escape to close/blur out of the field (common expectation), but otherwise
    // let every other key -- including Ctrl+V paste, Ctrl+A select-all, Enter, letters, etc. --
    // reach the field normally with no game-shortcut interference.
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
  }

  // P-mode virtual modifiers: compute convenient flags for handlers.
  // pMode === 'shift' makes handlers treat the event as if Shift were held;
  // pMode === 'ctrl' makes handlers treat the event as if Ctrl were held.
  const isShiftLike = (e.shiftKey || pMode === 'shift');
  const isCtrlLike = (e.ctrlKey || pMode === 'ctrl');

  // Always allow '/' to toggle the small FPS counter and prevent the browser's find shortcut.
  if (e.key === '/') {
    fpsVisible = !fpsVisible;
    e.preventDefault();
    return;
  }

  // Hex Mode key restriction: while hex mode is active, only a specific allowlisted set of
  // controls are permitted -- everything else (Rule Spots, RLE/macrocell/presets already gated
  // elsewhere, Scramble, landing map, etc.) is either incompatible with hex topology or just
  // hasn't been vetted for it, so it's blocked here rather than left to fail unpredictably.
  // Ctrl+I (the mode toggle itself) and Escape/Shift+Escape (safety valves) always pass through
  // regardless of this list, so the player is never trapped.
  if (hexMode) {
    const kLower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const ctrl = e.ctrlKey || pMode === 'ctrl';
    const shift = e.shiftKey || pMode === 'shift';
    const alt = e.altKey;
    const isCtrlI = kLower === 'i' && ctrl;
    const isEscape = (e.key === 'Escape' || e.key === 'Esc');
    if (!isCtrlI && !isEscape) {
      // Exact (key, ctrl, shift) combinations allowed in Hex Mode. None involve Alt, so any
      // Alt-held combo (e.g. Alt+X, the Ancestor Finder) is blocked here too -- Alt Finder is
      // square-grid-only and never offered while Hex Mode is active.
      const HEX_ALLOWED = [
        ['a', false, false], ['s', false, false], ['z', false, false], ['x', false, false],
        ['j', false, false], ['j', true, false], ['j', false, true],
        ['f', false, false],
        ['q', false, false], ['w', false, false], ['e', false, false],
        ['r', false, false], ['r', false, true], ['r', true, false],
        ['p', false, false],
        ['o', false, true], ['l', false, true],
        ['c', false, false], ['v', false, false], ['d', false, false],
        ['b', false, false], ['b', true, false],
        ['z', false, true], ['u', false, false],
        ['g', false, false], ['g', true, false],
      ];
      const isArrow = kLower === 'ArrowUp' || kLower === 'ArrowDown' || kLower === 'ArrowLeft' || kLower === 'ArrowRight';
      const isAllowed = !alt && (isArrow || HEX_ALLOWED.some(([k, c, s]) => k === kLower && c === ctrl && s === shift));
      if (!isAllowed) {
        e.preventDefault();
        return;
      }
    }
  }

  // LTL Mode key allowlist: while Larger-than-Life mode is active, only controls verified safe
  // under LTL's very-large-radius rule model are allowed through; everything else is blocked by
  // default. This replaces an earlier blocklist (which only named the handful of controls known
  // to be unsafe) so that a NEW control added later is automatically blocked here until someone
  // deliberately reviews it and adds it below -- the old blocklist required remembering to add
  // every future LTL-unsafe control by hand, which is easy to forget.
  //
  // Built by reading every branch of this handler (including nested shift/ctrl sub-branches, not
  // just top-level ones -- e.g. plain V/panStep vs Shift+V/rewind are the same top-level branch
  // but need different LTL-allowed answers) rather than guessing, so this is a complete,
  // verified accounting of every control that existed at the time this was written, not a
  // partial list. Excluded, and why:
  //   Ctrl+H  FastForward panel        -- accelerator hardcodes 8-neighbor Moore stepping
  //   Alt+X   Ancestor Finder          -- built for square Moore B3/S23-family rules
  //   Ctrl+I  Hex Mode toggle          -- entirely different topology swap
  //   Shift+V reverse-time rewind      -- LTL keeps no history to rewind
  //   Shift+Y rule presets modal       -- curated B/S presets, Moore-only
  //   Alt+N   Portal mode              -- edge linking assumes a radius-1 neighborhood
  //   Ctrl+E  Rule Spot panel          -- places Bn/Snn-string regions, same Moore assumption
  // B and Ctrl+B are allowed -- they have their own LTL-specific rule-prompt/reset behavior
  // instead of the classic Bn/Snn prompt, handled by the ltlMode check inside the B-key branch
  // itself. Alt+H (the mode toggle) is handled well before this gate and is never affected by
  // it, so the player can always get back out.
  if (ltlMode) {
    const kLower2 = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const ctrl2 = e.ctrlKey || pMode === 'ctrl';
    const shift2 = e.shiftKey || pMode === 'shift';
    const alt2 = e.altKey;
    const isArrow2 = e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const isSpace2 = e.code === 'Space' || e.key === ' ';
    // Keys where every modifier combination is safe (no per-combo exclusions needed).
    const LTL_ALLOWED_ANY_MOD = new Set([
      'a','s','o','c','-','_','=','+','w','g','t','u','l','h','n','m','k','j','q','p','z','d',
      'r','i','b','f','y','x','v','e',
    ]);
    const isAllowed2 =
      isArrow2 || isSpace2 || e.key === '0' || e.key === '9' || e.key === '`' ||
      e.key === 'Escape' || e.key === 'Esc' || e.key === '/' ||
      (LTL_ALLOWED_ANY_MOD.has(kLower2) &&
        !(kLower2 === 'h' && ctrl2) &&      // Ctrl+H: FastForward panel
        !(kLower2 === 'x' && alt2) &&       // Alt+X: Ancestor Finder
        !(kLower2 === 'i' && ctrl2) &&      // Ctrl+I: Hex Mode toggle
        !(kLower2 === 'v' && shift2 && !ctrl2) && // Shift+V: reverse-time rewind
        !(kLower2 === 'y' && shift2) &&     // Shift+Y: rule presets modal
        !(kLower2 === 'n' && alt2) &&       // Alt+N: portal mode
        !(kLower2 === 'e' && ctrl2));       // Ctrl+E: Rule Spot panel
    if (!isAllowed2) {
      flashTinyToast("That control isn't available in Larger-than-Life mode. Press Alt+H to leave LTL mode.", 2200);
      e.preventDefault();
      return;
    }
  }

  // Global temporary controls lock: block all player key input until controlsLockedUntil.
  if (performance.now() < controlsLockedUntil) { e.preventDefault(); return; }

  // Shift+Escape (or P-mode + Escape) -> return to main menu overlay immediately.
  if ((e.key === 'Escape' || e.key === 'Esc') && (e.shiftKey || pMode === 'shift')) {
    try {
      // if startup sequence is still active, finish/clear it first
      if (startupActive) finishStartupNow();
    } catch (err) {}
    try {
      createMainMenuOverlay();
    } catch (err) {}
    e.preventDefault();
    return;
  }

  // Ctrl+Q -> clear the persistent landing map and hide its overlay
  if ((e.key === 'q' || e.key === 'Q') && (e.ctrlKey || pMode === 'ctrl')) {
    try {
      deadLanding.clear();
      landingMapVisible = false;
      flashTinyToast('Landing map cleared (Ctrl+Q)');
    } catch (err) {
      console.warn('Failed to clear landing map:', err);
    }
    e.preventDefault();
    return;
  }

  // Ctrl+X -> open quick preset-scan menu: lets player choose any preset (Y-list) and scan their entire map for instances,
  // then preview a minimal full-map image with every found instance highlighted and allow download as PNG/JPEG/WEBP.
  if ((e.key === 'x' || e.key === 'X') && (e.ctrlKey || pMode === 'ctrl')) {
    try {
      openCtrlXPresetScanner();
    } catch (err) {
      console.warn('Failed to open preset-scan menu:', err);
    }
    e.preventDefault();
    return;
  }

  // Alt+Z -> open a small filename-prompt modal, then export every cell currently on the
  // board as a .mc (macrocell) file under whatever name the player typed and trigger an
  // automatic download. Checked here, early, rather than at the end of this handler's long
  // if/else-if chain -- e.key doesn't reflect the Alt modifier, so a later, unqualified
  // `e.key === 'z'` branch further down (the plain-Z "erase" handler) would otherwise match
  // first and swallow the event via its own preventDefault()/return before this ever got a
  // chance to run. Same reasoning as the Alt+X handler immediately below.
  if ((e.key === 'z' || e.key === 'Z') && e.altKey) {
    try {
      openExportFilenameModal('mc', (name) => downloadBoardAsMacrocell(name));
    } catch (err) {
      console.warn('Failed to open macrocell export filename prompt:', err);
      flashTinyToast('Failed to export .mc file');
    }
    e.preventDefault();
    return;
  }

  // Alt+F -> open the same filename-prompt modal, then export every cell currently on the
  // board as a standard .rle file under whatever name the player typed and trigger an
  // automatic download. Same early-check reasoning as Alt+Z/Alt+X above: e.key stays 'f'
  // regardless of Alt being held, so a later unqualified `e.key === 'f'` branch further down
  // (the plain-F age-overlay toggle) would otherwise match first and swallow the event.
  if ((e.key === 'f' || e.key === 'F') && e.altKey) {
    try {
      openExportFilenameModal('rle', (name) => downloadBoardAsRLE(name));
    } catch (err) {
      console.warn('Failed to open RLE export filename prompt:', err);
      flashTinyToast('Failed to export .rle file');
    }
    e.preventDefault();
    return;
  }

  // Alt+Y -> open the LTL-specific pattern presets modal (Bug-Collection, etc.), a separate
  // library from plain Y's classic-Life presets since LTL patterns are built for a very
  // different radius-based rule model and would be meaningless mixed into that list. Checked
  // here, early, for the same reason as the other Alt+<letter> combos in this section: e.key
  // stays 'y' regardless of Alt being held, so the later Shift+Y (rule presets) and plain-Y
  // (classic presets) branches further down would otherwise match first and swallow the event.
  // Available whether or not LTL mode is actually on (browsing the library doesn't require it).
  if ((e.key === 'y' || e.key === 'Y') && e.altKey) {
    openLTLPresetModal();
    e.preventDefault();
    return;
  }

  // Alt+J -> spawn a 250x250 random noise block (44% density) centered on screen, same fill
  // mechanic as plain/Shift/Ctrl+J above but tuned for Larger-than-Life mode, where LTL's radius-5
  // rule needs a much larger seed area than ordinary Life for its neighbor-count ranges to do
  // anything interesting. Being inside the default Bosco's-rule ranges (R5,C0,S33-57,B34-45:
  // survival 33-57 of 120 possible neighbors i.e. ~27.5%-47.5% local density, birth 34-45 i.e.
  // ~28.3%-37.5%) isn't enough on its own -- Bosco's rule is chaotic enough that plenty of
  // in-range densities still either overcrowd-die within a few generations (the old 65% blew
  // straight past the S-max of 57) or freeze into a static/near-static block instead of staying
  // dynamic (empirically true of a fair amount of the 30%-37% band too, and again above ~50%).
  // 44% was picked by actually stepping the rule: across repeated randomized trials it was the
  // sweet spot that reliably neither dies out nor freezes over hundreds of generations, instead
  // settling into a sustained, actively churning population -- which is what "lively" means for
  // this rule in practice. Works outside LTL mode too (it's just a bigger noise spawn), but isn't
  // gated to it -- checked here, early, for the same reason as the other Alt+<letter> combos in
  // this section: e.key stays 'j' regardless of Alt being held, so the later unqualified
  // `e.key === 'j'` branch further down (plain/Shift/Ctrl+J) would otherwise match first and
  // swallow the event before Alt ever gets a look-in.
  if ((e.key === 'j' || e.key === 'J') && e.altKey) {
    const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
    const now = performance.now();
    const SIZE = 250;
    const DENSITY = 0.44;
    // SIZE is even, so a symmetric -half..+half loop would land on SIZE+1 -- offset the range
    // by one on one side to get exactly SIZE cells per axis (e.g. -125..124 -> 250).
    const half = Math.floor(SIZE / 2);
    let placed = 0;
    for (let dx = -half; dx < half; dx++) {
      for (let dy = -half; dy < half; dy++) {
        if (Math.random() < DENSITY) {
          const x = center.wx + dx;
          const y = center.wy + dy;
          const k = `${x},${y}`;
          if (!alive.has(k) && !invincible.has(k)) {
            alive.add(k);
            birth.set(k, { t: now, p: pausedAccum, gen: generation + 1 });
            placed++;
          }
        }
      }
    }
    flashTinyToast(`Mega noise spawned: 250x250 @ 44% (${placed} cells)`, 1800);
    e.preventDefault();
    return;
  }

  // Alt+H -> toggle Larger-than-Life (LTL) mode. Checked here, early, for the same reason as
  // the other Alt+<letter> combos in this section: e.key stays 'h' regardless of Alt being
  // held, so the later unqualified `e.key === 'h'` branches further down (Ctrl+H's FastForward
  // panel and plain/Shift+H's template-detach/keyboard-lock) would otherwise match first and
  // swallow the event. Entering LTL applies its default rule (R5,C0,S33-57,B34-45) and
  // switches stepLife() over to the radius-aware summed-area-table stepper (see ltlStepLife());
  // leaving it restores whatever B/S rule was active before LTL was turned on. Not available in
  // Hex Mode -- the Hex Mode key-allowlist above already blocks every Alt combo while hexMode
  // is active, so this only ever fires outside Hex Mode anyway.
  if ((e.key === 'h' || e.key === 'H') && e.altKey) {
    try {
      toggleLTLMode();
    } catch (err) {
      console.warn('Failed to toggle Larger-than-Life mode:', err);
    }
    e.preventDefault();
    return;
  }

  // Alt+X: open the Ancestor Finder. Checked here, early, rather than at the end of this
  // handler's long if/else-if chain -- e.key stays 'x' regardless of Alt being held (Alt
  // doesn't change which character key was pressed), so a later, unqualified `e.key === 'x'`
  // branch further down (the plain-X "draw" handler) would otherwise match first and swallow
  // the event via its own preventDefault()/return before this ever got a chance to run. Square-
  // grid B3/S23 only (see openAncestorFinderModal for why); the Hex Mode key-allowlist filter
  // above already blocks this in Hex Mode too, so this fires only for the intended case.
  if ((e.key === 'x' || e.key === 'X') && e.altKey) {
    openAncestorFinderModal();
    e.preventDefault();
    return;
  }

  // Alt+C -> open the unified export menu: one filename field, four format buttons
  // (.lif/.rle/.mc/.cells), each triggering its own download immediately on click. Checked
  // here, early, for the same reason as Alt+Z/Alt+F/Alt+X above -- e.key stays 'c' regardless
  // of Alt being held, so the later unqualified `e.key === 'c'` branch further down (which
  // itself already handles Ctrl+C for 3D mode and plain/Shift+C for pan-step/reload) would
  // otherwise match first and swallow the event. Not Hex-Mode-gated: unlike RLE/macrocell/
  // presets, plain export here doesn't depend on any square-grid-specific pattern library --
  // it just serializes whatever's on the board, hex included.
  if ((e.key === 'c' || e.key === 'C') && e.altKey) {
    try {
      openExportFormatModal();
    } catch (err) {
      console.warn('Failed to open export menu:', err);
      flashTinyToast('Failed to open export menu');
    }
    e.preventDefault();
    return;
  }

  // Alt+V -> open the Life 1.06 (.lif) / Plaintext (.cells) import modal. Same early-check
  // reasoning as Alt+Z/Alt+F/Alt+X/Alt+C above: e.key stays 'v' regardless of Alt being held,
  // so the later unqualified `e.key === 'v'` branch further down (which itself already handles
  // Ctrl+V for the Live Cluster overlay and plain/Shift+V for pan-step/reverse-time) would
  // otherwise match first and swallow the event. Hex-Mode-gated like the RLE/macrocell import
  // modals -- both .lif and .cells are row/coordinate formats built for the square grid.
  if ((e.key === 'v' || e.key === 'V') && e.altKey) {
    try {
      if (!blockedInHexMode('.lif/.cells import')) openLifCellsModal();
    } catch (err) {
      console.warn('Failed to open .lif/.cells import modal:', err);
      flashTinyToast('Failed to open .lif/.cells import modal');
    }
    e.preventDefault();
    return;
  }

  // Alt+B -> open the .zip pattern-file bundler: add/rename/delete/load individual .rle,
  // .lif, .cells, and .mc files, or load an existing .zip to edit it, then download the whole
  // working list as one .zip. Same early-check reasoning as Alt+Z/Alt+F/Alt+X/Alt+C/Alt+V
  // above: e.key stays 'b' regardless of Alt being held, so the later unqualified
  // `e.key === 'b'` branches further down (Shift+B "remove one random cell" and plain/Ctrl+B
  // "reset rules") would otherwise match first and swallow the event. Not Hex-Mode-gated: this
  // modal never touches the board's own grid/topology directly except via each row's optional
  // Load button (which reuses the same parsers the Hex-Mode-gated import modals use, but the
  // bundler itself is just file management).
  if ((e.key === 'b' || e.key === 'B') && e.altKey) {
    try {
      openZipBundleModal();
    } catch (err) {
      console.warn('Failed to open ZIP bundler:', err);
      flashTinyToast('Failed to open ZIP bundler');
    }
    e.preventDefault();
    return;
  }

  // Alt+N -> toggle Portal placement/link mode. Checked here, early, for the same reason as
  // the other Alt+<letter> combos above: e.key stays 'n' regardless of Alt being held, so the
  // later unqualified `e.key === 'n'` branch further down (plain N/Shift+N: rotate template /
  // toggle grid) would otherwise match first and swallow the event. Not available on mobile --
  // portal placement/linking is a precision keyboard+mouse workflow (hover to target an edge,
  // hold X/Z, tap C) that doesn't have a sensible touch equivalent, unlike ordinary drawing.
  // Also blocked in Hex Mode: portals are defined on square-grid edges between two cells,
  // which doesn't map onto hex topology.
  if ((e.key === 'n' || e.key === 'N') && e.altKey) {
    if (playerPlatformChoice === 'mobile') {
      flashTinyToast("Portal mode (Alt+N) isn't available on mobile", 1800);
      e.preventDefault();
      return;
    }
    if (blockedInHexMode('Portal mode')) { e.preventDefault(); return; }
    altNMode = !altNMode;
    portalDrawDown = false;
    portalEraseDown = false;
    portalLinkFirst = null;
    portalShowLinks = false;
    portalStraightDown = false;
    portalStraightAnchor = null;
    portalStraightLastKeys = null;
    flashTinyToast(altNMode
      ? 'Portal mode: ON (X draw, Shift+X straight line, Z erase, C link, V link lines, hover an edge)'
      : 'Portal mode: OFF', 1800);
    e.preventDefault();
    return;
  }

  // Alt+G -> delete every portal (outside Portal mode only -- while Alt+N mode is active, G
  // has no special meaning here and normal G/Ctrl+G/Shift+G behavior below still applies).
  // This is a portal-only wipe: unlike Ctrl+G's hard wipe, it leaves every other cell,
  // invincible wall, and Rule Spot completely untouched.
  if ((e.key === 'g' || e.key === 'G') && e.altKey && !altNMode) {
    try {
      const count = clearAllPortals();
      flashTinyToast(count > 0 ? `Removed ${count} portal pieces` : 'No portals to remove', 1600);
    } catch (err) {
      console.warn('Failed to clear portals:', err);
    }
    e.preventDefault();
    return;
  }

  // Alt+D -> Tutorial Mode: a guided, click-through walkthrough of X, Z, A, S, Q, W, E, R, C,
  // V, D, J, Shift+J, Ctrl+J as an easier alternative to reading the full U-key manual.
  if ((e.key === 'd' || e.key === 'D') && e.altKey) {
    try {
      toggleTutorialMode();
    } catch (err) {
      console.warn('Failed to toggle Tutorial Mode:', err);
      flashTinyToast('Failed to open Tutorial Mode');
    }
    e.preventDefault();
    return;
  }

  // Alt+S -> File Converter: load any of .lif/.rle/.mc/.cells and convert it to any of the
  // other three, independent of whatever's currently on the board.
  if ((e.key === 's' || e.key === 'S') && e.altKey) {
    try {
      openFileConverterModal();
    } catch (err) {
      console.warn('Failed to open File Converter:', err);
      flashTinyToast('Failed to open File Converter');
    }
    e.preventDefault();
    return;
  }

  // Alt+A -> toggle Cluster Tracking mode (hidden variant of Ctrl+V: silently computes the
  // same clustering with a fixed sensitivity of 5, draws no polygons). While tracking mode is
  // on, pressing X on a cluster starts the camera following it -- see the clusterTrackFollowing
  // gate near the top of this handler for what's allowed during an active follow.
  if ((e.key === 'a' || e.key === 'A') && e.altKey) {
    toggleClusterTrackMode();
    e.preventDefault();
    return;
  }

  // Alt+M -> Clear All Gliders: scans the whole board for every live glider (any of its 4
  // animation phases, in any of its 4 diagonal orientations) via RLE matching, and deletes
  // only the ones that are fully isolated (no other live cell touching them, including
  // diagonally) so a glider embedded in a larger still-evolving structure is never mistaken
  // for a clean, isolated glider and left alone. One toast reports the result; matched gliders
  // simply vanish from the board with no per-match feedback.
  if ((e.key === 'm' || e.key === 'M') && e.altKey) {
    try {
      clearAllGliders();
    } catch (err) {
      console.warn('Failed to clear gliders:', err);
      flashTinyToast('Failed to clear gliders');
    }
    e.preventDefault();
    return;
  }

  // Ctrl+D -> Scramble: a just-for-fun toy that nudges every cell on the board one cell in
  // its own random direction. If two cells would end up on top of each other, whichever one
  // loses gets bumped one further cell in the same direction (repeating if needed) until it
  // finds an empty spot, so nothing ever gets silently deleted or overlapped -- cells just get
  // shoved out of each other's way. Purely for messing around; no gameplay purpose.
  if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || pMode === 'ctrl')) {
    try {
      scrambleCells();
    } catch (err) {
      console.warn('Failed to scramble cells:', err);
    }
    e.preventDefault();
    return;
  }

  // If the main menu is showing, intercept most keys and only allow X to start the game.
  if (typeof showMainMenu !== 'undefined' && showMainMenu) {
    // Developer skip keys (title screen ONLY): 0 pretends the player chose PC, 9 pretends
    // Mobile -- both bypass the main menu AND the entire typed intro in one step, landing
    // straight in the normal game exactly as if the intro had been completed normally.
    if (e.key === '0') {
      try { devSkipToGame('pc'); } catch (err) { console.warn('devSkipToGame failed:', err); }
      e.preventDefault();
      return;
    }
    if (e.key === '9') {
      try { devSkipToGame('mobile'); } catch (err) { console.warn('devSkipToGame failed:', err); }
      e.preventDefault();
      return;
    }
    // During the initial menu boost, block starting (X) and other input until the black cover fades.
    if (menuInitialBoostActive) {
      // completely block input (including X) while initial boost overlay is active
      if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); return; }
      e.preventDefault();
      return;
    }
    // Allow X to start the actual startup sequence (only once initial boost finished)
    if (e.key === 'x' || e.key === 'X') {
      try { dismissMainMenuAndStart(); } catch (err) {}
      e.preventDefault();
      return;
    }
    // allow Space to center or be ignored but otherwise block all other input while in menu
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); return; }
    e.preventDefault();
    return;
  }

  // While startupActive, ignore user key input entirely except Space which advances one segment.
  // Allow '/' to still toggle the small FPS counter even during startup.
  if (typeof startupActive !== 'undefined' && startupActive) {
    // allow '/' to toggle the FPS overlay while startup is active
    if (e.key === '/') {
      fpsVisible = !fpsVisible;
      e.preventDefault();
      return;
    }
    // Space advances exactly one intro segment (no-op on the unskippable mobile/PC question).
    if (e.code === 'Space' || e.key === ' ') {
      try { if (typeof window.advanceStartupSegment === 'function') window.advanceStartupSegment(); } catch (err) {}
      e.preventDefault();
      return;
    }
    e.preventDefault();
    return;
  }
  // If legacyMode is active, only allow Arrow keys and plain letters a/s/x/z (no shifted/ctrl/alt/meta variants).
  // Exception: allow Shift+I to pass so the player can disable legacy mode while it's active.
  if (legacyMode) {
    const allowed = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','a','s','x','z']);
    // If this is Shift+I, allow it through so legacy mode can be disabled.
    if ((e.shiftKey || pMode === 'shift') && (e.key === 'i' || e.key === 'I')) {
      // permit Shift+I to reach the handler below
    } else {
      // Block if any real modifier (so actual shift/ctrl/alt/meta are disallowed) OR key not in allowed set,
      // but also block if virtual ctrl-mode would convert a plain key into a ctrl event.
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !allowed.has(e.key) || pMode === 'ctrl') {
        e.preventDefault();
        return;
      }
      // fall through: permitted key (plain a/s/x/z or arrows)
    }
  }

  // If the G key has been disabled via Shift+K, block any G key handling here.
  if ((e.key === 'g' || e.key === 'G') && gKeyDisabled) {
    flashTinyToast('G key is disabled');
    e.preventDefault();
    return;
  }

  // Global keyboard lock: when enabled, only allow A/S, Arrow keys, and Shift+H to work.
  // Shift+H must be used (actual Shift key held) to toggle the lock on/off.
  if (keyboardLocked) {
    // Always allow Shift+H to toggle the lock back on/off (require real Shift key)
    if (e.shiftKey && (e.key === 'h' || e.key === 'H')) {
      keyboardLocked = !keyboardLocked;
      flashTinyToast(keyboardLocked ? 'Keyboard: DISABLED (limited keys active)' : 'Keyboard: ENABLED', 1200);
      e.preventDefault();
      return;
    }
    // Allow A/S and Arrow keys while locked (both uppercase/lowercase)
    const allowed = new Set(['a','A','s','S','ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
    if (!allowed.has(e.key)) {
      // Block all other key handling silently
      e.preventDefault();
      return;
    }
    // allowed key: continue on to normal handlers
  }

  // While a cluster is being followed (Alt+A tracking mode, X pressed on a cluster), only
  // A, S (zoom, centered on the followed cluster), Z (stop following), and X (retarget to
  // whatever cluster is now under the mouse) are permitted -- arrow-key panning and every
  // other key are blocked for the duration, since the camera itself is being driven by the
  // tracked cluster's own movement each frame (see the frame() loop) and would otherwise
  // fight the player's own panning input.
  if (clusterTrackFollowing) {
    const kLower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (kLower === 'z') {
      stopClusterTracking();
      e.preventDefault();
      return;
    }
    if (kLower === 'x') {
      startClusterTrackingAtMouse();
      e.preventDefault();
      return;
    }
    if (kLower === 'a' || kLower === 's') {
      // fall through to the normal A/S zoom handlers below -- zoom stays centered on the
      // screen, which is correct here since the camera is already centered on the followed
      // cluster every frame.
    } else {
      e.preventDefault();
      return;
    }
  }

  // Arrow keys: either move the view, or (when crosshairMode+Space) start continuous crosshair movement.
  if (e.key === 'ArrowLeft') {
    if (crosshairMode && spaceDown) {
      // start continuous left movement
      leftArrowDown = true;
      e.preventDefault();
    } else {
      panByScreenDelta(-panStep, 0); e.preventDefault();
    }
  }
  else if (e.key === 'ArrowRight') {
    if (crosshairMode && spaceDown) {
      rightArrowDown = true;
      e.preventDefault();
    } else {
      panByScreenDelta(panStep, 0); e.preventDefault();
    }
  }
  else if (e.key === 'ArrowUp') {
    if (crosshairMode && spaceDown) {
      upArrowDown = true;
      e.preventDefault();
    } else {
      panByScreenDelta(0, -panStep); e.preventDefault();
    }
  }
  else if (e.key === 'ArrowDown') {
    if (crosshairMode && spaceDown) {
      downArrowDown = true;
      e.preventDefault();
    } else {
      panByScreenDelta(0, panStep); e.preventDefault();
    }
  }
  // Shift+Q toggles crosshair mode; plain Q still toggles pause/resume
  else if ((e.key === 'q' || e.key === 'Q') && isShiftLike) {
    crosshairMode = !crosshairMode;
    if (crosshairMode) {
      // initialize crosshair at center if absent
      crosshairPos = { x: innerWidth / 2, y: innerHeight / 2 };
      flashTinyToast('Crosshair mode: ON');
    } else {
      flashTinyToast('Crosshair mode: OFF');
    }
    e.preventDefault();
  }
  else if (e.key === 'q' || e.key === 'Q') {
    // toggle running; track paused durations so ages freeze while paused
    if (running) {
      // going to pause
      pauseStart = performance.now();
      running = false;
    } else {
      // resuming
      if (pauseStart !== null) {
        pausedAccum += performance.now() - pauseStart;
        pauseStart = null;
      }
      running = true;
    }
    e.preventDefault();
  }
  else if (e.key === 'a' || e.key === 'A') {
    // Ctrl+A toggles the landing-map overlay (shows persistent places where alive landed on dead cells)
    if (e.ctrlKey) {
      landingMapVisible = !landingMapVisible;
      flashTinyToast(landingMapVisible ? 'Landing map: ON (Ctrl+A)' : 'Landing map: OFF (Ctrl+A)', 1200);
      e.preventDefault();
      return;
    }

    if (isShiftLike) {
      invertColors = !invertColors;
      flashTinyToast(invertColors ? 'Inverted colors: ON' : 'Inverted colors: OFF');
    } else {
      zoomAt(window.innerWidth/2, window.innerHeight/2, 0.9);
    }
    e.preventDefault();
  }
  else if (e.key === 's' || e.key === 'S') {
    // Ctrl+S: reset all live cells' ages (update birth timestamps so age appears zeroed)
    if (e.ctrlKey || pMode === 'ctrl') {
      try {
        const now = performance.now();
        // For every birth record, set its timestamp to now and pausedAccum value to current pausedAccum.
        for (const [k, rec] of birth.entries()) {
          // preserve generation marker if present, update to current generation
          birth.set(k, { t: now, p: pausedAccum, gen: generation });
        }
        flashTinyToast('All cell ages reset (Ctrl+S)');
      } catch (err) {
        console.warn('Failed to reset ages:', err);
        flashTinyToast('Failed to reset ages');
      }
      e.preventDefault();
      return;
    }

    if (isShiftLike) {
      // reset zoom to default cell size
      cellSize = 12;
      // redraw immediately to reflect change
      draw(performance.now());
    } else {
      zoomAt(window.innerWidth/2, window.innerHeight/2, 1.1111111);
    }
    e.preventDefault();
  }
  // While Cluster Tracking mode is on (Alt+A) but not yet following anything, X picks up
  // whatever cluster is under the mouse and starts the camera following it, instead of drawing.
  // Checked before every other X handler, mirroring the Rule Spot panel's own X-interception
  // pattern just below -- once clusterTrackFollowing is true, the dedicated gate near the top
  // of this function takes over X (retarget) before code ever reaches here.
  else if (clusterTrackModeActive && !clusterTrackFollowing && (e.key === 'x' || e.key === 'X') && !isShiftLike && !e.ctrlKey) {
    startClusterTrackingAtMouse();
    e.preventDefault();
    return;
  }
  // While Portal mode (Alt+N) is active, X/Z draw/erase portal pieces on grid-line edges near
  // the mouse instead of normal cell drawing/erasing, and C links two hovered portal groups
  // together. Checked before every other X/Z/C handler so it fully takes over those keys while
  // the mode is on -- mirrors the Rule Spot panel's own X-interception pattern just below.
  // Shift+X is checked FIRST (straight-line portal draw) so it takes priority over plain X's
  // free-hand draw.
  else if (altNMode && (e.key === 'x' || e.key === 'X') && isShiftLike && !e.ctrlKey) {
    // Guard against key-repeat: real keyboards (and this game's own on-screen key-repeat
    // simulation) fire repeated keydown events while a key stays physically held, not just
    // once. Without this guard, every repeat firing would re-run
    // `_portalEdgeUnderMouse()` and reset the anchor to wherever the mouse happens to be at
    // that instant -- so the "straight line" would actually restart from a new anchor several
    // times a second while dragging, producing exactly the scattered, non-straight mess this
    // feature is supposed to prevent. Only capture the anchor on the genuine first press.
    if (!portalStraightDown) {
      portalDrawDown = false; // mutually exclusive with plain-X free-hand draw -- see the plain-X branch below for why this matters
      portalStraightDown = true;
      portalStraightAnchor = _portalEdgeUnderMouse();
      portalStraightLastKeys = new Set();
    }
    e.preventDefault();
    return;
  }
  else if (altNMode && (e.key === 'x' || e.key === 'X') && !e.ctrlKey) {
    // If Shift gets pressed or released mid-hold while X stays physically down, the browser's
    // key-repeat can flip which of these two branches an X keydown matches from one repeat to
    // the next (plain-X here vs Shift+X above). Without clearing the other flag whenever one
    // fires, both could end up true at once, and the keyup handler's if/else-if chain only
    // ever clears one of them -- leaving the other stuck true forever, which looks exactly
    // like the game continuing to draw/act on a key the player has actually let go of. Treat
    // the two as mutually exclusive: entering one always cancels the other first.
    portalStraightDown = false;
    portalStraightAnchor = null;
    portalStraightLastKeys = null;
    portalDrawDown = true;
    e.preventDefault();
    return;
  }
  else if (altNMode && (e.key === 'z' || e.key === 'Z') && !e.ctrlKey) {
    portalEraseDown = true;
    e.preventDefault();
    return;
  }
  else if (altNMode && (e.key === 'c' || e.key === 'C') && !e.ctrlKey) {
    try {
      if (!mousePos) {
        flashTinyToast('Hover a portal piece first');
        e.preventDefault();
        return;
      }
      const hoveredGroup = portalGroupAtMouse();
      if (hoveredGroup === null) {
        flashTinyToast('No portal piece under pointer');
        e.preventDefault();
        return;
      }
      if (portalLinkFirst === null) {
        portalLinkFirst = hoveredGroup;
        flashTinyToast('Portal selected -- hover the other portal and press C to link');
      } else {
        if (portalFindGroup(portalLinkFirst) === portalFindGroup(hoveredGroup)) {
          flashTinyToast("Can't link a portal to itself");
        } else {
          portalLinkGroups(portalLinkFirst, hoveredGroup);
          flashTinyToast('Portals linked');
        }
        portalLinkFirst = null;
      }
    } catch (err) {
      console.warn('Failed to link portals:', err);
    }
    e.preventDefault();
    return;
  }
  // In Portal mode, plain V toggles a subtle overlay showing which portals are linked to
  // which -- a thin connecting line drawn between every linked pair's midpoints, so the player
  // can tell at a glance what's wired to what without having to hover each piece individually.
  // Only intercepted while altNMode is on; everywhere else V keeps its normal pan-step/reverse-
  // time/import behavior untouched (see the Alt+V and Ctrl+V handlers elsewhere, and the plain
  // V handler further below for outside Portal mode).
  else if (altNMode && (e.key === 'v' || e.key === 'V') && !e.ctrlKey) {
    portalShowLinks = !portalShowLinks;
    flashTinyToast(portalShowLinks ? 'Portal link lines: ON' : 'Portal link lines: OFF', 1400);
    e.preventDefault();
    return;
  }
  // While the Rule Spot panel is open, plain X places the spot at the mouse instead of
  // drawing -- checked before the normal Shift+X/X draw handlers so it takes priority.
  else if ((e.key === 'x' || e.key === 'X') && !isShiftLike && typeof ruleSpotPlacementMode !== 'undefined' && ruleSpotPlacementMode) {
    try {
      placeRuleSpotAtMouse();
    } catch (err) {
      console.warn('Failed to place rule spot:', err);
    }
    e.preventDefault();
    return;
  }
  // Shift+X (hold) => place invincible wall pixels; plain X => draw normal alive cells
  else if ((e.key === 'x' || e.key === 'X') && isShiftLike) {
    invDown = true;
    e.preventDefault();
  }
  else if (e.key === 'x' || e.key === 'X') {
    pDown = true;
    e.preventDefault();
  }
  // While the Rule Spot panel is open AND the mouse is hovering over an existing rule spot,
  // plain Z deletes that spot instead of its normal "erase" behavior. If the panel isn't open,
  // or the mouse isn't over a spot, this falls through to the existing Z handlers untouched.
  else if ((e.key === 'z' || e.key === 'Z') && !isShiftLike && !e.ctrlKey && typeof ruleSpotPlacementMode !== 'undefined' && ruleSpotPlacementMode && mousePos) {
    const hoverWorld = screenToWorld(mousePos.x, mousePos.y);
    const hoveredSpot = getRuleSpotAt(hoverWorld.wx, hoverWorld.wy);
    if (hoveredSpot) {
      const idx = ruleSpots.indexOf(hoveredSpot);
      if (idx >= 0) ruleSpots.splice(idx, 1);
      const panel = document.getElementById('rule-spot-panel');
      if (panel && panel._updatePlacedCount) panel._updatePlacedCount();
      flashTinyToast(`Rule Spot deleted (${hoveredSpot.ruleStr})`);
      e.preventDefault();
      return;
    }
    // not hovering a spot -- fall through to normal Z (erase-hold) behavior below
    oDown = true;
    e.preventDefault();
    return;
  }
  // Shift+Z toggles age-color spatial blending (disable/enable)
  else if ((e.key === 'z' || e.key === 'Z') && isShiftLike) {
    disableAgeBlend = !disableAgeBlend;
    flashTinyToast(disableAgeBlend ? 'Age color blending disabled' : 'Age color blending enabled');
    e.preventDefault();
  }
  // Ctrl+Z toggles next-generation preview mode; plain Z (hold) is erase
  else if ((e.key === 'z' || e.key === 'Z') && e.ctrlKey) {
    previewNextGenMode = !previewNextGenMode;
    flashTinyToast(previewNextGenMode ? 'Next-gen preview: ON' : 'Next-gen preview: OFF');
    e.preventDefault();
  }
  else if (e.key === 'z' || e.key === 'Z') { oDown = true; e.preventDefault(); }
  // 'o' (hold) begins a drag-selection (no clicking): start selection at current mouse pos (or center if no mouse)
  else if (e.key === 'o' || e.key === 'O') {
    // Shift+O: decrease brightness of cells
    if (isShiftLike) {
      cellBrightness = Math.max(0.1, +(cellBrightness - 0.1).toFixed(2));
      flashTinyToast(`Cell brightness: ${cellBrightness.toFixed(2)}`);
      e.preventDefault();
      return;
    }

    if (!selectionActive) {
      selectionActive = true;
      // anchor at current mouse position or center if absent
      if (mousePos) selStart = { x: mousePos.x, y: mousePos.y };
      else selStart = { x: innerWidth / 2, y: innerHeight / 2 };
      selCurrent = { ...selStart };
      // ensure selectedSet cleared for fresh selection
      selectedSet.clear();
    }
    e.preventDefault();
  }
  else if (e.key === 'c' || e.key === 'C') {
    // Ctrl+C -> open 3D mode in an iframe overlay instead of redirecting; Escape will close it.
    // Disabled for mobile players: the virtual keyboard dispatches synthetic key events on the
    // main page's window, which can't reach into the iframe's own document, so a mobile player
    // would have no way to control (or even exit) 3D mode once inside it.
    if (e.ctrlKey || pMode === 'ctrl') {
      if (playerPlatformChoice === 'mobile') {
        flashTinyToast('3D mode isn\'t available on mobile');
        e.preventDefault();
        return;
      }
      try {
        // Prevent multiple overlays
        if (document.getElementById('iframe-3d-overlay')) {
          e.preventDefault();
          return;
        }

        // create fullscreen overlay container (iframe sits on top of canvas)
        const wrap = document.createElement('div');
        wrap.id = 'iframe-3d-overlay';
        Object.assign(wrap.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: '100vw',
          height: '100vh',
          zIndex: 30000,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          fontFamily: 'Times New Roman, Times, serif',
          justifyContent: 'center',
          pointerEvents: 'auto'
        });

        // create iframe sized to most of viewport (acts like domain inside iframe)
        const iframe = document.createElement('iframe');
        iframe.src = 'https://3D-mode.on.websim.com';
        iframe.id = 'iframe-3d';
        Object.assign(iframe.style, {
          width: '92vw',
          height: '84vh',
          border: '2px solid rgba(255,255,255,0.08)',
          borderRadius: '8px',
          background: '#000'
        });
        iframe.setAttribute('allowfullscreen','');

        // bottom-center transient popup (10s) that overlays the iframe
        const popup = document.createElement('div');
        popup.id = 'iframe-3d-popup';
        popup.textContent = 'Press 1 to exit 3D mode';
        Object.assign(popup.style, {
          position: 'fixed',
          left: '50%',
          bottom: '6vh',
          transform: 'translateX(-50%)',
          padding: '10px 14px',
          background: 'rgba(0,0,0,0.72)',
          color: '#fff',
          borderRadius: '8px',
          fontFamily: 'Times New Roman, Times, serif',
          fontSize: '14px',
          zIndex: 30001,
          pointerEvents: 'none',
          opacity: '0',
          transition: 'opacity 220ms ease'
        });

        // append iframe and popup to wrapper then to body
        wrap.appendChild(iframe);
        document.body.appendChild(wrap);
        document.body.appendChild(popup);

        // fade-in popup
        requestAnimationFrame(() => { popup.style.opacity = '1'; });

        // hide popup after 10 seconds
        const popupTimer = setTimeout(() => {
          try { popup.style.opacity = '0'; setTimeout(() => popup.remove(), 260); } catch (e) {}
        }, 10000);

        // Escape handler: remove iframe overlay and popup
        function escHandler(ev) {
          if (ev.key === 'Escape' || ev.key === 'Esc') {
            try {
              if (popupTimer) clearTimeout(popupTimer);
            } catch (e) {}
            try {
              popup.style.opacity = '0';
              if (popup.parentElement) setTimeout(() => popup.remove(), 220);
            } catch (e) {}
            try {
              wrap.style.opacity = '0';
              setTimeout(() => { if (wrap.parentElement) wrap.remove(); }, 220);
            } catch (e) {}
            window.removeEventListener('keydown', escHandler, true);
            ev.preventDefault();
          }
        }
        // listen with capture to ensure Esc closes even when iframe has focus (iframe key events don't bubble here,
        // but pressing Esc in the parent outside iframe or if iframe allows keyboard will be handled)
        window.addEventListener('keydown', escHandler, true);

        // Provide a small toast feedback that 3D mode opened
        flashTinyToast('3D mode opened (iframe overlay). Press 1 to exit', 4200);
      } catch (err) {
        console.warn('Failed to open 3D iframe overlay:', err);
      }
      e.preventDefault();
      return;
    }

    if (isShiftLike) {
      // Shift+C refreshes the whole page
      location.reload();
    } else {
      panStep = Math.max(5, Math.floor(panStep * 0.8));
    }
    e.preventDefault();
  }
  // Ctrl+V: toggle the Live Cluster Highlight overlay. Note this only ever fires when no text
  // input/textarea/contenteditable is focused -- the global typing-guard near the top of this
  // handler already lets a focused field's real Ctrl+V paste through untouched and returns
  // before reaching here, so this never competes with or blocks the browser's actual paste.
  else if ((e.key === 'v' || e.key === 'V') && (e.ctrlKey || pMode === 'ctrl')) {
    try {
      toggleLiveClusterOverlay();
    } catch (err) {
      console.warn('Failed to toggle Live Cluster Highlight:', err);
    }
    e.preventDefault();
    return;
  }
  else if (e.key === 'v' || e.key === 'V') {
    if (isShiftLike) {
      // Shift+V toggles reverse-time rewind mode
      reverseTime = !reverseTime;
      // ensure simulation is running when rewinding
      running = true;
      flashTinyToast(reverseTime ? 'Reverse time: ON' : 'Reverse time: OFF');
    } else {
      panStep = Math.min(200, Math.ceil(panStep * 1.25));
    }
    e.preventDefault();
  }
  // Shift+D: spawn a 25x25 hollow box made of invincible wall cells centered on screen
  else if ((e.key === 'd' || e.key === 'D') && isShiftLike) {
    spawnInvincibleBox(25);
    e.preventDefault();
  }
  else if (e.key === 'd' || e.key === 'D') { panStep = DEFAULT_PAN_STEP; e.preventDefault(); }

  // adjust crosshair speed with - / =
  else if (e.key === '-' || e.key === '_') {
    if (isShiftLike) {
      // Shift + - recenters the crosshair (only when crosshair mode is active)
      if (crosshairMode) {
        crosshairPos = { x: innerWidth / 2, y: innerHeight / 2 };
        flashTinyToast('Crosshair centered');
      } else {
        flashTinyToast('Crosshair not active');
      }
    } else {
      crosshairSpeed = Math.max(5, Math.round(crosshairSpeed * 0.85));
      flashTinyToast(`Crosshair speed: ${crosshairSpeed} px/s`);
    }
    e.preventDefault();
  }
  else if (e.key === '=' || e.key === '+') {
    // Shift+= resets speed to default; plain = / + increases speed.
    if (isShiftLike) {
      crosshairSpeed = DEFAULT_CROSSHAIR_SPEED;
      flashTinyToast(`Crosshair speed reset to default: ${crosshairSpeed} px/s`);
    } else {
      crosshairSpeed = Math.min(2000, Math.round(crosshairSpeed * 1.25));
      flashTinyToast(`Crosshair speed: ${crosshairSpeed} px/s`);
    }
    e.preventDefault();
  }

  // hold Space to enable arrow-based crosshair movement (Space + Arrow)
  else if (e.code === 'Space' || e.key === ' ') {
    spaceDown = true;
    e.preventDefault();
  }
  else if ((e.key === 'e' || e.key === 'E') && (e.ctrlKey || pMode === 'ctrl')) {
    // Ctrl+E: open the Rule Spot side panel -- lets the player adjust width/height/rule string
    // with live inputs, see a live mouse-following preview of the region, and press X to place
    // it at the mouse. A freshly-placed spot defaults to the current global rule string, so it
    // behaves exactly like the rest of the board until the player edits it.
    try {
      openRuleSpotPanel();
    } catch (err) {
      console.warn('Failed to open Rule Spot panel:', err);
    }
    e.preventDefault();
    return;
  }
  else if (e.key === 'e' || e.key === 'E') {
    if (isShiftLike) {
      // Shift+E: remove half of all alive cells (floor if odd)
      const all = Array.from(alive);
      const total = all.length;
      if (total === 0) {
        flashTinyToast('No cells to remove');
      } else {
        // shuffle by Fisher-Yates
        for (let i = all.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = all[i]; all[i] = all[j]; all[j] = tmp;
        }
        const removeCount = Math.floor(total / 2);
        for (let i = 0; i < removeCount; i++) {
          const k = all[i];
          alive.delete(k);
          birth.delete(k);
        }
        flashTinyToast(`Removed ${removeCount} of ${total} alive cells`);
      }
    } else {
      // plain E: decrease tick rate (slower)
      stepInterval = Math.min(2000, Math.ceil(stepInterval * 1.25));
    }
    e.preventDefault();
  }
  else if ((e.key === 'r' || e.key === 'R') && e.ctrlKey) {
    // Ctrl+R: open Super-Speed menu to pick a discrete per-frame multiplier (1..100)
    openSuperSpeedMenu();
    e.preventDefault();
  }
  else if ((e.key === 'r' || e.key === 'R') && isShiftLike) {
    // Shift+R: extreme tick rate — 7,500,000 ticks per second (legacy)
    stepInterval = 1000 / 7500000; // ms per tick (very small)
    // ensure simulation is running and reset step timer to avoid huge backlog
    running = true;
    lastStep = performance.now();
    // entering legacy extreme tick interval clears any superStepMultiplier so behavior is predictable
    superStepMultiplier = 1;
    flashTinyToast('Extreme ticks: 7,500,000 tps', 1200);
    e.preventDefault();
  }
  else if (e.key === 'r' || e.key === 'R') { // increase tick rate (faster)
    stepInterval = Math.max(20, Math.floor(stepInterval * 0.8));
    e.preventDefault();
  }
  else if (e.key === 'w' || e.key === 'W') {
    if (isShiftLike) {
      // Shift+W: reset camera to starting point
      offsetX = 0;
      offsetY = 0;
      flashTinyToast('Camera reset to origin');
      draw(performance.now());
    } else {
      // plain W: reset tick rate to default
      stepInterval = DEFAULT_STEP_INTERVAL;
    }
    e.preventDefault();
  }
  else if ((e.key === 'f' || e.key === 'F') && isShiftLike) {
    // Shift+F: export all cells (alive + fading multi-state + pendingPlacement) as Extended RLE and copy to clipboard.
    // Not available in Hex Mode -- RLE's row-scanned rectangular format and its "rule = B#/S#"
    // header have no meaningful hex-topology representation.
    if (blockedInHexMode('RLE export')) { e.preventDefault(); return; }
    // Build a deduplicated list like cellsInSelection does, ensuring faded states are not missed.
    const cells = [];
    const seen = new Set();

    // include alive cells (state 1)
    for (const k of alive) {
      const [x, y] = parseKey(k);
      cells.push({ x, y, s: 1 });
      seen.add(k);
    }

    // include fading / multi-state entries (states map), preserve their exact stage
    for (const [k, st] of states.entries()) {
      if (seen.has(k)) continue;
      const [x, y] = parseKey(k);
      cells.push({ x, y, s: st });
      seen.add(k);
    }

    // include pendingPlacement (these are intended as alive in the next activation)
    for (const k of pendingPlacement) {
      if (seen.has(k)) continue;
      const [x, y] = parseKey(k);
      // pending placements are effectively alive (state 1) for export purposes
      cells.push({ x, y, s: 1 });
      seen.add(k);
    }

    // ensure invincible cells are NOT included (they are not part of life states); if you want them included remove this.
    // (This matches selection behavior which also excluded invincible pixels.)
    // Build rule hint string
    const ruleHint = `B${[...birthRules].sort((a,b)=>a-b).join('')}/S${[...survivalRules].sort((a,b)=>a-b).join('')}${cellStatesCount>2?('/G'+cellStatesCount):''}`;
    const rle = cellsToRLE(cells, ruleHint);

    (async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(rle);
          flashTinyToast('All cells exported as multi-state RLE (copied)');
        } else {
          const ta = document.createElement('textarea');
          ta.value = rle;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          flashTinyToast('All cells exported as multi-state RLE (copied)');
        }
      } catch (err) {
        alert('Copy failed: ' + err);
      }
    })();
    e.preventDefault();
  }
  // Ctrl+F: open cluster-scan modal to detect clusters within a sensitivity radius (default 10, min 5, max 750)
  else if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || pMode === 'ctrl')) {
    openClusterScanModal();
    e.preventDefault();
  }
  else if (e.key === 'f' || e.key === 'F') { // toggle age overlay
    showAges = !showAges;
    e.preventDefault();
  }
  else if ((e.key === 'b' || e.key === 'B') && isShiftLike) {
    // Shift+B: remove exactly one random alive cell
    if (alive.size === 0) {
      flashTinyToast('No cells to remove');
    } else {
      const arr = Array.from(alive);
      const idx = Math.floor(Math.random() * arr.length);
      const k = arr[idx];
      alive.delete(k);
      birth.delete(k);
      flashTinyToast(`Removed 1 cell at ${k}`);
    }
    e.preventDefault();
  }
  else if (e.key === 'b' || e.key === 'B') {
    // LTL mode: B/Ctrl+B have their own rule-editing behavior here, entirely separate from the
    // classic Bn/Snn branch below (an LTL rule can't be expressed in that syntax at all -- its
    // S/B are wide numeric ranges over a huge neighborhood, not small per-count digit sets).
    if (ltlMode) {
      if (e.ctrlKey) {
        // Ctrl+B in LTL mode: revert to the default Bugs rule, same "instant reset" role Ctrl+B
        // plays in classic mode -- and also clears any mid-fade cells, mirroring classic
        // Ctrl+B's purge of the states map when it resets to binary.
        applyLTLRuleString(LTL_DEFAULT_RULE_STRING);
        for (const [k] of Array.from(states.entries())) {
          states.delete(k);
          alive.delete(k);
          birth.delete(k);
        }
        flashTinyToast(`LTL rules reset to default: ${LTL_DEFAULT_RULE_STRING}`);
        e.preventDefault();
        return;
      }

      // Plain B in LTL mode: prompt for a new LTL rule string. S and B's max are capped by the
      // radius (see ltlMaxNeighborCount()) -- a (2*radius+1) square window can only contain so
      // many neighbors, so the prompt spells that ceiling out for the player rather than
      // silently rejecting an out-of-range value with no explanation. C works exactly like
      // classic mode's /G: it's the total state count, C>=3 means cells that fail survival
      // fade through states 2..C-1 instead of dying outright, C0/C1/C2 all mean no fading.
      // S and B each also accept a single number (e.g. "S40") as shorthand for that exact count
      // (equivalent to "S40-40") -- see parseLTLRuleString()'s S/B handling.
      const maxCount = ltlMaxNeighborCount(ltlRadius, ltlIncludeCenter);
      const currentLTLRuleStr = `R${ltlRadius},C${ltlCellStatesCount},S${ltlSurvivalMin}-${ltlSurvivalMax},B${ltlBirthMin}-${ltlBirthMax}`;
      const ltlInput = prompt(
        `Enter an LTL rule as R<radius>,C<states>,S<min>-<max>,B<min>-<max> (S/B can also be a single number, e.g. S40).\n` +
        `At R${ltlRadius}, S and B's max is ${maxCount} -- change R to raise or lower that ceiling.\n` +
        `C works like classic mode's /G: it's the TOTAL state count. C>=3 makes failed-survival cells fade over C-1 steps instead of dying immediately; C0/C1/C2 all mean no fading, up to C256.`,
        currentLTLRuleStr
      );
      if (!ltlInput) { e.preventDefault(); return; }
      const ltlParsed = parseLTLRuleString(ltlInput.trim());
      if (!ltlParsed) {
        const attemptedMax = (() => {
          // Best-effort: if only R changed, show the ceiling implied by the attempted string so
          // a range-exceeded rejection is diagnosable instead of a bare "invalid".
          const rMatch = ltlInput.match(/[Rr](\d+)/);
          if (!rMatch) return null;
          return ltlMaxNeighborCount(parseInt(rMatch[1], 10), false);
        })();
        alert(`Invalid LTL rule string.${attemptedMax != null ? ` (At that radius, S and B's max is ${attemptedMax}.)` : ''} Use R<radius>,C<states 0-256>,S<min>-<max>,B<min>-<max> (S/B may also be a single number), e.g. ${LTL_DEFAULT_RULE_STRING}`);
        e.preventDefault();
        return;
      }
      ltlRadius = ltlParsed.radius;
      ltlSurvivalMin = ltlParsed.survivalMin;
      ltlSurvivalMax = ltlParsed.survivalMax;
      ltlBirthMin = ltlParsed.birthMin;
      ltlBirthMax = ltlParsed.birthMax;
      ltlNeighborhood = ltlParsed.neighborhood;
      ltlIncludeCenter = ltlParsed.includeCenter;
      ltlCellStatesCount = ltlParsed.states;
      // Switching back to no-fading (C<3) purges any cells left mid-fade, same as classic
      // mode's own C==2 migration just below.
      if (ltlCellStatesCount < 3) {
        for (const [k] of Array.from(states.entries())) {
          states.delete(k);
          alive.delete(k);
          birth.delete(k);
        }
      }
      flashTinyToast(`LTL rule set: R${ltlRadius},C${ltlCellStatesCount},S${ltlSurvivalMin}-${ltlSurvivalMax},B${ltlBirthMin}-${ltlBirthMax}`);
      e.preventDefault();
      return;
    }

    // Ctrl+B: immediately reset rules back to the current mode's default and binary states.
    // In Hex Mode that's B2/S34 (the hex-topology analog used when entering Hex Mode); in
    // normal mode it's Conway's classic B3/S23.
    if (e.ctrlKey) {
      if (hexMode) {
        birthRules = new Set([2]);
        survivalRules = new Set([3, 4]);
      } else {
        birthRules = new Set([3]);
        survivalRules = new Set([2,3]);
      }
      cellStatesCount = 2;
      // purge any fading states so we are in pure binary life
      for (const [k, st] of Array.from(states.entries())) {
        if (st === 1) alive.add(k);
        else {
          states.delete(k);
          alive.delete(k);
          birth.delete(k);
        }
      }
      flashTinyToast(hexMode ? 'Rules reset to Hex default: B2/S34' : 'Rules reset to Conway: B3/S23');
      e.preventDefault();
      return;
    }

    // prompt for rules like "B3/S23" or "B36/S23"; only digits 0-8 allowed
    // Use the current rule as the prompt default so the user sees the active rule string.
    // allow optional /C third section for generational states: prompt default shows current full rule
    const currentRuleStr = `B${[...birthRules].sort((a,b)=>a-b).join('')}/S${[...survivalRules].sort((a,b)=>a-b).join('')}${cellStatesCount>2?('/G'+cellStatesCount):''}`;
    const input = prompt('Enter rules in Bn/Snn or Bn/Snn/Gn format (digits 0-8 only for neighbors; generational section must start with "G" if present). E.g. B3/S23 or B2/S34/G4', currentRuleStr);
    if (!input) { e.preventDefault(); return; }

    // If user supplied a third slash section, require it begins with 'G' (case-insensitive).
    // This enforces the inputter rule while the parser itself will accept and ignore a leading G.
    const parts = input.trim().split('/');
    if (parts.length >= 3) {
      const third = parts[2] || '';
      // if there is a fourth part (e.g., B.../S.../G4) then the third is S and fourth is the G part;
      // handle both 3- and 4-segment inputs robustly.
      if (parts.length === 3) {
        // format B.../S.../C  -> in our new convention this should be B.../S.../G#
        if (third !== '' && !/^[gG]\d+/.test(third)) {
          alert('Invalid third section: when present it must start with "G" followed by the state count (e.g. /G4).');
          e.preventDefault();
          return;
        }
      } else {
        // parts.length >= 4, ensure the fourth segment (the numeric state) starts with optional G or is numeric
        const fourth = parts[3] || '';
        if (fourth !== '' && !/^\d+/.test(fourth) && !/^[gG]\d+/.test(fourth)) {
          alert('Invalid generational section: expected /G# for the state count.');
          e.preventDefault();
          return;
        }
        // additionally, if the third segment (parts[2]) is not the S part, ensure conventional structure:
        // We won't over-validate here; rely on parseRuleString for final parsing.
      }
    }

    const parsed = parseRuleString(input);
    if (!parsed || !(parsed.b instanceof Set) || !(parsed.s instanceof Set)) {
      alert('Invalid format. Use B{digits}/S{digits} or B{digits}/S{digits}/G{C} (C integer >= 2).');
      e.preventDefault();
      return;
    }
    birthRules = parsed.b;
    survivalRules = parsed.s;
    cellStatesCount = parsed.c || 2;
    // When switching back to binary (C==2) remove any stored fading states >1 and rebuild alive set
    if (cellStatesCount === 2) {
      // migrate states map: any key with state===1 -> ensure in alive; any >1 -> remove
      for (const [k, st] of Array.from(states.entries())) {
        if (st === 1) alive.add(k);
        else {
          states.delete(k);
          // ensure not present in alive or birth
          alive.delete(k);
          birth.delete(k);
        }
      }
    }
    e.preventDefault();
  }
  else if (e.key === 'g' || e.key === 'G') {
    // Ctrl+G: hard wipe — remove everything including fading states, and also clear the landing map (Ctrl+Q behavior)
    if (e.ctrlKey) {
      alive.clear();
      birth.clear();
      states.clear();         // remove faded / multi-state cells too
      invincible.clear();
      pendingPlacement.clear();
      activatePendingOnly = false;
      pendingPlacementStart = 0;
      generation = 0;
      historyStack.length = 0;
      ruleSpots.length = 0;   // remove all placed Rule Spots too
      clearAllPortals();      // hard wipe also removes all portals -- persistent board structure, same as invincible walls and Rule Spots
      fastForwardResetCycleMemory();
      fastForwardRunRemaining = 0;
      fastForwardLastStats = null;

      // Also perform the Ctrl+Q effect: clear the persistent landing map and hide its overlay
      try {
        deadLanding.clear();
        landingMapVisible = false;
      } catch (err) { /* ignore if map not present */ }

      // Keep the Rule Spot panel's placed-count label in sync if it happens to be open.
      try {
        const rsPanel = document.getElementById('rule-spot-panel');
        if (rsPanel && rsPanel._updatePlacedCount) rsPanel._updatePlacedCount();
      } catch (err) { /* ignore if panel not present */ }

      flashTinyToast('Hard wipe: all cells and Rule Spots removed (landing map cleared)');
    } else if (isShiftLike) {
      // Shift+G: delete all invincible cells only
      const count = invincible.size;
      invincible.clear();
      flashTinyToast(`Removed ${count} invincible cells`);
    } else {
      // plain G: clear everything except faded states (legacy behavior)
      alive.clear();
      birth.clear();
      invincible.clear();
      pendingPlacement.clear();
      activatePendingOnly = false;
      pendingPlacementStart = 0;
      generation = 0;
      fastForwardResetCycleMemory();
      fastForwardLastStats = null;
    }
    e.preventDefault();
  }
  else if (e.key === 't' || e.key === 'T') {
    if (isShiftLike) {
      // Shift+T: delete only all alive cells but keep invincible walls
      const aliveCount = alive.size;
      alive.clear();
      birth.clear();
      pendingPlacement.clear();
      activatePendingOnly = false;
      pendingPlacementStart = 0;
      generation = 0;
      fastForwardResetCycleMemory();
      fastForwardLastStats = null;
      flashTinyToast(`Deleted ${aliveCount} alive cells (invincible preserved)`);
    } else {
      // plain T: open RLE modal (not available in Hex Mode -- RLE's row/column format and its
      // whole pattern library are built for the square Moore-neighbor grid)
      if (!blockedInHexMode('RLE import')) openRLEModal();
    }
    e.preventDefault();
  }
  else if ((e.key === 'y' || e.key === 'Y') && isShiftLike) {
    // Shift+Y -> open rule-presets modal (not available in Hex Mode -- these B/S presets are
    // curated for square 8-neighbor dynamics; hex mode has its own fixed default rule instead)
    if (!blockedInHexMode('Rule presets')) openRulePresetModal();
    e.preventDefault();
  }
  else if (e.key === 'y' || e.key === 'Y') {
    // Not available in Hex Mode -- the preset library is classic square-grid patterns (gliders,
    // oscillators, guns) defined for Moore-neighbor B3/S23-family rules.
    if (!blockedInHexMode('Pattern presets')) openPresetModal();
    e.preventDefault();
  }
  else if (e.key === 'u' || e.key === 'U') {
    if (isShiftLike) {
      // Shift+U: delete only faded / multi-state cells (states map), preserve alive and invincible
      const removed = states.size;
      states.clear();
      flashTinyToast(`Deleted ${removed} faded cell(s)`);
    } else {
      // plain U: open help modal
      openHelpModal();
    }
    e.preventDefault();
  }
  else if ((e.key === 'i' || e.key === 'I') && (e.ctrlKey || pMode === 'ctrl')) {
    // Ctrl+I: toggle Hex Mode -- an animated topology swap between square and hexagonal grids.
    // Fires a pixelate-out/board-fade -> swap -> pixelate-in transition (see startHexTransition);
    // the actual hexMode flip + rule change happens mid-animation, at full pixelation.
    startHexTransition();
    e.preventDefault();
    return;
  }
  else if (e.key === 'i' || e.key === 'I') {
    if (e.shiftKey) {
      // Shift+I toggles legacy mode: allow only Arrow keys and plain a/s/x/z, block everything else.
      legacyMode = !legacyMode;
      flashTinyToast(legacyMode ? 'Legacy mode: ON (only Arrows + A/S/X/Z allowed)' : 'Legacy mode: OFF', 1400);
    } else {
      // plain I opens stats modal
      openStatsModal();
    }
    e.preventDefault();
  }
  else if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || pMode === 'ctrl')) {
    // Ctrl+L: open the Macrocell (.mc) import modal, for large patterns stored as a quadtree.
    // Not available in Hex Mode -- macrocell is a square-subdivision (literally "quad") format
    // with no hex analog.
    if (!blockedInHexMode('Macrocell import')) {
      try {
        openMacrocellModal();
      } catch (err) {
        console.warn('Failed to open Macrocell modal:', err);
      }
    }
    e.preventDefault();
    return;
  }
  else if (e.key === 'l' || e.key === 'L') {
    // Shift+L: increase brightness of cells
    if (isShiftLike) {
      cellBrightness = Math.min(3.0, +(cellBrightness + 0.1).toFixed(2));
      flashTinyToast(`Cell brightness: ${cellBrightness.toFixed(2)}`);
      e.preventDefault();
      return;
    }
    // plain L opens age-color legend modal
    openAgeLegendModal();
    e.preventDefault();
  }
  else if ((e.key === 'h' || e.key === 'H') && (e.ctrlKey || pMode === 'ctrl')) {
    // Ctrl+H: open the FastForward panel (bulk-step + finite-cycle accelerator)
    try {
      openFastForwardPanel();
    } catch (err) {
      console.warn('Failed to open FastForward panel:', err);
    }
    e.preventDefault();
    return;
  }
  else if ((e.key === 'm' || e.key === 'M') && (e.ctrlKey || pMode === 'ctrl')) {
    // Ctrl+M: take a snapshot of the current board state and add it to the Snapshot menu (Ctrl+K)
    try {
      const snap = takeSnapshot();
      flashTinyToast(`Snapshot saved: "${snap.name}" (${snap.cellCount} cells)`, 1400);
    } catch (err) {
      console.warn('Failed to take snapshot:', err);
      flashTinyToast('Failed to take snapshot', 1400);
    }
    e.preventDefault();
    return;
  }
  else if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || pMode === 'ctrl')) {
    // Ctrl+K: open the Snapshot menu (load/rename/delete/download saved snapshots)
    try {
      openSnapshotMenu();
    } catch (err) {
      console.warn('Failed to open Snapshot menu:', err);
    }
    e.preventDefault();
    return;
  }
  else if (e.key === 'h' || e.key === 'H') {
    // If Shift+H -> toggle global keyboard lock (disable most keys) otherwise detach template.
    if (e.shiftKey) {
      keyboardLocked = !keyboardLocked;
      flashTinyToast(keyboardLocked ? 'Keyboard: DISABLED (limited keys active)' : 'Keyboard: ENABLED', 1200);
    } else {
      // detach the contraption from the mouse but keep the template cached
      templateAttached = false;
      flashTinyToast('Template detached');
    }
    e.preventDefault();
  }
  // Rotate template: N = rotate left (CCW), M = rotate right (CW)
  else if ((e.key === 'n' || e.key === 'N')) {
    // Shift+N toggles grid visibility; plain N rotates template when attached
    if (e.shiftKey) {
      showGrid = !showGrid;
      flashTinyToast(showGrid ? 'Grid: SHOWN' : 'Grid: HIDDEN');
    } else {
      if (templateCells && templateAttached) {
        rotateTemplateLeft();
        flashTinyToast('Template rotated left');
      }
    }
    e.preventDefault();
  }
  else if ((e.key === 'm' || e.key === 'M')) {
    if (e.shiftKey) {
      // Shift+M => open identification modal to choose or paste an RLE to scan for.
      // Not available in Hex Mode -- the scanner searches for classic RLE-defined square-grid
      // patterns (its own internal simulations are square-grid too), independent of the main
      // board's topology, so it's not a meaningful tool to offer while the main board is hex.
      if (!blockedInHexMode('Identification Scanner')) openIdentificationModal();
    } else {
      if (templateCells && templateAttached) {
        rotateTemplateRight();
        flashTinyToast('Template rotated right');
      }
    }
    e.preventDefault();
  }
  // K: flip template horizontally (mirror left/right) or Shift+K toggles the G-key enable/disable state
  else if ((e.key === 'k' || e.key === 'K')) {
    if (e.shiftKey) {
      // Toggle the G key lock
      gKeyDisabled = !gKeyDisabled;
      flashTinyToast(gKeyDisabled ? 'G key: DISABLED' : 'G key: ENABLED', 1000);
    } else {
      if (templateCells && templateAttached) {
        // mirror across Y axis: (x,y) -> (-x,y)
        templateCells = templateCells.map(c => ({ x: -c.x, y: c.y }));
        flashTinyToast('Template flipped horizontally');
      }
    }
    e.preventDefault();
  }
  else if (e.key === '`') {
    // Show cell info for a live cell under the pointer; do nothing if pointer absent or not on a live cell.
    (async () => {
      if (!mousePos) {
        flashTinyToast('No live cell under pointer');
        e.preventDefault();
        return;
      }
      const { wx, wy } = screenToWorld(mousePos.x, mousePos.y);
      const key = `${wx},${wy}`;
      if (!alive.has(key) || !birth.has(key)) {
        flashTinyToast('No live cell under pointer');
        e.preventDefault();
        return;
      }

      // compute initial values and open modal
      const rec = birth.get(key); // { t, p, gen? }
      if (document.getElementById('cell-info-modal')) document.getElementById('cell-info-modal').remove();
      const modal = document.createElement('div');
      modal.id = 'cell-info-modal';
      Object.assign(modal.style, {
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
        background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 10003,
        width: 'min(84vw,360px)', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
      });

      const title = document.createElement('div');
      title.textContent = `Cell @ (${wx}, ${wy})`;
      Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
      modal.appendChild(title);

      const grid = document.createElement('div');
      grid.style.display = 'grid';
      grid.style.gridTemplateColumns = '1fr auto';
      grid.style.rowGap = '8px';
      grid.style.columnGap = '10px';
      grid.style.fontSize = '13px';

      // create 6 rows; we'll update values periodically
      const rows = [
        ['Age (ms)', ''],
        ['Age (ticks)', ''],
        ['Born on generation', ''],
        ['Recorded birth timestamp', ''],
        ['Paused-accum at birth (ms)', ''],
        ['Current generation', '']
      ];
      for (const r of rows) {
        const keyEl = document.createElement('div');
        keyEl.textContent = r[0];
        Object.assign(keyEl.style, { color: 'rgba(255,255,255,0.9)', fontWeight: '600' });
        const valEl = document.createElement('div');
        valEl.textContent = r[1];
        Object.assign(valEl.style, { color: 'rgba(255,255,255,0.85)', textAlign: 'right' });
        grid.appendChild(keyEl);
        grid.appendChild(valEl);
      }

      modal.appendChild(grid);

      const btnRow = document.createElement('div');
      btnRow.style.display = 'flex';
      btnRow.style.justifyContent = 'flex-end';
      btnRow.style.gap = '8px';
      btnRow.style.marginTop = '10px';

      const closeBtn = document.createElement('button');
      closeBtn.textContent = 'Close';
      Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
      closeBtn.addEventListener('click', () => {
        const el = document.getElementById('cell-info-modal');
        if (el) el.remove();
        if (updId) clearInterval(updId);
      });

      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy info';
      Object.assign(copyBtn.style, { padding: '8px 10px', cursor: 'pointer' });
      copyBtn.addEventListener('click', async () => {
        // compute current snapshot before copying
        const effectiveNow = running ? performance.now() : (pauseStart || performance.now());
        const ageMs = Math.max(0, (effectiveNow - pausedAccum) - (rec.t - rec.p));
        const ticks = Math.floor(ageMs / Math.max(1, stepInterval));
        const birthGen = (typeof rec.gen === 'number') ? rec.gen : Math.max(0, generation - ticks);
        const txt = `Cell ${key}\nAge: ${Math.round(ageMs)} ms (${ticks} ticks)\nBorn on generation: ${birthGen}\nBirth timestamp: ${Math.round(rec.t)} ms\nPaused-accum at birth: ${Math.round(rec.p)} ms\nCurrent generation: ${generation}`;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(txt);
          else {
            const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); ta.remove();
          }
          flashTinyToast('Cell info copied');
        } catch (err) {
          alert('Copy failed: ' + err);
        }
      });

      btnRow.appendChild(copyBtn);
      btnRow.appendChild(closeBtn);
      modal.appendChild(btnRow);

      document.body.appendChild(modal);

      // updater: refresh displayed numbers driven strictly by generation counts (no real-time fallback)
      function updateGrid() {
        // compute age in generations (ticks) from stored birth.gen (must exist) — fallbacks avoided
        const ageTicks = (rec && typeof rec.gen === 'number') ? Math.max(0, generation - rec.gen) : 0;

        // grid children are pairs: key,val,key,val,...
        const vals = [
          `${ageTicks} gens`,
          String(ageTicks),
          (typeof rec.gen === 'number') ? String(rec.gen) : 'unknown',
          (typeof rec.gen === 'number') ? String(rec.gen) : 'unknown',
          (typeof rec.gen === 'number') ? `gen:${rec.gen}` : 'no-gen',
          String(generation)
        ];
        for (let i = 0; i < vals.length; i++) {
          const valNode = grid.children[i*2 + 1];
          if (valNode) valNode.textContent = vals[i];
        }
      }

      updateGrid();
      const updId = setInterval(() => {
        // if modal removed, clear interval
        if (!document.getElementById('cell-info-modal')) {
          clearInterval(updId);
          return;
        }
        // refresh rec (in case birth record was updated externally)
        if (!birth.has(key)) return; // cell died
        // read latest record so gen/readings reflect stored values
        const latest = birth.get(key);
        if (latest) {
          // override rec to keep timestamp and pausedAcc accurate if changed
          rec.t = latest.t; rec.p = latest.p; rec.gen = latest.gen;
        }
        updateGrid();
      }, 200);

      e.preventDefault();
    })();
  }
  // J: spawn 15x15 random noise centered on the screen. Shift+J => "super J" 31x31 noise. Ctrl+J => "ultra J" 45x45 noise.
  else if (e.key === 'j' || e.key === 'J') {
    const center = screenToWorld(window.innerWidth/2, window.innerHeight/2);
    const now = performance.now();
    // detect modifiers: real Ctrl key triggers ultra J; Shift-like (actual Shift or P-mode virtual Shift) triggers super J
    const isCtrlLike = e.ctrlKey;
    // areaHalf values: normal 7 -> 15x15, shift 15 -> 31x31, ctrl 22 -> 45x45
    const areaHalf = isCtrlLike ? 22 : (isShiftLike ? 15 : 7);
    let placed = 0;
    for (let dx = -areaHalf; dx <= areaHalf; dx++) {
      for (let dy = -areaHalf; dy <= areaHalf; dy++) {
        if (Math.random() < 0.5) {
          const x = center.wx + dx;
          const y = center.wy + dy;
          const k = `${x},${y}`;
          if (!alive.has(k)) {
            alive.add(k);
            birth.set(k, { t: now, p: pausedAccum });
            placed++;
          }
        }
      }
    }
    if (isCtrlLike) flashTinyToast(`Ultra noise spawned (${placed} cells)`);
    else if (isShiftLike) flashTinyToast(`Super noise spawned (${placed} cells)`);
    else flashTinyToast(`Noise spawned (${placed} cells)`);
    e.preventDefault();
  }
  // P: cycle P-mode: regular -> shift -> ctrl -> regular
  else if (e.key === 'p' || e.key === 'P') {
    if (pMode === 'regular') pMode = 'shift';
    else if (pMode === 'shift') pMode = 'ctrl';
    else pMode = 'regular';
    flashTinyToast(`P-mode: ${pMode.toUpperCase()}`, 1400);
    e.preventDefault();
  }
});

// Safety net for every "hold this key to do X" flag in the game: if the window/tab loses
// focus while a key is physically held down (alt-tabbing away, clicking outside the game,
// an OS notification stealing focus, opening dev tools, etc.), the browser never fires a
// matching keyup event once focus returns -- the key's hold-flag stays stuck true forever,
// making the game act as if that key is still being pressed even though the player has let
// go. Resetting every hold-flag on blur closes that gap for good, rather than leaving the
// player's only recourse be re-pressing and releasing the stuck key to clear it manually.
addEventListener('blur', () => {
  pDown = false;
  oDown = false;
  invDown = false;
  spaceDown = false;
  portalDrawDown = false;
  portalEraseDown = false;
  portalStraightDown = false;
  portalStraightAnchor = null;
  portalStraightLastKeys = null;
});

addEventListener('keyup', (e) => {
  if (altNMode && (e.key === 'x' || e.key === 'X')) {
    // Clear BOTH portal-X flags unconditionally on release, not just whichever one an
    // if/else-if chain happened to match first -- a mid-hold Shift press/release can leave
    // both portalDrawDown and portalStraightDown true at once (see the keydown handlers'
    // mutual-exclusion comments), and an if/else-if here would only ever clear one of them,
    // leaving the other permanently stuck true with no way for the player to clear it except
    // pressing X again to re-trigger this same broken cleanup.
    portalDrawDown = false;
    portalStraightDown = false;
    portalStraightAnchor = null;
    portalStraightLastKeys = null;
  }
  else if (altNMode && (e.key === 'z' || e.key === 'Z')) { portalEraseDown = false; }
  else if (e.key === 'x' || e.key === 'X') {
    // try to stop the invincible-mode first if it was used with Shift
    if (e.shiftKey || invDown) invDown = false;
    // otherwise stop normal draw
    pDown = false;
  }
  else if (e.key === 'z' || e.key === 'Z') { oDown = false; }
  else if (e.key === 'o' || e.key === 'O') {
    // release O: compute selection rectangle and open modal, but KEEP selectionActive true
    // so the selection rectangle and blue highlight persist until the user picks an action.
    if (selectionActive && selStart && selCurrent) {
      // compute selection rectangle in CSS pixels (normalize)
      const x1 = Math.min(selStart.x, selCurrent.x);
      const y1 = Math.min(selStart.y, selCurrent.y);
      const x2 = Math.max(selStart.x, selCurrent.x);
      const y2 = Math.max(selStart.y, selCurrent.y);

      // populate selectedSet so draws can highlight selected pixels in blue
      const selCells = cellsInSelection({ x1, y1, x2, y2 });
      selectedSet.clear();
      for (const c of selCells) selectedSet.add(c.key);

      openSelectionModal({ x1, y1, x2, y2 });
      // freeze the selection so it no longer follows the mouse after O is released;
      // selectionActive remains true until the user chooses an action in the modal.
      selectionFrozen = true;
    } else {
      // nothing selected; ensure selection state is cleared
      selectionActive = false;
      selStart = null;
      selCurrent = null;
      selectedSet.clear();
      selectionFrozen = false;
    }
  }
  else if (e.code === 'Space' || e.key === ' ') {
    // releasing Space disables crosshair-arrow movement
    spaceDown = false;
    // clear arrow hold flags used for continuous crosshair motion
    leftArrowDown = rightArrowDown = upArrowDown = downArrowDown = false;
  }
  // clear arrow flags if individual arrow key is released (covers cases where space remains held)
  else if (e.key === 'ArrowLeft') leftArrowDown = false;
  else if (e.key === 'ArrowRight') rightArrowDown = false;
  else if (e.key === 'ArrowUp') upArrowDown = false;
  else if (e.key === 'ArrowDown') downArrowDown = false;
});

/* Selection modal and helpers */
function drawSelectionRectOnCanvas(rect) {
  // rect: { x1,y1,x2,y2 } in CSS pixels
  ctx.save();
  ctx.strokeStyle = 'rgba(0,200,255,0.9)';
  ctx.fillStyle = 'rgba(0,200,255,0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.rect(rect.x1 + 0.5, rect.y1 + 0.5, rect.x2 - rect.x1, rect.y2 - rect.y1);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function worldBoundsTouchingRect(rect) {
  // Convert rect corners to world cell coords and return inclusive integer bounds (minX,maxX,minY,maxY)
  const tl = screenToWorld(rect.x1, rect.y1);
  const br = screenToWorld(rect.x2, rect.y2);
  let minx = Math.min(tl.wx, br.wx);
  let maxx = Math.max(tl.wx, br.wx);
  let miny = Math.min(tl.wy, br.wy);
  let maxy = Math.max(tl.wy, br.wy);
  // Expand by 1 cell to include cells "touching" the square
  minx -= 1; miny -= 1; maxx += 1; maxy += 1;
  return { minx, maxx, miny, maxy };
}

function cellsInSelection(rect) {
  const wb = worldBoundsTouchingRect(rect);
  const found = [];
  const seen = new Set();

  // Include alive cells (state==1)
  for (const k of alive) {
    if (invincible.has(k)) continue;
    const [x, y] = parseKey(k);
    if (x >= wb.minx && x <= wb.maxx && y >= wb.miny && y <= wb.maxy) {
      found.push({ x, y, key: k, s: 1 });
      seen.add(k);
    }
  }

  // Also include faded / multi-state entries from the states map (state >= 2)
  for (const [k, st] of states.entries()) {
    if (invincible.has(k)) continue;
    if (seen.has(k)) continue; // don't duplicate if already added as alive
    const [x, y] = parseKey(k);
    if (x >= wb.minx && x <= wb.maxx && y >= wb.miny && y <= wb.maxy) {
      // preserve the exact faded stage number (st)
      found.push({ x, y, key: k, s: st });
      seen.add(k);
    }
  }

  return found;
}

/* ================= Ancestor Finder (Alt+X) =================
   Searches for predecessor states (generation N-1 configurations that evolve into the given
   target under the current B/S rule) via bounded backtracking constraint search. Square-grid
   / Moore-neighborhood only -- not offered in Hex Mode (see openAncestorFinderModal's guard).

   Algorithm: build a padded "variable region" around the target's bounding box (padded by 2 in
   every direction -- enough that any cell whose neighborhood could affect a target-region cell,
   and whose OWN neighborhood in turn needs checking, is included). Every cell in that region is
   an unknown (dead/alive) to search over. For every cell in that SAME region, its predecessor
   state forward-steps (via the standard birth/survival rule) to either "target's actual state
   there" (inside the target's own footprint) or "dead" (everywhere else in the region) --
   getting this constraint region's extent right was the difference between finding predecessors
   that only ROUGHLY resembled the target (verified false) versus ones that forward-simulate to
   EXACTLY the target with nothing extra outside it (verified true).

   Variable ordering: most-constrained-variable (MRV) rather than a fixed order -- at each step,
   among currently-unassigned cells, pick whichever has the FEWEST still-feasible values (0, 1,
   or 2 out of {dead, alive}), so branches that are forced or near-forced get resolved first and
   contradictions surface as early as possible. Plain static ordering wastes huge amounts of
   search on cells that don't matter yet; MRV consistently cut node counts by 30-50x in testing
   on harder patterns. To keep MRV's own per-node cost cheap, the scan for "which cell is most
   constrained" is limited to the "active" region -- the target's own bounding box, plus any
   unassigned cell adjacent to an already-assigned one (the search frontier) -- rather than
   rescanning the entire padded region on every node; cells outside that frontier fall back to a
   simple distance-from-center order once the frontier is exhausted. This combination was
   verified to find identical, fully-correct results (forward-simulated back to the exact
   target) as a plain static order, while being both far fewer search nodes AND faster in wall-
   clock time on harder patterns (a 10-cell irregular pattern: ~3900 nodes, ~340ms) without
   being slower on easy ones (a 5-cell glider: ~4000 nodes, under 500ms).

   Backtracks cell-by-cell (dead tried before alive, since sparse predecessors are far more
   likely/interesting than dense ones), with per-assignment feasibility pruning: after each
   tentative assignment, every constraint whose dependency cells (itself + 8 neighbors) are all
   within the region is re-checked against what's still achievable given any UNASSIGNED
   neighbors -- infeasible branches are cut immediately rather than discovered only once fully
   assigned.

   Bounded by both a node-count cap and a wall-clock time budget so it can never hang the UI --
   if neither the requested count nor the caps are hit first, the caller treats it as "possibly
   no predecessor exists" (a possible Garden of Eden) rather than a crash or infinite spin. This
   is explicitly NOT a proof of non-existence -- it's a practical "this was too hard to find one
   for" within the time/node budget: reliable on small/moderate patterns, honest about giving up
   on harder ones, not a competitor to real SAT-based finders. */
function findPredecessors(targetAliveKeys, birthRulesSet, survivalRulesSet, opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(10, opts.limit || 5));
  const maxNodes = opts.maxNodes || 4000000;
  const timeBudgetMs = opts.timeBudgetMs || 6000;
  // Strict mode: forbids any predecessor cell further than 1 step from the target's own
  // bounding box. Without this, the search is free to plant isolated, non-interacting "debris"
  // cells out in the padding (e.g. a lone cell 2+ cells away that dies of isolation next step
  // without ever touching the target) since such cells trivially satisfy "stays dead/doesn't
  // disturb anything nearby" -- they're technically valid but not meaningfully part of what
  // births the target, and every extra one found this way just duplicates an otherwise-clean
  // predecessor with pointless clutter attached. A 1-cell halo around the target bbox is the
  // provably minimum possible margin for ANY valid predecessor (a cell 2+ away from the target
  // bbox cannot be a neighbor of anything inside it), so restricting to that halo can never
  // exclude a genuinely necessary predecessor cell -- only ever-unnecessary ones.
  const strict = !!opts.strict;

  if (!targetAliveKeys || targetAliveKeys.size === 0) {
    return { predecessors: [], gaveUp: false, nodes: 0, exhaustedSearch: true };
  }

  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const k of targetAliveKeys) {
    const [x, y] = parseKey(k);
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }

  // Variable region: target bbox padded by 2 (required for correctness -- 1 ring undercounts
  // which cells need their own constraint check; see block comment above).
  const vMinX = minx - 2, vMaxX = maxx + 2, vMinY = miny - 2, vMaxY = maxy + 2;
  const vW = vMaxX - vMinX + 1, vH = vMaxY - vMinY + 1;
  const idx = (x, y) => (y - vMinY) * vW + (x - vMinX);
  const assign = new Int8Array(vW * vH).fill(-1); // -1 unknown, 0 dead, 1 alive

  // In strict mode, force the OUTER ring (Chebyshev distance > 1 from the target's own bbox)
  // permanently dead before search even begins -- it's never treated as a free variable, so the
  // search space shrinks and no branch can ever place debris there. The inner 1-cell halo (and
  // the target bbox itself) remain fully free, since that's the true minimum margin any valid
  // predecessor could need.
  if (strict) {
    for (let y = vMinY; y <= vMaxY; y++) for (let x = vMinX; x <= vMaxX; x++) {
      const dx = Math.max(minx - x, 0, x - maxx);
      const dy = Math.max(miny - y, 0, y - maxy);
      if (Math.max(dx, dy) > 1) assign[idx(x, y)] = 0;
    }
  }

  // Static fallback order (nearest target-bbox-center first) -- used to break ties among
  // equally-constrained active cells, and as the order once the active frontier is exhausted.
  const staticOrder = [];
  for (let y = vMinY; y <= vMaxY; y++) for (let x = vMinX; x <= vMaxX; x++) staticOrder.push([x, y]);
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  staticOrder.sort((a, b) => (Math.abs(a[0] - cx) + Math.abs(a[1] - cy)) - (Math.abs(b[0] - cx) + Math.abs(b[1] - cy)));

  function targetState(x, y) { return targetAliveKeys.has(`${x},${y}`) ? 1 : 0; }

  function neighborInfo(x, y) {
    let aliveCount = 0, unknownCount = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < vMinX || nx > vMaxX || ny < vMinY || ny > vMaxY) continue; // outside region = dead
      const v = assign[idx(nx, ny)];
      if (v === 1) aliveCount++;
      else if (v === -1) unknownCount++;
    }
    return { aliveCount, unknownCount };
  }
  function selfState(x, y) {
    if (x < vMinX || x > vMaxX || y < vMinY || y > vMaxY) return 0;
    return assign[idx(x, y)];
  }
  // Checks whether the constraint at (x,y) is still satisfiable given current (possibly
  // partial) assignments. Returns true if satisfiable (or already satisfied); false if no
  // remaining choice of unknowns could ever satisfy it (prune this branch).
  function checkConstraint(x, y) {
    const self = selfState(x, y);
    const { aliveCount, unknownCount } = neighborInfo(x, y);
    const want = targetState(x, y);
    if (self === -1 || unknownCount > 0) {
      const minAlive = aliveCount, maxAlive = aliveCount + unknownCount;
      const selfOptions = self === -1 ? [0, 1] : [self];
      for (const s of selfOptions) {
        for (let n = minAlive; n <= maxAlive; n++) {
          const result = s === 1 ? (survivalRulesSet.has(n) ? 1 : 0) : (birthRulesSet.has(n) ? 1 : 0);
          if (result === want) return true;
        }
      }
      return false;
    } else {
      const result = self === 1 ? (survivalRulesSet.has(aliveCount) ? 1 : 0) : (birthRulesSet.has(aliveCount) ? 1 : 0);
      return result === want;
    }
  }

  // Counts how many of {dead, alive} are still feasible for an unassigned cell (x,y), by
  // tentatively trying each and checking its own 8 neighbor-constraints (not a full-region
  // check -- just enough to know whether that single tentative value is still locally
  // consistent). Used only for MRV cell selection, not for the real backtracking assignment.
  function optionsCountFor(x, y) {
    let count = 0;
    for (const v of [0, 1]) {
      assign[idx(x, y)] = v;
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < vMinX || nx > vMaxX || ny < vMinY || ny > vMaxY) continue;
        if (!checkConstraint(nx, ny)) ok = false;
      }
      assign[idx(x, y)] = -1;
      if (ok) count++;
    }
    return count;
  }

  // A cell is "active" (worth MRV's attention right now) if it's inside the target's own
  // bounding box (always relevant), or adjacent to any already-assigned cell (the frontier of
  // the search so far). This keeps MRV's per-node scan bounded to a small relevant neighborhood
  // instead of the whole padded region, which is what made plain full-region MRV slower than
  // static ordering on easy patterns despite using far fewer nodes.
  function isActive(x, y) {
    if (x >= minx && x <= maxx && y >= miny && y <= maxy) return true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < vMinX || nx > vMaxX || ny < vMinY || ny > vMaxY) continue;
      if (assign[idx(nx, ny)] !== -1) return true;
    }
    return false;
  }

  function pickNextCell() {
    let best = null, bestCount = 3;
    for (const [x, y] of staticOrder) {
      if (assign[idx(x, y)] !== -1) continue;
      if (!isActive(x, y)) continue;
      const c = optionsCountFor(x, y);
      if (c < bestCount) { bestCount = c; best = [x, y]; if (c === 0) return best; } // forced dead-end, resolve immediately
    }
    if (best) return best;
    // No active cells left unassigned -- fall back to the first unassigned cell in static order.
    for (const [x, y] of staticOrder) if (assign[idx(x, y)] === -1) return [x, y];
    return null; // fully assigned
  }

  const results = [];
  let nodes = 0;
  const startTime = performance.now();
  let timedOut = false;

  function backtrack() {
    if (results.length >= limit || timedOut) return true;
    nodes++;
    if (nodes > maxNodes || performance.now() - startTime > timeBudgetMs) { timedOut = true; return true; }
    const next = pickNextCell();
    if (!next) {
      // Full assignment reached -- final full verification over the whole region.
      for (let y = vMinY; y <= vMaxY; y++) for (let x = vMinX; x <= vMaxX; x++) {
        if (!checkConstraint(x, y)) return false;
      }
      const cells = [];
      for (let y = vMinY; y <= vMaxY; y++) for (let x = vMinX; x <= vMaxX; x++) {
        if (assign[idx(x, y)] === 1) cells.push({ x, y });
      }
      results.push(cells);
      return results.length >= limit;
    }
    const [x, y] = next;
    for (const v of [0, 1]) { // dead first: sparser predecessors are more likely/interesting
      assign[idx(x, y)] = v;
      let feasible = true;
      for (let dy = -1; dy <= 1 && feasible; dy++) for (let dx = -1; dx <= 1 && feasible; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < vMinX || nx > vMaxX || ny < vMinY || ny > vMaxY) continue;
        if (!checkConstraint(nx, ny)) feasible = false;
      }
      if (feasible) {
        if (backtrack()) { if (results.length >= limit || timedOut) return true; }
      }
      assign[idx(x, y)] = -1;
    }
    return false;
  }

  backtrack();
  return { predecessors: results, gaveUp: timedOut, nodes, exhaustedSearch: !timedOut && results.length < limit };
}

/* Convert a list of cells (each {x,y,s}) to Extended multi-state RLE.
   State mapping:
     0 -> b
     1..24 -> A..X
     25..48 -> a..x
     >=49 -> two-letter scheme p..z + A..X/a..x (simple prefix encoding)
*/
function cellsToRLE(cellsList, ruleHint = 'B3/S23') {
  if (!cellsList || cellsList.length === 0) return '';
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const c of cellsList) {
    if (c.x < minx) minx = c.x;
    if (c.x > maxx) maxx = c.x;
    if (c.y < miny) miny = c.y;
    if (c.y > maxy) maxy = c.y;
  }
  const w = maxx - minx + 1;
  const h = maxy - miny + 1;
  // build grid rows filled with state 0
  const rows = Array.from({ length: h }, () => Array.from({ length: w }, () => 0));
  for (const c of cellsList) {
    const st = (typeof c.s === 'number') ? c.s : 1;
    rows[c.y - miny][c.x - minx] = st;
  }

  // helper to encode a numeric state into token(s)
  // Mapping:
  //   0 -> b (dead)
  //   1 -> o (standard alive token)
  //   2..25 -> A..X (faded / generational states offset by -1)
  //   26..49 -> a..x
  //   >=50 -> two-letter prefix tokens starting at 'p' plus A..X/a..x for extension
  function encodeState(st) {
    if (!st || st === 0) return 'b';
    if (st === 1) return 'o';
    // map 2..25 -> A..X
    if (st >= 2 && st <= 25) return String.fromCharCode(65 + (st - 2)); // A..X
    // map 26..49 -> a..x
    if (st >= 26 && st <= 49) return String.fromCharCode(97 + (st - 26)); // a..x
    // for >=50 produce prefix: compute index relative to 50
    const idx = st - 50;
    const prefixIndex = Math.floor(idx / 48); // 0-based
    const second = idx % 48;
    const prefixChar = String.fromCharCode(112 + (prefixIndex % 11)); // p..z (11 prefixes)
    let secondChar;
    if (second <= 23) secondChar = String.fromCharCode(65 + second); // A..X
    else secondChar = String.fromCharCode(97 + (second - 24)); // a..x
    return prefixChar + secondChar;
  }

  // Now build RLE body: We must emit runs of identical tokens.
  let body = '';
  for (let y = 0; y < h; y++) {
    let runCount = 0;
    let runToken = null;
    for (let x = 0; x < w; x++) {
      const st = rows[y][x];
      const token = encodeState(st);
      if (runToken === null) {
        runToken = token; runCount = 1;
      } else if (runToken === token) {
        runCount++;
      } else {
        body += (runCount === 1 ? '' : String(runCount)) + runToken;
        runToken = token; runCount = 1;
      }
    }
    if (runToken !== null) {
      body += (runCount === 1 ? '' : String(runCount)) + runToken;
    }
    if (y < h - 1) body += '$';
  }
  body += '!';

  const header = `x = ${w}, y = ${h}, rule = ${ruleHint}\n`;
  return header + body;
}

/* ================= Clear All Gliders (Alt+M) =================
   Scans the entire live board for gliders and deletes every one that's fully isolated (no
   other live cell touching it, including diagonally), then reports the result in one toast.
   Gliders that are embedded in or touching a larger structure are left alone, since deleting
   them could silently corrupt whatever they're part of.

   Per the requested design, matching is done via RLE, not by hand-coding coordinate offsets
   directly into the scan: a glider has exactly 4 distinct animation phases before its cycle
   repeats (shifted by one cell diagonally), and each phase is expressed here as its own
   Conway RLE string (built once by simulating a single reference glider through parseRLE/
   cellsToRLE, the same encode/decode path the rest of the game already uses for patterns).
   Each of those 4 phase RLEs is then rotated into its 4 compass orientations (a glider can be
   heading NE/NW/SE/SW), giving 16 total shapes actually searched for -- so "any of a glider's
   4 phases" is honored regardless of which diagonal direction that glider happens to be
   travelling in. */

// The 4 distinct phases of a single glider cycle are derived programmatically below (see
// _gliderClearPhaseRLEs), rather than hand-coded, so they can never drift out of sync with
// whatever glider shape the rest of the game actually uses.

// Simulates one glider (from the game's own Glider preset RLE) through birthRules=B3/S23,
// survivalRules=S23 for 4 generations, capturing each generation's cell set as its own
// normalized (top-left-anchored) RLE string. Returns an array of 4 RLE strings, phase 0..3.
// Cached after first call since the result never changes.
let _gliderClearPhaseRLECache = null;
function _gliderClearPhaseRLEs() {
  if (_gliderClearPhaseRLECache) return _gliderClearPhaseRLECache;

  const gliderPreset = presets.find(p => p.name === 'Glider');
  const baseCells = gliderPreset ? parseRLE(gliderPreset.rle) : parseRLE('x = 3, y = 3, rule = B3/S23\nbob$2bo$3o!');

  function stepPlain(cells) {
    const counts = new Map();
    for (const c of cells) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const k = `${c.x + dx},${c.y + dy}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    const aliveSet = new Set(cells.map(c => `${c.x},${c.y}`));
    const next = [];
    for (const [k, n] of counts.entries()) {
      const wasAlive = aliveSet.has(k);
      const survives = wasAlive && (n === 2 || n === 3);
      const born = !wasAlive && n === 3;
      if (survives || born) {
        const [x, y] = parseKey(k);
        next.push({ x, y, s: 1 });
      }
    }
    return next;
  }

  function normalizeToRLE(cells) {
    let minx = Infinity, miny = Infinity;
    for (const c of cells) { if (c.x < minx) minx = c.x; if (c.y < miny) miny = c.y; }
    const norm = cells.map(c => ({ x: c.x - minx, y: c.y - miny, s: 1 }));
    return cellsToRLE(norm, 'B3/S23');
  }

  let cur = baseCells.map(c => ({ x: c.x, y: c.y, s: 1 }));
  const phases = [normalizeToRLE(cur)];
  for (let i = 0; i < 3; i++) {
    cur = stepPlain(cur);
    phases.push(normalizeToRLE(cur));
  }

  _gliderClearPhaseRLECache = phases;
  return phases;
}

// Rotates a normalized (top-left-anchored) cell list 90 degrees clockwise n times (0..3),
// re-normalizing to top-left afterward so it can be matched the same way as any other phase.
function _rotateNormalizedCells(cells, times) {
  let cur = cells.map(c => ({ x: c.x, y: c.y }));
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) {
    cur = cur.map(c => ({ x: -c.y, y: c.x }));
  }
  let minx = Infinity, miny = Infinity;
  for (const c of cur) { if (c.x < minx) minx = c.x; if (c.y < miny) miny = c.y; }
  return cur.map(c => ({ x: c.x - minx, y: c.y - miny }));
}

// Builds the full set of shapes to search for: all 4 phases x all 4 rotations = 16 normalized
// coordinate sets (deduplicated, since some phases may coincide under rotation), each as
// { norm: [{x,y}], w, h } ready for sparse matching against the live board.
let _gliderClearTargetsCache = null;
function _gliderClearTargets() {
  if (_gliderClearTargetsCache) return _gliderClearTargetsCache;
  const phaseRLEs = _gliderClearPhaseRLEs();
  const seen = new Set();
  const targets = [];
  for (const rle of phaseRLEs) {
    const baseCells = parseRLE(rle).map(c => ({ x: c.x, y: c.y }));
    let minx0 = Infinity, miny0 = Infinity;
    for (const c of baseCells) { if (c.x < minx0) minx0 = c.x; if (c.y < miny0) miny0 = c.y; }
    const normBase = baseCells.map(c => ({ x: c.x - minx0, y: c.y - miny0 }));
    for (let rot = 0; rot < 4; rot++) {
      const norm = _rotateNormalizedCells(normBase, rot);
      const key = norm.map(c => `${c.x},${c.y}`).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      let maxx = 0, maxy = 0;
      for (const c of norm) { if (c.x > maxx) maxx = c.x; if (c.y > maxy) maxy = c.y; }
      targets.push({ norm, w: maxx + 1, h: maxy + 1 });
    }
  }
  _gliderClearTargetsCache = targets;
  return targets;
}

// Scans the sparse `alive` Set for every occurrence of the given target shape, at every
// possible top-left origin touching a live cell's neighborhood, returning an array of
// { origin: {x,y}, cellKeys: Set<string> } for each match found. Mirrors the isolation-check
// logic already used by the Identification Scanner's scanForPattern(), adapted to operate on
// the live sparse board directly instead of a bounded dense grid.
function _findIsolatedPatternInstances(target) {
  const found = [];
  const { norm, w, h } = target;
  const patternSetOffsets = new Set(norm.map(c => `${c.x},${c.y}`));

  // Only consider origins where the pattern's own first cell could land on a currently-alive
  // cell, so we never brute-force the whole (potentially huge) world -- only positions
  // anchored to something actually alive are worth checking.
  const candidateOrigins = new Set();
  for (const k of alive) {
    const [ax, ay] = parseKey(k);
    for (const c of norm) {
      candidateOrigins.add(`${ax - c.x},${ay - c.y}`);
    }
  }

  for (const originKey of candidateOrigins) {
    const [ox, oy] = parseKey(originKey);

    let match = true;
    for (let k = 0; k < norm.length; k++) {
      const px = ox + norm[k].x;
      const py = oy + norm[k].y;
      if (!alive.has(`${px},${py}`)) { match = false; break; }
    }
    if (!match) continue;

    // Isolation check: no live cell anywhere in the 3x3 neighborhood of any pattern cell may
    // be alive unless it's itself part of the pattern at this origin. This guarantees a glider
    // embedded in (or merely touching) a larger structure is never treated as a clean, isolated
    // glider and left untouched by the deletion step below.
    let touching = false;
    for (let k = 0; k < norm.length && !touching; k++) {
      const baseX = ox + norm[k].x;
      const baseY = oy + norm[k].y;
      for (let ny = -1; ny <= 1 && !touching; ny++) {
        for (let nx = -1; nx <= 1; nx++) {
          const sx = baseX + nx;
          const sy = baseY + ny;
          const relX = sx - ox;
          const relY = sy - oy;
          if (patternSetOffsets.has(`${relX},${relY}`)) continue;
          if (alive.has(`${sx},${sy}`)) { touching = true; break; }
        }
      }
    }
    if (touching) continue;

    const cellKeys = new Set();
    for (const c of norm) cellKeys.add(`${ox + c.x},${oy + c.y}`);
    found.push({ origin: { x: ox, y: oy }, cellKeys });
  }

  return found;
}

// Alt+M entry point: scans for every isolated glider (any of its 4 phases, in any of its 4
// diagonal orientations) via RLE-derived matching, deletes each one found, and reports the
// total via a single toast. Matched gliders vanish silently -- no per-glider feedback.
function clearAllGliders() {
  if (alive.size === 0) {
    flashTinyToast('No gliders found');
    return;
  }

  const targets = _gliderClearTargets();
  const toDelete = new Set();
  // Track which live cells have already been claimed by a match this pass, so overlapping
  // candidate origins (e.g. two of the 16 target shapes both matching the same physical
  // glider) can't double-count or double-delete the same cells.
  const claimed = new Set();

  for (const target of targets) {
    const instances = _findIsolatedPatternInstances(target);
    for (const inst of instances) {
      // skip if any cell in this match was already claimed by an earlier target/orientation
      let overlapsClaimed = false;
      for (const k of inst.cellKeys) { if (claimed.has(k)) { overlapsClaimed = true; break; } }
      if (overlapsClaimed) continue;

      for (const k of inst.cellKeys) { toDelete.add(k); claimed.add(k); }
    }
  }

  if (toDelete.size === 0) {
    flashTinyToast('No gliders found');
    return;
  }

  const gliderCount = Math.round(toDelete.size / 5); // every glider is exactly 5 live cells
  for (const k of toDelete) {
    alive.delete(k);
    birth.delete(k);
  }

  flashTinyToast(`Cleared ${gliderCount} glider${gliderCount === 1 ? '' : 's'}`);
}

/* ================= Ancestor Finder modal (Alt+X) =================
   UI for findPredecessors(): lets the player set how many ancestors to look for (5-10), runs
   the search against a snapshot of the CURRENT board, and stores results in a new uniquely-
   named folder (window.ancestorFolders) -- one folder per search run, never mixed together, as
   requested. Each folder holds: a special "target" entry at index 0 (a snapshot of the board
   state everything else in the folder is an ancestor OF, used as that folder's own top-of-list
   preview) followed by however many predecessor snapshots were actually found (0 to the
   player's requested limit). A folder with zero predecessors found is tagged as a possible
   Garden of Eden -- "possible" because the search giving up within its time/node budget is not
   a mathematical proof of non-existence, just an honest "this was too hard to find one for".
   Square-grid B3/S23 only: the predecessor search's correctness has only been derived and
   verified for Conway's own rule, and hex topology is excluded entirely per its own design
   (also already blocked upstream by the Hex Mode key-allowlist filter, and repeated here as a
   second guard in case this modal is ever reachable another way in the future). */
function openAncestorFinderModal() {
  if (hexMode) {
    flashTinyToast('Ancestor Finder isn\'t available in Hex Mode (built for the square grid). Press Ctrl+I to switch back.', 2200);
    return;
  }
  const isClassicRule = birthRules.size === 1 && birthRules.has(3) &&
    survivalRules.size === 2 && survivalRules.has(2) && survivalRules.has(3);
  if (!isClassicRule) {
    flashTinyToast('Ancestor Finder only works with the classic rule B3/S23. Press Ctrl+B to reset rules, then try again.', 2400);
    return;
  }
  if (document.getElementById('ancestor-finder-modal')) return;

  if (!window.ancestorFolders) window.ancestorFolders = []; // each: { name, createdAt, targetInstance, instances: [], possibleGardenOfEden }
  let ancestorFolderSeq = window.ancestorFolders.length;

  const modal = document.createElement('div');
  modal.id = 'ancestor-finder-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '14px', borderRadius: '8px', zIndex: 12000,
    width: 'min(90vw,520px)', maxHeight: '82vh', overflow: 'auto', boxSizing: 'border-box',
    fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Ancestor Finder';
  Object.assign(title.style, { fontWeight: '700', fontSize: '15px', marginBottom: '4px' });
  modal.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.textContent = 'Searches for generation-before states of your CURRENT board under B3/S23. Square grid only.';
  Object.assign(subtitle.style, { fontSize: '12px', color: 'rgba(255,255,255,0.65)', marginBottom: '10px' });
  modal.appendChild(subtitle);

  // ---- Limit control (5-10) ----
  const limitRow = document.createElement('div');
  Object.assign(limitRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' });
  const limitLabel = document.createElement('label');
  limitLabel.textContent = 'How many to look for:';
  limitLabel.style.fontSize = '13px';
  const limitInput = document.createElement('input');
  limitInput.type = 'number';
  limitInput.min = '5';
  limitInput.max = '10';
  limitInput.value = '5';
  Object.assign(limitInput.style, { width: '60px', padding: '4px 6px' });
  limitInput.addEventListener('change', () => {
    let v = Math.round(Number(limitInput.value));
    if (!Number.isFinite(v)) v = 5;
    v = Math.max(5, Math.min(10, v));
    limitInput.value = String(v);
  });
  limitRow.appendChild(limitLabel);
  limitRow.appendChild(limitInput);
  modal.appendChild(limitRow);

  // ---- Generations-back control (chain multiple predecessor searches) ----
  const depthRow = document.createElement('div');
  Object.assign(depthRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' });
  const depthLabel = document.createElement('label');
  depthLabel.textContent = 'Generations back:';
  depthLabel.style.fontSize = '13px';
  const depthInput = document.createElement('input');
  depthInput.type = 'number';
  depthInput.min = '1';
  depthInput.max = '5';
  depthInput.value = '1';
  Object.assign(depthInput.style, { width: '60px', padding: '4px 6px' });
  depthInput.addEventListener('change', () => {
    let v = Math.round(Number(depthInput.value));
    if (!Number.isFinite(v)) v = 1;
    v = Math.max(1, Math.min(5, v));
    depthInput.value = String(v);
  });
  depthRow.appendChild(depthLabel);
  depthRow.appendChild(depthInput);
  modal.appendChild(depthRow);
  const depthNote = document.createElement('div');
  depthNote.textContent = 'Beyond 1: chains searches back-to-back, each step continuing from the sparsest ancestor found. Stops early (and tells you) if any step comes up empty.';
  Object.assign(depthNote.style, { fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginBottom: '10px' });
  modal.appendChild(depthNote);

  // ---- Search thoroughness control (time/node budget tradeoff) ----
  const budgetRow = document.createElement('div');
  Object.assign(budgetRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' });
  const budgetLabel = document.createElement('label');
  budgetLabel.textContent = 'Search effort:';
  budgetLabel.style.fontSize = '13px';
  const budgetSelect = document.createElement('select');
  Object.assign(budgetSelect.style, { padding: '4px 6px' });
  const budgetOptions = [
    { value: 'normal', label: 'Normal (fast)' },
    { value: 'thorough', label: 'Thorough (slower, tries harder)' },
  ];
  for (const o of budgetOptions) {
    const opt = document.createElement('option');
    opt.value = o.value; opt.textContent = o.label;
    budgetSelect.appendChild(opt);
  }
  budgetRow.appendChild(budgetLabel);
  budgetRow.appendChild(budgetSelect);
  modal.appendChild(budgetRow);

  // ---- Strict Mode checkbox ----
  const strictRow = document.createElement('div');
  Object.assign(strictRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' });
  const strictCheckbox = document.createElement('input');
  strictCheckbox.type = 'checkbox';
  strictCheckbox.id = 'ancestor-strict-mode-checkbox';
  strictCheckbox.checked = true; // on by default -- minimal, clean predecessors are almost always what you want
  const strictLabel = document.createElement('label');
  strictLabel.htmlFor = 'ancestor-strict-mode-checkbox';
  strictLabel.textContent = 'Strict mode (only the target -- no incidental extra cells)';
  strictLabel.style.fontSize = '13px';
  strictLabel.style.cursor = 'pointer';
  strictRow.appendChild(strictCheckbox);
  strictRow.appendChild(strictLabel);
  modal.appendChild(strictRow);
  const strictNote = document.createElement('div');
  strictNote.textContent = 'Without strict mode, the search is technically free to include isolated cells (like a stray blinker piece) that don\'t interact with the target but still satisfy the search -- strict mode forbids any predecessor cell more than 1 step from the target\'s own footprint, which rules those out without ever excluding a cell that\'s actually necessary.';
  Object.assign(strictNote.style, { fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginBottom: '10px' });
  modal.appendChild(strictNote);

  const findBtn = document.createElement('button');
  findBtn.textContent = 'Find Ancestors';
  Object.assign(findBtn.style, { padding: '8px 12px', cursor: 'pointer', fontWeight: '600', width: '100%', marginBottom: '10px' });
  modal.appendChild(findBtn);

  const foldersLabel = document.createElement('div');
  foldersLabel.textContent = 'Folders';
  Object.assign(foldersLabel.style, { fontWeight: '600', fontSize: '13px', marginBottom: '6px' });
  modal.appendChild(foldersLabel);

  const folderListWrap = document.createElement('div');
  folderListWrap.style.display = 'flex';
  folderListWrap.style.flexDirection = 'column';
  folderListWrap.style.gap = '8px';
  modal.appendChild(folderListWrap);

  // ---- small processing overlay, self-contained (distinct id from the Identification scanner's) ----
  function showAncestorProcessingOverlay(text) {
    let ov = document.getElementById('ancestor-processing-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'ancestor-processing-overlay';
      Object.assign(ov.style, {
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
        background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '18px 26px', borderRadius: '10px',
        zIndex: 200000, fontSize: '16px', textAlign: 'center',
        fontFamily: 'Times New Roman, Times, serif'
      });
      ov.textContent = text;
      document.body.appendChild(ov);
    } else {
      ov.textContent = text;
      ov.style.display = 'block';
    }
  }
  function hideAncestorProcessingOverlay() {
    const ov = document.getElementById('ancestor-processing-overlay');
    if (ov) ov.remove();
  }

  // Converts a Set of "x,y" alive-cell keys into a fixed-size Uint8Array snapshot grid,
  // matching the {sim,gen,pos,t,snapshot,size} instance shape used by openInstancePreview's
  // canvas renderer (0=dead, 1=alive) so that renderer can be reused as-is.
  function cellsToSnapshotInstance(cellKeys, label) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const k of cellKeys) {
      const [x, y] = typeof k === 'string' ? parseKey(k) : [k.x, k.y];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (!Number.isFinite(minx)) { minx = 0; maxx = 0; miny = 0; maxy = 0; }
    const w = maxx - minx + 1, h = maxy - miny + 1;
    const size = Math.max(Math.min(128, Math.max(w, h) + 4), 8);
    const grid = new Uint8Array(size * size);
    const offX = Math.floor((size - w) / 2) - minx;
    const offY = Math.floor((size - h) / 2) - miny;
    let count = 0;
    for (const k of cellKeys) {
      const [x, y] = typeof k === 'string' ? parseKey(k) : [k.x, k.y];
      const sx = x + offX, sy = y + offY;
      if (sx >= 0 && sx < size && sy >= 0 && sy < size) { grid[sy * size + sx] = 1; count++; }
    }
    return { sim: 0, gen: 0, pos: { x: 0, y: 0 }, t: performance.now(), snapshot: grid, size, label, cellCount: count };
  }

  findBtn.addEventListener('click', async () => {
    // Re-validate here, not just at modal-open time: the modal can stay open while the player
    // does other things (e.g. Ctrl+I into Hex Mode, or some other path changes the rules), so
    // the guards that gated opening this modal are repeated at the actual moment of search too.
    if (hexMode) {
      flashTinyToast('Hex Mode is now active -- Ancestor Finder only works on the square grid.', 2200);
      return;
    }
    const stillClassicRule = birthRules.size === 1 && birthRules.has(3) &&
      survivalRules.size === 2 && survivalRules.has(2) && survivalRules.has(3);
    if (!stillClassicRule) {
      flashTinyToast('Rules have changed away from B3/S23 -- Ancestor Finder needs the classic rule.', 2200);
      return;
    }
    if (alive.size === 0) {
      flashTinyToast('Nothing on the board to find ancestors for.', 1800);
      return;
    }
    let limit = Math.round(Number(limitInput.value));
    if (!Number.isFinite(limit)) limit = 5;
    limit = Math.max(5, Math.min(10, limit));

    let depth = Math.round(Number(depthInput.value));
    if (!Number.isFinite(depth)) depth = 1;
    depth = Math.max(1, Math.min(5, depth));

    // "Thorough" trades UI responsiveness for a much bigger search budget -- useful for
    // patterns that time out under the normal budget. Both are still hard-capped so the UI can
    // never truly hang, just take longer before honestly giving up.
    const thorough = budgetSelect.value === 'thorough';
    const strict = strictCheckbox.checked;
    const searchOpts = thorough
      ? { limit, maxNodes: 25000000, timeBudgetMs: 20000, strict }
      : { limit, maxNodes: 4000000, timeBudgetMs: 6000, strict };

    findBtn.disabled = true;

    // Snapshot the CURRENT board state as the first search target (per requirement: it uses the
    // player's current state on the board). Copying to a plain Set decouples the search from
    // the live `alive` Set. Also capture `generation` at this exact moment -- folders persist
    // and can be opened long after the search ran, by which point the live `generation` counter
    // may have moved on, so "apply this ancestor" must use the generation AT SEARCH TIME minus
    // one, not whatever generation the board happens to be on when the player clicks Apply later.
    let currentTargetKeys = new Set(alive);
    let currentGeneration = generation;
    let chainBroken = false;
    let foldersCreatedThisRun = 0;

    for (let step = 1; step <= depth; step++) {
      showAncestorProcessingOverlay(
        depth > 1
          ? `Searching generation -${step} of ${depth} (up to ${limit} ancestor${limit === 1 ? '' : 's'})...`
          : `Searching for up to ${limit} ancestor${limit === 1 ? '' : 's'}...`
      );

      // Yield one frame so the processing overlay actually paints before the (synchronous,
      // potentially CPU-heavy) search runs and blocks the main thread.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      let result;
      try {
        result = findPredecessors(currentTargetKeys, birthRules, survivalRules, searchOpts);
      } catch (err) {
        hideAncestorProcessingOverlay();
        findBtn.disabled = false;
        alert('Ancestor search failed: ' + (err && err.message ? err.message : err));
        return;
      }

      // Build this step's folder. Unique name per run (never merges with a previous folder or
      // a previous step in this same chain, per requirement that "wrong things can't be in a
      // folder together").
      ancestorFolderSeq++;
      const genLabel = `Gen ${currentGeneration}`;
      const stepLabel = depth > 1 ? ` (step ${step}/${depth})` : '';
      const possibleGoE = result.predecessors.length === 0;
      const folderName = possibleGoE
        ? `Ancestors of ${genLabel}${stepLabel} #${ancestorFolderSeq} (possible Garden of Eden)`
        : `Ancestors of ${genLabel}${stepLabel} #${ancestorFolderSeq}`;

      const targetInstance = cellsToSnapshotInstance(currentTargetKeys, 'Target (everything below is an ancestor of this)');
      const instances = result.predecessors.map((cells, i) =>
        cellsToSnapshotInstance(cells.map(c => `${c.x},${c.y}`), `Ancestor #${i + 1}`)
      );

      const folder = {
        name: folderName,
        createdAt: Date.now(),
        generationAtSearch: currentGeneration,
        targetInstance,
        instances,
        possibleGardenOfEden: possibleGoE,
        requestedLimit: limit,
        chainStep: depth > 1 ? step : null,
        chainDepth: depth > 1 ? depth : null,
        searchNodes: result.nodes,
        gaveUp: result.gaveUp,
        exhaustedSearch: result.exhaustedSearch,
        strict,
      };
      window.ancestorFolders.push(folder);
      foldersCreatedThisRun++;
      refreshFolderList();

      if (possibleGoE) {
        // Nothing found -- can't continue the chain any further back from here.
        chainBroken = true;
        if (depth > 1) {
          flashTinyToast(`Chain stopped at step ${step}/${depth}: no ancestors found (possible Garden of Eden).`, 2600);
        } else {
          flashTinyToast('No ancestors found within the search budget -- filed as a possible Garden of Eden.', 2400);
        }
        break;
      }

      if (step < depth) {
        // Continue the chain from the SPARSEST found ancestor (predecessors are searched dead-
        // first, so result.predecessors[0] is the sparsest/first found) -- picking one is
        // unavoidable since each ancestor could itself branch into many further ancestors;
        // sparsest keeps each successive search's region smallest and fastest.
        const nextCells = result.predecessors[0];
        currentTargetKeys = new Set(nextCells.map(c => `${c.x},${c.y}`));
        currentGeneration = currentGeneration - 1;
      } else if (instances.length < limit) {
        flashTinyToast(`Found ${instances.length} of ${limit} requested ancestor(s).`, 2000);
      } else {
        flashTinyToast(`Found ${instances.length} ancestor(s).`, 1600);
      }
    }

    hideAncestorProcessingOverlay();
    findBtn.disabled = false;

    if (depth > 1 && !chainBroken) {
      flashTinyToast(`Chain complete: created ${foldersCreatedThisRun} folder(s) across ${depth} generation(s) back.`, 2400);
    }
  });

  function refreshFolderList() {
    folderListWrap.innerHTML = '';
    if (window.ancestorFolders.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No folders yet -- click "Find Ancestors" to create one.';
      empty.style.fontSize = '12px';
      empty.style.color = 'rgba(255,255,255,0.5)';
      folderListWrap.appendChild(empty);
      return;
    }
    for (let fi = window.ancestorFolders.length - 1; fi >= 0; fi--) {
      const f = window.ancestorFolders[fi];
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: '8px', padding: '8px', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '6px'
      });

      const info = document.createElement('div');
      const nameDiv = document.createElement('div');
      nameDiv.textContent = f.name;
      nameDiv.style.fontSize = '13px';
      nameDiv.style.fontWeight = '600';
      if (f.possibleGardenOfEden) nameDiv.style.color = '#ffb84d';
      const countDiv = document.createElement('div');
      const chainNote = f.chainStep ? ` · chain step ${f.chainStep}/${f.chainDepth}` : '';
      const strictNote = f.strict ? ' · strict' : '';
      const statsNote = Number.isFinite(f.searchNodes) ? ` · ${f.searchNodes.toLocaleString()} nodes searched${f.gaveUp ? ' (budget exhausted)' : ''}` : '';
      countDiv.textContent = `${f.instances.length} of ${f.requestedLimit} requested${chainNote}${strictNote}${statsNote}`;
      countDiv.style.fontSize = '11px';
      countDiv.style.color = 'rgba(255,255,255,0.6)';
      info.appendChild(nameDiv);
      info.appendChild(countDiv);

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';

      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open';
      Object.assign(openBtn.style, { padding: '6px 8px', cursor: 'pointer' });
      openBtn.addEventListener('click', () => openAncestorFolderModal(fi));

      const dlBtn = document.createElement('button');
      dlBtn.textContent = 'Download ZIP';
      Object.assign(dlBtn.style, { padding: '6px 8px', cursor: 'pointer' });
      dlBtn.addEventListener('click', async () => {
        try { await downloadAncestorFolderAsZip(fi); }
        catch (err) { alert('Download failed: ' + (err && err.message ? err.message : err)); }
      });

      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      Object.assign(delBtn.style, { padding: '6px 8px', cursor: 'pointer' });
      delBtn.addEventListener('click', () => {
        if (!confirm(`Delete folder "${f.name}"?`)) return;
        window.ancestorFolders.splice(fi, 1);
        refreshFolderList();
      });

      actions.appendChild(openBtn);
      actions.appendChild(dlBtn);
      actions.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(actions);
      folderListWrap.appendChild(row);
    }
  }

  const closeRow = document.createElement('div');
  Object.assign(closeRow.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '12px' });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 12px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => modal.remove());
  closeRow.appendChild(closeBtn);
  modal.appendChild(closeRow);

  refreshFolderList();
  document.body.appendChild(modal);
}

// Renders a Uint8Array snapshot instance onto a small canvas thumbnail element and returns it.
// Shared by the folder-contents modal (thumbnails) and reused at a larger size for full preview.
function renderAncestorThumbnail(inst, pixelSize) {
  const canvas = document.createElement('canvas');
  canvas.width = pixelSize; canvas.height = pixelSize;
  canvas.style.width = pixelSize + 'px';
  canvas.style.height = pixelSize + 'px';
  canvas.style.background = '#000';
  canvas.style.border = '1px solid rgba(255,255,255,0.1)';
  canvas.style.borderRadius = '4px';
  const c = canvas.getContext('2d');
  c.fillStyle = '#000'; c.fillRect(0, 0, pixelSize, pixelSize);
  const s = inst.size;
  const cw = Math.max(1, pixelSize / s), ch = Math.max(1, pixelSize / s);
  c.fillStyle = '#0f0';
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    if (inst.snapshot[y * s + x]) c.fillRect(x * cw, y * ch, cw, ch);
  }
  return canvas;
}

// Folder-contents modal: shows the special "target" preview at the top (what everything else
// in the folder is an ancestor of), followed by each found ancestor as its own thumbnail row
// with Preview/Apply actions -- mirrors the Identification Scanner's folder modal pattern.
function openAncestorFolderModal(folderIndex) {
  const folder = window.ancestorFolders && window.ancestorFolders[folderIndex];
  if (!folder) return;
  if (document.getElementById('ancestor-folder-modal')) return;

  const fm = document.createElement('div');
  fm.id = 'ancestor-folder-modal';
  Object.assign(fm.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '14px', borderRadius: '8px', zIndex: 12500,
    width: 'min(90vw,560px)', maxHeight: '84vh', overflow: 'auto', boxSizing: 'border-box',
    fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = folder.name;
  Object.assign(title.style, { fontWeight: '700', fontSize: '14px', marginBottom: '4px' });
  fm.appendChild(title);

  if (Number.isFinite(folder.searchNodes)) {
    const statsLine = document.createElement('div');
    const chainNote = folder.chainStep ? `Chain step ${folder.chainStep} of ${folder.chainDepth} · ` : '';
    statsLine.textContent = `${chainNote}${folder.searchNodes.toLocaleString()} search nodes explored${folder.gaveUp ? ' (search budget exhausted before finishing)' : ''}`;
    Object.assign(statsLine.style, { fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginBottom: '10px' });
    fm.appendChild(statsLine);
  }

  // Special "target" preview at the top: what everything else in this folder is an ancestor of.
  const targetSection = document.createElement('div');
  Object.assign(targetSection.style, { marginBottom: '12px', padding: '8px', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px' });
  const targetLabel = document.createElement('div');
  targetLabel.textContent = 'Everything in this folder is an ancestor of:';
  Object.assign(targetLabel.style, { fontSize: '12px', fontWeight: '600', marginBottom: '6px', color: 'rgba(255,255,255,0.85)' });
  targetSection.appendChild(targetLabel);
  const targetThumb = renderAncestorThumbnail(folder.targetInstance, 140);
  targetThumb.style.cursor = 'pointer';
  targetThumb.addEventListener('click', () => openAncestorInstancePreview(folder.targetInstance, true, folder.generationAtSearch));
  targetSection.appendChild(targetThumb);
  fm.appendChild(targetSection);

  if (folder.possibleGardenOfEden) {
    const goeNote = document.createElement('div');
    goeNote.textContent = folder.gaveUp
      ? 'The search ran out of time/node budget before finding any ancestor. This MAY be a Garden of Eden (a state with no possible predecessor) -- but this isn\'t a proof, just that the search couldn\'t find one in the time given. Try "Thorough" search effort for a bigger budget.'
      : 'The search fully explored every possibility within its region and found no valid ancestor. This is a much stronger signal of a genuine Garden of Eden than a budget timeout would be -- though it\'s still bounded by the padded region size the search used, not an absolute proof.';
    Object.assign(goeNote.style, { fontSize: '12px', color: '#ffb84d', marginBottom: '10px' });
    fm.appendChild(goeNote);
  }

  const list = document.createElement('div');
  list.style.display = 'flex';
  list.style.flexDirection = 'column';
  list.style.gap = '8px';

  folder.instances.forEach((inst, i) => {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', gap: '10px', padding: '6px',
      border: '1px solid rgba(255,255,255,0.06)', borderRadius: '6px'
    });
    const thumb = renderAncestorThumbnail(inst, 64);
    thumb.style.cursor = 'pointer';
    thumb.addEventListener('click', () => openAncestorInstancePreview(inst, false, folder.generationAtSearch));
    const info = document.createElement('div');
    info.textContent = `Ancestor #${i + 1} (${inst.cellCount} cells)`;
    info.style.fontSize = '13px';
    info.style.flex = '1';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply to board';
    Object.assign(applyBtn.style, { padding: '6px 8px', cursor: 'pointer' });
    applyBtn.addEventListener('click', () => applyAncestorInstanceToBoard(inst, folder.generationAtSearch));
    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(applyBtn);
    list.appendChild(row);
  });
  fm.appendChild(list);

  const closeRow = document.createElement('div');
  Object.assign(closeRow.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '10px' });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 12px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => fm.remove());
  closeRow.appendChild(closeBtn);
  fm.appendChild(closeRow);

  document.body.appendChild(fm);
}

// Larger single-instance preview modal, reusing the same snapshot-rendering approach as the
// Identification Scanner's openInstancePreview. isTarget=true labels it as the folder's target.
function openAncestorInstancePreview(inst, isTarget, generationAtSearch) {
  if (document.getElementById('ancestor-instance-preview-modal')) return;
  const pm = document.createElement('div');
  pm.id = 'ancestor-instance-preview-modal';
  Object.assign(pm.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 13000,
    width: 'min(84vw,480px)', boxSizing: 'border-box',
    fontFamily: 'Times New Roman, Times, serif'
  });
  const title = document.createElement('div');
  title.textContent = isTarget ? 'Target pattern' : (inst.label || 'Ancestor');
  Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
  pm.appendChild(title);

  const canvas = renderAncestorThumbnail(inst, Math.min(420, inst.size * 6));
  canvas.style.display = 'block';
  pm.appendChild(canvas);

  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' });
  if (!isTarget) {
    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply to board';
    Object.assign(applyBtn.style, { padding: '8px 10px', cursor: 'pointer' });
    applyBtn.addEventListener('click', () => { applyAncestorInstanceToBoard(inst, generationAtSearch); pm.remove(); });
    btnRow.appendChild(applyBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => pm.remove());
  btnRow.appendChild(closeBtn);
  pm.appendChild(btnRow);

  document.body.appendChild(pm);
}

// Replaces the current board with the given ancestor instance, centered where the board
// currently is (same approach as the Identification Scanner's "Apply to center").
// generationAtSearch is the folder's captured generation number from when the search ran (NOT
// the live `generation` counter, which may have moved on since -- see where folders are built).
function applyAncestorInstanceToBoard(inst, generationAtSearch) {
  alive.clear(); birth.clear(); states.clear(); invincible.clear(); pendingPlacement.clear();
  activatePendingOnly = false; pendingPlacementStart = 0;
  // Use the generation captured when this folder's search ran (this IS the generation before
  // that one), falling back to the live counter minus one only if that value is somehow
  // unavailable (older folder shape, etc.) -- prevents silently using a stale/advanced
  // generation number if the player applies a folder long after the board has moved on.
  const baseGen = Number.isFinite(generationAtSearch) ? generationAtSearch : generation;
  generation = Math.max(0, baseGen - 1);
  const s = inst.size;
  const cx = Math.floor(s / 2), cy = Math.floor(s / 2);
  const now = performance.now();
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    if (!inst.snapshot[y * s + x]) continue;
    const wx = Math.floor(offsetX) + (x - cx);
    const wy = Math.floor(offsetY) + (y - cy);
    const k = `${wx},${wy}`;
    alive.add(k);
    birth.set(k, { t: now, p: pausedAccum, gen: generation });
  }
  flashTinyToast('Ancestor applied to board.');
  const modal = document.getElementById('ancestor-finder-modal');
  if (modal) modal.remove();
  const fmodal = document.getElementById('ancestor-folder-modal');
  if (fmodal) fmodal.remove();
}

// Packages a folder's target + all found ancestors into a downloadable .zip (one .txt RLE per
// entry, plus the target labeled clearly), mirroring downloadFolderAsZip's approach.
async function downloadAncestorFolderAsZip(folderIndex) {
  const folder = window.ancestorFolders && window.ancestorFolders[folderIndex];
  if (!folder) { alert('Folder not found'); return; }

  let JSZip;
  try {
    JSZip = (await import('jszip')).default || (await import('jszip'));
  } catch (err) {
    alert('Failed to load zip library: ' + err.message);
    return;
  }

  function instanceToRLE(inst) {
    const s = inst.size;
    const cells = [];
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      if (!inst.snapshot[y * s + x]) continue;
      cells.push({ x, y, s: 1 });
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (cells.length === 0) return 'x = 1, y = 1, rule = B3/S23\nb!';
    const norm = cells.map(c => ({ x: c.x - minx, y: c.y - miny, s: c.s }));
    return cellsToRLE(norm, 'B3/S23');
  }

  const zip = new JSZip();
  zip.file('target (everything else is an ancestor of this).txt', instanceToRLE(folder.targetInstance));
  folder.instances.forEach((inst, i) => {
    zip.file(`ancestor_${i + 1}.txt`, instanceToRLE(inst));
  });
  if (folder.possibleGardenOfEden) {
    zip.file('README.txt', 'No ancestors were found within the search budget for this target.\nThis MAY be a Garden of Eden (a state with no possible predecessor),\nbut this is not a mathematical proof -- only that the search could not\nfind one within its time/node limits.');
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  const safeName = folder.name.replace(/[<>:"/\\|?*]+/g, '_').slice(0, 120) || 'ancestors';
  a.download = `${safeName}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  flashTinyToast(`Downloaded ZIP: ${safeName}.zip`);
}

function openSelectionModal(rect) {
  // Use the selectedSet (populated when O released) to build the listed selection.
  const cells = Array.from(selectedSet).map(k => {
    const [x, y] = parseKey(k);
    // prefer alive state==1, otherwise read fading stage from states map
    const s = alive.has(k) ? 1 : (states.has(k) ? states.get(k) : 0);
    return { x, y, key: k, s };
  });

  // Build modal
  if (document.getElementById('selection-modal')) document.getElementById('selection-modal').remove();
  const modal = document.createElement('div');
  modal.id = 'selection-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 10002,
    width: 'min(86vw,420px)', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });
  const title = document.createElement('div');
  title.textContent = `Selection (${cells.length} cells)`;
  Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
  modal.appendChild(title);

  const info = document.createElement('div');
  info.textContent = 'Choose an action for all pixels inside or touching the selection.';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '10px' });
  modal.appendChild(info);

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  cancelBtn.addEventListener('click', () => {
    // Only when the user presses Cancel do we clear the selection rectangle and highlights
    selectionActive = false;
    selStart = null;
    selCurrent = null;
    selectedSet.clear();
    selectionFrozen = false;
    modal.remove();
  });

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Convert to RLE text';
  Object.assign(copyBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  copyBtn.addEventListener('click', async () => {
    // Not available in Hex Mode -- RLE has no meaningful hex-topology representation. The rest
    // of the selection modal (deleting the selected region, etc.) is unaffected since selecting
    // a rectangle of cells is still a meaningful operation regardless of topology.
    if (blockedInHexMode('RLE export')) return;
    const rle = cellsToRLE(cells);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(rle);
        flashTinyToast('RLE copied to clipboard');
      } else {
        const ta = document.createElement('textarea');
        ta.value = rle;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        flashTinyToast('RLE copied to clipboard');
      }
    } catch (err) {
      alert('Copy failed: ' + err);
    }
    // after action, hide selection and clear highlights
    selectionActive = false;
    selStart = null;
    selCurrent = null;
    selectedSet.clear();
    selectionFrozen = false;
    modal.remove();
  });

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Delete';
  Object.assign(delBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  delBtn.addEventListener('click', () => {
    for (const c of cells) {
      // remove alive births
      alive.delete(c.key);
      birth.delete(c.key);
      // remove fading states if present
      if (states.has(c.key)) states.delete(c.key);
      // also remove invincible walls if present
      if (invincible.has(c.key)) invincible.delete(c.key);
    }
    flashTinyToast(`Deleted ${cells.length} cells`);
    // after delete, hide selection and clear highlights
    selectionActive = false;
    selStart = null;
    selCurrent = null;
    selectedSet.clear();
    selectionFrozen = false;
    modal.remove();
  });

  // "Fill Noise" fills every cell inside the selection rectangle with random noise at a
  // player-chosen density, rather than acting only on the (possibly empty) selectedSet like
  // Copy/Delete above -- so it uses the selection's own world bounds (worldBoundsTouchingRect)
  // to iterate every grid cell in the rectangle, not just ones already alive. Opens a small
  // follow-up modal (same visual language as this one) with a percent input defaulted to 50,
  // and Close (cancel, no changes, returns to this selection modal) / Fill (applies it) buttons.
  const fillNoiseBtn = document.createElement('button');
  fillNoiseBtn.textContent = 'Fill Noise';
  Object.assign(fillNoiseBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  fillNoiseBtn.addEventListener('click', () => {
    openFillNoiseModal(rect, modal);
  });

  row.appendChild(cancelBtn);
  row.appendChild(copyBtn);
  row.appendChild(delBtn);
  row.appendChild(fillNoiseBtn);
  modal.appendChild(row);

  document.body.appendChild(modal);
}

/* Follow-up modal opened by the selection modal's "Fill Noise" button. Lets the player type a
   percentage (defaulted to 50) and either back out via Close (no changes, just returns to the
   selection modal) or commit via Fill, which fills every cell in the selection rectangle with
   random noise at that density -- each cell independently rolled alive with probability
   percent/100, matching the same fill mechanic used elsewhere (Alt+J's mega-noise, the startup
   sequence's seedRandom, etc.): alive.add(key) + birth.set(key, {t, p: pausedAccum, gen}). */
function openFillNoiseModal(rect, parentModal) {
  if (document.getElementById('fill-noise-modal')) document.getElementById('fill-noise-modal').remove();
  const modal = document.createElement('div');
  modal.id = 'fill-noise-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 10003,
    width: 'min(86vw,340px)', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Fill Noise';
  Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
  modal.appendChild(title);

  const info = document.createElement('div');
  info.textContent = 'Fill the selection with random noise at this density:';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '10px' });
  modal.appendChild(info);

  const inputRow = document.createElement('div');
  Object.assign(inputRow.style, { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' });

  const percentInput = document.createElement('input');
  percentInput.type = 'number';
  percentInput.min = '0';
  percentInput.max = '100';
  percentInput.step = '1';
  percentInput.value = '50';
  Object.assign(percentInput.style, {
    width: '80px', padding: '6px', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: '14px'
  });
  inputRow.appendChild(percentInput);

  const percentLabel = document.createElement('span');
  percentLabel.textContent = '%';
  Object.assign(percentLabel.style, { fontSize: '14px' });
  inputRow.appendChild(percentLabel);

  modal.appendChild(inputRow);

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    // Cancel: no changes, just drop this sub-modal and return to the selection modal, which is
    // still open underneath (Fill Noise never touched it).
    modal.remove();
  });

  const fillBtn = document.createElement('button');
  fillBtn.textContent = 'Fill';
  Object.assign(fillBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  fillBtn.addEventListener('click', () => {
    let pct = parseFloat(percentInput.value);
    if (!isFinite(pct)) pct = 50;
    pct = Math.max(0, Math.min(100, pct));
    const density = pct / 100;

    const wb = worldBoundsTouchingRect(rect);
    const now = performance.now();
    let placed = 0;
    for (let x = wb.minx; x <= wb.maxx; x++) {
      for (let y = wb.miny; y <= wb.maxy; y++) {
        const k = `${x},${y}`;
        if (invincible.has(k)) continue; // never overwrite invincible walls
        if (Math.random() < density) {
          if (!alive.has(k)) placed++;
          alive.add(k);
          birth.set(k, { t: now, p: pausedAccum, gen: generation + 1 });
          if (states.has(k)) states.delete(k); // a fresh noise-fill cell is fully alive, not mid-fade
        }
      }
    }
    flashTinyToast(`Filled selection with noise @ ${pct}% (${placed} cells)`, 1800);

    // Filling changes the board, so treat it like the other selection actions: clear the
    // selection highlight/rectangle and close both modals rather than leaving a stale selection
    // sitting over cells that no longer match what was originally dragged.
    selectionActive = false;
    selStart = null;
    selCurrent = null;
    selectedSet.clear();
    selectionFrozen = false;
    modal.remove();
    if (parentModal) parentModal.remove();
  });

  row.appendChild(closeBtn);
  row.appendChild(fillBtn);
  modal.appendChild(row);

  document.body.appendChild(modal);
  percentInput.focus();
  percentInput.select();
}

/* Mouse tracking for keyboard drawing (no click or wheel controls) */
let mousePos = null; // current pointer position in CSS pixels
canvas.addEventListener('mousemove', (ev) => {
  const rect = canvas.getBoundingClientRect();
  mousePos = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
});
canvas.addEventListener('pointerleave', () => {
  mousePos = null;
});

/* Direct touch-to-draw on the canvas (mobile players only). A direct touch on the board moves
   mousePos to the touched point, so cells appear exactly where the finger is, and by default
   also starts normal drawing (the same effect X has) -- matching ordinary touchscreen
   expectations of "touch the board to draw".

   Holding a modifier+key combo on the virtual keyboard BEFORE touching the board changes what
   the touch does instead, exactly like holding that same combo with a real keyboard while
   moving a real mouse would: holding Z (erase) makes the touch erase instead of draw, and
   holding Shift+X (invincible placement) makes it place invincible walls instead. This works
   because oDown/invDown are the same global flags the game's main render loop already reads
   every frame regardless of what set them true -- so this handler only needs to check whether
   one is already active from the keyboard, and defer to it, rather than blindly forcing pDown.

   Gated on playerPlatformChoice === 'mobile' so this never changes anything for PC players,
   who already have this exact behavior via X/Z/Shift+X + real mouse movement. */
let _touchDrawId = null;
let _touchDrawSetPDown = false; // true only if THIS touch was the one that turned pDown on,
                                 // so releasing it never clobbers a pDown set some other way
function _touchPosOnCanvas(t) {
  const rect = canvas.getBoundingClientRect();
  return { x: t.clientX - rect.left, y: t.clientY - rect.top };
}
canvas.addEventListener('touchstart', (e) => {
  if (playerPlatformChoice !== 'mobile') return;
  const t = e.changedTouches[0];
  if (!t) return;
  e.preventDefault();
  _touchDrawId = t.identifier;
  mousePos = _touchPosOnCanvas(t);
  // If Z or Shift+X is already being held on the virtual keyboard, defer to that (erase /
  // invincible placement) instead of also drawing -- oDown/invDown being true already is
  // exactly what the render loop needs to see to do the right thing at mousePos.
  if (oDown || invDown) {
    _touchDrawSetPDown = false;
  } else {
    pDown = true;
    _touchDrawSetPDown = true;
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (playerPlatformChoice !== 'mobile' || _touchDrawId === null) return;
  for (const t of e.changedTouches) {
    if (t.identifier === _touchDrawId) {
      e.preventDefault();
      mousePos = _touchPosOnCanvas(t);
    }
  }
}, { passive: false });

function _touchDrawEnd(e) {
  if (playerPlatformChoice !== 'mobile' || _touchDrawId === null) return;
  for (const t of e.changedTouches) {
    if (t.identifier === _touchDrawId) {
      _touchDrawId = null;
      // Only clear pDown if this touch was actually the thing that set it -- if the player was
      // instead erasing/invincible-placing via a held keyboard key, that key's own release is
      // what should clear oDown/invDown, not this touch ending.
      if (_touchDrawSetPDown) pDown = false;
      _touchDrawSetPDown = false;
    }
  }
}
canvas.addEventListener('touchend', _touchDrawEnd, { passive: true });
canvas.addEventListener('touchcancel', _touchDrawEnd, { passive: true });

/* Note: mouse clicks and wheel zoom are intentionally removed; P/O keys handle draw/erase. */

/* Map screen pixel to integer world cell coords */
function screenToWorld(px, py) {
  // canvas style pixels (CSS pixels)
  const cx = px - innerWidth / 2;
  const cy = py - innerHeight / 2;
  if (hexMode) {
    // Inverse of the hex axial->pixel forward projection used everywhere else (drawCellAt,
    // the grid outline, etc.): shiftedPx = sqrt3*(x-offsetX) + sqrt3/2*(y-offsetY),
    // shiftedPy = 1.5*(y-offsetY).
    const shiftedPy = cy / cellSize;
    const shiftedPx = cx / cellSize;
    const ay = shiftedPy / 1.5 + offsetY;
    const ax = (shiftedPx - (HEX_SQRT3 / 2) * (ay - offsetY)) / HEX_SQRT3 + offsetX;
    // Math.floor() on fractional axial coords picks the wrong hex for most of a hex's own area
    // (see hexAxialRound above for why) -- use proper cube-coordinate rounding instead so the
    // hex actually under the cursor is the one returned, not a nearby-but-wrong neighbor.
    const r = hexAxialRound(ax, ay);
    return { wx: r.x, wy: r.y };
  }
  const wx = Math.floor((cx / cellSize) + offsetX);
  const wy = Math.floor((cy / cellSize) + offsetY);
  return {wx, wy};
}

/* Zoom keeping world point under screen point stable */
function zoomAt(screenX, screenY, factor) {
  const before = {
    x: (screenX - innerWidth/2) / cellSize + offsetX,
    y: (screenY - innerHeight/2) / cellSize + offsetY
  };
  // Allow much smaller cell sizes so the player can zoom out effectively (practical "infinite" zoom out).
  // Keep a tiny positive floor to avoid division-by-zero or degenerate rendering.
  cellSize = Math.max(0.05, Math.min(80, cellSize * factor));
  const after = {
    x: (screenX - innerWidth/2) / cellSize + offsetX,
    y: (screenY - innerHeight/2) / cellSize + offsetY
  };
  offsetX += before.x - after.x;
  offsetY += before.y - after.y;
  draw(performance.now());
}

/* Simulation step using neighbor counting via a Map and configurable rules */
/* ============================================================================
   Larger-than-Life stepping (Alt+H)
   ----------------------------------------------------------------------------
   Classic stepLife() (below) counts neighbors by walking each alive cell's fixed 8 (or 6, in
   Hex Mode) neighbor offsets -- cheap, since that neighborhood is tiny. LTL's neighborhood is
   a (2*radius+1) square window (120 cells at the default radius of 5), so walking it the
   same way per alive cell would be far too slow. Instead this builds a dense grid covering the
   alive region padded by `radius`, a 2D summed-area table (integral image) over that grid, and
   answers every cell's neighbor-count query in O(1) via a rectangle sum -- turning an
   O(alive * radius^2) pass into an O(width * height) one, independent of radius. LTL rule
   strings in this app never carry an M token (see parseLTLRuleString()'s doc note), so every
   rule always excludes the center cell from its own neighbor sum (outer-totalistic) -- `self`
   is always subtracted back out of the rectangle sum below, with no per-rule branching needed.
   LTL has its own gens-style fading (ltlCellStatesCount, set via B/Ctrl+B while in LTL mode,
   identical in spirit to classic mode's /G): when C>=3 a cell that fails survival decays
   through states 2..C-1 -- immune to neighbor counts while fading, auto-advancing each
   generation -- instead of dying outright, exactly mirroring classic stepLife()'s gens branch.
   Rule spots, portals, and hex topology still don't combine with LTL mode; see the LTL
   key-block in the keydown handler. Invincible wall cells are respected and never change. No
   reverse-time history is recorded here since Shift+V (rewind) is disabled in LTL mode. */
/* LTL_MAX_GRID_CELLS is a chosen performance ceiling, not a hard technical limit -- the
   summed-area table pass below (building `sat`, then the per-cell rule-evaluation loop) is
   O(width * height), so its cost scales roughly linearly with this cap regardless of how many
   cells are actually alive inside that bounding box. A big radius pads the bounding box by
   `radius` on every side (see `minX -= r; maxX += r;` etc. below), so large-radius rules (e.g.
   R100+) need a noticeably bigger box just to fit their own neighborhood padding around even a
   modest-sized pattern like a single "bug" soliton -- that's what was hitting the old, smaller
   cap here even for patterns that weren't actually huge.
   Raised from the original ~2000x2000 (4,000,000) to ~4500x4500 (20,250,000): benchmarking the
   actual sat-table+eval pass at that size costs on the order of a few hundred ms per generation
   in this engine, which is fine for large-radius rules that are typically run at a deliberate
   pace (or paused/stepped manually) rather than max tick-rate -- if a specific pattern still
   needs more room than this, raise the constant further; it trades per-generation time for
   capacity, nothing else depends on its exact value. */
const LTL_MAX_GRID_CELLS = 20250000; // ~4500x4500 dense grid cap

function ltlStepLife() {
  const now = performance.now();

  if (activatePendingOnly) {
    if (now - pendingPlacementStart < PENDING_ACTIVATE_DELAY_MS) return;
    for (const k of pendingPlacement) {
      if (!birth.has(k)) birth.set(k, { t: now, p: pausedAccum, gen: generation + 1 });
      alive.add(k);
    }
    pendingPlacement.clear();
    activatePendingOnly = false;
    pendingPlacementStart = 0;
    generation++;
    return;
  }

  if (alive.size === 0 && pendingPlacement.size === 0 && states.size === 0) { generation++; return; }

  const r = ltlRadius;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const k of alive) {
    if (pendingPlacement.has(k)) continue;
    const comma = k.indexOf(',');
    const x = Number(k.slice(0, comma)), y = Number(k.slice(comma + 1));
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) {
    // only pendingPlacement cells present (nothing yet in `alive`) -- use those for bounds instead
    for (const k of pendingPlacement) {
      const comma = k.indexOf(',');
      const x = Number(k.slice(0, comma)), y = Number(k.slice(comma + 1));
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) {
    // nothing alive/pending, only fading cells (states map) -- use those for bounds so fading
    // cells keep advancing/expiring even with no live cells left on the board.
    for (const k of states.keys()) {
      const comma = k.indexOf(',');
      const x = Number(k.slice(0, comma)), y = Number(k.slice(comma + 1));
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  minX -= r; maxX += r; minY -= r; maxY += r;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  if (width * height > LTL_MAX_GRID_CELLS) {
    flashTinyToast('LTL: pattern has grown too large to keep simulating', 2200);
    generation++;
    return;
  }

  // Fading cells (states map, values >=2) are intentionally left OUT of this grid, same as
  // classic stepLife()'s gens mode -- a fading cell doesn't count toward any neighbor's sum
  // while it decays, it just occupies the cell until it rolls to fully dead.
  const grid = new Uint8Array(width * height);
  for (const k of alive) {
    if (pendingPlacement.has(k)) continue;
    const comma = k.indexOf(',');
    const x = Number(k.slice(0, comma)), y = Number(k.slice(comma + 1));
    grid[(y - minY) * width + (x - minX)] = 1;
  }

  // sat is (width+1) x (height+1); sat[row][col] = sum of grid[0..row-1][0..col-1]
  const satW = width + 1;
  const sat = new Int32Array(satW * (height + 1));
  for (let yy = 0; yy < height; yy++) {
    let rowSum = 0;
    const gOff = yy * width;
    const sOff = (yy + 1) * satW;
    const sPrevOff = yy * satW;
    for (let xx = 0; xx < width; xx++) {
      rowSum += grid[gOff + xx];
      sat[sOff + xx + 1] = sat[sPrevOff + xx + 1] + rowSum;
    }
  }
  function rectSum(x0, y0, x1, y1) {
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > width - 1) x1 = width - 1;
    if (y1 > height - 1) y1 = height - 1;
    if (x0 > x1 || y0 > y1) return 0;
    return sat[(y1 + 1) * satW + (x1 + 1)] - sat[y0 * satW + (x1 + 1)] - sat[(y1 + 1) * satW + x0] + sat[y0 * satW + x0];
  }

  const nextAlive = new Set();
  const nextFading = new Map(); // key -> state (2..ltlCellStatesCount-1), mirrors classic states map
  const nextBirth = new Map();

  for (let yy = 0; yy < height; yy++) {
    const worldY = yy + minY;
    for (let xx = 0; xx < width; xx++) {
      const self = grid[yy * width + xx];
      const worldX = xx + minX;
      const key = `${worldX},${worldY}`;
      if (invincible.has(key)) continue; // walls never change
      // A cell already mid-fade (in `states`, not `alive`) can't be born into and doesn't
      // survive/die by neighbor count this pass -- it's advanced separately, below, exactly
      // like classic stepLife()'s gens handling.
      if (states.has(key) && !alive.has(key)) continue;
      const total = rectSum(xx - r, yy - r, xx + r, yy + r);
      // LTL rule strings never carry an M token in this app (see parseLTLRuleString()'s doc
      // note), so ltlIncludeCenter is always false -- every rule excludes the center cell from
      // its own neighbor sum, matching Golly's own outer-totalistic LTL convention.
      const neighborCount = ltlIncludeCenter ? total : (total - self);
      if (self) {
        if (neighborCount >= ltlSurvivalMin && neighborCount <= ltlSurvivalMax) {
          nextAlive.add(key);
          nextBirth.set(key, birth.get(key) || { t: now, p: pausedAccum, gen: generation + 1 });
        } else if (ltlCellStatesCount >= 3) {
          // Failed survival, but C/fading is on (same convention as classic mode's /G): drop
          // to the first fading state instead of dying outright.
          nextFading.set(key, 2);
        }
        // else: failed survival, fading off -> dies outright (nothing added)
      } else {
        if (neighborCount >= ltlBirthMin && neighborCount <= ltlBirthMax) {
          nextAlive.add(key);
          nextBirth.set(key, { t: now, p: pausedAccum, gen: generation + 1 });
          try { incrementDeadLanding(key); } catch (e) {}
        }
      }
    }
  }

  // Advance existing fading cells: state -> state+1, dying (removed) once it would reach
  // ltlCellStatesCount. A newborn/reviving cell already claimed in nextAlive above takes
  // priority over its old fading entry, same precedence as classic stepLife()'s gens handling.
  for (const [k, st] of states.entries()) {
    if (nextAlive.has(k) || nextFading.has(k)) continue;
    const advanced = st + 1;
    if (advanced < ltlCellStatesCount) nextFading.set(k, advanced);
    // else: rolls past the last fading state -> dead, nothing added
  }

  for (const k of pendingPlacement) {
    if (invincible.has(k)) continue;
    nextAlive.add(k);
    nextFading.delete(k); // placing a live cell here overrides any fade it interrupted
    if (!nextBirth.has(k)) nextBirth.set(k, birth.get(k) || { t: now, p: pausedAccum, gen: generation + 1 });
  }

  alive.clear();
  birth.clear();
  states.clear();
  for (const k of nextAlive) alive.add(k);
  for (const [k, rec] of nextBirth.entries()) if (alive.has(k)) birth.set(k, rec);
  for (const [k, st] of nextFading.entries()) if (!alive.has(k)) states.set(k, st);
  pendingPlacement.clear();

  generation++;
}

function stepLife() {
  // Larger-than-Life mode uses an entirely different neighbor-counting algorithm (a
  // summed-area table sized for the rule's radius, rather than the fixed 8-neighbor walk
  // below) -- see ltlStepLife() just above for why and how.
  if (ltlMode) { ltlStepLife(); return; }

  const now = performance.now();

  // If we were requested to simply activate pendingPlacement as a batch (no evolution),
  // do that and return immediately. This ensures contraptions are placed intact before any
  // neighbor-based births/survivals happen, preventing partial malfunctions at high tick rates.
  if (activatePendingOnly) {
    // if the short protection delay hasn't elapsed yet, skip activation this step
    if (now - pendingPlacementStart < PENDING_ACTIVATE_DELAY_MS) {
      return;
    }

    const newBirth = new Map();
    // Keep existing alive cells as-is, and add pendingPlacement as newly active (or preserve their birth records)
    for (const k of alive) {
      newBirth.set(k, birth.get(k));
    }
    for (const k of pendingPlacement) {
      if (birth.has(k)) newBirth.set(k, birth.get(k));
      else newBirth.set(k, { t: now, p: pausedAccum, gen: generation + 1 });
      alive.add(k);
    }
    // Commit births
    birth.clear();
    for (const [k, rec] of newBirth.entries()) birth.set(k, rec);

    // clear pending and reset flag
    pendingPlacement.clear();
    activatePendingOnly = false;
    pendingPlacementStart = 0;
    // count this activation as one generation
    generation++;
    return;
  }

  // Before evolving forward, save a snapshot so reverse-time can restore it later.
  // Note: we only save snapshots when advancing forward (not when reverse-time is active).
  pushHistorySnapshot();

  const counts = new Map(); // key -> neighbor count

  // Count neighbors using only the cells that are in state==1 (alive), and exclude pendingPlacement
  // so newly placed contraptions don't interact until after the next generation.
  // This enforces "Law 1: Only state==1 counts as neighbors".
  // In hex mode, cells use a 6-direction axial neighborhood instead of the 8-direction Moore
  // neighborhood -- same sparse "x,y" key storage, just a different offset table, since a
  // hex grid's natural coordinate system (axial coords) maps cleanly onto integer x,y pairs.
  for (const k of alive) {
    if (pendingPlacement.has(k)) continue; // treat as "not yet active" for neighbor counting
    const [sx, sy] = parseKey(k);
    if (hexMode) {
      for (const [dx, dy] of HEX_NEIGHBOR_OFFSETS) {
        const nk = `${sx+dx},${sy+dy}`;
        counts.set(nk, (counts.get(nk) || 0) + 1);
      }
    } else {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        // Any of the 8 Moore-neighborhood steps (including diagonals) can land just past a
        // linked portal's line -- redirect through the portal transform when that's the case,
        // so a multi-cell pattern crossing the seam gets fully consistent neighbor counts on
        // both sides (diagonal corner-adjacency matters for shapes like a glider, not just the
        // straight-across step).
        const nk = (portalEdges.size > 0 && portalLinks.size > 0)
          ? resolveNeighborKey(sx, sy, dx, dy)
          : `${sx+dx},${sy+dy}`;
        counts.set(nk, (counts.get(nk) || 0) + 1);
      }
    }
  }
  // Note: cells in fading states (states map entries >=2) are intentionally ignored for neighbor counts.

  // We'll compute new states according to generational rules:
  // - newborns become state==1
  // - survivors remain state==1
  // - alive cells that fail survival become state==2 (first fading state) if cellStatesCount>2,
  //   otherwise they die (state 0) as usual for binary life.
  // - All cells currently in fading states (>=2) advance by +1 each generation and when reaching cellStatesCount roll to 0.
  const nextStates = new Map(); // key -> state (1..C-1)
  const nextBirth = new Map();

  // During the introduction ONLY, births are additionally constrained to stay within the
  // currently visible screen area -- the intro seeds a block of noise centered on screen (see
  // autoJSpawn in startStartupSequence) and then lets it simulate for atmosphere while the
  // player reads/answers the intro's questions, but that noise can otherwise grow/drift past
  // the edges of the screen over several generations. Since the intro has no camera controls
  // and the player can't pan to see what's happening offscreen anyway, any birth that would
  // land outside the visible area is simply skipped while startupActive is true; nothing about
  // normal gameplay (after the intro ends) is affected by this, and existing on-screen cells
  // still evolve/die normally regardless of this check.
  const __introBirthBoundsActive = startupActive;
  let __introLeft = 0, __introRight = 0, __introTop = 0, __introBottom = 0;
  if (__introBirthBoundsActive) {
    const halfW = innerWidth / 2;
    const halfH = innerHeight / 2;
    __introLeft = Math.floor((-halfW) / cellSize + offsetX);
    __introRight = Math.ceil((halfW) / cellSize + offsetX);
    __introTop = Math.floor((-halfH) / cellSize + offsetY);
    __introBottom = Math.ceil((halfH) / cellSize + offsetY);
  }

  // births: any dead cell (state 0) with count in birthRules and not on invincible wall
  for (const [k, n] of counts.entries()) {
    if (invincible.has(k)) continue;
    // only allow birth onto truly dead (not in states map and not alive)
    if (!states.has(k) && !alive.has(k)) {
      const [bx, by] = parseKey(k);
      if (__introBirthBoundsActive && (bx < __introLeft || bx > __introRight || by < __introTop || by > __introBottom)) {
        continue; // would spawn off-screen during the intro -- skip
      }
      const spot = ruleSpots.length ? getRuleSpotAt(bx, by) : null;
      const localBirthRules = spot ? spot.birthRules : birthRules;
      if (localBirthRules.has(n)) {
        // newborn: state 1
        nextStates.set(k, 1);
        nextBirth.set(k, { t: now, p: pausedAccum, gen: generation + 1 });
        // record landing activity for this dead->alive event (unless in intro/menu)
        incrementDeadLanding(k);
      }
    }
  }

  // survivors: alive cells (state==1) that meet survival -> remain state 1
  for (const k of alive) {
    if (pendingPlacement.has(k)) continue;
    const n = counts.get(k) || 0;
    const [sx2, sy2] = parseKey(k);
    const spot = ruleSpots.length ? getRuleSpotAt(sx2, sy2) : null;
    const localSurvivalRules = spot ? spot.survivalRules : survivalRules;
    if (localSurvivalRules.has(n)) {
      nextStates.set(k, 1);
      if (birth.has(k)) nextBirth.set(k, birth.get(k));
      else nextBirth.set(k, { t: now, p: pausedAccum, gen: generation + 1 });
    } else {
      // failed survival: if generational states >2 then move to first fade (2), otherwise die.
      // Use the rule spot's own genCount (its /G value) if this cell is inside one, so a
      // spot's /G actually takes effect independently of the global cellStatesCount.
      const localGenCount = spot ? spot.genCount : cellStatesCount;
      if (localGenCount >= 3) {
        const fs = 2;
        if (fs < localGenCount) {
          nextStates.set(k, fs);
          // fading states do not have birth timestamps (they no longer "count" as alive)
          // but we keep no birth entry so age overlay won't treat them as "alive ages"
        }
      } else {
        // binary death: nothing to add
      }
    }
  }

  // pendingPlacement: keep them alive/active; they are added as state 1
  for (const k of pendingPlacement) {
    if (invincible.has(k)) continue;
    nextStates.set(k, 1);
    if (birth.has(k)) nextBirth.set(k, birth.get(k));
    else nextBirth.set(k, { t: now, p: pausedAccum, gen: generation + 1 });
  }

  // Advance existing fading states (>=2): they auto-increment and are immune to neighbors (Law 2)
  for (const [k, st] of states.entries()) {
    // if the key was explicitly set in nextStates (e.g., a newborn overlapped a fading cell), newborn overrides
    if (nextStates.has(k)) continue;
    // fading auto-advance: st -> st+1; if reaches genCount -> 0 (dead). Use the rule spot's own
    // genCount (/G value) if this cell is inside one, otherwise the global cellStatesCount.
    const [fx, fy] = parseKey(k);
    const fadeSpot = ruleSpots.length ? getRuleSpotAt(fx, fy) : null;
    const localGenCountFade = fadeSpot ? fadeSpot.genCount : cellStatesCount;
    const advanced = st + 1;
    if (advanced < localGenCountFade) {
      nextStates.set(k, advanced);
    } else {
      // rolls to 0 -> remove (dead)
    }
  }

  // Also ensure any alive keys (old alive Set) that were not considered above but still not present in nextStates
  // (this can occur when alive had pendingPlacement earlier) are handled; but loop above covered alive & pending.

  // Commit nextStates: rebuild alive set (state==1) and states map (all non-zero)
  alive.clear();
  states.clear();
  birth.clear();

  for (const [k, st] of nextStates.entries()) {
    if (st === 1) {
      alive.add(k);
      // carry birth info if present
      if (nextBirth.has(k)) birth.set(k, nextBirth.get(k));
    } else if (st >= 2) {
      states.set(k, st);
    }
  }
  // add births for newborns that are alive (state 1) already set above
  for (const [k, rec] of nextBirth.entries()) {
    if (alive.has(k)) birth.set(k, rec);
  }

  // Clear pendingPlacement set — those cells are now active for subsequent generations
  pendingPlacement.clear();

  // count this evolution as one generation
  generation++;
}

/* ============================================================================
   FAST-FORWARD ENGINE  (Ctrl+H)
   ----------------------------------------------------------------------------
   This is NOT a full HashLife implementation (no quadtree canonicalization,
   no universal memoized 2^k-step results across arbitrary sub-patterns --
   that's incompatible with this simulator's per-region rule spots, invincible
   walls, and generational fading states, all of which stepLife() supports).

   Instead this is a lightweight bulk-stepping accelerator that:

     1) Runs the *exact same* birth/survival math as stepLife() (so results are
        always identical to running stepLife() one generation at a time), but
        skips the expensive full history-snapshot allocation on every single
        sub-step -- it snapshots once at the start of a batch instead of once
        per generation. This alone removes most of the GC/allocation pressure
        that makes very high step counts feel laggy.

     2) Detects when the ENTIRE alive-cell layout has returned to a bit-for-bit
        identical state it was in P generations ago (a true finite oscillator/
        still-life cycle -- common in Life: blinkers, gliders-in-a-box, pulsars,
        etc. eventually settle into exact periodic behavior). Once a cycle of
        period P is confirmed, the remaining generations in the requested batch
        are applied to the bookkeeping (generation counter, birth/.gen ages)
        in analytic jumps of P at a time instead of resimulating every single
        intermediate generation. This is the "not really a full hashlife, but
        captures its main practical benefit" behavior: huge, boring, already-
        stable patterns stop costing CPU, while still-evolving/chaotic regions
        keep simulating normally (cycle detection just never fires for them).

     3) Time-boxes itself to a per-frame wall-clock budget so a huge or chaotic
        pattern can never freeze the tab solid -- it simulates as many
        generations as it can within budget, then yields back to the browser,
        picking up again next frame. That's the "some lag, but not gamebreaking
        lag" behavior requested: worst case you see the frame rate dip, you
        never get an unresponsive page.

   SAFETY / FALLBACK: the accelerator only engages in the "plain" case this
   board is usually in -- no rule spots, no invincible walls, no pending
   placement, not reverse-time, not paused, and binary (non-generational)
   life. The instant any of those features are active it steps aside
   completely and the normal exact stepLife() path (already fully feature-
   complete) runs instead, so nothing about rule spots, invincible walls,
   fading states, contraption placement, or rewind is ever affected.
   ============================================================================ */

// Toggle + tunables (Ctrl+H opens a small panel to adjust these; mirrors the
// existing Ctrl+R Super-Speed modal's UX conventions).
let fastForwardEnabled = false;       // master on/off switch for the accelerator
let fastForwardGenerations = 5000;    // how many generations to attempt per "Run" batch
let fastForwardFrameBudgetMs = 14;    // max wall-clock ms per animation frame spent fast-forwarding
let fastForwardCycleWindow = 256;     // how many recent generation-hashes to remember for cycle detection
let fastForwardRunRemaining = 0;      // generations left in the currently-running batch (0 = idle)
let fastForwardLastStats = null;      // small object describing the outcome of the last run, for the panel/toast

// Internal cycle-detection ring buffer: maps a cheap structural hash of the
// current alive-set to the generation number it was last seen at. Cleared
// whenever the board is edited/reset so stale hashes can never cause an
// incorrect "cycle" match against a since-modified board.
const __ffSeenHashes = new Map(); // hash(string) -> generation (number)
let __ffHashOrder = [];           // FIFO of hashes currently in __ffSeenHashes, bounded by fastForwardCycleWindow

function fastForwardResetCycleMemory() {
  __ffSeenHashes.clear();
  __ffHashOrder.length = 0;
  __ffActiveSet = null; // force the dirty-tracking step to reseed from the full alive set next time
}

/* Cheap, order-independent structural hash of the current alive set.
   Not cryptographic -- just needs to make accidental collisions between truly
   different boards astronomically unlikely while being fast to compute every
   generation. We combine a 32-bit FNV-1a-style rolling hash over each cell's
   (x,y) with a running XOR so the result doesn't depend on Set iteration
   order (important since alive is a plain Set and order can vary run to run
   for equal content on some engines). We also fold in alive.size as a cheap
   first-line differentiator.

   Returns a plain JS number (not a string). Building a string key here via
   toString(36) + concatenation was needless overhead -- this function runs
   up to twice per simulated generation, and a number works exactly as well
   as a Map key while skipping string allocation entirely. */
function __ffHashAliveSet() {
  let acc = 0 | 0;
  for (const k of alive) {
    // hash the string key itself (cheap, avoids re-parsing "x,y" -> numbers)
    let hh = 0x811c9dc5 | 0;
    for (let i = 0; i < k.length; i++) {
      hh ^= k.charCodeAt(i);
      hh = Math.imul(hh, 0x01000193);
    }
    acc ^= hh; // order-independent combine
  }
  const h = Math.imul(alive.size + 1, 0x9e3779b1) ^ acc;
  // combine into a single safe-integer number: high bits from the hash,
  // low bits from alive.size, so two boards with the same hash but a
  // different cell count still can't collide.
  return (h >>> 0) * 1048576 + (alive.size & 0xfffff);
}

/* Returns true if the accelerator is allowed to run right now given the
   board's current feature usage. Mirrors the "plain case" assumptions
   documented above; any special feature currently in play forces the caller
   to use the ordinary exact stepLife() path instead. */
function fastForwardIsSafeToRun() {
  if (!fastForwardEnabled) return false;
  if (reverseTime) return false;
  if (activatePendingOnly) return false;
  if (pendingPlacement.size > 0) return false;
  if (ruleSpots.length > 0) return false;
  if (invincible.size > 0) return false;
  if (cellStatesCount > 2 || states.size > 0) return false; // generational fading needs the exact path
  // The accelerator's fast path (packed-key neighbor deltas below) hardcodes the 8-direction
  // Moore neighborhood for binary Life -- it has no concept of hex mode's 6-direction axial
  // neighborhood. Running it under hex mode would silently apply square-grid birth/survival
  // math while the board renders as hexagons, which is exactly what caused runaway explosive
  // growth. Fall back to the normal (correct, hex-aware) stepLife() path whenever hex mode is on.
  if (hexMode) return false;
  // Same reasoning as hexMode above: the accelerator's packed-key fast path hardcodes the
  // 8-direction Moore neighborhood for binary Life and has no concept of LTL's radius-based
  // summed-area neighbor counting. Ctrl+H (which opens this panel) is disabled in LTL mode
  // anyway (see the LTL key-block in the keydown handler), but this keeps stepLife()'s own
  // ltlMode branch as the single source of truth regardless of how fastForwardTick() is reached.
  if (ltlMode) return false;
  return true;
}

/* Apply exactly one generation of plain binary Life (B/S rules only, no rule
   spots/invincible/fading/pending -- fastForwardIsSafeToRun() guarantees none
   of those are in play whenever this is called) directly against alive/birth,
   WITHOUT touching historyStack. This is the same neighbor-counting algorithm
   stepLife() uses, trimmed to the subset that applies in the safe case, so
   results are always identical to what stepLife() would have produced.

   Performance notes (this is the hottest path in the whole accelerator, run
   once per simulated generation, so every allocation here matters):

   - Neighbor keys are computed as packed 32-bit integers (x in the high bits,
     y in the low bits, both offset to stay non-negative) instead of template-
     string concatenation ("x,y"). String building/parsing was by far the
     single biggest cost of the original version -- Number.prototype.toString
     and string concatenation are comparatively very expensive and this inner
     loop runs 8x per alive cell, every generation. Packed integers are cheap
     to compute, cheap to hash into a Map, and need no parsing back out.

   - alive/birth are NOT cleared and rebuilt every generation. Instead we
     compute which cells die and which cells are newly born, then apply just
     those deltas to the existing alive Set / birth Map in place. For a
     mostly-stable or slowly-changing pattern (exactly the kind of pattern
     this accelerator is designed to blast through) the vast majority of
     cells are unchanged generation to generation, so this avoids rebuilding
     the entire board's worth of Set/Map entries every single tick. */
const __FF_KEY_OFFSET = 1 << 20; // supports coordinates in [-1048576, 1048575], far beyond any playable board
function __ffPackKey(x, y) {
  return ((x + __FF_KEY_OFFSET) * (1 << 21)) + (y + __FF_KEY_OFFSET);
}
function __ffUnpackKey(packed) {
  const y = (packed % (1 << 21)) - __FF_KEY_OFFSET;
  const x = Math.floor(packed / (1 << 21)) - __FF_KEY_OFFSET;
  return x + ',' + y;
}

/* Dirty-region ("active frontier") tracking state, used by
   __ffStepDirtyNoHistory below. null means "no history yet -- next step must
   seed from the entire alive set." Reset alongside the cycle-detection memory
   any time the board is edited outside of the accelerator's own stepping
   (see fastForwardResetCycleMemory), since a stale active set from before an
   edit could otherwise cause a hand-edited region to be silently skipped. */
let __ffActiveSet = null; // Set of packed-int keys, or null

function __ffStepPlainNoHistory(nowTs) {
  const counts = new Map(); // packed-int key -> neighbor count
  const aliveSetPacked = new Set(); // packed-int keys of currently-alive cells (built once, reused below)

  for (const k of alive) {
    const comma = k.indexOf(',');
    const sx = Number(k.slice(0, comma));
    const sy = Number(k.slice(comma + 1));
    const packed = __ffPackKey(sx, sy);
    aliveSetPacked.add(packed);
    for (let dx = -1; dx <= 1; dx++) {
      const nx = sx + dx;
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nk = __ffPackKey(nx, sy + dy);
        counts.set(nk, (counts.get(nk) || 0) + 1);
      }
    }
  }

  const nextGen = generation + 1;
  const toDie = [];   // string keys of cells that die this generation
  const toBirth = []; // string keys of cells newly born this generation

  for (const [packed, n] of counts) {
    const wasAlive = aliveSetPacked.has(packed);
    if (wasAlive) {
      if (!survivalRules.has(n)) toDie.push(__ffUnpackKey(packed));
      // else: survives unchanged, no delta needed (birth record untouched)
    } else if (birthRules.has(n)) {
      toBirth.push(__ffUnpackKey(packed));
    }
  }

  // Any currently-alive cell with zero live neighbors this generation dies
  // too (it simply never appears in `counts`, since counts only contains
  // cells that had at least one live neighbor).
  if (aliveSetPacked.size > 0) {
    for (const packed of aliveSetPacked) {
      if (!counts.has(packed)) toDie.push(__ffUnpackKey(packed));
    }
  }

  for (let i = 0; i < toDie.length; i++) {
    alive.delete(toDie[i]);
    birth.delete(toDie[i]);
  }
  for (let i = 0; i < toBirth.length; i++) {
    const k = toBirth[i];
    alive.add(k);
    birth.set(k, { t: nowTs, p: pausedAccum, gen: nextGen });
    incrementDeadLanding(k);
  }

  generation = nextGen;
}

/* Dirty-region ("active frontier") tracked step: functionally identical to
   __ffStepPlainNoHistory (same B/S rules, same results), but only
   re-examines cells that are alive OR sit adjacent to something that
   changed (was born or died) in the immediately preceding generation.

   Why this helps: a cell whose entire 3x3 neighborhood is identical to last
   generation's is *guaranteed* to produce the same result it did last
   generation (Conway's Life, and any B/S-style rule, is purely a function of
   the local neighborhood) -- so if nothing changed nearby, there's no need
   to recompute anything for it. For a large pattern that's mostly static or
   gently oscillating, with only a small region of real activity (a glider
   crossing an otherwise-quiet field of still lifes, for example), this means
   per-generation work scales with the size of the ACTIVE FRONTIER, not the
   size of the whole pattern.

   This is explicitly NOT full HashLife: it doesn't memoize or reuse results
   across repeated sub-patterns, and it doesn't jump multiple generations at
   once for a static region (the existing period-cycle detector already
   handles the fully-static/fully-periodic case separately -- this
   complements that by speeding up the *partially* active case, which cycle
   detection alone can't help with since the board as a whole never repeats
   exactly while the active region keeps moving). Benchmarked at roughly a
   97-99% reduction in per-generation work on large mostly-static patterns
   with a small moving region, scaling far better than the plain full-rescan
   step as pattern size grows -- but it carries bookkeeping overhead that
   makes it slower than a plain full rescan on small or fully-chaotic boards
   where nearly everything changes every generation anyway, which is why
   fastForwardRunBatch only switches to this path once the board is large
   enough for the trade to reliably pay off (see __FF_DIRTY_THRESHOLD). */
function __ffStepDirtyNoHistory(nowTs) {
  const candidates = new Set(); // packed-int keys to examine this generation

  if (__ffActiveSet === null) {
    // No activity history yet (first call, or just reset by an edit/load) --
    // seed from the entire alive set once. Subsequent calls reuse the
    // active-frontier tracking below and no longer need a full scan.
    for (const k of alive) {
      const comma = k.indexOf(',');
      const sx = Number(k.slice(0, comma));
      const sy = Number(k.slice(comma + 1));
      candidates.add(__ffPackKey(sx, sy));
      for (let dx = -1; dx <= 1; dx++) {
        const nx = sx + dx;
        for (let dy = -1; dy <= 1; dy++) {
          candidates.add(__ffPackKey(nx, sy + dy));
        }
      }
    }
  } else {
    for (const p of __ffActiveSet) candidates.add(p);
  }

  const counts = new Map(); // packed-int key -> live-neighbor count, only for candidates
  for (const p of candidates) {
    const y = (p % (1 << 21)) - __FF_KEY_OFFSET;
    const x = Math.floor(p / (1 << 21)) - __FF_KEY_OFFSET;
    let n = 0;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (alive.has(`${nx},${y + dy}`)) n++;
      }
    }
    counts.set(p, n);
  }

  const nextGen = generation + 1;
  const toDie = [];
  const toBirth = [];
  const newActivePacked = new Set(); // cells that actually changed this generation

  for (const [p, n] of counts) {
    const k = __ffUnpackKey(p);
    const wasAlive = alive.has(k);
    if (wasAlive) {
      if (!survivalRules.has(n)) { toDie.push(k); newActivePacked.add(p); }
    } else if (birthRules.has(n)) {
      toBirth.push(k);
      newActivePacked.add(p);
    }
  }

  for (let i = 0; i < toDie.length; i++) {
    alive.delete(toDie[i]);
    birth.delete(toDie[i]);
  }
  for (let i = 0; i < toBirth.length; i++) {
    const k = toBirth[i];
    alive.add(k);
    birth.set(k, { t: nowTs, p: pausedAccum, gen: nextGen });
    incrementDeadLanding(k);
  }

  // Next generation's active set: every cell that changed, expanded by one
  // ring of neighbors (a change can influence a neighbor's count next round).
  const nextActive = new Set();
  for (const p of newActivePacked) {
    const y = (p % (1 << 21)) - __FF_KEY_OFFSET;
    const x = Math.floor(p / (1 << 21)) - __FF_KEY_OFFSET;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      for (let dy = -1; dy <= 1; dy++) {
        nextActive.add(__ffPackKey(nx, y + dy));
      }
    }
  }
  __ffActiveSet = nextActive;

  generation = nextGen;
}

// Below this size, a plain full rescan is at least as fast as dirty-region
// tracking (the bookkeeping overhead of maintaining an active-frontier set
// isn't worth it when the whole board is cheap to scan anyway), and on a
// small fully-chaotic board dirty-tracking can even be slower since nearly
// every cell is "active" every generation. Above this size, dirty-tracking
// wins by a wide and rapidly growing margin for the large majority of
// realistic patterns (anything with meaningful static or oscillating
// structure, which is the norm once a pattern is this big) -- see the
// benchmarks referenced in __ffStepDirtyNoHistory's comment above.
const __FF_DIRTY_THRESHOLD = 1500;

/* Runs up to `count` generations using the bulk/no-history path, with cycle
   detection: once the exact alive-layout is seen to repeat with period P, the
   remainder of `count` is fast-forwarded analytically (bookkeeping only) in
   jumps of P instead of resimulating every generation. Time-boxed to
   `budgetMs` of wall-clock time so it always yields back promptly. Returns a
   stats object describing what happened (used for the toast/panel). */
function fastForwardRunBatch(count, budgetMs) {
  const startTime = performance.now();
  const startGen = generation;
  let simulated = 0;   // generations actually stepped one-at-a-time
  let jumped = 0;      // generations skipped via cycle-jump bookkeeping
  let cyclePeriod = 0;
  let stoppedReason = 'completed';

  if (alive.size === 0) {
    return { simulated: 0, jumped: 0, cyclePeriod: 0, startGen, endGen: generation, reason: 'empty-board' };
  }

  fastForwardResetCycleMemory();
  // seed with the current (pre-batch) layout at its own generation number
  __ffSeenHashes.set(__ffHashAliveSet(), generation);

  // Time-budget is only polled every __FF_BUDGET_CHECK_INTERVAL generations
  // instead of on every single iteration. performance.now() is cheap but not
  // free, and calling it (plus the comparison/branch) once per generation is
  // measurable overhead once you're doing tens of thousands of generations
  // per batch. A bounded overshoot of at most that many extra generations
  // past the budget is an acceptable, predictable tradeoff -- worst case the
  // frame runs slightly over budget by a small, fixed amount, never
  // unboundedly.
  const __FF_BUDGET_CHECK_INTERVAL = 32;

  let remaining = count;
  let sinceBudgetCheck = 0;
  while (remaining > 0) {
    if (sinceBudgetCheck >= __FF_BUDGET_CHECK_INTERVAL) {
      sinceBudgetCheck = 0;
      if (performance.now() - startTime > budgetMs) { stoppedReason = 'time-budget'; break; }
    }
    if (alive.size === 0) { stoppedReason = 'died-out'; break; }

    const now = performance.now();
    // Pick the stepping strategy based on current pattern size: below
    // __FF_DIRTY_THRESHOLD a plain full rescan is simplest and at least as
    // fast; at or above it, dirty-region tracking's active-frontier approach
    // wins by a wide and growing margin for the large majority of realistic
    // patterns (see __ffStepDirtyNoHistory's comment for benchmarks). This
    // is re-checked periodically (not just once per batch) so a pattern that
    // grows past the threshold mid-run, or is pruned below it, switches
    // strategies correctly rather than being locked into an initial choice.
    if (alive.size >= __FF_DIRTY_THRESHOLD) {
      __ffStepDirtyNoHistory(now);
    } else {
      __ffActiveSet = null; // ensure a clean reseed if we switch back to dirty-tracking later
      __ffStepPlainNoHistory(now);
    }
    simulated++;
    remaining--;
    sinceBudgetCheck++;

    // Cycle detection: hash the freshly-stepped layout and see if we've been
    // here before. A repeat means the board is in a true finite cycle of
    // period (generation - previousGenerationWeSawThisHash).
    const h = __ffHashAliveSet();
    const seenAtGen = __ffSeenHashes.get(h);
    if (seenAtGen !== undefined) {
      const period = generation - seenAtGen;
      if (period > 0) {
        cyclePeriod = period;
        // Jump the remainder of the batch forward in whole cycles. Since the
        // layout is bit-for-bit identical every `period` generations, the
        // alive/states/invincible sets need no further recomputation -- we
        // only need to advance the generation counter so ages stay correct
        // (a cell "born on gen 40" that's part of a period-4 cycle repeating
        // through gen 4000 is still, correctly, reported as having been
        // alive since gen 40 -- we only skip ahead in whole-cycle increments,
        // so we never invent a fake later birth for any surviving cell).
        const wholeCycles = Math.floor(remaining / period);
        if (wholeCycles > 0) {
          const jumpTicks = wholeCycles * period;
          generation += jumpTicks;
          jumped += jumpTicks;
          remaining -= jumpTicks;
        }
        // The layout itself is unchanged by the jump (only `generation`
        // moved forward), so `h` is still the correct hash for the current
        // board -- no need to call __ffHashAliveSet() again here.
        fastForwardResetCycleMemory();
        __ffSeenHashes.set(h, generation);
      }
    } else {
      __ffSeenHashes.set(h, generation);
      __ffHashOrder.push(h);
      if (__ffHashOrder.length > fastForwardCycleWindow) {
        const old = __ffHashOrder.shift();
        __ffSeenHashes.delete(old);
      }
    }
  }

  return {
    simulated, jumped, cyclePeriod,
    startGen, endGen: generation,
    reason: stoppedReason,
    elapsedMs: performance.now() - startTime
  };
}

/* Public entry point used by the main frame() loop. Attempts to advance the
   simulation using the accelerator; returns true if it handled stepping this
   frame (caller should NOT also call stepLife()), or false if the board is
   currently in a state the accelerator doesn't support (caller should fall
   back to the ordinary exact stepLife()/superStepMultiplier path). */
function fastForwardTick() {
  if (!fastForwardIsSafeToRun()) return false;

  // One history snapshot for the WHOLE batch (not per generation) so a single
  // rewind (Shift+V / rewindStep) undoes the entire fast-forwarded batch in
  // one step. This is a deliberate, documented tradeoff of the bulk path --
  // fine-grained one-generation rewind through a fast-forwarded run isn't
  // meaningful anyway since most of it may have been analytically jumped.
  pushHistorySnapshot();

  const targetCount = fastForwardRunRemaining > 0 ? fastForwardRunRemaining : fastForwardGenerations;
  const stats = fastForwardRunBatch(targetCount, fastForwardFrameBudgetMs);
  fastForwardLastStats = stats;

  if (fastForwardRunRemaining > 0) {
    fastForwardRunRemaining = Math.max(0, fastForwardRunRemaining - (stats.simulated + stats.jumped));
  }

  return true;
}

/* Save a snapshot of current world state into historyStack (bounded by HISTORY_MAX).
   Called automatically at the start of stepLife; entries store primitive serializable
   representations so rewinding can restore them exactly. */
function pushHistorySnapshot() {
  // snapshot alive keys, birth entries, pendingPlacement and invincible sets
  const aliveArr = Array.from(alive);
  const birthArr = Array.from(birth.entries()); // [key, rec]
  const pendingArr = Array.from(pendingPlacement);
  const invArr = Array.from(invincible);
  historyStack.push({
    alive: aliveArr,
    birth: birthArr,
    generation: generation,
    pendingPlacement: pendingArr,
    invincible: invArr
  });
  if (historyStack.length > HISTORY_MAX) historyStack.shift();
}

/* Rewind one generation by popping historyStack and restoring state.
   If there's no history to rewind, inform the player and disable reverse-mode. */
function rewindStep() {
  if (historyStack.length === 0) {
    reverseTime = false;
    flashTinyToast('No earlier generations to rewind to', 1200);
    return;
  }
  const snap = historyStack.pop();
  // restore sets/maps
  alive.clear();
  birth.clear();
  pendingPlacement.clear();
  invincible.clear();

  for (const k of snap.alive) alive.add(k);
  for (const [k, rec] of snap.birth) birth.set(k, rec);
  for (const k of snap.pendingPlacement) pendingPlacement.add(k);
  for (const k of snap.invincible) invincible.add(k);

  generation = typeof snap.generation === 'number' ? snap.generation : Math.max(0, generation - 1);
}

/* ============================================================================
   SNAPSHOT SYSTEM  (Ctrl+M to save, Ctrl+K to open the menu)
   ----------------------------------------------------------------------------
   A "snapshot" is a full, exact copy of the board's state at the moment it
   was taken: every alive cell, every fading/generational cell (with its
   precise stage), every invincible wall, and the generation number they were
   captured at. Multiple snapshots can exist at once, are named "Snapshot"
   by default but freely renamable, can be loaded (replacing the ENTIRE
   current board state, same as loading a save file), deleted, or downloaded
   as a standalone .rle text file.

   Snapshots persist across page reloads via localStorage (this app doesn't
   otherwise use localStorage for anything, so a dedicated key is used and
   won't collide with anything).

   FORMAT: each snapshot is stored as plain RLE text (reusing cellsToRLE's
   existing token scheme: 'o' = alive, 'A'..'X'/'a'..'x'/two-letter tokens =
   fading stages) plus one extra comment line recording the absolute origin
   offset (since cellsToRLE/parseRLE normally work in bounding-box-relative
   coordinates, but a snapshot must restore cells at their exact original
   world position, not recentered) and which cells were invincible walls
   (encoded as extra RLE state tokens above any realistic fading-stage range,
   using the same encoder cellsToRLE already uses, so the file is still a
   single valid, self-describing RLE document -- it opens fine in any RLE
   viewer, just showing invincible cells as an unfamiliar "fading" color).
   ============================================================================ */

const SNAPSHOT_STORAGE_KEY = 'lifeSimSnapshots_v1';

function __snapshotLoadAll() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    console.warn('Failed to read snapshots from localStorage:', err);
    return [];
  }
}

function __snapshotSaveAll(list) {
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('Failed to write snapshots to localStorage (storage may be full):', err);
    flashTinyToast('Could not save snapshot (browser storage full or unavailable)', 1800);
  }
}

/* Build the cell list (alive + fading states only -- NOT invincible, see
   below) for RLE encoding. Invincible walls are intentionally excluded here:
   the RLE two-letter token scheme used by cellsToRLE/parseRLE only supports
   578 distinct state values (0-577); any "reserved sentinel" state at or
   above that silently aliases back onto a real, different, already-meaningful
   state instead of being reserved (there is no free slot). So invincible
   cells are recorded separately, outside the RLE grid entirely, as an
   explicit "#I x,y x,y ..." comment line (see __snapshotSerializeRLE). */
function __snapshotBuildCellsList() {
  const cellsList = [];
  for (const k of alive) {
    const [x, y] = parseKey(k);
    cellsList.push({ x, y, s: 1 });
  }
  for (const [k, st] of states.entries()) {
    if (alive.has(k)) continue; // already emitted above as alive; states map may briefly overlap during transitions
    const [x, y] = parseKey(k);
    cellsList.push({ x, y, s: st });
  }
  return cellsList;
}

/* Serialize the current board into a self-contained RLE string with extra
   comment lines: "#O ox oy" records the absolute origin (since
   cellsToRLE/parseRLE normally work in bounding-box-relative coordinates,
   but a snapshot must restore cells at their exact original world position,
   not recentered), "#G generation" records the generation counter at
   capture time, and "#I x,y x,y ..." records invincible wall positions
   (kept out of the RLE grid itself -- see __snapshotBuildCellsList). All are
   plain "#"-prefixed RLE comment lines, so the file still opens fine in any
   external RLE viewer (which will just ignore lines it doesn't recognize),
   while this app's own loader reads them back explicitly. */
function __snapshotSerializeRLE() {
  const cellsList = __snapshotBuildCellsList();
  const invincibleList = Array.from(invincible); // "x,y" strings, already in the right format
  const iLine = invincibleList.length > 0 ? `#I ${invincibleList.join(' ')}\n` : '';
  // #H tags which topology this snapshot was taken under (1 = hex, 0 = square). "x,y" coordinates
  // mean different things under each topology's neighbor rules, so a snapshot must only ever be
  // restored back into the same mode it was captured in -- loadSnapshotById checks this tag.
  const hLine = `#H ${hexMode ? 1 : 0}\n`;

  if (cellsList.length === 0) {
    if (invincibleList.length === 0) {
      return `#O 0 0\n#G ${generation}\n${hLine}x = 1, y = 1, rule = B${Array.from(birthRules).join('')}/S${Array.from(survivalRules).join('')}\nb!`;
    }
    // no alive/fading cells, but invincible walls exist -- build the RLE grid around them instead
    let minx = Infinity, miny = Infinity;
    for (const k of invincibleList) { const [x, y] = parseKey(k); if (x < minx) minx = x; if (y < miny) miny = y; }
    return `#O ${minx} ${miny}\n#G ${generation}\n${hLine}${iLine}x = 1, y = 1, rule = B${Array.from(birthRules).join('')}/S${Array.from(survivalRules).join('')}\nb!`;
  }

  let minx = Infinity, miny = Infinity;
  for (const c of cellsList) { if (c.x < minx) minx = c.x; if (c.y < miny) miny = c.y; }
  const rle = cellsToRLE(cellsList, `B${Array.from(birthRules).sort().join('')}/S${Array.from(survivalRules).sort().join('')}`);
  return `#O ${minx} ${miny}\n#G ${generation}\n${hLine}${iLine}${rle}`;
}

/* Parse a snapshot's RLE text back into absolute-coordinate cells + metadata.
   Unlike parseRLE() (used for templates), this does NOT recenter around
   (0,0) -- it restores cells at their exact original world position using
   the "#O ox oy" origin comment written by __snapshotSerializeRLE().
   Invincible wall positions are read back from the separate "#I ..." comment
   line and returned in their own array (they were never part of the RLE
   grid, so parseRLE never sees or touches them).

   parseRLE() re-centers its output around (0,0) using its own bounding box,
   so to recover absolute coordinates we just need to re-apply parseRLE's own
   centering offset in reverse and then shift by the recorded absolute
   origin. We don't assume anything about where parseRLE's internal bounding
   box starts (it doesn't matter -- undoing its own centering transform is
   self-consistent regardless), which keeps this correct even for hand-edited
   or externally-sourced RLE text loaded via the menu, not just snapshots
   this app produced itself. */
function __snapshotParseRLE(text) {
  let originX = 0, originY = 0, savedGen = 0;
  const oMatch = text.match(/^#O\s+(-?\d+)\s+(-?\d+)\s*$/m);
  if (oMatch) { originX = parseInt(oMatch[1], 10); originY = parseInt(oMatch[2], 10); }
  const gMatch = text.match(/^#G\s+(-?\d+)\s*$/m);
  if (gMatch) { savedGen = parseInt(gMatch[1], 10); }
  const iMatch = text.match(/^#I\s+(.+)$/m);
  const invincibleKeys = iMatch ? iMatch[1].trim().split(/\s+/).filter(Boolean) : [];
  // #H tag: which topology this snapshot was captured under. Absent (older snapshots taken
  // before hex mode existed) defaults to square (0), which is correct/backwards-compatible.
  const hMatch = text.match(/^#H\s+(\d+)\s*$/m);
  const wasHex = hMatch ? hMatch[1] === '1' : false;

  const rel = parseRLE(text);
  if (!rel || rel.length === 0) return { cells: [], invincibleKeys, generation: savedGen, wasHex };

  // parseRLE centered its output so that its own bounding box's min corner
  // sits at (-cx, -cy) (see its final centering line). Re-derive that same
  // min corner from the cells it gave us, then shift so the min corner lands
  // at the recorded absolute origin instead of at (-cx,-cy).
  let relMinX = Infinity, relMinY = Infinity;
  for (const c of rel) { if (c.x < relMinX) relMinX = c.x; if (c.y < relMinY) relMinY = c.y; }
  const shiftX = originX - relMinX;
  const shiftY = originY - relMinY;
  const cells = rel.map(c => ({ x: c.x + shiftX, y: c.y + shiftY, s: c.s }));
  return { cells, invincibleKeys, generation: savedGen, wasHex };
}

/* Take a snapshot of the current board and add it to the saved list.
   Returns the newly created snapshot's metadata (id, name, cellCount). */
function takeSnapshot(customName) {
  const list = __snapshotLoadAll();
  const cellsList = __snapshotBuildCellsList();
  const rle = __snapshotSerializeRLE();
  const existingCount = list.filter(s => /^Snapshot(\s+\d+)?$/.test(s.name)).length;
  const name = customName || (existingCount === 0 ? 'Snapshot' : `Snapshot ${existingCount + 1}`);
  const entry = {
    id: 'snap_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
    name,
    createdAt: Date.now(),
    generation,
    cellCount: cellsList.length + invincible.size,
    rle
  };
  list.push(entry);
  __snapshotSaveAll(list);
  return entry;
}

/* Load a snapshot by id: fully replaces the current board state (alive,
   birth, states, invincible, generation, pendingPlacement) the same way
   loading a save file would. This does NOT push a history/rewind entry --
   loading a snapshot is treated as a fresh starting point, not a step. */
function loadSnapshotById(id) {
  const list = __snapshotLoadAll();
  const entry = list.find(s => s.id === id);
  if (!entry) {
    flashTinyToast('Snapshot not found (it may have been deleted)', 1400);
    return false;
  }
  const { cells, invincibleKeys, generation: savedGen, wasHex } = __snapshotParseRLE(entry.rle);

  // A snapshot's "x,y" coordinates mean something different depending on which topology it was
  // captured under (square Moore-neighbor grid vs. hex axial 6-neighbor grid) -- restoring one
  // into the wrong mode would silently place cells at technically-valid but semantically-wrong
  // positions, immediately misbehaving once stepLife() applies the current mode's neighbor
  // rules to them. Block the restore and tell the player how to fix it instead.
  if (wasHex !== hexMode) {
    flashTinyToast(
      wasHex
        ? `"${entry.name}" was captured in Hex Mode — switch to Hex Mode (Ctrl+I) to load it.`
        : `"${entry.name}" was captured in normal mode — switch out of Hex Mode (Ctrl+I) to load it.`,
      2400
    );
    return false;
  }

  // Full board replacement.
  alive.clear();
  birth.clear();
  states.clear();
  invincible.clear();
  pendingPlacement.clear();
  activatePendingOnly = false;
  historyStack.length = 0;
  fastForwardResetCycleMemory();
  fastForwardLastStats = null;

  const now = performance.now();
  for (const c of cells) {
    const k = `${c.x},${c.y}`;
    if (c.s === 1) {
      alive.add(k);
      birth.set(k, { t: now, p: pausedAccum, gen: savedGen });
    } else if (c.s > 1) {
      // fading/generational cell: restore into the states map at its exact stage
      states.set(k, c.s);
    }
  }
  for (const k of invincibleKeys) invincible.add(k);

  generation = savedGen;
  flashTinyToast(`Loaded "${entry.name}" (${cells.length + invincibleKeys.length} cells, generation ${savedGen})`, 1600);
  return true;
}

function deleteSnapshotById(id) {
  const list = __snapshotLoadAll();
  const idx = list.findIndex(s => s.id === id);
  if (idx === -1) return false;
  const [removed] = list.splice(idx, 1);
  __snapshotSaveAll(list);
  flashTinyToast(`Deleted snapshot "${removed.name}"`, 1200);
  return true;
}

function renameSnapshotById(id, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) return false;
  const list = __snapshotLoadAll();
  const entry = list.find(s => s.id === id);
  if (!entry) return false;
  entry.name = trimmed.slice(0, 80); // keep names reasonably short
  __snapshotSaveAll(list);
  return true;
}

/* Trigger a browser download of a snapshot's RLE text as a .rle file. */
function downloadSnapshotById(id) {
  const list = __snapshotLoadAll();
  const entry = list.find(s => s.id === id);
  if (!entry) return;
  const blob = new Blob([entry.rle], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = entry.name.replace(/[^a-z0-9_\- ]/gi, '').trim().replace(/\s+/g, '_') || 'snapshot';
  a.href = url;
  a.download = `${safeName}.rle`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}


/* Actually flips the topology: swaps hexMode, resets rule string to the appropriate default,
   clears the board (cells don't carry over between square<->hex since the neighbor semantics
   are fundamentally different), and turns off features that don't make sense in hex mode.
   Called once, at the midpoint of the transition animation (during the 'swap' phase), so the
   player never sees the actual discontinuity -- it happens while the screen is fully pixelated. */
function applyHexModeSwap() {
  hexMode = !hexMode;

  // Defensive: Ctrl+I (which leads here) is already blocked while ltlMode is active via the
  // LTL key-block in the keydown handler, but make sure LTL mode can never be left silently
  // "on" (with its radius-based stepping and default rule string) alongside a hex-topology
  // board if this is ever reached some other way.
  if (ltlMode) {
    ltlMode = false;
    __ltlPrevBirthRules = null;
    __ltlPrevSurvivalRules = null;
    __ltlPrevCellStatesCount = null;
  }

  // Clear the board: square-grid patterns don't mean anything under a hex neighborhood and
  // vice versa, so carrying them over would just look like garbage/noise either direction.
  alive.clear();
  birth.clear();
  states.clear();
  pendingPlacement.clear();
  invincible.clear();
  historyStack.length = 0;
  reverseTime = false;
  generation = 0;

  if (hexMode) {
    // Entering hex mode: default to B2/S34, a lively hex-topology analog of Conway's B3/S23.
    birthRules = new Set([2]);
    survivalRules = new Set([3, 4]);
    cellStatesCount = 2;

    // Rule Spots are axis-aligned rectangular regions with their own per-region B/S rules --
    // they fundamentally assume a square grid, so placement is disabled in hex mode. Existing
    // spots are left in ruleSpots (harmless, just inert) rather than deleted, so they come back
    // automatically when the player returns to square mode. If the Rule Spot panel happens to
    // be open (player was mid-placement when Ctrl+I fired), close it properly -- just flipping
    // the flag would leave the panel's DOM element and its escape-key listener orphaned on screen.
    if (ruleSpotPlacementMode || document.getElementById('rule-spot-panel')) {
      closeRuleSpotPanel();
    }

    // The Live Cluster overlay's convex-hull expansion kernel assumes 8-neighbor (Moore)
    // adjacency and would draw an incorrect hull shape under a 6-neighbor hex topology.
    // Use the real toggle function (not just the flag) so its sensitivity-slider DOM element
    // and cached hull data get torn down properly too.
    if (liveClusterOverlayEnabled) {
      toggleLiveClusterOverlay();
    }

    flashTinyToast('Hex Mode: ON — B2/S34, 6-neighbor hex topology', 2200);
  } else {
    // Leaving hex mode: restore classic Conway defaults.
    birthRules = new Set([3]);
    survivalRules = new Set([2, 3]);
    cellStatesCount = 2;
    flashTinyToast('Hex Mode: OFF — back to B3/S23', 1600);
  }
}

/* Kicks off the animated pixelate -> swap -> unpixelate transition. Safe to call while a
   transition is already running (e.g. rapid Ctrl+I taps): the new direction simply overrides
   mid-flight, using whatever pixelation level was already reached as the new starting point
   so the animation never jumps or stutters. */
function startHexTransition() {
  const now = performance.now();
  const direction = hexMode ? 'toSquare' : 'toHex';
  if (hexTransition && hexTransition.phase !== 'unpixelate' && hexTransition.phase !== 'idle') {
    // Already mid pixelate/hold when re-toggled: keep current visual pixelation level as the
    // starting point for a fresh transition rather than resetting to zero abruptly.
    hexTransition = {
      phase: 'pixelate',
      direction,
      phaseStartedAt: now - (HEX_TRANSITION_PIXELATE_MS * hexTransitionCurrentAmount()),
    };
  } else {
    hexTransition = { phase: 'pixelate', direction, phaseStartedAt: now };
  }
}

// Returns current pixelation amount (0..1) based on the active transition's phase/progress.
// Used both by the renderer and by startHexTransition's mid-flight-restart logic above.
function hexTransitionCurrentAmount() {
  if (!hexTransition) return 0;
  const now = performance.now();
  const elapsed = now - hexTransition.phaseStartedAt;
  if (hexTransition.phase === 'pixelate') {
    return Math.max(0, Math.min(1, elapsed / HEX_TRANSITION_PIXELATE_MS));
  } else if (hexTransition.phase === 'hold') {
    return 1;
  } else if (hexTransition.phase === 'unpixelate') {
    return Math.max(0, Math.min(1, 1 - (elapsed / HEX_TRANSITION_UNPIXELATE_MS)));
  }
  return 0;
}

/* Advances the transition state machine. Called once per frame from draw(). Returns the
   current pixelation amount (0 = clear, 1 = fully pixelated) so draw() knows how heavily to
   apply the pixelation post-effect this frame, plus a fadeAmount (0..1, 1 = cells fully faded)
   used to fade out old cells during the pixelate phase (only relevant right at the transition
   start, since the board is cleared during the swap anyway). */
function updateHexTransition(now) {
  if (!hexTransition) return { pixelAmount: 0, fadeAmount: 0 };
  const elapsed = now - hexTransition.phaseStartedAt;

  if (hexTransition.phase === 'pixelate') {
    const t = Math.max(0, Math.min(1, elapsed / HEX_TRANSITION_PIXELATE_MS));
    if (t >= 1) {
      // Reached full pixelation: perform the actual topology swap now, while the screen is
      // fully obscured, then hold briefly before revealing the new grid.
      applyHexModeSwap();
      hexTransition.phase = 'hold';
      hexTransition.phaseStartedAt = now;
      return { pixelAmount: 1, fadeAmount: 1 };
    }
    return { pixelAmount: t, fadeAmount: t };
  }

  if (hexTransition.phase === 'hold') {
    if (elapsed >= HEX_TRANSITION_HOLD_MS) {
      hexTransition.phase = 'unpixelate';
      hexTransition.phaseStartedAt = now;
      return { pixelAmount: 1, fadeAmount: 1 };
    }
    return { pixelAmount: 1, fadeAmount: 1 };
  }

  if (hexTransition.phase === 'unpixelate') {
    const t = Math.max(0, Math.min(1, elapsed / HEX_TRANSITION_UNPIXELATE_MS));
    if (t >= 1) {
      hexTransition = null; // transition complete, back to idle
      return { pixelAmount: 0, fadeAmount: 0 };
    }
    return { pixelAmount: 1 - t, fadeAmount: 0 };
  }

  return { pixelAmount: 0, fadeAmount: 0 };
}

/* Applies a chunky pixelation post-effect to whatever is currently on the canvas, by
   downscaling the canvas to a tiny offscreen buffer and scaling it back up with image
   smoothing disabled. amount is 0..1 (0 = no effect, 1 = maximum pixelation). Reuses a single
   offscreen canvas across calls to avoid allocating a new one every frame. */
let __hexPixelateCanvas = null;
let __hexPixelateCtx = null;
function applyPixelateEffect(amount) {
  if (amount <= 0.001) return;
  const blockSize = Math.max(1, Math.round(1 + amount * HEX_TRANSITION_MAX_PIXEL_SIZE));
  const w = Math.max(1, Math.ceil(innerWidth / blockSize));
  const h = Math.max(1, Math.ceil(innerHeight / blockSize));

  if (!__hexPixelateCanvas) {
    __hexPixelateCanvas = document.createElement('canvas');
    __hexPixelateCtx = __hexPixelateCanvas.getContext('2d');
  }
  if (__hexPixelateCanvas.width !== w || __hexPixelateCanvas.height !== h) {
    __hexPixelateCanvas.width = w;
    __hexPixelateCanvas.height = h;
  }

  // Downscale the current full-res canvas into the tiny buffer (this blurs/averages detail away).
  // Note: drawImage's source rect reads raw backing-store pixels, ignoring the ctx transform,
  // so we must use canvas.width/height (device pixels, includes DPR scaling) here -- not
  // innerWidth/innerHeight (CSS pixels) -- or on high-DPI screens we'd only sample a corner.
  __hexPixelateCtx.imageSmoothingEnabled = true;
  __hexPixelateCtx.clearRect(0, 0, w, h);
  __hexPixelateCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, w, h);

  // ...then draw it back up to full size (in CSS-pixel space, since ctx has the DPR transform
  // applied) with smoothing off, so each tiny pixel becomes a visible blocky square.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(__hexPixelateCanvas, 0, 0, w, h, 0, 0, innerWidth, innerHeight);
  ctx.imageSmoothingEnabled = true;
}


function lerpColorHex(a, b, t) {
  const ah = parseInt(a.slice(1), 16);
  const bh = parseInt(b.slice(1), 16);
  const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
  const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
  const rr = Math.round(ar + (br - ar) * t);
  const rg = Math.round(ag + (bg - ag) * t);
  const rb = Math.round(ab + (bb - ab) * t);
  return `rgb(${rr},${rg},${rb})`;
}

/* Inverts a color for Shift+A's board-wide invert mode. Accepts '#rrggbb' hex or 'rgb(r,g,b)' /
   'rgba(r,g,b,a)' strings (the two formats used throughout this file's cell-color code, e.g.
   getAgeColor()'s hex stage colors and lerpColorHex()'s rgb(...) output) and flips each channel
   (255 - channel), preserving alpha untouched. This is what actually makes Shift+A invert the F
   key's age-overlay colors instead of just painting a flat black square over them (the old
   behavior below) -- and it's applied only to board cell colors, never to toast/UI chrome, so
   flashTinyToast and friends are untouched by design. */
function invertBoardColor(color) {
  if (!color) return color;
  if (color[0] === '#') {
    const hex = color.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16), g = parseInt(hex[1] + hex[1], 16), b = parseInt(hex[2] + hex[2], 16);
      return `rgb(${255 - r},${255 - g},${255 - b})`;
    }
    const num = parseInt(hex, 16);
    const r = (num >> 16) & 0xff, g = (num >> 8) & 0xff, b = num & 0xff;
    return `rgb(${255 - r},${255 - g},${255 - b})`;
  }
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
  if (m) {
    const r = parseInt(m[1], 10), g = parseInt(m[2], 10), b = parseInt(m[3], 10);
    if (m[4] !== undefined) return `rgba(${255 - r},${255 - g},${255 - b},${m[4]})`;
    return `rgb(${255 - r},${255 - g},${255 - b})`;
  }
  return color; // unrecognized format -- leave as-is rather than guess
}

/* Draw background, grid and alive cells (and template preview) */
function draw(now = performance.now()) {
  // Hex Mode transition (Ctrl+I): advance the pixelate/swap/unpixelate state machine once per
  // frame, at the very top, so both the cell-fade-out (below) and the final pixelation post-
  // effect (at the end of this function) use a single consistent progress value for this frame.
  const __hexT = hexTransition ? updateHexTransition(now) : { pixelAmount: 0, fadeAmount: 0 };

  // Frame-scoped hex render cache: r and the 6 corner offsets only change when cellSize changes
  // (once per zoom action, not per frame), so compute them once here and reuse across both the
  // grid-outline pass and every drawCellAt call this frame, instead of each recomputing its own
  // copy per hex (previously: 6 multiplications repeated per cell, per frame, for every alive
  // and grid-outline hex -- this was a meaningful chunk of hex mode's per-frame cost).
  let __hexR = 0, __hexScaledCorners = null;
  if (hexMode) {
    __hexR = Math.max(1, cellSize * HEX_RADIUS_FACTOR);
    __hexScaledCorners = HEX_UNIT_CORNERS.map(([ux, uy]) => [__hexR * ux, __hexR * uy]);
  }
  // Color -> Path2D accumulator for this frame's hex cell fills (see drawCellAt/
  // flushHexFillBatches below). Declared here so it's fresh and empty every frame.
  const __hexFillBatches = new Map();
  // Same idea for square-grid mode: batch same-colored fillRects into one Path2D per color
  // instead of one immediate fillRect (+ fillStyle set) per cell. See flushSquareFillBatches.
  const __squareFillBatches = new Map();

  // fill background (inverts if requested)
  const bgColor = invertColors ? '#fff' : '#000';
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  // Optionally draw grid (only when cells are large enough to be useful)
  if (showGrid && cellSize >= 6 && !hexMode) {
    // grid color should be subtly visible on top of background and invert too
    ctx.strokeStyle = invertColors ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    const halfW = innerWidth / 2;
    const halfH = innerHeight / 2;
    const left = Math.floor(( -halfW) / cellSize + offsetX) - 1;
    const right = Math.ceil(( halfW) / cellSize + offsetX) + 1;
    const top = Math.floor(( -halfH) / cellSize + offsetY) - 1;
    const bottom = Math.ceil(( halfH) / cellSize + offsetY) + 1;

    // vertical lines
    for (let x = left; x <= right; x++) {
      const sx = Math.round((x - offsetX) * cellSize + innerWidth / 2) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, innerHeight);
    }
    // horizontal lines
    for (let y = top; y <= bottom; y++) {
      const sy = Math.round((y - offsetY) * cellSize + innerHeight / 2) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(innerWidth, sy);
    }
    ctx.stroke();
  } else if (showGrid && cellSize >= 6 && hexMode) {
    // Hex grid: outline every hex tile whose center falls within (a slightly padded) view.
    // Uses the same axial->pixel projection as drawCellAt, just stroking instead of filling.
    ctx.strokeStyle = invertColors ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    const r = __hexR;

    // Convert the viewport's 4 screen-space corners into (fractional) axial coordinates via the
    // inverse of the forward projection used everywhere else (shiftedPx = sqrt3*x + sqrt3/2*y,
    // shiftedPy = 1.5*y). Axial x,y form a SKEWED (parallelogram) coordinate system relative to
    // screen space -- a naive square x/y loop range only covers a parallelogram of that skewed
    // space, which misses two opposite corners of the actual rectangular viewport (this was the
    // bug causing black wedges in the top-right/bottom-left). Bounding all 4 corners' axial
    // coordinates and iterating that full range guarantees complete rectangular coverage.
    const corners = [
      [0, 0], [innerWidth, 0], [0, innerHeight], [innerWidth, innerHeight]
    ];
    let minAx = Infinity, maxAx = -Infinity, minAy = Infinity, maxAy = -Infinity;
    for (const [scx, scy] of corners) {
      const shiftedPy = (scy - innerHeight / 2) / cellSize;
      const shiftedPx = (scx - innerWidth / 2) / cellSize;
      const ay = shiftedPy / 1.5 + offsetY;
      const ax = (shiftedPx - (HEX_SQRT3 / 2) * (ay - offsetY)) / HEX_SQRT3 + offsetX;
      if (ax < minAx) minAx = ax;
      if (ax > maxAx) maxAx = ax;
      if (ay < minAy) minAy = ay;
      if (ay > maxAy) maxAy = ay;
    }
    const PAD = 2; // extra rings beyond the computed bound, cheap insurance against rounding
    const top = Math.floor(minAy) - PAD, bottom = Math.ceil(maxAy) + PAD;

    // Reuse the shared per-frame corner offsets instead of rebuilding them here.
    const scaledCorners = __hexScaledCorners;

    for (let wy = top; wy <= bottom; wy++) {
      // Row-invariant terms: everything that depends only on wy (not wx) is hoisted out of the
      // inner loop below, since it was previously being recomputed for every wx unnecessarily.
      const rowPxTerm = (HEX_SQRT3 / 2) * (wy - offsetY) - HEX_SQRT3 * offsetX;
      const sy = 1.5 * (wy - offsetY) * cellSize + innerHeight / 2;
      if (sy < -r || sy > innerHeight + r) continue; // whole row off-screen, skip entirely
      // Per-row tight horizontal bound instead of reusing the global (looser) minAx/maxAx: since
      // the axial parallelogram's horizontal extent at a given row is narrower than the full
      // bounding box's width, deriving it per-row (cheap: 2 inverse-projection evaluations)
      // shrinks the number of columns actually iterated, cutting the ~37% overestimate from
      // using one global box down close to the true visible-hex count.
      const rowShiftedPy = (wy - offsetY) * 1.5;
      const invLeftPx = (-innerWidth / 2) / cellSize;
      const invRightPx = (innerWidth / 2) / cellSize;
      const rowWxLeft = Math.floor((invLeftPx - (HEX_SQRT3 / 2) * (wy - offsetY)) / HEX_SQRT3 + offsetX) - PAD;
      const rowWxRight = Math.ceil((invRightPx - (HEX_SQRT3 / 2) * (wy - offsetY)) / HEX_SQRT3 + offsetX) + PAD;
      for (let wx = rowWxLeft; wx <= rowWxRight; wx++) {
        const sx = (HEX_SQRT3 * wx + rowPxTerm) * cellSize + innerWidth / 2;
        if (sx < -r || sx > innerWidth + r) continue;
        for (let i = 0; i < 6; i++) {
          const [ox, oy] = scaledCorners[i];
          const vx = sx + ox;
          const vy = sy + oy;
          if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();
  }

  // For performance, compute visible bounds in world coords
  const halfW = innerWidth / 2;
  const halfH = innerHeight / 2;
  const left = Math.floor(( -halfW) / cellSize + offsetX) - 1;
  const right = Math.ceil(( halfW) / cellSize + offsetX) + 1;
  const top = Math.floor(( -halfH) / cellSize + offsetY) - 1;
  const bottom = Math.ceil(( halfH) / cellSize + offsetY) + 1;

  // Age color stages:
  // Stage 0: light green -> navy (23.5s)
  // Stage 1: navy -> dark purple (35s)
  // Stage 2: dark purple -> dark red (47.5s)
  // Stage 3: dark red -> dark yellow (65s)
  // Stage 4: dark yellow -> dark green (90s)
  // Stage 5: dark green -> very dark teal (100s)
  // Stage 6: final very dark teal (terminal)
  const AGE_STAGES = [
    { dur: 23500, from: '#90ee90', to: '#000080' }, // light green -> navy
    { dur: 35000, from: '#000080', to: '#2e004f' }, // navy -> dark purple
    { dur: 47500, from: '#2e004f', to: '#5a0000' }, // dark purple -> dark red
    { dur: 65000, from: '#5a0000', to: '#8b7500' }, // dark red -> dark yellow
    { dur: 90000, from: '#8b7500', to: '#006400' }, // dark yellow -> dark green
    { dur: 100000, from: '#006400', to: '#00393f' }, // dark green -> very dark teal
  ];
  // Precompute total cycle length (terminal color at end of last stage)
  const AGE_TOTAL = AGE_STAGES.reduce((s, st) => s + st.dur, 0);

  // Given an age in ms, return the interpolated color string
  function getAgeColor(ageMs) {
    if (ageMs <= 0) return AGE_STAGES[0].from;
    let remaining = ageMs;
    for (let i = 0; i < AGE_STAGES.length; i++) {
      const st = AGE_STAGES[i];
      if (remaining < st.dur) {
        const t = remaining / st.dur;
        return lerpColorHex(st.from, st.to, t);
      }
      remaining -= st.dur;
    }
    // past all stages: return final color (very dark teal)
    return AGE_STAGES[AGE_STAGES.length - 1].to;
  }

  // effectiveNow freezes while paused so ages do not advance during pause
  const effectiveNow = running ? now : (pauseStart || now);

  // Live Cluster Highlight (Ctrl+V): recompute on a throttle, then render convex-hull-filled
  // highlights directly over the board -- same grouping/hull logic as the Ctrl+F scanner, but
  // with no menu and no per-cluster count labels, just the highlight shapes themselves.
  if (liveClusterOverlayEnabled) {
    liveClusterMaybeRecompute(now);
    if (__liveClusterCache.length > 0) {
      ctx.save();
      const palette = ['rgba(255,64,64,0.18)','rgba(255,160,64,0.14)','rgba(255,255,64,0.14)','rgba(160,255,64,0.14)','rgba(64,255,160,0.14)','rgba(64,160,255,0.14)','rgba(180,64,255,0.14)','rgba(255,64,200,0.14)'];
      function liveConvexHull(points) {
        if (!points || points.length <= 2) return points.slice();
        const expandedSet = new Map();
        const neigh = [[0,0],[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
        for (const p of points) for (const n of neigh) { const ex = p.x + n[0], ey = p.y + n[1]; const key = ex + ',' + ey; if (!expandedSet.has(key)) expandedSet.set(key, [ex, ey]); }
        const pts = Array.from(expandedSet.values()); pts.sort((a,b)=>a[0]===b[0]?a[1]-b[1]:a[0]-b[0]);
        const cross = (o,a,b)=> (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
        const lower = []; for (const p of pts){ while (lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop(); lower.push(p); }
        const upper = []; for (let i=pts.length-1;i>=0;i--){ const p=pts[i]; while (upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], p) <=0) upper.pop(); upper.push(p); }
        upper.pop(); lower.pop(); const hull = lower.concat(upper); return hull.map(h=>({x:h[0], y:h[1]}));
      }
      for (let i = 0; i < __liveClusterCache.length; i++) {
        const cl = __liveClusterCache[i];
        if (!cl || cl.length === 0) continue;
        // cheap visibility cull: skip clusters entirely outside the current viewport
        let cminx = Infinity, cminy = Infinity, cmaxx = -Infinity, cmaxy = -Infinity;
        for (const p of cl) { if (p.x < cminx) cminx = p.x; if (p.x > cmaxx) cmaxx = p.x; if (p.y < cminy) cminy = p.y; if (p.y > cmaxy) cmaxy = p.y; }
        if (cmaxx < left || cminx > right || cmaxy < top || cminy > bottom) continue;
        let hull = liveConvexHull(cl);
        if (!hull || hull.length < 3) { hull = [{x:cminx,y:cminy},{x:cmaxx,y:cminy},{x:cmaxx,y:cmaxy},{x:cminx,y:cmaxy}]; }
        ctx.beginPath();
        for (let vi = 0; vi < hull.length; vi++) {
          const vx = Math.round((hull[vi].x - offsetX) * cellSize + innerWidth / 2);
          const vy = Math.round((hull[vi].y - offsetY) * cellSize + innerHeight / 2);
          if (vi === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fillStyle = palette[i % palette.length];
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // draw rule spot regions (subtle tinted rectangle + border + small rule-string label) so the
  // player can see where custom-rule areas are on the board, before drawing any cells on top.
  // While the panel is open, whichever spot the mouse is currently over is highlighted in
  // orange with a "Z to delete" hint, matching the Z-key deletion behavior.
  if (ruleSpots.length > 0) {
    let hoveredSpotForDelete = null;
    if (ruleSpotPlacementMode && mousePos) {
      const hw = screenToWorld(mousePos.x, mousePos.y);
      hoveredSpotForDelete = getRuleSpotAt(hw.wx, hw.wy);
    }
    ctx.save();
    for (const spot of ruleSpots) {
      if (spot.maxx < left || spot.minx > right || spot.maxy < top || spot.miny > bottom) continue;
      const sx0 = Math.round((spot.minx - offsetX) * cellSize + innerWidth / 2);
      const sy0 = Math.round((spot.miny - offsetY) * cellSize + innerHeight / 2);
      const sw = Math.round((spot.maxx - spot.minx + 1) * cellSize);
      const sh = Math.round((spot.maxy - spot.miny + 1) * cellSize);
      const isHovered = spot === hoveredSpotForDelete;
      ctx.fillStyle = isHovered ? 'rgba(255,150,0,0.16)' : 'rgba(0,160,255,0.08)';
      ctx.fillRect(sx0, sy0, sw, sh);
      ctx.strokeStyle = isHovered ? 'rgba(255,170,0,0.9)' : 'rgba(0,180,255,0.55)';
      ctx.lineWidth = isHovered ? 2 : 1;
      ctx.strokeRect(sx0 + 0.5, sy0 + 0.5, sw, sh);
      if (cellSize >= 3) {
        ctx.fillStyle = isHovered ? 'rgba(255,210,140,0.95)' : 'rgba(120,210,255,0.9)';
        ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, Arial';
        ctx.textBaseline = 'top';
        ctx.fillText(isHovered ? `${spot.ruleStr}  (Z to delete)` : spot.ruleStr, sx0 + 3, sy0 + 2);
      }
    }
    ctx.restore();
  }

  // Rule Spot placement-mode live preview: a dashed ghost rectangle following the mouse,
  // sized/labeled from the side panel's current width/height/rule draft values. Distinct
  // dashed style (vs. solid for placed spots) so it clearly reads as "not committed yet".
  // Colored red instead of teal when the current position would overlap an existing spot
  // (which placement rejects), so the player sees the conflict before pressing X.
  if (ruleSpotPlacementMode && mousePos) {
    const centerWorld = screenToWorld(mousePos.x, mousePos.y);
    const halfW = Math.floor(ruleSpotDraftWidth / 2);
    const halfH = Math.floor(ruleSpotDraftHeight / 2);
    const pminx = centerWorld.wx - halfW;
    const pmaxx = pminx + ruleSpotDraftWidth - 1;
    const pminy = centerWorld.wy - halfH;
    const pmaxy = pminy + ruleSpotDraftHeight - 1;
    const psx0 = Math.round((pminx - offsetX) * cellSize + innerWidth / 2);
    const psy0 = Math.round((pminy - offsetY) * cellSize + innerHeight / 2);
    const psw = Math.round((pmaxx - pminx + 1) * cellSize);
    const psh = Math.round((pmaxy - pminy + 1) * cellSize);

    let wouldOverlap = false;
    for (const existing of ruleSpots) {
      if (!(pmaxx < existing.minx || pminx > existing.maxx || pmaxy < existing.miny || pminy > existing.maxy)) {
        wouldOverlap = true;
        break;
      }
    }

    ctx.save();
    ctx.fillStyle = wouldOverlap ? 'rgba(255,60,60,0.12)' : 'rgba(0,220,160,0.10)';
    ctx.fillRect(psx0, psy0, psw, psh);
    ctx.strokeStyle = wouldOverlap ? 'rgba(255,70,70,0.9)' : 'rgba(0,255,180,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(psx0 + 0.5, psy0 + 0.5, psw, psh);
    ctx.setLineDash([]);
    ctx.fillStyle = wouldOverlap ? 'rgba(255,160,160,0.95)' : 'rgba(160,255,220,0.95)';
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, Arial';
    ctx.textBaseline = 'bottom';
    ctx.fillText(wouldOverlap ? `${ruleSpotDraftRuleStr}  (overlaps existing spot)` : `${ruleSpotDraftRuleStr}  (X to place)`, psx0 + 3, psy0 - 3);
    ctx.restore();
  }

  // draw invincible pixels first (they do not have ages)
  if (invincible.size > 0) {
    ctx.fillStyle = invertColors ? '#666' : '#333'; // slightly lighter/darker depending on board invert
    for (const k of invincible) {
      const [x, y] = parseKey(k);
      if (x < left || x > right || y < top || y > bottom) continue;
      const sx = Math.round((x - offsetX) * cellSize + innerWidth/2);
      const sy = Math.round((y - offsetY) * cellSize + innerHeight/2);
      ctx.fillRect(sx, sy, Math.max(1, Math.ceil(cellSize)), Math.max(1, Math.ceil(cellSize)));
    }
  }

  // draw portal pieces as plain solid white lines on the grid edges they occupy. Every piece
  // is rendered identically (flat white, same width, same glow) regardless of group or link
  // state -- touching pieces already act as one portal (merged into a single group at
  // draw-time; see placePortalPiece/portalMergeGroups), so there's nothing group-specific to
  // signal visually.
  if (portalEdges.size > 0) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (const [ek, piece] of portalEdges.entries()) {
      const [ax, ay] = parseKey(piece.a);
      const [bx, by] = parseKey(piece.b);
      if (Math.max(ax, bx) < left || Math.min(ax, bx) > right || Math.max(ay, by) < top || Math.min(ay, by) > bottom) continue;

      // the edge line runs perpendicular to the a->b direction, centered on the shared border
      const midX = (ax + bx + 1) / 2, midY = (ay + by + 1) / 2;
      const sxMid = (midX - offsetX) * cellSize + innerWidth / 2;
      const syMid = (midY - offsetY) * cellSize + innerHeight / 2;
      const half = cellSize / 2;
      if (ay === by) { // vertical edge (cells differ in x)
        ctx.moveTo(sxMid, syMid - half);
        ctx.lineTo(sxMid, syMid + half);
      } else { // horizontal edge (cells differ in y)
        ctx.moveTo(sxMid - half, syMid);
        ctx.lineTo(sxMid + half, syMid);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // In Portal mode with link lines toggled on (V), draw a subtle line between every linked
  // pair's centroid so the player can see at a glance which portals connect to which, without
  // having to hover each piece individually. Deliberately understated -- thin, low-opacity,
  // dashed -- so it reads as an informational overlay rather than a bold gameplay element like
  // the portal pieces themselves.
  if (altNMode && portalShowLinks && portalLinks.size > 0) {
    const centroidCache = new Map(); // groupRoot -> {x,y} average of its edges' midpoints, in world space
    function portalGroupCentroid(root) {
      if (centroidCache.has(root)) return centroidCache.get(root);
      let sumX = 0, sumY = 0, n = 0;
      for (const p of portalEdges.values()) {
        if (portalFindGroup(p.group) !== root) continue;
        const [ax, ay] = parseKey(p.a);
        const [bx, by] = parseKey(p.b);
        sumX += (ax + bx + 1) / 2;
        sumY += (ay + by + 1) / 2;
        n++;
      }
      const c = n > 0 ? { x: sumX / n, y: sumY / n } : null;
      centroidCache.set(root, c);
      return c;
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    const seenPairs = new Set();
    for (const [rootA, rootB] of portalLinks.entries()) {
      const pairKey = rootA < rootB ? `${rootA}|${rootB}` : `${rootB}|${rootA}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const ca = portalGroupCentroid(rootA), cb = portalGroupCentroid(rootB);
      if (!ca || !cb) continue;
      const sxA = (ca.x - offsetX) * cellSize + innerWidth / 2;
      const syA = (ca.y - offsetY) * cellSize + innerHeight / 2;
      const sxB = (cb.x - offsetX) * cellSize + innerWidth / 2;
      const syB = (cb.y - offsetY) * cellSize + innerHeight / 2;
      ctx.moveTo(sxA, syA);
      ctx.lineTo(sxB, syB);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // In Portal mode, highlight the grid edge currently nearest the mouse (what X/Z/C would
  // target right now) so the player can see exactly where a piece will land before pressing.
  if (altNMode && mousePos) {
    const edge = _portalEdgeUnderMouse();
    if (edge) {
      const midX = (edge.x + edge.nx + 1) / 2, midY = (edge.y + edge.ny + 1) / 2;
      const sxMid = (midX - offsetX) * cellSize + innerWidth / 2;
      const syMid = (midY - offsetY) * cellSize + innerHeight / 2;
      const half = cellSize / 2;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (edge.y === edge.ny) {
        ctx.moveTo(sxMid, syMid - half);
        ctx.lineTo(sxMid, syMid + half);
      } else {
        ctx.moveTo(sxMid - half, syMid);
        ctx.lineTo(sxMid + half, syMid);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // draw landing-map tints on dead cells (persistent, non-fading), only when overlay enabled
  if (landingMapVisible && deadLanding.size > 0) {
    for (const [k, cnt] of deadLanding.entries()) {
      const [x, y] = parseKey(k);
      if (x < left || x > right || y < top || y > bottom) continue;
      // skip if currently alive (we show landing overlays only on dead spots)
      if (alive.has(k) || invincible.has(k) || states.has(k)) continue;
      const color = getLandingColorFromCount(cnt);
      if (!color) continue;
      const sx = Math.round((x - offsetX) * cellSize + innerWidth/2);
      const sy = Math.round((y - offsetY) * cellSize + innerHeight/2);
      ctx.save();
      // draw a semi-transparent filled rect so the underlying grid remains visible
      ctx.fillStyle = applyBrightnessToColor(color, Math.max(0.6, cellBrightness * 0.9));
      ctx.globalAlpha = 0.9;
      ctx.fillRect(sx, sy, Math.max(1, Math.ceil(cellSize)), Math.max(1, Math.ceil(cellSize)));
      ctx.restore();
    }
  }

  // Helper: adjust a color string by the global brightness multiplier.
  // Supports "rgb(r,g,b)" and hex "#rrggbb" forms.
  function applyBrightnessToColor(color, brightness) {
    brightness = Math.max(0.1, Math.min(3.0, brightness || 1));
    if (!color) return color;
    color = String(color).trim();
    try {
      if (color.startsWith('rgb')) {
        const m = color.match(/rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i);
        if (!m) return color;
        let r = Math.round(Math.max(0, Math.min(255, Number(m[1]) * brightness)));
        let g = Math.round(Math.max(0, Math.min(255, Number(m[2]) * brightness)));
        let b = Math.round(Math.max(0, Math.min(255, Number(m[3]) * brightness)));
        return `rgb(${r},${g},${b})`;
      }
      if (color[0] === '#') {
        const hex = color.slice(1);
        const v = parseInt(hex.length === 3 ? hex.split('').map(ch => ch+ch).join('') : hex, 16);
        let r = (v >> 16) & 0xff;
        let g = (v >> 8) & 0xff;
        let b = v & 0xff;
        r = Math.round(Math.max(0, Math.min(255, r * brightness)));
        g = Math.round(Math.max(0, Math.min(255, g * brightness)));
        b = Math.round(Math.max(0, Math.min(255, b * brightness)));
        return `rgb(${r},${g},${b})`;
      }
    } catch (e) {
      return color;
    }
    return color;
  }

  // Helper to draw a single cell at world x,y with a given fillStyle, applying brightness.
  // In hex mode, cells are pointy-top hexagons projected via hexAxialToPixel instead of squares.
  function drawCellAt(x, y, fillStyle) {
    const resolvedColor = applyBrightnessToColor(fillStyle, cellBrightness);
    if (hexMode) {
      const shiftedPx = HEX_SQRT3 * (x - offsetX) + (HEX_SQRT3 / 2) * (y - offsetY);
      const shiftedPy = 1.5 * (y - offsetY);
      const sx = Math.round(shiftedPx * cellSize + innerWidth / 2);
      const sy = Math.round(shiftedPy * cellSize + innerHeight / 2);
      // Batch by color into a shared Path2D instead of an immediate beginPath()+fill() per cell.
      // With many hexes on screen, most share the same fill color (e.g. plain alive-cell white/
      // black when showAges is off), so accumulating them into one path per color and issuing a
      // single fill() per color at the end of the frame (see flushHexFillBatches below) turns
      // what used to be hundreds/thousands of individual fill draw calls into a handful. Falls
      // back to an immediate single-shape fill only for the rare colors that don't batch well
      // (kept identical either way -- this is purely a batching optimization, same pixels).
      let path = __hexFillBatches.get(resolvedColor);
      if (!path) { path = new Path2D(); __hexFillBatches.set(resolvedColor, path); }
      for (let i = 0; i < 6; i++) {
        const [ox, oy] = __hexScaledCorners[i];
        const vx = sx + ox;
        const vy = sy + oy;
        if (i === 0) path.moveTo(vx, vy); else path.lineTo(vx, vy);
      }
      path.closePath();
    } else {
      // Batch same-colored square fills into a Path2D too, same reasoning as the hex branch
      // above: most frames redraw hundreds/thousands of cells that share only a handful of
      // distinct colors (plain alive white/black, the handful of age-overlay ramp colors,
      // selection blue, fade grays), so grouping them into one path per color and issuing a
      // single fill() per color at frame end (flushSquareFillBatches) cuts what used to be one
      // fillStyle-set + one fillRect call per cell down to one fillStyle-set + one fill() call
      // per distinct color. Pixel-identical output to the old immediate-fillRect approach --
      // opaque/translucent cells here never rely on per-cell draw ORDER (each world cell is
      // only ever drawn once per pass; see the draw-call-site audit in the surrounding code),
      // so batching by color instead of by call order changes nothing visually.
      const sx = Math.round((x - offsetX) * cellSize + innerWidth/2);
      const sy = Math.round((y - offsetY) * cellSize + innerHeight/2);
      const w = Math.max(1, Math.ceil(cellSize));
      let path = __squareFillBatches.get(resolvedColor);
      if (!path) { path = new Path2D(); __squareFillBatches.set(resolvedColor, path); }
      path.rect(sx, sy, w, w);
    }
  }

  // Flushes all batched square-grid fills accumulated by drawCellAt this frame: one fill() call
  // per distinct color used, instead of one per cell. Must run before the pixelation post-effect
  // (which reads back whatever's on the canvas) and after all drawCellAt calls for the frame.
  function flushSquareFillBatches() {
    if (hexMode || __squareFillBatches.size === 0) return;
    for (const [color, path] of __squareFillBatches) {
      ctx.fillStyle = color;
      ctx.fill(path);
    }
    __squareFillBatches.clear();
  }

  // Flushes all batched hex fills accumulated by drawCellAt this frame: one fill() call per
  // distinct color used, instead of one per cell. Must run before the pixelation post-effect
  // (which reads back whatever's on the canvas) and after all drawCellAt calls for the frame.
  function flushHexFillBatches() {
    if (!hexMode || __hexFillBatches.size === 0) return;
    for (const [color, path] of __hexFillBatches) {
      ctx.fillStyle = color;
      ctx.fill(path);
    }
    __hexFillBatches.clear();
  }

  // Draw state==1 cells (alive) similarly to before, using birth ages when requested
  // Hex Mode transition: fade existing cells out as the pixelate-in phase progresses, since
  // the board gets cleared mid-transition anyway (square<->hex cell layouts aren't compatible).
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - __hexT.fadeAmount);
  for (const k of alive) {
    const [x, y] = parseKey(k);
    if (x < left || x > right || y < top || y > bottom) continue;

    // If this cell is part of the current selection, draw it highlighted blue.
    if (selectionActive && selectedSet.has(k)) {
      drawCellAt(x, y, 'rgba(0,120,255,0.95)');
      continue;
    }

    if (showAges && birth.has(k)) {
      // Age now computed strictly in generations (no use of performance.now); fallbacks removed.
      // Each birth record must include .gen = generation when the cell became alive.
      const recSelf = birth.get(k);
      // default age in ticks (generations)
      let ageTicksSelf = 0;
      if (recSelf && typeof recSelf.gen === 'number') {
        ageTicksSelf = Math.max(0, generation - recSelf.gen);
      } else {
        ageTicksSelf = 0;
      }

      // blending (neighbor-average) happens in tick units as well
      let displayTicks = ageTicksSelf;
      if (!disableAgeBlend) {
        let sumTicks = 0, countTicks = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const nk = `${x + ox},${y + oy}`;
          if (invincible.has(nk)) continue;
          const recN = birth.get(nk);
          if (recN && typeof recN.gen === 'number') {
            sumTicks += Math.max(0, generation - recN.gen);
            countTicks++;
          }
        }
        if (countTicks > 0) {
          const avgTicks = sumTicks / countTicks;
          if (!recSelf._smoothAge) recSelf._smoothAge = avgTicks;
          // smoother blending but still generation-driven; smoother alpha chosen to keep per-gen responsiveness
          const alpha = 0.33;
          recSelf._smoothAge = recSelf._smoothAge * (1 - alpha) + avgTicks * alpha;
          displayTicks = recSelf._smoothAge;
        } else {
          displayTicks = ageTicksSelf;
        }
      }

      // Convert tick-count to an equivalent ms value for the existing color ramp function by multiplying
      // by a fixed generation-to-time scale (DEFAULT_STEP_INTERVAL). This prevents changing tick speed
      // (stepInterval) from instantly shifting all ages' color mapping.
      const ageMsFromTicks = displayTicks * DEFAULT_STEP_INTERVAL;

      if (invertColors) {
        // Properly invert the age-ramp color itself (see invertBoardColor()) instead of just
        // painting a flat black square over it -- the old approach here meant the F-key age
        // overlay effectively never showed while Shift+A was on, since the black square drawn
        // second always won. Now the age gradient stays visible, just with every color flipped,
        // matching how the rest of the board (background, plain alive cells, fading states)
        // already inverts.
        drawCellAt(x, y, invertBoardColor(getAgeColor(ageMsFromTicks)));
      } else {
        drawCellAt(x, y, getAgeColor(ageMsFromTicks));
      }
    } else {
      drawCellAt(x, y, invertColors ? '#000' : '#fff');
    }
  }

  // Draw fading states (state >= 2) as visual fades; they are immune and don't participate as neighbors.
  if (states.size > 0) {
    for (const [k, st] of states.entries()) {
      const [x, y] = parseKey(k);
      if (x < left || x > right || y < top || y > bottom) continue;
      // If selected, show blue as well
      if (selectionActive && selectedSet.has(k)) {
        drawCellAt(x, y, 'rgba(0,120,255,0.75)');
        continue;
      }
      // Use this cell's rule spot genCount (its /G value) if it's inside one, so fade staging
      // reflects that region's own generational count rather than always the global one. Rule
      // spots don't combine with LTL mode, so under LTL this always falls through to
      // ltlCellStatesCount -- NOT the classic-mode `cellStatesCount` global, which
      // toggleLTLMode() hardcodes to 2 while LTL is active (that's what LTL's own C is stored
      // in ltlCellStatesCount for in the first place). Using the classic global here was the
      // actual bug behind fading always rendering as a single stage regardless of C: the
      // simulation (ltlStepLife()) was already correctly advancing cells through many fading
      // states using ltlCellStatesCount, but this render path was computing fadedStatesCount
      // from the wrong (always-2-under-LTL) counter, collapsing every fade to one visual stage.
      const renderSpot = ruleSpots.length ? getRuleSpotAt(x, y) : null;
      const localGenCountRender = renderSpot ? renderSpot.genCount : (ltlMode ? ltlCellStatesCount : cellStatesCount);
      // Compute number of faded states = (G - 2). genCount is total states (C), so faded count is C-2.
      const fadedStatesCount = Math.max(0, localGenCountRender - 2); // equals number of distinct faded stages
      // Compute a faded color based on how far into the fade this cell is.
      // Valid st values for fades start at 2 up to (genCount - 1). Map those to t in [0..1].
      // If fadedStatesCount == 0 there's no fade range (shouldn't happen, but guard).
      let t = 0;
      if (fadedStatesCount <= 0) {
        t = 0;
      } else {
        // st == 2 => idx 0 ; st == (genCount-1) => idx fadedStatesCount-1
        const idx = Math.max(0, st - 2);
        t = Math.max(0, Math.min(1, idx / Math.max(1, fadedStatesCount - 1)));
      }
      // simple lerp from light gray to dim red/teal depending on invert
      const from = invertColors ? '#dddddd' : '#555555';
      const to = invertColors ? '#888888' : '#222222';
      drawCellAt(x, y, lerpColorHex(from, to, t));
    }
  }
  ctx.restore(); // matches ctx.save() before the alive-cell loop (ends Hex Mode fade-out alpha)

  // Next-generation preview overlay (mode toggled via Ctrl+Z): draw white dots on dead cells that will be born,
  // and black dots on alive cells that will die next generation; dots are drawn centered on the cell body.
  if (previewNextGenMode) {
    // Compute neighbor counts ignoring faded states (states map); only state==1 counts (alive Set)
    const countsPreview = new Map();
    for (const k of alive) {
      // alive cells count neighbors
      const [sx, sy] = parseKey(k);
      if (hexMode) {
        for (const [dx, dy] of HEX_NEIGHBOR_OFFSETS) {
          const nk = `${sx+dx},${sy+dy}`;
          countsPreview.set(nk, (countsPreview.get(nk) || 0) + 1);
        }
      } else {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nk = `${sx + dx},${sy + dy}`;
          countsPreview.set(nk, (countsPreview.get(nk) || 0) + 1);
        }
      }
    }

    // draw births (dead -> alive): where not alive AND birthRules has count
    ctx.save();
    // draw dots on top of cell area: small radius based on cellSize (clamped)
    const dotRadius = Math.max(1, Math.min(6, Math.floor(cellSize * 0.22)));
    for (const [k, cnt] of countsPreview.entries()) {
      // skip if invincible or fading occupies the spot (we only preview for standard cells)
      if (invincible.has(k)) continue;
      const isAlive = alive.has(k);
      if (!isAlive && birthRules.has(cnt)) {
        const [x, y] = parseKey(k);
        if (x < left || x > right || y < top || y > bottom) continue;
        const sx = Math.round((x - offsetX) * cellSize + innerWidth / 2);
        const sy = Math.round((y - offsetY) * cellSize + innerHeight / 2);
        // white dot for birth (draw filled circle centered on cell)
        ctx.beginPath();
        ctx.fillStyle = '#ffffff';
        ctx.arc(sx + Math.floor(cellSize/2) - 0.5, sy + Math.floor(cellSize/2) - 0.5, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // draw deaths (alive -> dead): iterate alive cells and see if their neighbor count fails survival
    ctx.fillStyle = '#000000';
    for (const k of alive) {
      if (invincible.has(k)) continue;
      const n = countsPreview.get(k) || 0;
      if (!survivalRules.has(n)) {
        const [x, y] = parseKey(k);
        if (x < left || x > right || y < top || y > bottom) continue;
        const sx = Math.round((x - offsetX) * cellSize + innerWidth / 2);
        const sy = Math.round((y - offsetY) * cellSize + innerHeight / 2);
        // black dot for death
        ctx.beginPath();
        ctx.fillStyle = '#000000';
        ctx.arc(sx + Math.floor(cellSize/2) - 0.5, sy + Math.floor(cellSize/2) - 0.5, dotRadius, 0, Math.PI * 2);
        ctx.fill();
        // if background is dark, add thin white outline for visibility
        if (!invertColors) {
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.22)';
          ctx.stroke();
        } else {
          // on inverted (white background) outline with subtle black
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(0,0,0,0.22)';
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  // draw selection rectangle if active (holding O)
  if (selectionActive && selStart && selCurrent) {
    const rect = {
      x1: Math.min(selStart.x, selCurrent.x),
      y1: Math.min(selStart.y, selCurrent.y),
      x2: Math.max(selStart.x, selCurrent.x),
      y2: Math.max(selStart.y, selCurrent.y)
    };
    drawSelectionRectOnCanvas(rect);
  }

  // draw crosshair on-screen when crosshairMode is active
  if (crosshairMode && crosshairPos) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,40,40,0.9)';
    ctx.lineWidth = 1;
    // center crosshair lines on half-pixel for crispness
    const cx = Math.round(crosshairPos.x) + 0.5;
    const cy = Math.round(crosshairPos.y) + 0.5;
    // horizontal
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(innerWidth, cy);
    ctx.stroke();
    // vertical
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, innerHeight);
    ctx.stroke();
    // small center box
    const size = Math.max(4, Math.min(8, Math.round(cellSize)));
    ctx.fillStyle = 'rgba(255,40,40,0.95)';
    ctx.fillRect(Math.round(cx - size/2), Math.round(cy - size/2), size, size);
    ctx.restore();
  }

  // draw template preview if attached and mouse present
  if (templateAttached && templateCells && mousePos) {
    const {wx, wy} = screenToWorld(mousePos.x, mousePos.y);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(0,255,0,0.9)';
    for (const c of templateCells) {
      const tx = wx + c.x;
      const ty = wy + c.y;
      if (tx < left || tx > right || ty < top || ty > bottom) continue;
      const sx = Math.round((tx - offsetX) * cellSize + innerWidth/2);
      const sy = Math.round((ty - offsetY) * cellSize + innerHeight/2);
      ctx.fillRect(sx, sy, Math.max(1, Math.ceil(cellSize)), Math.max(1, Math.ceil(cellSize)));
    }
    ctx.globalAlpha = 1;
  }

  // Flush every hex cell fill accumulated by drawCellAt this frame (alive cells, fading states,
  // selection highlights, etc.) as one fill() call per distinct color, instead of the one-
  // fill-call-per-cell this used to be. Must happen before the pixelation post-effect below,
  // since that reads back whatever is currently painted on the canvas.
  // Re-apply the same fade-out alpha used while accumulating alive/fading cells (its own
  // ctx.save()/ctx.restore() pair already reverted globalAlpha by this point in the frame,
  // since Path2D fills use globalAlpha as of when fill() actually runs, not when the path's
  // points were added -- so without this, the hex-transition fade-out would be lost).
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - __hexT.fadeAmount);
  flushHexFillBatches();
  // Same batched-fill flush as above, but for square-grid mode's accumulated cell fills. Shares
  // the same fade-out alpha wrap; __hexT.fadeAmount is always 0 outside an active hex-mode
  // transition, so this is a no-op alpha-wise for ordinary square-mode play and only matters
  // during the brief pixelate-transition window when switching into/out of Hex Mode.
  flushSquareFillBatches();
  ctx.restore();

  // Hex Mode transition (Ctrl+I): apply a chunky pixelation post-effect over everything just
  // drawn this frame, proportional to how far into the transition we are. This runs last so
  // it obscures the actual board-swap moment (which happens mid-transition, at full pixelation).
  if (__hexT.pixelAmount > 0.001) {
    applyPixelateEffect(__hexT.pixelAmount);
  }
}

/* Arrow hold flags for continuous crosshair motion (used when crosshairMode && spaceDown) */
let leftArrowDown = false, rightArrowDown = false, upArrowDown = false, downArrowDown = false;

/* track previous frame time for smooth per-second movement */
let __lastFrameTime = performance.now();

/* Animation loop */
function frame(t) {
  const dt = Math.max(0, t - __lastFrameTime);
  __lastFrameTime = t;

  // handle life steps
  // Primary stepping behavior:
  // - If FastForward (Ctrl+H) is engaged and the board is currently in a state it
  //   supports (see fastForwardIsSafeToRun()), let it handle stepping this frame --
  //   it internally bulk-steps + cycle-jumps up to fastForwardGenerations generations
  //   within its own time budget, so it fully replaces the per-frame loop below.
  // - Otherwise, if a super-step multiplier is active (Ctrl+R toggled), run that many
  //   discrete generations immediately per animation frame (this avoids fiddling with
  //   the stepInterval time gap).
  // - Otherwise proceed with the usual time-based stepping using stepInterval.
  if (running) {
    if (!reverseTime && fastForwardTick()) {
      // FastForward handled this frame's stepping entirely (possibly thousands of
      // generations at once). Keep lastStep in sync so the time-based branch below
      // doesn't also try to fire once FastForward is toggled back off.
      lastStep = t;
    } else if (superStepMultiplier > 1) {
      // run N discrete steps immediately this frame
      for (let si = 0; si < superStepMultiplier; si++) {
        if (reverseTime) rewindStep();
        else stepLife();
      }
      // record lastStep so we don't also trigger the time-based step this frame
      lastStep = t;
    } else if (t - lastStep > stepInterval) {
      if (reverseTime) {
        rewindStep();
      } else {
        stepLife();
      }
      lastStep = t;
    }
  }

  // Continuous crosshair movement when in crosshair mode and Space is held:
  if (crosshairMode && spaceDown && crosshairPos) {
    let dx = 0, dy = 0;
    if (leftArrowDown) dx -= 1;
    if (rightArrowDown) dx += 1;
    if (upArrowDown) dy -= 1;
    if (downArrowDown) dy += 1;
    if (dx !== 0 || dy !== 0) {
      // normalize diagonal movement so diagonal isn't faster
      const len = Math.hypot(dx, dy) || 1;
      const movePx = (crosshairSpeed * dt) / 1000; // px to move this frame
      crosshairPos.x = Math.min(innerWidth, Math.max(0, crosshairPos.x + (dx / len) * movePx));
      crosshairPos.y = Math.min(innerHeight, Math.max(0, crosshairPos.y + (dy / len) * movePx));
    }
  }

  // Cluster Tracking (Alt+A): recompute the hidden cluster cache on its throttle, and while
  // a cluster is being followed, recenter the camera on its current centroid every frame so
  // the tracked cluster stays fixed at screen-center regardless of how it moves or evolves.
  __clusterTrackMaybeRecompute(t);
  if (clusterTrackFollowing && __clusterTrackFollowedCentroid) {
    offsetX = __clusterTrackFollowedCentroid.x;
    offsetY = __clusterTrackFollowedCentroid.y;
  }

  // handle keyboard drawing/erasing at mouse position or crosshair (continuous while key held)
  // choose operating cursor: crosshair when enabled, otherwise live mouse pointer
  let cursorCSS = null;
  if (crosshairMode && crosshairPos) cursorCSS = { x: crosshairPos.x, y: crosshairPos.y };
  else cursorCSS = mousePos;

  // Portal mode drawing/erasing (Alt+N mode, X/Z held): operates on the grid-line edge nearest
  // the mouse rather than a cell, so it's handled separately from the normal pDown/oDown paint
  // loop below (which always targets a whole cell).
  if (!startupActive && altNMode && (portalDrawDown || portalEraseDown)) {
    const edge = _portalEdgeUnderMouse();
    if (edge) {
      if (portalDrawDown) placePortalPiece(edge.x, edge.y, edge.nx, edge.ny);
      else if (portalEraseDown) erasePortalPiece(edge.x, edge.y, edge.nx, edge.ny);
    }
  }

  // Portal mode straight-line drawing (Alt+N mode, Shift+X held): draws a straight run of
  // portal pieces from wherever Shift+X was first pressed out to the current mouse position,
  // locked to that starting edge's own orientation (a vertical-edge anchor can only extend by
  // varying y, a horizontal-edge anchor only by varying x -- that's structurally what "one
  // straight portal wall" means). The endpoint is read directly from the mouse's continuous
  // world position along that locked axis only, ignoring its position on the other axis
  // entirely, so the line can never waver or hop onto an unintended parallel edge no matter
  // how the mouse wanders off-axis while dragging -- it truly stays straight. Recomputed every
  // frame so the line live-updates as the mouse moves -- pieces that were part of the previous
  // frame's line but aren't part of the current one get erased first, so moving the mouse
  // redraws the line instead of leaving a trail of pieces behind, and pieces that already
  // existed on the board before Shift+X was pressed are left alone (never erased by this
  // preview logic).
  if (!startupActive && altNMode && portalStraightDown && portalStraightAnchor && cursorCSS) {
    const { wx, wy } = screenToWorld(cursorCSS.x, cursorCSS.y);
    const lineEdges = _portalStraightLineEdges(portalStraightAnchor, wx, wy);
    const newKeys = new Set(lineEdges.map(e => portalEdgeKey(e.x, e.y, e.nx, e.ny)));

    // erase pieces from the previous preview that are no longer part of the current line
    for (const oldKey of portalStraightLastKeys) {
      if (!newKeys.has(oldKey)) {
        const p = portalEdges.get(oldKey);
        if (p) {
          const [ax, ay] = parseKey(p.a);
          const [bx, by] = parseKey(p.b);
          erasePortalPiece(ax, ay, bx, by);
        }
      }
    }
    // place every edge in the current line (placePortalPiece is a no-op if already present)
    for (const e of lineEdges) placePortalPiece(e.x, e.y, e.nx, e.ny);
    portalStraightLastKeys = newKeys;
  }

  // prevent any drawing/placement during startup sequence
  if (!startupActive && cursorCSS && (pDown || oDown || invDown || selectionActive)) {
    const {wx, wy} = screenToWorld(cursorCSS.x, cursorCSS.y);

    // update selection cursor while selecting (no click)
    if (selectionActive && selStart && !selectionFrozen && mousePos) {
      selCurrent = { x: mousePos.x, y: mousePos.y };
    }

    // placing template should skip cells that are invincible
    if (templateAttached && templateCells && invDown) {
      // Place the attached template as invincible walls (Shift+X while template attached)
      placeTemplateInvincibleAt(wx, wy);
    } else if (templateAttached && templateCells && pDown) {
      placeTemplateAt(wx, wy);
    } else if (invDown) {
      const k = `${wx},${wy}`;
      // make it invincible: remove any normal alive/birth there and add to invincible set
      alive.delete(k);
      birth.delete(k);
      invincible.add(k);
    } else if (pDown) {
      const key = `${wx},${wy}`;
      if (invincible.has(key)) {
        // don't place normal alive on top of an invincible pixel
      } else if (!alive.has(key)) {
        alive.add(key);
        // immediate user-drawn cells become alive in the current generation
        birth.set(key, { t: performance.now(), p: pausedAccum, gen: generation });
        // record this user placement as a landing event (increment persistent dead-landing count)
        incrementDeadLanding(key);
      }
    } else if (oDown) {
      // erase: remove alive / birth / invincible at mouse
      const key = `${wx},${wy}`;
      if (alive.has(key)) {
        alive.delete(key);
        birth.delete(key);
      }
      if (invincible.has(key)) {
        invincible.delete(key);
      }
    }
  }

  draw(t);

  // Update FPS counters and draw small overlay if enabled
  __fpsFrames++;
  const now = performance.now();
  const elapsed = now - __fpsLast;
  if (elapsed >= 500) { // update twice per second
    __fpsValue = Math.round((__fpsFrames / elapsed) * 1000);
    __fpsFrames = 0;
    __fpsLast = now;
  }

  if (fpsVisible) {
    // draw a tiny rounded rect in top-left (or bottom-left if prefer); choose top-left
    const pad = 6;
    const w = 84;
    const h = 28;
    // choose contrast depending on invertColors
    const bg = 'rgba(0,0,0,0.55)';
    const fg = 'rgba(200,200,200,0.9)';
    ctx.save();
    // draw background box
    ctx.fillStyle = bg;
    ctx.beginPath();
    const bx = 8 + 0.5, by = 8 + 0.5;
    const r = 6;
    ctx.moveTo(bx + r, by);
    ctx.arcTo(bx + w, by, bx + w, by + h, r);
    ctx.arcTo(bx + w, by + h, bx, by + h, r);
    ctx.arcTo(bx, by + h, bx, by, r);
    ctx.arcTo(bx, by, bx + w, by, r);
    ctx.closePath();
    ctx.fill();

    // draw FPS text
    ctx.fillStyle = fg;
    ctx.font = '14px system-ui, -apple-system, "Segoe UI", Roboto, Arial';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${__fpsValue} fps`, bx + 12, by + h / 2);
    ctx.restore();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* Removed pointer dragging (left-click pan) to keep input keyboard-driven for drawing/erasing. */
/* Continuous draw/erase while X/Z are held: handled in the animation loop using mousePos. */

/* Rotation helpers for the attached template:
   rotateTemplateLeft(): 90° CCW => (x,y) -> (-y,x)
   rotateTemplateRight(): 90° CW => (x,y) -> (y,-x)
   After rotating we keep templateAttached true so the preview stays on the mouse. */
function rotateTemplateLeft() {
  if (!templateCells) return;
  templateCells = templateCells.map(c => ({ x: -c.y, y: c.x }));
}
function rotateTemplateRight() {
  if (!templateCells) return;
  templateCells = templateCells.map(c => ({ x: c.y, y: -c.x }));
}

/* RLE modal UI and parsing (now supports .mc file uploads of coordinate lists) */
function openRLEModal() {
  // build modal elements
  if (document.getElementById('rle-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'rle-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(90vw,520px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Import pattern';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '600' });

  const info = document.createElement('div');
  info.textContent = 'Paste Conway RLE text (header and data), or load a .rle or .txt file containing RLE.';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '8px' });

  const ta = document.createElement('textarea');
  ta.style.width = '100%';
  ta.style.boxSizing = 'border-box';
  ta.style.height = '120px';
  ta.placeholder = 'Paste RLE text here (header and data). Example: bo$2bo$3o!';
  ta.value = '';
  ta.autofocus = true;

  // file input for .txt files containing RLE
  const fileRow = document.createElement('div');
  Object.assign(fileRow.style, { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' });

  const fileLabel = document.createElement('label');
  fileLabel.textContent = 'Load .rle or .txt file:';
  Object.assign(fileLabel.style, { fontSize: '13px', color: 'rgba(255,255,255,0.9)' });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.rle,.txt,text/plain';
  Object.assign(fileInput.style, { cursor: 'pointer' });

  // handle file selection / drop
  fileInput.addEventListener('change', (ev) => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || '');
      // try to parse RLE immediately; on success attach template and close modal
      try {
        const cells = parseRLE(txt);
        if (!cells || cells.length === 0) throw new Error('No live cells parsed');
        templateCells = cells;
        templateAttached = true;
        // set textarea value too so user can see/inspect the loaded text
        ta.value = txt;
        if (modal.parentElement) modal.parentElement.removeChild(modal);
      } catch (err) {
        // If parsing fails, still place text into textarea for manual correction
        ta.value = txt;
        alert('Loaded file but failed to parse RLE: ' + err.message + '\nText placed into paste area for editing.');
      }
    };
    reader.onerror = () => {
      alert('Failed to read file');
    };
    reader.readAsText(f);
  });

  // support drag-and-drop onto the modal for convenience
  modal.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  modal.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(rle|txt)$/i.test(f.name) && f.type !== 'text/plain') {
      alert('Please drop a .rle or .txt file containing RLE text.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || '');
      try {
        const cells = parseRLE(txt);
        if (!cells || cells.length === 0) throw new Error('No live cells parsed');
        templateCells = cells;
        templateAttached = true;
        ta.value = txt;
        if (modal.parentElement) modal.parentElement.removeChild(modal);
      } catch (err) {
        ta.value = txt;
        alert('Loaded file but failed to parse RLE: ' + err.message + '\nText placed into paste area for editing.');
      }
    };
    reader.onerror = () => { alert('Failed to read dropped file'); };
    reader.readAsText(f);
  });

  fileRow.appendChild(fileLabel);
  fileRow.appendChild(fileInput);

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end', alignItems: 'center' });

  const pasteBtn = document.createElement('button');
  pasteBtn.textContent = 'Paste from clipboard';
  Object.assign(pasteBtn.style, { padding: '8px 10px', cursor: 'pointer', marginRight: 'auto' });
  pasteBtn.addEventListener('click', async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      alert('Clipboard API not available in this browser.');
      return;
    }
    try {
      const txt = await navigator.clipboard.readText();
      if (!txt) {
        alert('Clipboard is empty.');
        return;
      }
      ta.value = txt;
    } catch (err) {
      alert('Failed to read clipboard: ' + err.message);
    }
  });

  const loadBtn = document.createElement('button');
  loadBtn.textContent = 'Load & Attach (RLE)';
  Object.assign(loadBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  loadBtn.addEventListener('click', () => {
    const text = ta.value;
    try {
      const cells = parseRLE(text);
      if (!cells || cells.length === 0) throw new Error('No live cells parsed');
      templateCells = cells;
      templateAttached = true;
      document.body.removeChild(modal);
    } catch (err) {
      alert('Failed to parse RLE: ' + err.message);
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  cancelBtn.addEventListener('click', () => {
    if (document.getElementById('rle-modal')) document.body.removeChild(modal);
  });

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Detach Template';
  Object.assign(clearBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  clearBtn.addEventListener('click', () => {
    templateCells = null;
    templateAttached = false;
  });

  row.appendChild(pasteBtn);
  row.appendChild(clearBtn);
  row.appendChild(cancelBtn);
  row.appendChild(loadBtn);

  modal.appendChild(title);
  modal.appendChild(info);
  modal.appendChild(ta);
  modal.appendChild(fileRow);
  modal.appendChild(row);
  document.body.appendChild(modal);

  // focus textarea for immediate typing/pasting
  ta.focus();
}

/* Macrocell (.mc) import modal (Ctrl+L): functions the same way as the RLE
   import modal (openRLEModal) above -- paste text, load a file, or drag a
   file onto the modal -- but reads Golly's macrocell quadtree format instead
   of RLE, for loading much larger/more compactly-stored patterns. See
   parseMacrocellFile() for the format implementation. */
function openMacrocellModal() {
  if (document.getElementById('macrocell-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'macrocell-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(90vw,520px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Import macrocell pattern';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '600' });

  const info = document.createElement('div');
  info.textContent = 'Paste macrocell (.mc) text (starts with "[M2]") or load a .mc file. Macrocell is a compact quadtree format for very large patterns; extremely huge patterns may exceed what this simulator can hold as individual cells.';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '8px' });

  const ta = document.createElement('textarea');
  ta.style.width = '100%';
  ta.style.boxSizing = 'border-box';
  ta.style.height = '120px';
  ta.placeholder = 'Paste macrocell text here. Example: [M2] (golly 2.0)\\n#R B3/S23\\n$$..*$...*$.***$$$$';
  ta.value = '';
  ta.autofocus = true;

  // file input for .mc files
  const fileRow = document.createElement('div');
  Object.assign(fileRow.style, { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' });

  const fileLabel = document.createElement('label');
  fileLabel.textContent = 'Load .mc file:';
  Object.assign(fileLabel.style, { fontSize: '13px', color: 'rgba(255,255,255,0.9)' });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.mc,text/plain';
  Object.assign(fileInput.style, { cursor: 'pointer' });

  function tryLoadMacrocellText(txt) {
    const cells = parseMacrocellFile(txt);
    if (!cells || !cells.cells || cells.cells.length === 0) throw new Error('No live cells parsed');
    return cells.cells;
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || '');
      try {
        const cells = tryLoadMacrocellText(txt);
        templateCells = cells;
        templateAttached = true;
        ta.value = txt;
        if (modal.parentElement) modal.parentElement.removeChild(modal);
      } catch (err) {
        ta.value = txt;
        alert('Loaded file but failed to parse macrocell data: ' + err.message + '\nText placed into paste area for editing.');
      }
    };
    reader.onerror = () => { alert('Failed to read file'); };
    reader.readAsText(f);
  });

  modal.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  modal.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.mc$/i.test(f.name) && f.type !== 'text/plain') {
      alert('Please drop a .mc file containing macrocell text.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || '');
      try {
        const cells = tryLoadMacrocellText(txt);
        templateCells = cells;
        templateAttached = true;
        ta.value = txt;
        if (modal.parentElement) modal.parentElement.removeChild(modal);
      } catch (err) {
        ta.value = txt;
        alert('Loaded file but failed to parse macrocell data: ' + err.message + '\nText placed into paste area for editing.');
      }
    };
    reader.onerror = () => { alert('Failed to read dropped file'); };
    reader.readAsText(f);
  });

  fileRow.appendChild(fileLabel);
  fileRow.appendChild(fileInput);

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end', alignItems: 'center' });

  const pasteBtn = document.createElement('button');
  pasteBtn.textContent = 'Paste from clipboard';
  Object.assign(pasteBtn.style, { padding: '8px 10px', cursor: 'pointer', marginRight: 'auto' });
  pasteBtn.addEventListener('click', async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      alert('Clipboard API not available in this browser.');
      return;
    }
    try {
      const txt = await navigator.clipboard.readText();
      if (!txt) { alert('Clipboard is empty.'); return; }
      ta.value = txt;
    } catch (err) {
      alert('Failed to read clipboard: ' + err.message);
    }
  });

  const loadBtn = document.createElement('button');
  loadBtn.textContent = 'Load & Attach (Macrocell)';
  Object.assign(loadBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  loadBtn.addEventListener('click', () => {
    const text = ta.value;
    try {
      const cells = tryLoadMacrocellText(text);
      templateCells = cells;
      templateAttached = true;
      document.body.removeChild(modal);
    } catch (err) {
      alert('Failed to parse macrocell data: ' + err.message);
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  cancelBtn.addEventListener('click', () => {
    if (document.getElementById('macrocell-modal')) document.body.removeChild(modal);
  });

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Detach Template';
  Object.assign(clearBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  clearBtn.addEventListener('click', () => {
    templateCells = null;
    templateAttached = false;
  });

  row.appendChild(pasteBtn);
  row.appendChild(clearBtn);
  row.appendChild(cancelBtn);
  row.appendChild(loadBtn);

  modal.appendChild(title);
  modal.appendChild(info);
  modal.appendChild(ta);
  modal.appendChild(fileRow);
  modal.appendChild(row);
  document.body.appendChild(modal);

  ta.focus();
}

/* Alt+V: import modal for Life 1.06 (.lif) and Plaintext (.cells) patterns. Visually and
   structurally mirrors openRLEModal/openMacrocellModal above (paste text, load a file, or
   drag-and-drop a file onto the modal), but reads EITHER format through one shared "Load &
   Attach" flow -- it auto-detects which of the two the pasted/loaded text actually is (a
   "#Life 1.06" header line vs. a plaintext '.'/'O' grid, optionally with '!' comment lines)
   rather than requiring the player to pick a format up front. This is "reads multiple pattern
   file TYPES", not "reads multiple pattern files at once" -- like the RLE/macrocell modals,
   only one pattern is loaded and attached per use. */
function tryLoadLifOrCellsText(txt) {
  // Life 1.06 is unambiguous: it always starts with a literal "#Life 1.06" header line, which
  // Plaintext never does, so checking for that first cleanly separates the two formats without
  // needing to guess based on absence of the other's markers.
  const firstNonBlankLine = (txt.split(/\r?\n/).find(l => l.trim() !== '') || '').trim();
  if (/^#Life\s+1\.06/i.test(firstNonBlankLine)) {
    return { cells: parseLifeFile(txt), formatLabel: 'Life 1.06 (.lif)' };
  }
  // Otherwise assume Plaintext (.cells) -- its only required marker is the absence of a
  // Life 1.06 header, since '!' comment lines are themselves optional in the format.
  return { cells: parseCellsFile(txt), formatLabel: 'Plaintext (.cells)' };
}

function openLifCellsModal() {
  if (document.getElementById('lifcells-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'lifcells-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(90vw,520px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Import .lif / .cells pattern';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '600' });

  const info = document.createElement('div');
  info.textContent = 'Paste Life 1.06 (.lif) or Plaintext (.cells) text, or load a .lif/.cells file. The format is detected automatically from the text.';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '8px' });

  const ta = document.createElement('textarea');
  ta.style.width = '100%';
  ta.style.boxSizing = 'border-box';
  ta.style.height = '120px';
  ta.placeholder = 'Paste .lif or .cells text here. Example (.lif): #Life 1.06\\n0 0\\n1 0\\n2 0\\nExample (.cells): !glider\\n.O.\\n..O\\nOOO';
  ta.value = '';
  ta.autofocus = true;

  // file input for .lif/.life/.cells files
  const fileRow = document.createElement('div');
  Object.assign(fileRow.style, { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' });

  const fileLabel = document.createElement('label');
  fileLabel.textContent = 'Load .lif or .cells file:';
  Object.assign(fileLabel.style, { fontSize: '13px', color: 'rgba(255,255,255,0.9)' });

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.lif,.life,.cells,text/plain';
  Object.assign(fileInput.style, { cursor: 'pointer' });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || '');
      try {
        const { cells, formatLabel } = tryLoadLifOrCellsText(txt);
        templateCells = cells;
        templateAttached = true;
        ta.value = txt;
        if (modal.parentElement) modal.parentElement.removeChild(modal);
        flashTinyToast(`Loaded ${formatLabel} pattern (${cells.length.toLocaleString()} cells)`);
      } catch (err) {
        ta.value = txt;
        alert('Loaded file but failed to parse .lif/.cells data: ' + err.message + '\nText placed into paste area for editing.');
      }
    };
    reader.onerror = () => { alert('Failed to read file'); };
    reader.readAsText(f);
  });

  modal.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  modal.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(lif|life|cells)$/i.test(f.name) && f.type !== 'text/plain') {
      alert('Please drop a .lif, .life, or .cells file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result || '');
      try {
        const { cells, formatLabel } = tryLoadLifOrCellsText(txt);
        templateCells = cells;
        templateAttached = true;
        ta.value = txt;
        if (modal.parentElement) modal.parentElement.removeChild(modal);
        flashTinyToast(`Loaded ${formatLabel} pattern (${cells.length.toLocaleString()} cells)`);
      } catch (err) {
        ta.value = txt;
        alert('Loaded file but failed to parse .lif/.cells data: ' + err.message + '\nText placed into paste area for editing.');
      }
    };
    reader.onerror = () => { alert('Failed to read dropped file'); };
    reader.readAsText(f);
  });

  fileRow.appendChild(fileLabel);
  fileRow.appendChild(fileInput);

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end', alignItems: 'center' });

  const pasteBtn = document.createElement('button');
  pasteBtn.textContent = 'Paste from clipboard';
  Object.assign(pasteBtn.style, { padding: '8px 10px', cursor: 'pointer', marginRight: 'auto' });
  pasteBtn.addEventListener('click', async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      alert('Clipboard API not available in this browser.');
      return;
    }
    try {
      const txt = await navigator.clipboard.readText();
      if (!txt) { alert('Clipboard is empty.'); return; }
      ta.value = txt;
    } catch (err) {
      alert('Failed to read clipboard: ' + err.message);
    }
  });

  const loadBtn = document.createElement('button');
  loadBtn.textContent = 'Load & Attach';
  Object.assign(loadBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  loadBtn.addEventListener('click', () => {
    const text = ta.value;
    try {
      const { cells, formatLabel } = tryLoadLifOrCellsText(text);
      templateCells = cells;
      templateAttached = true;
      document.body.removeChild(modal);
      flashTinyToast(`Loaded ${formatLabel} pattern (${cells.length.toLocaleString()} cells)`);
    } catch (err) {
      alert('Failed to parse .lif/.cells data: ' + err.message);
    }
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  cancelBtn.addEventListener('click', () => {
    if (document.getElementById('lifcells-modal')) document.body.removeChild(modal);
  });

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Detach Template';
  Object.assign(clearBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  clearBtn.addEventListener('click', () => {
    templateCells = null;
    templateAttached = false;
  });

  row.appendChild(pasteBtn);
  row.appendChild(clearBtn);
  row.appendChild(cancelBtn);
  row.appendChild(loadBtn);

  modal.appendChild(title);
  modal.appendChild(info);
  modal.appendChild(ta);
  modal.appendChild(fileRow);
  modal.appendChild(row);
  document.body.appendChild(modal);

  ta.focus();
}

/* Preset modal: shows a list of presets with a tiny visual preview and a Copy button (no code shown) */
/* `presetList` and `titleText` are optional so the existing plain-Y call site (which wants the
   full classic-Life library) needs no changes. Alt+Y's LTL variant calls this with
   (presetsLTL, 'LTL Presets') instead -- everything else (thumbnails, Copy RLE, Attach,
   Instant Load, category grouping) is shared UI/behavior. */
function openPresetModal(presetList, titleText) {
  const list = presetList || presets;
  const heading = titleText || 'Presets';
  if (document.getElementById('preset-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'preset-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(90vw,560px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  // top-right close button (mirrors bottom-right Close for scrollable modals)
  const topCloseBtn_presets = document.createElement('button');
  topCloseBtn_presets.textContent = 'Close';
  Object.assign(topCloseBtn_presets.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    padding: '6px 10px',
    cursor: 'pointer',
    zIndex: 10001
  });
  topCloseBtn_presets.addEventListener('click', () => {
    const el = document.getElementById('preset-modal');
    if (el) el.remove();
  });
  modal.appendChild(topCloseBtn_presets);

  const title = document.createElement('div');
  title.textContent = heading;
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '600' });
  modal.appendChild(title);

  // Group presets by category and display in a fixed order. Empty categories still show a header.
  const categoryOrder = ['Oscillators', 'Spaceships', 'Guns', 'Still lifes', 'Special'];
  for (const cat of categoryOrder) {
    const header = document.createElement('div');
    header.textContent = cat;
    Object.assign(header.style, { fontWeight: '700', marginTop: '8px', marginBottom: '6px' });
    modal.appendChild(header);

    const group = list.filter(p => p.category === cat);
    // Put presets tagged "Rake" first so rake-patterns (e.g. Time Bomb) appear together in the list
    group.sort((a, b) => {
      const aR = (a.tag && String(a.tag).toLowerCase() === 'rake') ? 0 : 1;
      const bR = (b.tag && String(b.tag).toLowerCase() === 'rake') ? 0 : 1;
      if (aR !== bR) return aR - bR;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    if (group.length === 0) {
      const emptyNote = document.createElement('div');
      emptyNote.textContent = '(none)';
      Object.assign(emptyNote.style, { color: 'rgba(255,255,255,0.45)', marginBottom: '8px', fontSize: '13px' });
      modal.appendChild(emptyNote);
      continue;
    }

    for (const p of group) {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '8px' });

      // create a placeholder canvas immediately for layout; if preset points to an external .txt file, fetch it and replace the preview
      const thumb = document.createElement('canvas');
      thumb.width = 80; thumb.height = 80;
      Object.assign(thumb.style, { width: '80px', height: '80px', flex: '0 0 auto', border: '1px solid rgba(255,255,255,0.06)', background: '#000' });

      // if preset has an external text file, fetch it and render its RLE into a thumbnail; otherwise render from p.rle
      (async () => {
        try {
          if (p.filePath) {
            // show a fixed "question mark" preview for file-based contraptions (e.g. V-Gun) instead of fetching the file
            const questionRLE = `x = 9, y = 16, rule = B3/S23
b7ob$2o5b2o$8bo$8bo$8bo$7bob$6b2ob$4b3o2b$3b2o4b$3bo5b$3bo5b$3bo5b$3bo5b$3bo5b$9b$3bo5b!`;
            const rendered = renderThumbnailFromRLE(questionRLE, 80);
            const ctxDst = thumb.getContext('2d');
            ctxDst.clearRect(0,0,thumb.width,thumb.height);
            ctxDst.drawImage(rendered, 0, 0);
          } else if (p.rle) {
            const rendered = renderThumbnailFromRLE(p.rle, 80);
            const ctxDst = thumb.getContext('2d');
            ctxDst.clearRect(0,0,thumb.width,thumb.height);
            ctxDst.drawImage(rendered, 0, 0);
          }
        } catch (err) {
          // on error, draw a tiny error indicator on the canvas
          const ctx = thumb.getContext('2d');
          ctx.fillStyle = '#111'; ctx.fillRect(0,0,thumb.width,thumb.height);
          ctx.fillStyle = '#f44';
          ctx.font = '10px sans-serif';
          ctx.fillText('err', 6, 14);
        }
      })();

      const meta = document.createElement('div');
      meta.style.flex = '1';
      meta.style.display = 'flex';
      meta.style.flexDirection = 'column';
      meta.style.gap = '4px';
      const titleRow = document.createElement('div');
      titleRow.style.display = 'flex';
      titleRow.style.alignItems = 'center';
      titleRow.style.gap = '8px';
      const name = document.createElement('div');
      name.textContent = p.name;
      name.style.fontWeight = '600';
      titleRow.appendChild(name);
      // If the preset has a tag (e.g. "Printer"), show a small badge next to the name
      if (p.tag) {
        const tagBadge = document.createElement('div');
        tagBadge.textContent = String(p.tag);
        Object.assign(tagBadge.style, {
          background: 'rgba(255,255,255,0.08)',
          color: '#fff',
          fontSize: '11px',
          padding: '4px 6px',
          borderRadius: '6px',
          fontWeight: '700',
          alignSelf: 'center',
        });
        titleRow.appendChild(tagBadge);
      }
      meta.appendChild(titleRow);

      const controls = document.createElement('div');
      controls.style.display = 'flex';
      controls.style.gap = '8px';
      controls.style.alignItems = 'center';

      // Special-case UI for the V-Gun preset: provide Download (download the V-Gun.txt file)
      // and Load (fetch and attach the contraption) buttons that use the repository file.
      if (p.name === 'V-Gun') {
        const dlBtn = document.createElement('button');
        dlBtn.textContent = 'Download';
        Object.assign(dlBtn.style, { padding: '6px 10px', cursor: 'pointer' });
        dlBtn.addEventListener('click', async () => {
          try {
            const resp = await fetch('/V-Gun.txt');
            if (!resp.ok) throw new Error('Failed to fetch V-Gun.txt');
            const txt = await resp.text();
            const blob = new Blob([txt], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'V-Gun.txt';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 3000);
            flashTinyToast('V-Gun.txt downloaded');
          } catch (err) {
            alert('Download failed: ' + err.message);
          }
        });

        const loadBtn = document.createElement('button');
        loadBtn.textContent = 'Load';
        Object.assign(loadBtn.style, { padding: '6px 10px', cursor: 'pointer' });
        loadBtn.addEventListener('click', async () => {
          try {
            const resp = await fetch('/V-Gun.txt');
            if (!resp.ok) throw new Error('Failed to fetch V-Gun.txt');
            const txt = await resp.text();
            const cells = parseRLE(txt);
            if (!cells || cells.length === 0) throw new Error('No cells parsed');
            templateCells = cells;
            templateAttached = true;
            // close the preset modal if present
            const pm = document.getElementById('preset-modal');
            if (pm && pm.parentElement) pm.parentElement.removeChild(pm);
            flashTinyToast('V-Gun loaded as template');
          } catch (err) {
            alert('Load failed: ' + err.message);
          }
        });

        // Instant Load button: load V-Gun.txt and place it immediately at screen center (no attachment)
        const instantBtn = document.createElement('button');
        instantBtn.textContent = 'Instant Load';
        Object.assign(instantBtn.style, { padding: '6px 10px', cursor: 'pointer' });
        instantBtn.addEventListener('click', async () => {
          try {
            const resp = await fetch('/V-Gun.txt');
            if (!resp.ok) throw new Error('Failed to fetch V-Gun.txt');
            const txt = await resp.text();
            const cells = parseRLE(txt);
            if (!cells || cells.length === 0) throw new Error('No cells parsed');

            // compute center world coords
            const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
            const now = performance.now();

            // compute bounding box of parsed cells
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (const c of cells) {
              if (c.x < minx) minx = c.x;
              if (c.x > maxx) maxx = c.x;
              if (c.y < miny) miny = c.y;
              if (c.y > maxy) maxy = c.y;
            }
            const w = maxx - minx + 1;
            const h = maxy - miny + 1;
            const offsetXFromCenter = -Math.floor(w / 2) - minx;
            const offsetYFromCenter = -Math.floor(h / 2) - miny;

            // insert each cell as pendingPlacement so it activates intact next generation
            for (const c of cells) {
              const tx = center.wx + c.x + offsetXFromCenter;
              const ty = center.wy + c.y + offsetYFromCenter;
              const k = `${tx},${ty}`;
              if (invincible.has(k)) continue;
              if (states.has(k)) states.delete(k);
              alive.add(k);
              birth.set(k, { t: now, p: pausedAccum, gen: generation });
              pendingPlacement.add(k);
            }

            if (pendingPlacement.size > 0) {
              activatePendingOnly = true;
              pendingPlacementStart = performance.now();
            }

            const pm = document.getElementById('preset-modal');
            if (pm && pm.parentElement) pm.parentElement.removeChild(pm);

            flashTinyToast('V-Gun instant-loaded at center');
          } catch (err) {
            alert('Instant load failed: ' + err.message);
          }
        });

        controls.appendChild(dlBtn);
        controls.appendChild(loadBtn);
        controls.appendChild(instantBtn);
      } else {
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy RLE';
        copyBtn.className = 'preset-copy-button';
        Object.assign(copyBtn.style, { padding: '6px 10px', cursor: 'pointer' });
        copyBtn.addEventListener('click', async () => {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(p.rle);
            } else {
              const ta = document.createElement('textarea');
              ta.value = p.rle;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              ta.remove();
            }
            flashTinyToast('Copied: ' + p.name);
          } catch (err) {
            alert('Copy failed: ' + err);
          }
        });

        const attachBtn = document.createElement('button');
        attachBtn.textContent = 'Attach';
        Object.assign(attachBtn.style, { padding: '6px 10px', cursor: 'pointer' });
        attachBtn.addEventListener('click', () => {
          try {
            const cells = parseRLE(p.rle);
            if (!cells || cells.length === 0) throw new Error('No cells parsed');
            // LTL presets carry their own rule (radius, S/B range, M flag) in their RLE header --
            // apply it so the pattern actually runs under the rule it was designed for, rather
            // than silently inheriting whatever rule (possibly a different radius or M setting)
            // happened to be active already. Classic (non-LTL) presets are untouched here since
            // they're all meant to run under the board's normal B/S rule.
            if (list === presetsLTL) applyPresetRuleForLTL(extractRLEHeaderRule(p.rle));
            templateCells = cells;
            templateAttached = true;
            document.body.removeChild(modal);
          } catch (err) {
            alert('Failed to parse RLE: ' + err.message);
          }
        });

        controls.appendChild(copyBtn);
        controls.appendChild(attachBtn);

        // Instant Load: place contraption immediately at screen center (does not attach template)
        const instantBtn = document.createElement('button');
        instantBtn.textContent = 'Instant Load';
        Object.assign(instantBtn.style, { padding: '6px 10px', cursor: 'pointer' });
        instantBtn.addEventListener('click', () => {
          (async () => {
            try {
              // parse RLE (use preset.rle)
              const cells = parseRLE(p.rle);
              if (!cells || cells.length === 0) throw new Error('No cells parsed');
              // Same reasoning as the Attach button above: LTL presets need their own RLE-header
              // rule applied, or they'll run under whatever rule (possibly a different radius or
              // M setting) was already active and desync from the pattern they were designed for.
              if (list === presetsLTL) applyPresetRuleForLTL(extractRLEHeaderRule(p.rle));
              // compute center world coords
              const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
              const now = performance.now();

              // Place parsed cells centered: convert their relative coords so their center aligns with world center
              // First compute bounding box of parsed cells to center them visually
              let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
              for (const c of cells) {
                if (c.x < minx) minx = c.x;
                if (c.x > maxx) maxx = c.x;
                if (c.y < miny) miny = c.y;
                if (c.y > maxy) maxy = c.y;
              }
              const w = maxx - minx + 1;
              const h = maxy - miny + 1;
              // anchor such that pattern is centered on the chosen world cell
              const offsetXFromCenter = -Math.floor(w / 2) - minx;
              const offsetYFromCenter = -Math.floor(h / 2) - miny;

              // insert each cell as pendingPlacement so it activates intact next generation
              for (const c of cells) {
                const tx = center.wx + c.x + offsetXFromCenter;
                const ty = center.wy + c.y + offsetYFromCenter;
                const k = `${tx},${ty}`;
                // respect invincible walls
                if (invincible.has(k)) continue;
                // remove any fading state there
                if (states.has(k)) states.delete(k);
                // mark as pending/alive and give birth record
                alive.add(k);
                birth.set(k, { t: now, p: pausedAccum, gen: generation });
                pendingPlacement.add(k);
              }

              // ensure batch activation protection
              if (pendingPlacement.size > 0) {
                activatePendingOnly = true;
                pendingPlacementStart = performance.now();
              }

              // close the preset modal if present
              const pm = document.getElementById('preset-modal');
              if (pm && pm.parentElement) pm.parentElement.removeChild(pm);

              flashTinyToast(list === presetsLTL
                ? `${p.name} instant-loaded at center (rule: ${extractRLEHeaderRule(p.rle) || 'unchanged'})`
                : `${p.name} instant-loaded at center`);
            } catch (err) {
              alert('Instant load failed: ' + err.message);
            }
          })();
        });

        controls.appendChild(instantBtn);
      }

      row.appendChild(thumb);
      row.appendChild(meta);
      row.appendChild(controls);
      modal.appendChild(row);
    }
  }

  const closeRow = document.createElement('div');
  closeRow.style.display = 'flex';
  closeRow.style.justifyContent = 'flex-end';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    const el = document.getElementById('preset-modal');
    if (el) el.remove();
  });
  closeRow.appendChild(closeBtn);
  modal.appendChild(closeRow);

  document.body.appendChild(modal);
}

/* Alt+Y: same modal UI as plain Y's openPresetModal(), just pointed at presetsLTL instead of
   the classic-Life `presets` library. Kept as a thin wrapper rather than inlining the modal
   again so LTL presets automatically pick up any future UI changes to openPresetModal(). */
function openLTLPresetModal() {
  openPresetModal(presetsLTL, 'LTL Presets');
}

/* Tiny floating toast to show copy/attach feedback. duration in ms (optional, default 1500)
   New behavior: toasts stack from the bottom-left upward (newest at the bottom). When the stack
   reaches the top of the viewport, oldest toasts are removed to keep the stack inside the screen. */
function flashTinyToast(msg, duration = 1500) {
  // Ensure a single container exists for bottom-left stacking
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    Object.assign(container.style, {
      position: 'fixed',
      left: '12px',
      bottom: '12px',
      display: 'flex',
      flexDirection: 'column-reverse', // newest at the bottom
      alignItems: 'flex-start',
      gap: '8px',
      zIndex: 10000,
      pointerEvents: 'none',
      fontFamily: 'Times New Roman, Times, serif',
      maxWidth: 'min(86vw,360px)',
      boxSizing: 'border-box'
    });
    document.body.appendChild(container);
  }

  // Before adding the new toast, remove the "most-recent" outline from any existing toasts
  // so only the newest toast has the soft white outline.
  for (const child of Array.from(container.children)) {
    child.style.boxShadow = '';
    child.style.outline = '';
  }

  const toast = document.createElement('div');
  // Toast colors invert along with Shift+A's board-wide invert -- on an inverted (white)
  // board the old fixed white-on-near-white-translucent styling was nearly unreadable, so both
  // the background tint and text/outline/glow colors flip to dark-on-light here, matching the
  // same "black on white" swap the board itself gets.
  Object.assign(toast.style, {
    background: invertColors ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)',
    color: invertColors ? '#000' : '#fff',
    padding: '8px 12px',
    borderRadius: '6px',
    fontSize: '13px',
    pointerEvents: 'auto', // allow possible future interactions
    opacity: '1',
    transition: 'transform 260ms ease, opacity 300ms ease, box-shadow 200ms ease'
  });
  toast.textContent = msg;

  // Give the newly created toast a soft outline to mark it as the most recent (inverted to dark
  // on an inverted board, same reasoning as above).
  toast.style.boxShadow = invertColors ? '0 0 10px 2px rgba(0,0,0,0.9)' : '0 0 10px 2px rgba(255,255,255,0.9)';
  // Also set a subtle outline to improve contrast on different backgrounds.
  toast.style.outline = invertColors ? '1px solid rgba(0,0,0,0.12)' : '1px solid rgba(255,255,255,0.12)';

  // Insert at end of container (visual bottom because of column-reverse)
  container.appendChild(toast);

  // Slight entrance transform so older toasts appear pushed up smoothly
  toast.style.transform = 'translateY(8px)';
  requestAnimationFrame(() => {
    toast.style.transform = 'translateY(0)';
  });

  // Remove oldest toasts if the stack would extend past the top of viewport.
  // We check after a tiny delay to allow layout to settle.
  setTimeout(() => {
    // Keep removing the oldest (which are at the end of children when viewed top->bottom),
    // but because we use column-reverse the visually oldest is the lastElementChild.
    // We'll remove while any toast's bounding rect top is above 0 (i.e., reaches top of viewport)
    // or while total container height exceeds window.innerHeight - 16px.
    function pruneIfOverflow() {
      const children = Array.from(container.children);
      if (children.length === 0) return;
      const firstChild = children[0]; // visually topmost child (since column-reverse, index 0 is top)
      const rect = firstChild.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      // If the top-most toast reaches above the viewport top (rect.top < 2) OR container height > viewport-24
      if (rect.top < 2 || containerRect.height > (window.innerHeight - 24)) {
        // remove the oldest toast (which is the topmost visually => children[0])
        const removeEl = children[children.length - 1]; // actual oldest by insertion (to keep conveyor feel)
        if (removeEl) {
          // fade out then remove
          removeEl.style.opacity = '0';
          removeEl.style.transform = 'translateY(-8px)';
          setTimeout(() => {
            if (removeEl.parentElement) removeEl.parentElement.removeChild(removeEl);
          }, 300);
        }
        // Recurse to ensure full pruning if still overflowing
        setTimeout(pruneIfOverflow, 50);
      }
    }
    pruneIfOverflow();
  }, 40);

  // Schedule fade and removal for this toast
  const fadeDelay = Math.max(600, duration - 300);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px)';
  }, fadeDelay);

  setTimeout(() => {
    if (toast.parentElement) toast.parentElement.removeChild(toast);
    // If container becomes empty, remove it to keep DOM clean
    if (container.children.length === 0 && container.parentElement) container.parentElement.removeChild(container);
  }, duration);
}

/* Elongated banner toast that slides down from the top edge of the screen, for messages that
   deserve more visual weight than the small bottom-left flashTinyToast stack -- currently used
   only for the one-time "Need help? Alt+D" nudge shown right after the introduction ends. */
function flashTopBannerToast(msg, duration = 4200) {
  const banner = document.createElement('div');
  Object.assign(banner.style, {
    position: 'fixed',
    left: '50%',
    top: '0',
    transform: 'translate(-50%, -100%)',
    minWidth: 'min(90vw, 420px)',
    maxWidth: '90vw',
    boxSizing: 'border-box',
    padding: '12px 28px',
    background: 'rgba(15,15,20,0.94)',
    border: '1px solid rgba(255,255,255,0.25)',
    borderBottomLeftRadius: '10px',
    borderBottomRightRadius: '10px',
    color: '#fff',
    fontFamily: 'Times New Roman, Times, serif',
    fontSize: '15px',
    textAlign: 'center',
    zIndex: 22000,
    boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
    transition: 'transform 450ms ease, opacity 450ms ease',
    opacity: '1',
    pointerEvents: 'none'
  });
  banner.textContent = msg;
  document.body.appendChild(banner);

  requestAnimationFrame(() => {
    banner.style.transform = 'translate(-50%, 0)';
  });

  setTimeout(() => {
    banner.style.transform = 'translate(-50%, -100%)';
    banner.style.opacity = '0';
    setTimeout(() => { if (banner.parentElement) banner.remove(); }, 500);
  }, duration);
}

/* Basic RLE parser supporting header/comments and standard symbols (b, o, $, !) */
/* Extended RLE parser supporting multi-state tokens (., b, A..X, a..x, and two-letter prefixed tokens) */
/* Extracts just the "rule = ..." portion of an RLE header line (e.g. from
   "x = 113, y = 113, rule = R7,C0,S64-113,B65-95" this returns "R7,C0,S64-113,B65-95"), without
   touching parseRLE()'s cell-parsing logic or its return shape -- parseRLE() itself captures
   the header line but has never actually read the rule back out of it (every call site only
   ever wanted the cell array), which is exactly why loading an LTL preset like Soldier Bugs
   placed its cells but silently kept whatever rule (radius/S/B/M) was already active instead of
   switching to the preset's own R7,C0,S64-113,B65-95 -- a very different, larger-radius rule
   than whatever was active before. Returns null if no rule clause is found. */
function extractRLEHeaderRule(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^x\s*=/i.test(line)) {
      const m = line.match(/rule\s*=\s*(.+)$/i);
      return m ? m[1].trim() : null;
    }
  }
  return null;
}

/* Applies an RLE-header rule string to the board, correctly routed to either the classic B/S
   rule or LTL mode depending on which notation it's in and whether the two are in sync. Used
   when loading a preset from presetsLTL (Alt+Y) so the preset's own rule -- radius and S/B
   range -- actually takes effect instead of leaving whatever rule was already active, which for
   radius-sensitive LTL rules produces visibly wrong dynamics (e.g. a pattern built for radius 7
   running under a leftover radius 5 rule desyncs almost immediately). */
function applyPresetRuleForLTL(ruleStr) {
  if (!ruleStr) return;
  const parsed = parseLTLRuleString(ruleStr);
  if (!parsed) return; // not a recognizable LTL rule string -- leave the active rule untouched
  if (!ltlMode) {
    // Preset is LTL-flavored but LTL mode isn't on -- turn it on first so the rule has somewhere
    // meaningful to apply (mirrors what Alt+H itself does: stash the current B/S rule so it can
    // still be restored later, then switch into LTL mode).
    __ltlPrevBirthRules = birthRules;
    __ltlPrevSurvivalRules = survivalRules;
    __ltlPrevCellStatesCount = cellStatesCount;
    reverseTime = false;
    cellStatesCount = 2;
    ltlMode = true;
  }
  ltlRadius = parsed.radius;
  ltlSurvivalMin = parsed.survivalMin;
  ltlSurvivalMax = parsed.survivalMax;
  ltlBirthMin = parsed.birthMin;
  ltlBirthMax = parsed.birthMax;
  ltlNeighborhood = parsed.neighborhood;
  ltlIncludeCenter = parsed.includeCenter;
}

function parseRLE(text) {
  if (!text) throw new Error('Empty');
  // Split lines and keep header (to allow rule detection) and body lines
  const lines = text.split(/\r?\n/);
  let header = '';
  let data = '';
  for (let raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) continue;           // comment
    if (/^x\s*=/.test(line.toLowerCase())) {
      header = line;
      continue;
    }
    data += line;
  }
  // normalize body whitespace
  data = data.replace(/\s+/g, '');
  // find terminator
  const bangIndex = data.indexOf('!');
  if (bangIndex === -1) throw new Error('Missing "!" terminator');
  const body = data.slice(0, bangIndex);

  // Helper to decode a token into a numeric state:
  // '.' or 'b' -> 0
  // 'o' or 'O' -> 1  (standard RLE alive)
  // 'A'..'X' -> 2..25
  // 'a'..'x' -> 26..49
  // two-letter like 'pA' -> >=50 (prefix-based scheme)
  function decodeToken(tok) {
    if (!tok) return 0;
    // dead tokens -- lowercase 'b' only (case-sensitive): 'B' is reserved for state 3 in this
    // game's own A-X generational-state letter scheme (see the mapping below), so treating it
    // as dead here would silently destroy every state-3 cell on import.
    if (tok === '.' || tok === 'b') return 0;
    // standard alive token 'o' / 'O'
    if (tok === 'o' || tok === 'O') return 1;
    const ch = tok[0];
    // single uppercase A..X map to states 2..25
    if (/^[A-X]$/.test(ch)) return 2 + (ch.charCodeAt(0) - 65); // A -> 2
    // single lowercase a..x map to 26..49
    if (/^[a-x]$/.test(ch)) return 26 + (ch.charCodeAt(0) - 97); // a -> 26
    // two-letter: prefix char + letter, map into >=50
    if (tok.length === 2) {
      const p = tok.charCodeAt(0);
      const second = tok[1];
      let idx2 = -1;
      if (/^[A-X]$/.test(second)) idx2 = second.charCodeAt(0) - 65; // 0..23
      else if (/^[a-x]$/.test(second)) idx2 = 24 + (second.charCodeAt(0) - 97); // 24..47
      else return 0;
      // map prefix to a small index starting from 0 for 'p'
      // allow prefixes 'p'..'z' (112..122); compute prefixIndex = p-112
      const prefixIndex = (p >= 112 && p <= 122) ? (p - 112) : 0;
      return 50 + prefixIndex * 48 + idx2; // start at 50 to match encode offset
    }
    // fallback: treat as dead
    return 0;
  }

  // tokenize: we must allow tokens that are either single-char (.,b,A..X,a..x) or two-char (prefix+letter)
  // iterate through body consuming optional repeat numbers and then tokens
  const outCells = [];
  let x = 0, y = 0;
  let i = 0;
  while (i < body.length) {
    // read repeat count if present
    let numStr = '';
    while (i < body.length && /[0-9]/.test(body[i])) {
      numStr += body[i++];
    }
    const count = numStr === '' ? 1 : parseInt(numStr, 10);

    if (i >= body.length) break;
    const ch = body[i];

    // Handle $ (newlines)
    if (ch === '$') {
      i++;
      y += count;
      x = 0;
      continue;
    }
    // If the char is a dot, b, uppercase A-X or lowercase a-x, it's a single token
    // But if it's a prefix candidate (p..z) and followed by a valid letter, consume two chars.
    let tok = '';
    if (ch === '.' || ch.toLowerCase() === 'b' || /^[A-Xa-x]$/.test(ch)) {
      tok = ch;
      i++;
    } else {
      // attempt two-character token
      if (i + 1 < body.length) {
        const ch2 = body[i + 1];
        if (/^[p-z]$/.test(ch) && /^[A-Xa-x]$/.test(ch2)) {
          tok = ch + ch2;
          i += 2;
        } else {
          // invalid token, throw
          throw new Error('Unexpected token "' + ch + '" in RLE');
        }
      } else {
        throw new Error('Unexpected end of RLE after "' + ch + '"');
      }
    }

    const state = decodeToken(tok);

    // emit count cells at current x for this state
    for (let k = 0; k < count; k++) {
      // only record non-dead cells (state !== 0)
      if (state !== 0) outCells.push({ x: x + k, y, s: state });
    }
    x += count;
  }

  if (outCells.length === 0) return [];

  // Some RLE inputs (or mis-tokenized files) can produce only multi-state values (>1),
  // which causes whole templates to appear as "faded" instead of normal alive cells.
  // If the parser finds no explicit alive-token (state==1) but there are parsed cells,
  // assume the intent was standard alive cells and normalize parsed states => 1.
  const hasExplicitAlive = outCells.some(c => c.s === 1);
  if (!hasExplicitAlive) {
    // convert any parsed non-zero state into alive (1) to avoid accidental full-fade templates
    for (const c of outCells) {
      if (c.s !== 0) c.s = 1;
    }
  }

  // Normalize cells so center is around (0,0) (keep state per cell)
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const c of outCells) {
    if (c.x < minx) minx = c.x;
    if (c.x > maxx) maxx = c.x;
    if (c.y < miny) miny = c.y;
    if (c.y > maxy) maxy = c.y;
  }
  const w = maxx - minx + 1;
  const h = maxy - miny + 1;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const rel = outCells.map(c => ({ x: c.x - minx - cx, y: c.y - miny - cy, s: c.s }));
  return rel;
}

/* ============================================================================
   MACROCELL (.mc) PARSER
   ----------------------------------------------------------------------------
   Implements Golly's "macrocell" format exactly as documented at
   https://golly.sourceforge.io/Help/formats.html -- this is the file format
   HashLife-based tools use to compactly store enormous, highly-repetitive
   patterns as a canonicalized quadtree, rather than a flat cell list.

   Format summary (see Golly's docs for the authoritative spec):
     - First line: "[M2] (program name)"
     - Header comments: lines starting with '#'. "#R ..." gives the rule,
       "#G ..." gives the generation count, any other "#..." is a plain
       comment.
     - Tree body: a child-first list of nodes, one per line, numbered in
       file order starting at 1. Node number 0 is reserved and means
       "an entirely empty square of whatever size is needed" -- it's never
       given an explicit line.
     - A line starting with '.', '*', or '$' is a two-state LEAF node: an
       8x8 pixel raster, rows separated by '$', '.' = dead, '*' = alive,
       with trailing dead cells on each row suppressed.
     - A line of exactly five integers "1 nw ne sw se" is a multi-state LEAF
       node (a 2x2 square) -- here nw/ne/sw/se are STATE VALUES directly,
       not node references.
     - A line of five integers "k nw ne sw se" (k >= 2, or k >= 4 for
       two-state patterns) is a non-leaf NODE: k is log2 of this node's
       square size, and nw/ne/sw/se are 1-based line numbers of
       already-defined child nodes (or 0 for an empty child), each
       exactly one quarter the size of this node.
     - The root is the last (and largest) node in the file.
     - Coordinate convention: the upper-left cell of the ROOT's southeast
       child sits at absolute (x=0, y=1).

   Since this simulator stores cells individually in a flat Set (it is not
   a true HashLife engine), a macrocell file that legitimately represents
   an astronomical universe cannot be fully materialized here. A generous
   but bounded cell cap is enforced during expansion so an attempt to load
   such a file fails fast with a clear message instead of hanging the tab
   or exhausting memory.
   ============================================================================ */

class MacrocellParseError extends Error {}

function parseMacrocellFile(text, opts) {
  opts = opts || {};
  const maxCells = opts.maxCells || 3_000_000; // generous for this app's flat cell-set model, bounded for safety

  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].startsWith('[M2]')) {
    throw new MacrocellParseError('Not a macrocell file (missing "[M2]" header line on the first line)');
  }

  let rule = null;
  let savedGen = 0;
  let bodyStartIdx = 1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) { bodyStartIdx = i + 1; continue; }
    if (line[0] === '#') {
      if (line.slice(0, 2) === '#R') rule = line.slice(2).trim();
      else if (line.slice(0, 2) === '#G') {
        const g = parseInt(line.slice(2).trim(), 10);
        if (Number.isFinite(g)) savedGen = g;
      }
      bodyStartIdx = i + 1;
      continue;
    }
    bodyStartIdx = i;
    break;
  }

  // nodes[1..n]: {leaf:true, twoState:true, cells:[[dx,dy,s],...]} for an 8x8
  // raster leaf; {leaf:true, twoState:false, nw,ne,sw,se} (state values) for
  // a 2x2 multi-state leaf; {k, nw, ne, sw, se} (node references) for a
  // non-leaf. Node 0 is implicit ("empty") and never stored here.
  const nodes = [null];

  function parseTwoStateLeaf(line) {
    const rows = line.split('$');
    const cells = [];
    for (let ry = 0; ry < rows.length && ry < 8; ry++) {
      const row = rows[ry];
      for (let rx = 0; rx < row.length && rx < 8; rx++) {
        if (row[rx] === '*') cells.push([rx, ry, 1]);
      }
    }
    return { leaf: true, twoState: true, cells };
  }

  for (let i = bodyStartIdx; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length === 0) continue;
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line[0] === '#') continue; // tolerate a stray mid-tree comment

    const first = line[0];
    if (first === '.' || first === '*' || first === '$') {
      nodes.push(parseTwoStateLeaf(line));
      continue;
    }

    const parts = line.split(/\s+/).map(Number);
    if (parts.length !== 5 || parts.some(p => !Number.isFinite(p))) {
      throw new MacrocellParseError(`Malformed node line ${i + 1}: "${line}"`);
    }
    const [k, nw, ne, sw, se] = parts;
    if (k === 1) {
      nodes.push({ leaf: true, twoState: false, nw, ne, sw, se });
    } else {
      nodes.push({ k, nw, ne, sw, se });
    }
  }

  if (nodes.length <= 1) throw new MacrocellParseError('No nodes found in macrocell file');
  const rootIdx = nodes.length - 1;
  const root = nodes[rootIdx];
  if (!root) throw new MacrocellParseError(`Reference to undefined node ${rootIdx}`);
  const rootK = root.leaf ? (root.twoState ? 3 : 1) : root.k;
  const rootSize = Math.pow(2, rootK);

  let cellCount = 0;
  const outCells = [];

  function expand(nodeIdx, k, ox, oy) {
    if (cellCount > maxCells) return;
    if (nodeIdx === 0) return;
    const node = nodes[nodeIdx];
    if (!node) throw new MacrocellParseError(`Reference to undefined node ${nodeIdx}`);

    if (node.leaf) {
      if (node.twoState) {
        for (const [dx, dy, s] of node.cells) {
          if (cellCount > maxCells) return;
          outCells.push({ x: ox + dx, y: oy + dy, s });
          cellCount++;
        }
      } else {
        const quad = [[node.nw, 0, 0], [node.ne, 1, 0], [node.sw, 0, 1], [node.se, 1, 1]];
        for (const [s, dx, dy] of quad) {
          if (s === 0) continue;
          if (cellCount > maxCells) return;
          outCells.push({ x: ox + dx, y: oy + dy, s });
          cellCount++;
        }
      }
      return;
    }

    const half = Math.pow(2, k - 1);
    expand(node.nw, k - 1, ox, oy);
    expand(node.ne, k - 1, ox + half, oy);
    expand(node.sw, k - 1, ox, oy + half);
    expand(node.se, k - 1, ox + half, oy + half);
  }

  expand(rootIdx, rootK, 0, 0);

  if (cellCount > maxCells) {
    throw new MacrocellParseError(`Pattern is too large to load (over ${maxCells.toLocaleString()} cells). This simulator stores cells individually and can't hold macrocell patterns at this scale.`);
  }
  if (outCells.length === 0) return { cells: [], rule, generation: savedGen };

  // Apply the documented coordinate convention (SE child of root at (0,1)),
  // then center the result around (0,0) the same way parseRLE() does, so it
  // can be attached and placed as a template identically to an RLE import.
  const half = rootSize / 2;
  const shiftX = 0 - half;
  const shiftY = 1 - half;
  for (const c of outCells) { c.x += shiftX; c.y += shiftY; }

  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const c of outCells) {
    if (c.x < minx) minx = c.x;
    if (c.x > maxx) maxx = c.x;
    if (c.y < miny) miny = c.y;
    if (c.y > maxy) maxy = c.y;
  }
  const w = maxx - minx + 1;
  const h = maxy - miny + 1;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const cells = outCells.map(c => ({ x: c.x - minx - cx, y: c.y - miny - cy, s: c.s }));

  const hasExplicitAlive = cells.some(c => c.s === 1);
  if (!hasExplicitAlive) {
    for (const c of cells) if (c.s !== 0) c.s = 1;
  }

  return { cells, rule, generation: savedGen, cellCount };
}


/* ============================================================================
   MACROCELL (.mc) ENCODER
   ----------------------------------------------------------------------------
   Inverse of parseMacrocellFile above: takes the current board's flat cell
   data and writes it out as a Golly-compatible macrocell quadtree. Builds the
   tree bottom-up over a bounding square sized to a power of two that covers
   every live cell, using 8x8 two-state leaves (Golly's own convention, and
   the most compact form) when the board is pure 2-state, or 2x2 multi-state
   leaves (state values directly, per the format spec) when any cell carries
   a fade/generational state beyond plain alive. Empty subtrees are collapsed
   to node 0 (the format's built-in "entirely empty" reference) rather than
   being written out, keeping the file reasonably small for sparse patterns.
   ============================================================================ */
function encodeMacrocellFile(cellsList, ruleStr, generationCount) {
  if (cellsList.length === 0) {
    // A single empty node is still a valid (if trivial) macrocell file.
    return `[M2] (websim gol export)\n#R ${ruleStr}\n#G ${generationCount || 0}\n1 0 0 0 0\n`;
  }

  const twoStateOnly = cellsList.every(c => c.s === 1);

  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const c of cellsList) {
    if (c.x < minx) minx = c.x;
    if (c.x > maxx) maxx = c.x;
    if (c.y < miny) miny = c.y;
    if (c.y > maxy) maxy = c.y;
  }

  // Smallest leaf size this encoding uses: 8 for two-state (8x8 raster leaves),
  // 2 for multi-state (2x2 state-value leaves) -- matches parseMacrocellFile's
  // own k===1 <-> 2x2-multistate / k===3 <-> 8x8-two-state convention.
  const leafSize = twoStateOnly ? 8 : 2;
  const width = maxx - minx + 1;
  const height = maxy - miny + 1;

  // Smallest power-of-two square (at least leafSize) that covers the whole
  // bounding box, so the quadtree subdivides evenly all the way down.
  let size = leafSize;
  while (size < Math.max(width, height)) size *= 2;
  let k = Math.log2(size);

  // Shift every cell so the covering square's own local origin is (0,0),
  // independent of the board's actual (possibly negative) coordinates.
  const ox = minx, oy = miny;

  // Bucket cells by which leaf-sized cell they fall into, keyed by that
  // leaf's own local top-left corner -- avoids allocating a dense grid for
  // what's normally a sparse board.
  const leafBuckets = new Map(); // "lx,ly" -> array of {dx,dy,s} local-to-leaf
  for (const c of cellsList) {
    const lx0 = Math.floor((c.x - ox) / leafSize) * leafSize;
    const ly0 = Math.floor((c.y - oy) / leafSize) * leafSize;
    const key = `${lx0},${ly0}`;
    let bucket = leafBuckets.get(key);
    if (!bucket) { bucket = []; leafBuckets.set(key, bucket); }
    bucket.push({ dx: (c.x - ox) - lx0, dy: (c.y - oy) - ly0, s: c.s });
  }

  const nodeLines = []; // nodeLines[i] is the 1-based line for node (i+1)
  const memo = new Map(); // dedupe identical subtrees, same spirit as Golly's canonical form

  function leafNodeIndex(lx0, ly0) {
    const bucket = leafBuckets.get(`${lx0},${ly0}`);
    if (!bucket || bucket.length === 0) return 0; // empty leaf -> implicit node 0

    let lineText;
    if (twoStateOnly) {
      // 8x8 two-state raster: '.'/'*' per cell, '$' between rows, trailing
      // dead cells on each row dropped (matches Golly's own writer).
      const grid = Array.from({ length: 8 }, () => Array(8).fill('.'));
      for (const { dx, dy, s } of bucket) {
        if (dx >= 0 && dx < 8 && dy >= 0 && dy < 8 && s !== 0) grid[dy][dx] = '*';
      }
      const rows = grid.map(row => {
        let last = -1;
        for (let i = row.length - 1; i >= 0; i--) { if (row[i] === '*') { last = i; break; } }
        return row.slice(0, last + 1).join('');
      });
      // Trailing entirely-empty rows are also droppable, but keeping them is
      // still spec-valid and simpler/safer to get right, so they're left in.
      lineText = rows.join('$');
      if (lineText.length === 0) return 0; // fully empty after all -> node 0
    } else {
      // 2x2 multi-state leaf: "1 nw ne sw se" where each value IS the state
      // (0 = dead), not a node reference -- per the format's k===1 case.
      const at = (dx, dy) => {
        const found = bucket.find(b => b.dx === dx && b.dy === dy);
        return found ? found.s : 0;
      };
      const nw = at(0, 0), ne = at(1, 0), sw = at(0, 1), se = at(1, 1);
      if (nw === 0 && ne === 0 && sw === 0 && se === 0) return 0;
      lineText = `1 ${nw} ${ne} ${sw} ${se}`;
    }

    const memoKey = 'leaf:' + lineText;
    const existing = memo.get(memoKey);
    if (existing !== undefined) return existing;
    nodeLines.push(lineText);
    const idx = nodeLines.length; // 1-based
    memo.set(memoKey, idx);
    return idx;
  }

  // Recursively builds/dedupes the node covering a size-(2^curK) square whose
  // local top-left corner is (lx, ly), returning its 1-based node index (or
  // 0 for an entirely empty subtree).
  function buildNode(curK, lx, ly) {
    const curSize = Math.pow(2, curK);
    if (curSize === leafSize) return leafNodeIndex(lx, ly);

    const half = curSize / 2;
    const nw = buildNode(curK - 1, lx, ly);
    const ne = buildNode(curK - 1, lx + half, ly);
    const sw = buildNode(curK - 1, lx, ly + half);
    const se = buildNode(curK - 1, lx + half, ly + half);
    if (nw === 0 && ne === 0 && sw === 0 && se === 0) return 0;

    const lineText = `${curK} ${nw} ${ne} ${sw} ${se}`;
    const memoKey = 'node:' + lineText;
    const existing = memo.get(memoKey);
    if (existing !== undefined) return existing;
    nodeLines.push(lineText);
    const idx = nodeLines.length;
    memo.set(memoKey, idx);
    return idx;
  }

  const rootIdx = buildNode(k, 0, 0);
  // The format requires an explicit root line even for a would-be-empty result,
  // and non-trivial `cellsList` here always yields at least one line, so this
  // is just a defensive fallback for a degenerate all-empty-after-bucketing case.
  if (rootIdx === 0) {
    nodeLines.push(`${k} 0 0 0 0`);
  }

  const header = `[M2] (websim gol export)\n#R ${ruleStr}\n#G ${generationCount || 0}\n`;
  return header + nodeLines.join('\n') + '\n';
}

/* Parses Life 1.06 (.lif / .life) format: a "#Life 1.06" header line followed by one line
   per live cell, each just "x y" (whitespace-separated integers, may be negative). Unlike
   RLE/macrocell, this format has no run-length encoding, no rule string, and no state beyond
   "alive" -- every listed cell becomes state 1, matching the standard RLE 'o' token above.
   Blank lines and anything after a live-cell line that doesn't parse as "x y" are ignored
   rather than treated as a hard error, since some tools emit trailing blank lines. */
function parseLifeFile(text) {
  if (!text) throw new Error('Empty');
  const lines = text.split(/\r?\n/);
  // Header must be the first non-blank line (not necessarily lines[0] literally) -- keeps this
  // in sync with tryLoadLifOrCellsText's own detection, which skips leading blank lines the
  // same way, so a file that passes detection never then fails re-parsing here.
  let headerIdx = 0;
  while (headerIdx < lines.length && lines[headerIdx].trim() === '') headerIdx++;
  if (headerIdx >= lines.length || !/^#Life\s+1\.06/i.test(lines[headerIdx].trim())) {
    throw new Error('Not a Life 1.06 file (missing "#Life 1.06" header line)');
  }

  const outCells = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^(-?\d+)\s+(-?\d+)$/);
    if (!m) continue; // skip anything that isn't a clean "x y" pair rather than hard-failing
    outCells.push({ x: parseInt(m[1], 10), y: parseInt(m[2], 10), s: 1 });
  }

  if (outCells.length === 0) throw new Error('No live cells found in Life 1.06 file');
  return outCells;
}

/* Encodes a cell list as Life 1.06 (.lif). Two-state only (like the format itself): any cell
   with a non-zero state is written as a plain live coordinate, since 1.06 has no concept of
   multiple states -- there's no lossy "downgrade" step needed beyond that, coordinates are
   used exactly as given (no bounding-box recentering), matching parseLifeFile's own reading. */
function encodeLifeFile(cellsList) {
  const lines = ['#Life 1.06'];
  for (const c of cellsList) {
    if (!c.s) continue; // state 0 is "dead", shouldn't be in cellsList anyway, but skip defensively
    lines.push(`${c.x} ${c.y}`);
  }
  return lines.join('\n') + '\n';
}

/* Parses Plaintext (.cells) format: any number of leading "!"-prefixed comment/description
   lines, then a rectangular block of rows using '.' for dead and 'O' (capital letter O, not
   zero) for alive -- some tools also accept '*'; both are treated as alive here for leniency.
   Row length may vary line-to-line (trailing dead cells are often omitted); missing trailing
   cells in a short row are simply treated as dead. Like Life 1.06, this format is two-state
   only, so every alive cell becomes state 1. Coordinates are relative to the top-left of the
   block (row 0 / col 0 at the first line's first character), same convention parseRLE uses. */
function parseCellsFile(text) {
  if (!text) throw new Error('Empty');
  const lines = text.split(/\r?\n/);

  const outCells = [];
  let y = 0;
  let sawGridLine = false;
  for (const raw of lines) {
    if (raw.startsWith('!')) continue; // comment/description line, skip entirely (not even blank-row-advancing)
    // A completely blank line inside the grid region is ambiguous between "blank comment" and
    // "empty row of the pattern" in the wild; treated as an empty row here (advances y) once
    // we've actually started seeing grid content, and simply skipped before that.
    if (raw.trim() === '' && !sawGridLine) continue;
    sawGridLine = true;
    for (let x = 0; x < raw.length; x++) {
      const ch = raw[x];
      if (ch === 'O' || ch === '*') outCells.push({ x, y, s: 1 });
      // '.' and anything else (including stray whitespace) is treated as dead
    }
    y++;
  }

  if (outCells.length === 0) throw new Error('No live cells found in .cells file');
  return outCells;
}

/* Encodes a cell list as Plaintext (.cells). Two-state only: any live cell (state != 0)
   becomes 'O', dead stays '.'. Unlike encodeLifeFile, this format IS a dense row/column grid,
   so (like cellsToRLE) the pattern is first recentered to its own bounding box -- trailing dead
   cells on each row are trimmed, matching how real-world .cells files are normally written. */
function encodeCellsFile(cellsList, headerComment) {
  if (!cellsList || cellsList.length === 0) return (headerComment ? `!${headerComment}\n` : '') + '\n';
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const c of cellsList) {
    if (c.x < minx) minx = c.x;
    if (c.x > maxx) maxx = c.x;
    if (c.y < miny) miny = c.y;
    if (c.y > maxy) maxy = c.y;
  }
  const w = maxx - minx + 1;
  const h = maxy - miny + 1;
  const grid = Array.from({ length: h }, () => Array(w).fill('.'));
  for (const c of cellsList) {
    if (!c.s) continue;
    grid[c.y - miny][c.x - minx] = 'O';
  }

  const rows = grid.map(row => {
    let last = -1;
    for (let i = row.length - 1; i >= 0; i--) { if (row[i] === 'O') { last = i; break; } }
    return row.slice(0, last + 1).join('');
  });

  const header = headerComment ? `!${headerComment}\n` : '';
  return header + rows.join('\n') + '\n';
}

/* ================= File Converter (Alt+S) =================
   Converts a pattern file between any two of the four formats this game already reads and
   writes (.lif, .rle, .mc, .cells), independent of whatever is currently on the board. The
   player loads one source file, the format is auto-detected, and any of the other three
   formats can be produced from it and downloaded -- covering all 12 directed conversion pairs
   (4 source formats x 3 possible targets each) through the same 4 parse functions and 4 encode
   functions already used elsewhere in the game for board import/export, so a conversion here
   round-trips through the exact same logic a normal load-then-export would. */

// Detects which of the 4 supported formats a block of text is, by the same unambiguous markers
// already used elsewhere in the game (tryLoadLifOrCellsText, the ZIP bundler's extension list):
// macrocell always starts with "[M2]", Life 1.06 always starts with "#Life 1.06", RLE always
// has a "x = ..., rule = ..." header line, and Plaintext (.cells) is the fallback when none of
// the other three markers match (its own markers, '!' comments and a '.'/'O' grid, are both
// optional in the format, so it can't be positively identified the same way the others can).
function detectPatternFileFormat(text) {
  const firstNonBlankLine = (text.split(/\r?\n/).find(l => l.trim() !== '') || '').trim();
  if (firstNonBlankLine.startsWith('[M2]')) return 'mc';
  if (/^#Life\s+1\.06/i.test(firstNonBlankLine)) return 'lif';
  if (/^\s*x\s*=\s*\d+\s*,\s*y\s*=\s*\d+/im.test(text)) return 'rle'; // 'm' flag: RLE's header line can appear after leading '#' comment lines, so match it at the start of ANY line, not just the start of the whole text
  return 'cells';
}

// Parses `text` (already known to be in `format`) into a flat {x,y,s} cell list, using
// whichever of the game's existing parsers matches. Throws on genuinely malformed input, same
// as each underlying parser already does.
function parsePatternFileAs(text, format) {
  if (format === 'rle') return parseRLE(text);
  if (format === 'mc') {
    const r = parseMacrocellFile(text);
    if (!r || !r.cells || r.cells.length === 0) throw new Error('No live cells parsed');
    return r.cells;
  }
  if (format === 'lif') return parseLifeFile(text);
  if (format === 'cells') return parseCellsFile(text);
  throw new Error(`Unknown source format: ${format}`);
}

// Encodes a flat {x,y,s} cell list into `format`'s text representation, using whichever of the
// game's existing encoders matches. ruleStr/filenameBase are only used by the formats that
// embed them (.mc's #R/#G comments, .rle's header, .cells' optional !comment line).
function encodePatternFileAs(cellsList, format, ruleStr, filenameBase) {
  if (format === 'rle') return cellsToRLE(cellsList, ruleStr);
  if (format === 'mc') return encodeMacrocellFile(cellsList, ruleStr, 0);
  if (format === 'lif') return encodeLifeFile(cellsList);
  if (format === 'cells') return encodeCellsFile(cellsList, filenameBase ? ` ${filenameBase}` : undefined);
  throw new Error(`Unknown target format: ${format}`);
}

const PATTERN_FILE_FORMAT_LABELS = { lif: '.lif', rle: '.rle', mc: '.mc', cells: '.cells' };
const PATTERN_FILE_FORMAT_NAMES = {
  lif: 'Life 1.06 (.lif)', rle: 'RLE (.rle)', mc: 'Macrocell (.mc)', cells: 'Plaintext (.cells)'
};

// Converting FROM macrocell TO either of the two flat per-cell text formats (.lif writes one
// "x y" line per live cell, .cells writes one character per cell in a dense grid) is the one
// direction genuinely worth warning about: macrocell is a compressed quadtree specifically
// built to represent huge, highly-repetitive patterns in a tiny file, while .lif/.cells have no
// such compression at all -- a macrocell file that's a few kilobytes can easily represent
// millions of live cells, which would expand into a .lif/.cells file many times larger (or,
// for very large/sparse macrocell patterns, so large it may be impractical to even download or
// reopen). RLE is excluded from this warning since it already has its own run-length
// compression and doesn't blow up the same way.
function conversionNeedsBloatWarning(sourceFormat, targetFormat) {
  return sourceFormat === 'mc' && (targetFormat === 'lif' || targetFormat === 'cells');
}

function openFileConverterModal() {
  if (document.getElementById('file-converter-modal')) return;

  let loadedText = null;
  let loadedFormat = null;
  let loadedCells = null;
  let loadedFilenameBase = null;

  const modal = document.createElement('div');
  modal.id = 'file-converter-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(92vw,460px)', maxHeight: '86vh', overflow: 'auto', boxSizing: 'border-box',
    fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'File Converter';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '600' });
  modal.appendChild(title);

  const info = document.createElement('div');
  info.textContent = 'Load a .lif, .rle, .mc, or .cells file, then convert it to any of the other three formats. The format is detected automatically.';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '10px' });
  modal.appendChild(info);

  // ---- file loader ----
  const loadRow = document.createElement('div');
  Object.assign(loadRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' });
  const loadLabel = document.createElement('label');
  loadLabel.textContent = 'Load file:';
  Object.assign(loadLabel.style, { fontSize: '13px' });
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.lif,.life,.rle,.mc,.cells,text/plain';
  Object.assign(fileInput.style, { cursor: 'pointer' });
  loadRow.appendChild(loadLabel);
  loadRow.appendChild(fileInput);
  modal.appendChild(loadRow);

  const statusLine = document.createElement('div');
  Object.assign(statusLine.style, { fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginBottom: '10px', minHeight: '18px' });
  statusLine.textContent = 'No file loaded yet.';
  modal.appendChild(statusLine);

  // ---- target format buttons ----
  const targetLabel = document.createElement('div');
  targetLabel.textContent = 'Convert to:';
  Object.assign(targetLabel.style, { fontSize: '13px', fontWeight: '600', marginBottom: '6px' });
  modal.appendChild(targetLabel);

  const targetRow = document.createElement('div');
  Object.assign(targetRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' });
  modal.appendChild(targetRow);

  const formatOrder = ['lif', 'rle', 'mc', 'cells'];
  const targetButtons = {};
  for (const fmt of formatOrder) {
    const btn = document.createElement('button');
    btn.textContent = PATTERN_FILE_FORMAT_LABELS[fmt];
    Object.assign(btn.style, { padding: '8px 12px', cursor: 'pointer', flex: '1 1 auto' });
    btn.disabled = true;
    btn.addEventListener('click', () => attemptConvert(fmt));
    targetButtons[fmt] = btn;
    targetRow.appendChild(btn);
  }

  function refreshTargetButtons() {
    for (const fmt of formatOrder) {
      const btn = targetButtons[fmt];
      // A format can't usefully convert to itself -- disable and grey out that one button once
      // a source is loaded, so the player isn't offered a no-op conversion.
      btn.disabled = !loadedCells || fmt === loadedFormat;
      btn.style.opacity = btn.disabled ? '0.45' : '1';
    }
  }
  refreshTargetButtons();

  function loadFromText(text, filenameBase) {
    let format;
    try {
      format = detectPatternFileFormat(text);
      const cells = parsePatternFileAs(text, format);
      loadedText = text;
      loadedFormat = format;
      loadedCells = cells;
      loadedFilenameBase = filenameBase || 'pattern';
      statusLine.textContent = `Loaded ${PATTERN_FILE_FORMAT_NAMES[format]} -- ${cells.length.toLocaleString()} cell(s).`;
      statusLine.style.color = 'rgba(255,255,255,0.85)';
    } catch (err) {
      loadedText = null; loadedFormat = null; loadedCells = null;
      statusLine.textContent = `Failed to parse file: ${err.message}`;
      statusLine.style.color = '#ff8a8a';
    }
    refreshTargetButtons();
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base = (f.name || 'pattern').replace(/\.[^.]+$/, '');
      loadFromText(String(reader.result || ''), base);
    };
    reader.onerror = () => {
      statusLine.textContent = 'Failed to read file.';
      statusLine.style.color = '#ff8a8a';
    };
    reader.readAsText(f);
  });

  modal.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  modal.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base = (f.name || 'pattern').replace(/\.[^.]+$/, '');
      loadFromText(String(reader.result || ''), base);
    };
    reader.onerror = () => {
      statusLine.textContent = 'Failed to read dropped file.';
      statusLine.style.color = '#ff8a8a';
    };
    reader.readAsText(f);
  });

  // ---- bloat warning (shown inline, not as a blocking alert(), so it fits this modal's style) ----
  const warningBox = document.createElement('div');
  Object.assign(warningBox.style, {
    display: 'none', fontSize: '12px', color: '#ffd76a', marginBottom: '10px', lineHeight: '1.4',
    padding: '8px 10px', background: 'rgba(255,215,106,0.08)',
    border: '1px solid rgba(255,215,106,0.45)', borderRadius: '6px'
  });
  modal.appendChild(warningBox);

  function doConvertAndDownload(targetFormat) {
    let outputText;
    try {
      const ruleStr = 'B3/S23'; // the converter works on a standalone file, not the live board, so it has no board rules to draw from; this matches the neutral default used elsewhere (e.g. Alt+B's bundler) when re-encoding a file whose own original rule string wasn't retained by its source format
      outputText = encodePatternFileAs(loadedCells, targetFormat, ruleStr, loadedFilenameBase);
    } catch (err) {
      flashTinyToast(`Conversion failed: ${err.message}`);
      return;
    }
    const blob = new Blob([outputText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = __sanitizeExportFilename(loadedFilenameBase);
    a.download = `${name}.${targetFormat}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    flashTinyToast(`Converted ${PATTERN_FILE_FORMAT_LABELS[loadedFormat]} -> ${PATTERN_FILE_FORMAT_LABELS[targetFormat]} (${name}.${targetFormat})`);
  }

  function attemptConvert(targetFormat) {
    if (!loadedCells) return;
    warningBox.style.display = 'none';

    if (conversionNeedsBloatWarning(loadedFormat, targetFormat)) {
      warningBox.innerHTML = '';
      const msg = document.createElement('div');
      msg.textContent = `Warning: .mc (macrocell) is a compressed format built for huge patterns. Converting to ${PATTERN_FILE_FORMAT_LABELS[targetFormat]} writes one line/character per live cell with no compression, so the result can be dramatically larger than the source .mc file -- for very large or sparse patterns, potentially too large to comfortably open or share.`;
      warningBox.appendChild(msg);

      const confirmRow = document.createElement('div');
      Object.assign(confirmRow.style, { display: 'flex', gap: '8px', marginTop: '8px' });
      const proceedBtn = document.createElement('button');
      proceedBtn.textContent = `Convert anyway (${loadedCells.length.toLocaleString()} cells)`;
      Object.assign(proceedBtn.style, { padding: '6px 10px', cursor: 'pointer' });
      proceedBtn.addEventListener('click', () => {
        warningBox.style.display = 'none';
        doConvertAndDownload(targetFormat);
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      Object.assign(cancelBtn.style, { padding: '6px 10px', cursor: 'pointer' });
      cancelBtn.addEventListener('click', () => { warningBox.style.display = 'none'; });
      confirmRow.appendChild(proceedBtn);
      confirmRow.appendChild(cancelBtn);
      warningBox.appendChild(confirmRow);

      warningBox.style.display = 'block';
      return;
    }

    doConvertAndDownload(targetFormat);
  }

  const closeRow = document.createElement('div');
  Object.assign(closeRow.style, { display: 'flex', justifyContent: 'flex-end' });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    if (modal.parentElement) modal.parentElement.removeChild(modal);
  });
  closeRow.appendChild(closeBtn);
  modal.appendChild(closeRow);

  document.body.appendChild(modal);
}

/* Strips characters that are illegal (or awkward) in a downloaded filename on Windows/macOS/
   Linux (\ / : * ? " < > |), trims surrounding whitespace/dots, and caps the length so a
   pasted essay doesn't produce an unusable download name. Falls back to 'board' if the result
   is empty, so every export always has a sane, non-blank filename regardless of what (if
   anything) the player typed into the Alt+Z/Alt+F filename modal below. */
function __sanitizeExportFilename(raw) {
  const cleaned = String(raw || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'board';
}

/* Shared filename-prompt modal used by both the Alt+Z (.mc) and Alt+F (.rle) board exports.
   Styled to match the app's other small dialogs (RLE/macrocell import modals, etc.): dark
   panel, Times New Roman, rounded corners. Shows a single text input pre-filled with 'board'
   so pressing Enter/clicking Export immediately reproduces the old default behavior for anyone
   who doesn't care to rename it -- this only adds a naming step, it doesn't require typing.
   `ext` is the file extension shown in the hint text and Export button (without the dot).
   `onConfirm(name)` is called with the sanitized filename (no extension) once the player
   confirms; nothing is called if they cancel/Escape. */
function openExportFilenameModal(ext, onConfirm) {
  if (document.getElementById('export-filename-modal')) return;

  // Bail out before showing any UI if there's nothing on the board -- matches the original
  // behavior of downloadBoardAsMacrocell()/downloadBoardAsRLE() short-circuiting immediately,
  // rather than making the player type a filename and hit Export only to be told afterward
  // that the export was empty. Mirrors exactly what __snapshotBuildCellsList() would collect.
  if (alive.size === 0 && states.size === 0) {
    flashTinyToast('Board is empty -- nothing to export');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'export-filename-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(90vw,360px)', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = `Export as .${ext}`;
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '600' });

  const info = document.createElement('div');
  info.textContent = 'Name this file:';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '6px' });

  const inputRow = document.createElement('div');
  Object.assign(inputRow.style, { display: 'flex', alignItems: 'center', gap: '4px' });

  const input = document.createElement('input');
  input.type = 'text';
  input.value = 'board';
  Object.assign(input.style, {
    flex: '1', minWidth: '0', padding: '6px 8px', boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.3)',
    borderRadius: '6px', color: '#fff', fontSize: '14px'
  });

  const extLabel = document.createElement('div');
  extLabel.textContent = `.${ext}`;
  Object.assign(extLabel.style, { fontSize: '14px', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' });

  inputRow.appendChild(input);
  inputRow.appendChild(extLabel);

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', marginTop: '10px', justifyContent: 'flex-end' });

  function closeModal() {
    if (modal.parentElement) modal.parentElement.removeChild(modal);
    window.removeEventListener('keydown', keyHandler, true);
  }

  function confirmAndClose() {
    const name = __sanitizeExportFilename(input.value);
    closeModal();
    try { onConfirm(name); } catch (err) { console.warn('Export filename modal onConfirm failed:', err); }
  }

  // Enter confirms, Escape cancels -- captured on the window (not just the input) so this
  // still works if focus somehow lands elsewhere in the modal, and stopPropagation on Enter
  // keeps it from also triggering whatever the underlying canvas's own Enter handling does.
  function keyHandler(ev) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      confirmAndClose();
    } else if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      ev.stopPropagation();
      closeModal();
    }
  }
  window.addEventListener('keydown', keyHandler, true);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  cancelBtn.addEventListener('click', closeModal);

  const exportBtn = document.createElement('button');
  exportBtn.textContent = `Export .${ext}`;
  Object.assign(exportBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  exportBtn.addEventListener('click', confirmAndClose);

  row.appendChild(cancelBtn);
  row.appendChild(exportBtn);

  modal.appendChild(title);
  modal.appendChild(info);
  modal.appendChild(inputRow);
  modal.appendChild(row);
  document.body.appendChild(modal);

  input.focus();
  input.select();
}

/* Alt+Z: converts every cell currently on the board into a .mc (macrocell) file
   and triggers an automatic browser download, using the same encoder above and
   the same Blob -> object URL -> temp <a> download pattern used elsewhere
   (e.g. downloadSnapshotById) for consistency. `filename` (no extension) comes from
   the Alt+Z filename-prompt modal; defaults to 'board' if called without one. */
function downloadBoardAsMacrocell(filename) {
  const cellsList = __snapshotBuildCellsList();

  if (cellsList.length === 0) {
    flashTinyToast('Board is empty -- nothing to export');
    return;
  }

  const name = __sanitizeExportFilename(filename);
  const ruleStr = `B${[...birthRules].sort((a,b)=>a-b).join('')}/S${[...survivalRules].sort((a,b)=>a-b).join('')}${cellStatesCount>2?('/G'+cellStatesCount):''}`;
  const mcText = encodeMacrocellFile(cellsList, ruleStr, generation);

  const blob = new Blob([mcText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.mc`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  flashTinyToast(`Exported ${cellsList.length.toLocaleString()} cells to ${name}.mc`);
}

/* Alt+F: converts every cell currently on the board into a standard .rle file and triggers an
   automatic browser download. Reuses the existing cellsToRLE() encoder (already used elsewhere
   for snapshots/templates) to build a plain, portable RLE file with a standard
   "x = W, y = H, rule = ..." header -- deliberately NOT the app's internal snapshot dialect
   (which adds #O/#G/#H/#I extension comments for its own round-tripping needs), so this file
   opens correctly in Golly or any other standard RLE-compatible tool, matching the same
   "clean standard format" choice made for the Alt+Z macrocell export. `filename` (no extension)
   comes from the Alt+F filename-prompt modal; defaults to 'board' if called without one. */
function downloadBoardAsRLE(filename) {
  const cellsList = __snapshotBuildCellsList();

  if (cellsList.length === 0) {
    flashTinyToast('Board is empty -- nothing to export');
    return;
  }

  const name = __sanitizeExportFilename(filename);
  const ruleStr = `B${[...birthRules].sort((a,b)=>a-b).join('')}/S${[...survivalRules].sort((a,b)=>a-b).join('')}${cellStatesCount>2?('/G'+cellStatesCount):''}`;
  const rleText = cellsToRLE(cellsList, ruleStr);

  const blob = new Blob([rleText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.rle`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  flashTinyToast(`Exported ${cellsList.length.toLocaleString()} cells to ${name}.rle`);
}

/* Alt+C export menu target: converts every cell currently on the board into a Life 1.06 (.lif)
   file and triggers an automatic browser download. `filename` (no extension) comes from the
   Alt+C export-format modal; defaults to 'board' if called without one. Life 1.06 is two-state
   only (see encodeLifeFile) -- any faded/multi-state cells are exported as plain alive cells. */
function downloadBoardAsLif(filename) {
  const cellsList = __snapshotBuildCellsList();

  if (cellsList.length === 0) {
    flashTinyToast('Board is empty -- nothing to export');
    return;
  }

  const name = __sanitizeExportFilename(filename);
  const lifText = encodeLifeFile(cellsList);

  const blob = new Blob([lifText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.lif`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  flashTinyToast(`Exported ${cellsList.length.toLocaleString()} cells to ${name}.lif`);
}

/* Alt+C export menu target: converts every cell currently on the board into a Plaintext
   (.cells) file and triggers an automatic browser download. `filename` (no extension) comes
   from the Alt+C export-format modal; defaults to 'board' if called without one. Plaintext is
   two-state only (see encodeCellsFile) -- any faded/multi-state cells are exported as plain
   alive 'O' cells. */
function downloadBoardAsCells(filename) {
  const cellsList = __snapshotBuildCellsList();

  if (cellsList.length === 0) {
    flashTinyToast('Board is empty -- nothing to export');
    return;
  }

  const name = __sanitizeExportFilename(filename);
  const cellsText = encodeCellsFile(cellsList, ` ${name}`);

  const blob = new Blob([cellsText], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.cells`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  flashTinyToast(`Exported ${cellsList.length.toLocaleString()} cells to ${name}.cells`);
}

/* Alt+C: unified export menu. Lets the player pick a filename ONCE and then choose which of
   the four supported formats (.lif, .rle, .mc, .cells) to export the current board as --
   picking a format immediately triggers that format's download using the typed name, and the
   modal stays open afterward (rather than auto-closing) so the player can export the same
   board under the same name in more than one format back-to-back without retyping it. Visually
   matches openExportFilenameModal (dark panel, Times New Roman, rounded corners) but swaps the
   single "Export" button for one button per format. */
function openExportFormatModal() {
  if (document.getElementById('export-format-modal')) return;

  // Bail out before showing any UI if there's nothing on the board -- same reasoning as
  // openExportFilenameModal's own pre-check.
  if (alive.size === 0 && states.size === 0) {
    flashTinyToast('Board is empty -- nothing to export');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'export-format-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(90vw,380px)', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Export board';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '600' });

  const info = document.createElement('div');
  info.textContent = 'Name this file, then choose a format to export as:';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '6px' });

  const input = document.createElement('input');
  input.type = 'text';
  input.value = 'board';
  Object.assign(input.style, {
    width: '100%', boxSizing: 'border-box', padding: '6px 8px',
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.3)',
    borderRadius: '6px', color: '#fff', fontSize: '14px', marginBottom: '10px'
  });

  function closeModal() {
    if (modal.parentElement) modal.parentElement.removeChild(modal);
    window.removeEventListener('keydown', keyHandler, true);
  }

  // Escape cancels; Enter triggers the first (leftmost) format button as a convenient default,
  // matching the "just hit Enter to go with a sensible default" feel of openExportFilenameModal.
  function keyHandler(ev) {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      ev.preventDefault();
      ev.stopPropagation();
      closeModal();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      const firstBtn = formatRow.querySelector('button');
      if (firstBtn) firstBtn.click();
    }
  }
  window.addEventListener('keydown', keyHandler, true);

  const formatRow = document.createElement('div');
  Object.assign(formatRow.style, { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' });

  // Each format button exports immediately on click (using whatever name is currently in the
  // input) but deliberately does NOT close the modal afterward -- see function doc comment --
  // so exporting the same board as e.g. both .rle and .mc under one typed name takes one modal
  // open, not two.
  const formats = [
    { ext: 'lif', label: '.lif', fn: downloadBoardAsLif },
    { ext: 'rle', label: '.rle', fn: downloadBoardAsRLE },
    { ext: 'mc',  label: '.mc',  fn: downloadBoardAsMacrocell },
    { ext: 'cells', label: '.cells', fn: downloadBoardAsCells }
  ];
  for (const f of formats) {
    const btn = document.createElement('button');
    btn.textContent = f.label;
    Object.assign(btn.style, { padding: '8px 12px', cursor: 'pointer', flex: '1 1 auto' });
    btn.addEventListener('click', () => {
      const name = __sanitizeExportFilename(input.value);
      try { f.fn(name); } catch (err) {
        console.warn(`Failed to export board as .${f.ext}:`, err);
        flashTinyToast(`Failed to export .${f.ext} file`);
      }
    });
    formatRow.appendChild(btn);
  }

  const closeRow = document.createElement('div');
  Object.assign(closeRow.style, { display: 'flex', justifyContent: 'flex-end' });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', closeModal);
  closeRow.appendChild(closeBtn);

  modal.appendChild(title);
  modal.appendChild(info);
  modal.appendChild(input);
  modal.appendChild(formatRow);
  modal.appendChild(closeRow);
  document.body.appendChild(modal);

  input.focus();
  input.select();
}

/* Alt+B: .zip pattern-file bundler. Lets the player collect any mix of .rle/.lif/.cells/.mc
   files into a working list (added individually via a file picker, or all at once by loading
   an existing .zip), then either download that list as a new .zip or keep editing it -- each
   listed file can be deleted, renamed, or "Load"ed straight onto the board as an attached
   template (reusing the same parsers each format's own import modal uses: parseRLE,
   parseMacrocellFile, parseLifeFile, parseCellsFile). This is a file MANAGER, not a board
   exporter -- unlike openExportFormatModal (Alt+C), which always serializes the current board,
   here the files come from the player's disk (or an existing zip) and the board is only ever a
   *destination* (via each row's Load button), never a source. */
function __zipEntryExtOf(filename) {
  const m = String(filename || '').match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

// Normalizes '.life' (an alternate extension some tools use for Life 1.06) to 'lif' so it's
// treated identically to '.lif' everywhere in this modal -- both parse with parseLifeFile.
function __zipEntryNormalizedExt(ext) {
  return ext === 'life' ? 'lif' : ext;
}

const ZIP_BUNDLE_ALLOWED_EXTS = ['rle', 'lif', 'life', 'cells', 'mc'];

function openZipBundleModal() {
  if (document.getElementById('zip-bundle-modal')) return;

  // entries: [{ name: 'glider.rle', ext: 'rle', text: '...' }, ...] -- ext is always the
  // normalized form ('life' folded into 'lif') so downstream logic only ever branches on the
  // 4 canonical extensions, but `name` keeps whatever extension the player/zip actually used.
  let entries = [];
  let loadedFromExistingZip = false; // controls whether the browser-setting hint line is shown

  const modal = document.createElement('div');
  modal.id = 'zip-bundle-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(92vw,560px)', maxHeight: '84vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Pattern file ZIP bundler';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '600' });

  const info = document.createElement('div');
  info.textContent = 'Add .rle, .lif, .cells, or .mc files below, or load an existing .zip to edit it, then create a .zip with everything in the list.';
  Object.assign(info.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '8px' });

  // ---- filename row ----
  const nameRow = document.createElement('div');
  Object.assign(nameRow.style, { display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '10px' });

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = 'Patternfiles';
  Object.assign(nameInput.style, {
    flex: '1', minWidth: '0', padding: '6px 8px', boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.3)',
    borderRadius: '6px', color: '#fff', fontSize: '14px'
  });
  const nameExtLabel = document.createElement('div');
  nameExtLabel.textContent = '.zip';
  Object.assign(nameExtLabel.style, { fontSize: '14px', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' });
  nameRow.appendChild(nameInput);
  nameRow.appendChild(nameExtLabel);

  // ---- add-files / load-zip row ----
  const loadersRow = document.createElement('div');
  Object.assign(loadersRow.style, { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px', alignItems: 'center' });

  const addFilesLabel = document.createElement('label');
  addFilesLabel.textContent = 'Add files:';
  Object.assign(addFilesLabel.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' });
  const addFilesInput = document.createElement('input');
  addFilesInput.type = 'file';
  addFilesInput.accept = '.rle,.lif,.life,.cells,.mc,text/plain';
  addFilesInput.multiple = true;
  Object.assign(addFilesInput.style, { cursor: 'pointer' });
  addFilesLabel.appendChild(addFilesInput);

  const loadZipLabel = document.createElement('label');
  loadZipLabel.textContent = 'Load .zip:';
  Object.assign(loadZipLabel.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' });
  const loadZipInput = document.createElement('input');
  loadZipInput.type = 'file';
  loadZipInput.accept = '.zip,application/zip';
  Object.assign(loadZipInput.style, { cursor: 'pointer' });
  loadZipLabel.appendChild(loadZipInput);

  loadersRow.appendChild(addFilesLabel);
  loadersRow.appendChild(loadZipLabel);

  // ---- browser-setting hint (only shown once a zip has actually been loaded/edited) ----
  // Placed directly under the Add files / Load .zip row -- not after the file list -- so it's
  // always near the top of the modal, right next to the control that triggers it, rather than
  // being pushed down (and potentially out of view / requiring a scroll) as the file list grows.
  const browserHint = document.createElement('div');
  browserHint.textContent = 'Editing an existing ZIP: enable "Ask where to save each file before downloading" in your browser\'s settings to overwrite the original file directly instead of getting a new copy.';
  Object.assign(browserHint.style, {
    fontSize: '13px', color: '#ffd76a', marginBottom: '10px', lineHeight: '1.4',
    padding: '8px 10px', background: 'rgba(255,215,106,0.08)',
    border: '1px solid rgba(255,215,106,0.45)', borderRadius: '6px', display: 'none'
  });

  // ---- file list ----
  const listWrap = document.createElement('div');
  Object.assign(listWrap.style, { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' });

  const emptyHint = document.createElement('div');
  emptyHint.textContent = 'No files added yet.';
  Object.assign(emptyHint.style, { fontSize: '13px', color: 'rgba(255,255,255,0.5)', fontStyle: 'italic' });

  // ---- bottom action row ----
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center' });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer', marginRight: 'auto' });

  const createBtn = document.createElement('button');
  createBtn.textContent = 'Create ZIP';
  Object.assign(createBtn.style, { padding: '8px 10px', cursor: 'pointer' });

  row.appendChild(closeBtn);
  row.appendChild(createBtn);

  function closeModal() {
    if (modal.parentElement) modal.parentElement.removeChild(modal);
  }
  closeBtn.addEventListener('click', closeModal);

  // Parses one entry's stored text with whatever parser matches its (normalized) extension,
  // returning a {x,y,s} cell list or throwing -- shared by the per-row Load button.
  function parseEntryCells(entry) {
    if (entry.ext === 'rle') return parseRLE(entry.text);
    if (entry.ext === 'mc') {
      const r = parseMacrocellFile(entry.text);
      if (!r || !r.cells || r.cells.length === 0) throw new Error('No live cells parsed');
      return r.cells;
    }
    if (entry.ext === 'lif') return parseLifeFile(entry.text);
    if (entry.ext === 'cells') return parseCellsFile(entry.text);
    throw new Error(`Unsupported file type: .${entry.ext}`);
  }

  function renderList() {
    listWrap.innerHTML = '';
    browserHint.style.display = loadedFromExistingZip ? 'block' : 'none';

    if (entries.length === 0) {
      listWrap.appendChild(emptyHint);
      return;
    }

    entries.forEach((entry, idx) => {
      const fileRow = document.createElement('div');
      Object.assign(fileRow.style, {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px',
        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px'
      });

      const nameSpan = document.createElement('div');
      nameSpan.textContent = entry.name;
      Object.assign(nameSpan.style, {
        flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', fontSize: '13px'
      });

      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      Object.assign(loadBtn.style, { padding: '4px 8px', cursor: 'pointer', fontSize: '12px' });
      loadBtn.addEventListener('click', () => {
        try {
          const cells = parseEntryCells(entry);
          templateCells = cells;
          templateAttached = true;
          flashTinyToast(`Loaded ${entry.name} onto board (${cells.length.toLocaleString()} cells)`);
        } catch (err) {
          alert(`Failed to parse ${entry.name}: ${err.message}`);
        }
      });

      const renameBtn = document.createElement('button');
      renameBtn.textContent = 'Rename';
      Object.assign(renameBtn.style, { padding: '4px 8px', cursor: 'pointer', fontSize: '12px' });
      renameBtn.addEventListener('click', () => {
        const currentBase = entry.name.replace(/\.[^.]+$/, '');
        const input = prompt(`Rename "${entry.name}" to (extension .${entry.ext} kept automatically):`, currentBase);
        if (input === null) return; // cancelled
        const cleaned = __sanitizeExportFilename(input);
        entry.name = `${cleaned}.${entry.ext}`;
        renderList();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      Object.assign(deleteBtn.style, { padding: '4px 8px', cursor: 'pointer', fontSize: '12px' });
      deleteBtn.addEventListener('click', () => {
        entries.splice(idx, 1);
        renderList();
      });

      fileRow.appendChild(nameSpan);
      fileRow.appendChild(loadBtn);
      fileRow.appendChild(renameBtn);
      fileRow.appendChild(deleteBtn);
      listWrap.appendChild(fileRow);
    });
  }
  renderList();

  // Adds one already-read {name, text} pair to the entries list, after checking its extension
  // is one of the 4 supported types -- unsupported files are skipped with a toast rather than
  // silently added or hard-erroring the whole batch (relevant since Add Files supports
  // multi-select, where one bad file shouldn't block the rest).
  function addEntryIfSupported(name, text) {
    const rawExt = __zipEntryExtOf(name);
    const ext = __zipEntryNormalizedExt(rawExt);
    if (!ZIP_BUNDLE_ALLOWED_EXTS.includes(rawExt)) {
      flashTinyToast(`Skipped ${name} (only .rle/.lif/.cells/.mc allowed)`);
      return false;
    }
    entries.push({ name, ext, text });
    return true;
  }

  addFilesInput.addEventListener('change', async () => {
    const files = Array.from(addFilesInput.files || []);
    if (files.length === 0) return;
    let added = 0;
    for (const f of files) {
      try {
        const text = await f.text();
        if (addEntryIfSupported(f.name, text)) added++;
      } catch (err) {
        flashTinyToast(`Failed to read ${f.name}`);
      }
    }
    addFilesInput.value = '';
    if (added > 0) renderList();
  });

  loadZipInput.addEventListener('change', async () => {
    const f = loadZipInput.files && loadZipInput.files[0];
    if (!f) return;
    try {
      const JSZipModule = await import('jszip');
      const JSZip = JSZipModule.default || JSZipModule;
      const data = await f.arrayBuffer();
      const zip = await JSZip.loadAsync(data);

      const zipEntryNames = Object.keys(zip.files).filter(n => !zip.files[n].dir);
      let added = 0;
      const newEntries = [];
      for (const name of zipEntryNames) {
        const rawExt = __zipEntryExtOf(name);
        if (!ZIP_BUNDLE_ALLOWED_EXTS.includes(rawExt)) continue; // silently skip non-pattern files in the zip
        const text = await zip.files[name].async('string');
        newEntries.push({ name: name.replace(/^.*\//, ''), ext: __zipEntryNormalizedExt(rawExt), text });
        added++;
      }

      if (added === 0) {
        alert('That ZIP has no .rle/.lif/.cells/.mc files in it.');
        loadZipInput.value = '';
        return;
      }

      entries = newEntries;
      loadedFromExistingZip = true;
      const baseName = (f.name || '').replace(/\.[^.]+$/, '') || 'Patternfiles';
      nameInput.value = baseName;
      renderList();
      flashTinyToast(`Loaded ${added} file(s) from ${f.name}`);
    } catch (err) {
      alert('Failed to load ZIP: ' + err.message);
    } finally {
      loadZipInput.value = '';
    }
  });

  createBtn.addEventListener('click', async () => {
    if (entries.length === 0) {
      flashTinyToast('Add at least one file before creating a ZIP');
      return;
    }
    try {
      const JSZipModule = await import('jszip');
      const JSZip = JSZipModule.default || JSZipModule;
      const zip = new JSZip();
      for (const entry of entries) zip.file(entry.name, entry.text);
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      const zipName = __sanitizeExportFilename(nameInput.value) || 'Patternfiles';
      a.download = `${zipName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      flashTinyToast(`Downloaded ${zipName}.zip (${entries.length} file(s))`);
    } catch (err) {
      alert('Failed to create ZIP: ' + err.message);
    }
  });

  modal.appendChild(title);
  modal.appendChild(info);
  modal.appendChild(nameRow);
  modal.appendChild(loadersRow);
  modal.appendChild(browserHint);
  modal.appendChild(listWrap);
  modal.appendChild(row);
  document.body.appendChild(modal);
}

function placeTemplateAt(wx, wy) {
  if (!templateCells) return;
  const now = performance.now();


  for (const c of templateCells) {
    const tx = wx + c.x;
    const ty = wy + c.y;
    const k = `${tx},${ty}`;

    // If an invincible wall occupies the spot, skip placing anything there.
    if (invincible.has(k)) continue;

    const st = (typeof c.s === 'number') ? c.s : 1;

    if (st <= 0) {
      // dead token in template -> skip
      continue;
    } else if (st === 1) {
      // alive in template: ensure it's alive and added as pending so it activates intact next generation.
      // Remove any fading-state entry at that position so it doesn't persist as a fade.
      if (states.has(k)) states.delete(k);

      if (!alive.has(k)) {
        alive.add(k);
        birth.set(k, { t: now, p: pausedAccum });
        pendingPlacement.add(k);
        // record landing activity for template placement (user-intended placement)
        incrementDeadLanding(k);
      } else {
        pendingPlacement.add(k);
        if (!birth.has(k)) birth.set(k, { t: now, p: pausedAccum });
      }
    } else {
      // faded state in template (st >= 2): spawn as a fading state immediately (not as alive)
      // Do not add to pendingPlacement (fades should not be treated as newborn alive cells).
      // Overwrite any existing alive/birth and set the fading state.
      if (alive.has(k)) { alive.delete(k); birth.delete(k); }
      states.set(k, st);
    }
  }

  // Ensure the very next simulation step will only activate pendingPlacement as a batch
  // (this is only necessary if there are any pending alive placements).
  if (pendingPlacement.size > 0) {
    activatePendingOnly = true;
    pendingPlacementStart = performance.now();
  }
}

/* Place the attached template as invincible wall cells (immediate, permanent walls).
   This removes any normal alive/birth cells at those coordinates and marks them invincible. */
function placeTemplateInvincibleAt(wx, wy) {
  if (!templateCells) return;
  let placed = 0;
  for (const c of templateCells) {
    const tx = wx + c.x;
    const ty = wy + c.y;
    const k = `${tx},${ty}`;
    // remove any normal alive/birth or fading state there and mark invincible
    if (alive.has(k)) { alive.delete(k); birth.delete(k); }
    if (states.has(k)) states.delete(k);
    if (!invincible.has(k)) {
      invincible.add(k);
      placed++;
    }
  }
  flashTinyToast(`Template placed as invincible (${placed} walls)`);
}

/* Create a hollow invincible box of given size (odd or even) centered on the screen */
function spawnInvincibleBox(size = 25) {
  // compute world center cell
  const center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
  const half = Math.floor(size / 2);
  const now = performance.now();
  let placed = 0;
  // loop bounds for box top-left .. bottom-right
  const minx = center.wx - half;
  const maxx = minx + size - 1;
  const miny = center.wy - half;
  const maxy = miny + size - 1;

  for (let x = minx; x <= maxx; x++) {
    for (let y = miny; y <= maxy; y++) {
      // Only place walls on the border (hollow box)
      if (x === minx || x === maxx || y === miny || y === maxy) {
        const k = `${x},${y}`;
        // remove any normal alive/birth there and mark invincible
        if (alive.has(k)) { alive.delete(k); birth.delete(k); }
        if (!invincible.has(k)) {
          invincible.add(k);
          placed++;
        }
      }
    }
  }
  flashTinyToast(`Invincible box placed (${size}×${size}, ${placed} walls)`);
}

/* Expose a tiny on-screen hint when user first interacts (auto-hide) */
let hinted = false;
function showHint() {
  if (hinted) return;
  hinted = true;
  const div = document.createElement('div');
  Object.assign(div.style, {
    position: 'fixed', right: '10px', bottom: '10px',
    color: '#fff', background: 'rgba(255,255,255,0.06)', padding: '8px 10px', borderRadius: '6px',
    fontFamily: 'Times New Roman, Times, serif', fontSize: '12px', pointerEvents: 'none'
  });
  div.textContent = 'X: draw • Z: erase • G: clear • Q: pause • Arrows: pan • A/S: zoom • C/V/D: pan speed • R/E: tick speed • B: edit rules (B3/S23) • T: import RLE • U: controls';
  document.body.appendChild(div);
  setTimeout(() => div.style.opacity = '0', 2800);
  setTimeout(() => div.remove(), 3200);
}


/* Stats modal: shows current zoom, alive count, pan speed, tick interval and other quick stats */
function openStatsModal() {
  if (document.getElementById('stats-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'stats-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(88vw,420px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Statistics';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '700', fontSize: '16px' });
  modal.appendChild(title);

  // container where rows will be rendered and refreshed
  const container = document.createElement('div');
  modal.appendChild(container);

  // function to build/update the stats content
  function buildContent() {
    // clear existing content
    container.innerHTML = '';

    // compute stats
    const aliveCount = alive.size;
    const zoom = Number(cellSize.toFixed(4));
    const cameraSpeed = panStep;
    const ticksMs = stepInterval;
    const runningState = running ? 'Running' : 'Paused';
    const templateState = templateCells ? (templateAttached ? `Attached (${templateCells.length} cells)` : `Loaded (${templateCells.length} cells)`) : 'None';
    const rulesStr = `B${[...birthRules].sort((a,b)=>a-b).join('')}/S${[...survivalRules].sort((a,b)=>a-b).join('')}`;

    const infoRows = [
      ['State', runningState],
      ['Generation', String(generation)],
      ['Alive cells', String(aliveCount)],
      ['Zoom (cell px)', String(zoom)],
      ['Camera speed (panStep)', String(cameraSpeed)],
      ['Tick interval (ms)', String(ticksMs)],
      ['Template', templateState],
      ['Rules', rulesStr],
      ['Pending placement', String(pendingPlacement.size)],
      ['Paused accumulated (ms)', String(Math.round(pausedAccum))],
    ];

    for (const [k, v] of infoRows) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.padding = '6px 4px';
      row.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
      const keyEl = document.createElement('div');
      keyEl.textContent = k;
      Object.assign(keyEl.style, { fontWeight: '700', color: '#fff' });
      const valEl = document.createElement('div');
      valEl.textContent = v;
      Object.assign(valEl.style, { color: 'rgba(255,255,255,0.85)' });
      row.appendChild(keyEl);
      row.appendChild(valEl);
      container.appendChild(row);
    }
  }

  // initial render
  buildContent();

  // set up an interval to refresh stats while modal is open
  const intervalMs = 500; // update twice a second
  const updId = setInterval(() => {
    // if modal was removed externally, stop interval
    if (!document.getElementById('stats-modal')) {
      clearInterval(updId);
      return;
    }
    buildContent();
  }, intervalMs);

  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.justifyContent = 'space-between';
  btnRow.style.marginTop = '10px';

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh';
  Object.assign(refreshBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  refreshBtn.addEventListener('click', () => {
    buildContent();
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    const el = document.getElementById('stats-modal');
    if (el) el.remove();
    clearInterval(updId);
  });

  btnRow.appendChild(refreshBtn);
  btnRow.appendChild(closeBtn);
  modal.appendChild(btnRow);

  document.body.appendChild(modal);
}

/* Help modal listing all keybindings, reorganised into sections with complete controls */
function openHelpModal() {
  if (document.getElementById('help-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'help-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '14px', borderRadius: '8px', zIndex: 9999,
    width: 'min(92vw,520px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  // top-right close button for scrolling help modal
  const topCloseBtn_help = document.createElement('button');
  topCloseBtn_help.textContent = 'Close';
  Object.assign(topCloseBtn_help.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    padding: '6px 10px',
    cursor: 'pointer',
    zIndex: 10001
  });
  topCloseBtn_help.addEventListener('click', () => {
    const el = document.getElementById('help-modal');
    if (el) el.remove();
  });
  modal.appendChild(topCloseBtn_help);

  const title = document.createElement('div');
  title.textContent = 'Controls & Keys';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '700', fontSize: '16px' });
  modal.appendChild(title);

  // sections: Full A–Z controls listing with Shift/Ctrl variants
  const sections = [
    {
      name: 'A',
      items: [
        ['Ctrl+A', 'Toggle landing-map overlay (shows persistent dead-cell landing counts)'],
        ['A', 'Zoom out (centered) -- also zooms while following a tracked cluster'],
        ['Shift+A', 'Invert colors toggle'],
        ['Alt+A', 'Toggle Cluster Tracking mode (hidden clustering, no polygons). While on, press X on a cluster to have the camera follow it; while following, only A/S (zoom), Z (stop), and X (retarget) work -- arrows and all other keys are blocked until you stop.'],
      ]
    },
    {
      name: 'B',
      items: [
        ['B', 'Open rule prompt (enter B#/S#/G#). In Larger-than-Life mode, opens an LTL-specific rule prompt instead (R<radius>,C<states>,S<min>-<max>,B<min>-<max>, or S/B may be a single number) -- S/B\'s max is capped by the current radius, and C works like classic mode\'s /G (C>=3 makes failed-survival cells fade instead of dying outright).'],
        ['Shift+B', 'Remove one random alive cell'],
        ['Ctrl+B', 'Reset rules to the current mode\'s default (B3/S23 normally, B2/S34 in Hex Mode). In Larger-than-Life mode, resets to the default rule (R5,C0,S33-57,B34-45) instead.'],
      ]
    },
    {
      name: 'C',
      items: [
        ['C', 'Decrease panStep (camera speed)'],
        ['Shift+C', 'Reload page (hard refresh)'],
        ['Ctrl+C', playerPlatformChoice === 'mobile' ? 'Enable 3D mode (Iframe) -- not available on mobile' : 'Enable 3D mode (Iframe)'],
      ]
    },
    {
      name: 'D',
      items: [
        ['Ctrl+D', 'Scramble: nudge every cell 1 space in a random direction (just for fun)'],
        ['D', 'Reset panStep to default'],
        ['Shift+D', 'Spawn hollow invincible box (25×25)'],
        ['Alt+D', 'Open Tutorial Mode: a guided, click-through walkthrough of the core controls (Arrow keys, X, Z, A, S, Q, W, E, R, C, V, D, J, Shift+J, Ctrl+J) -- an easier alternative to reading this whole manual.'],
      ]
    },
    {
      name: 'E',
      items: [
        ['Ctrl+E', 'Open Rule Spot panel (adjust size/rules, X to place at mouse) -- not available in Hex Mode'],
        ['E', 'Make tick rate slower (increase stepInterval)'],
        ['Shift+E', 'Remove half of all alive cells'],
      ]
    },
    {
      name: 'F',
      items: [
        ['F', 'Toggle age-color overlay'],
        ['Shift+F', 'Export all cells as extended RLE (copied to clipboard) -- not available in Hex Mode'],
        ['Ctrl+F', 'Open cluster-scan modal (scan for clusters / Ctrl+F) -- not available in Hex Mode'],
        ['Alt+F', 'Export every cell on the board as a standard .rle file (automatic download)'],
      ]
    },
    {
      name: 'G',
      items: [
        ['G', 'Clear alive/pending/invincible (soft wipe)'],
        ['Shift+G', 'Delete all invincible wall cells only'],
        ['Ctrl+G', 'Hard wipe: remove everything including faded states and all portals'],
        ['Alt+G', 'Delete all portals only (outside Portal mode) -- leaves cells, invincible walls, and Rule Spots untouched'],
      ]
    },
    {
      name: 'H',
      items: [
        ['H', 'Detach contraption from mouse (when attached)'],
        ['Shift+H', 'Toggle global keyboard lock (disable most keys)'],
        ['Ctrl+H', 'Open FastForward panel (bulk-step + cycle-detection accelerator) -- not available in Hex Mode, not available in Larger-than-Life mode'],
        ['Alt+H', 'Toggle Larger-than-Life (LTL) mode: switches to a radius-based neighbor-count rule (default R5,C0,S33-57,B34-45) instead of the usual 8-neighbor Moore rule. While active, Ctrl+H, Alt+X, Ctrl+I, B/Ctrl+B, Shift+V, Shift+Y, and Alt+N are disabled; press Alt+H again to leave LTL mode and restore the rule you had before.'],
      ]
    },
    {
      name: 'I',
      items: [
        ['I', 'Open statistics modal'],
        ['Shift+I', 'Toggle legacy mode (restrict allowed keys)'],
        ['Ctrl+I', 'Toggle Hex Mode: animated swap to a hexagonal grid (B2/S34, 6-neighbor rules). While active, most controls are restricted -- see "Hex Mode" below. Not available in Larger-than-Life mode.'],
      ]
    },
    {
      name: 'J',
      items: [
        ['J', 'Spawn 15×15 random noise centered on screen'],
        ['Shift+J', 'Spawn 31×31 "super" noise'],
        ['Ctrl+J', 'Spawn 45×45 "ultra" noise'],
        ['Alt+J', 'Spawn 250×250 "mega" noise at 44% density -- empirically tuned to keep Larger-than-Life mode\'s default Bosco\'s-rule dynamic instead of dying out or freezing'],
      ]
    },
    {
      name: 'K',
      items: [
        ['K', 'Flip attached template horizontally'],
        ['Shift+K', 'Toggle G-key enable/disable state'],
        ['Ctrl+K', 'Open Snapshot menu (load/rename/delete/download saved snapshots)'],
      ]
    },
    {
      name: 'L',
      items: [
        ['L', 'Open age color legend modal'],
        ['Shift+L', 'Increase cell brightness'],
        ['Ctrl+L', 'Open Macrocell (.mc) import modal (for large quadtree-encoded patterns) -- not available in Hex Mode'],
      ]
    },
    {
      name: 'M',
      items: [
        ['M', 'Rotate attached template right (CW)'],
        ['Shift+M', 'Open identification modal (scan for pattern instances) -- not available in Hex Mode'],
        ['Ctrl+M', 'Take a snapshot of the current board (saved to Snapshot menu, Ctrl+K)'],
      ]
    },
    {
      name: 'N',
      items: [
        ['N', 'Rotate attached template left (CCW)'],
        ['Shift+N', 'Toggle grid visibility'],
        ['Alt+N', "Toggle Portal mode (not available on mobile, Hex Mode, or Larger-than-Life mode). While active: X (hold) draws a portal piece on the grid edge nearest the cursor, Shift+X (hold) draws a straight run of portal pieces from where the key was first pressed out to the current mouse position, locked to that starting edge's orientation and immune to perpendicular mouse drift (only movement along the locked axis affects the line, so it can't waver off-straight), live-updating as you move the mouse, Z (hold) erases one, C hovers+links two portal groups together (press C over one portal, then hover the other and press C again), and V toggles a subtle overlay line between every linked pair so you can see at a glance what's connected to what. Touching pieces merge into one group automatically. Cells (e.g. a spaceship) that cross a linked portal edge are treated as adjacent to the linked portal's far side, so patterns pass through intact instead of dying at the edge. Crossing points line up 1:1 along each portal's length -- a pattern only passes through cleanly where both linked portals are the same length (or along the overlapping stretch of two different-length portals); any extra length beyond that overlap behaves like a normal wall with no link, rather than squeezing the pattern to fit. Severing a linked portal into separate pieces leaves the link with the larger piece (a tie is 50/50); linking an already-linked portal to a new target replaces the old link. Alt+G (outside Portal mode) removes every portal on the board without touching anything else; Ctrl+G's hard wipe also clears all portals along with everything else it removes."],
      ]
    },
    {
      name: 'O',
      items: [
        ['O (hold)', 'Begin drag-select; release opens selection modal'],
        ['Shift+O', 'Decrease cell brightness'],
      ]
    },
    {
      name: 'P',
      items: [
        ['P', 'Toggle P-mode (virtual Shift)'],
        ['P (hold via keys) combined', 'Acts as virtual Shift for other shortcuts'],
      ]
    },
    {
      name: 'Q',
      items: [
        ['Ctrl+Q', 'Clear the persistent landing map and hide its overlay'],
        ['Q', 'Toggle pause / resume simulation'],
        ['Shift+Q', 'Toggle crosshair mode (X/Z operate at crosshair)'],
      ]
    },
    {
      name: 'R',
      items: [
        ['R', 'Increase tick rate (faster)'],
        ['Shift+R', 'Extreme tick rate (7,500,000 tps)'],
        ['Ctrl+R', 'Open Super-Speed menu (set 1–100× per-frame multiplier)'],
      ]
    },
    {
      name: 'S',
      items: [
        ['Ctrl+S', "Reset all cells' ages (set birth timestamps to now)"],
        ['S', 'Zoom in (centered) -- also zooms while following a tracked cluster'],
        ['Shift+S', 'Reset zoom to default cell size'],
        ['Alt+S', 'Open File Converter: load a .lif, .rle, .mc, or .cells file and convert it to any of the other three formats. Converting from .mc to .lif or .cells warns first, since macrocell is compressed and the flat text formats can bloat dramatically.'],
      ]
    },
    {
      name: 'T',
      items: [
        ['T', 'Open RLE import modal (paste/upload .txt) -- not available in Hex Mode'],
        ['Shift+T', 'Delete only alive cells (preserve invincible)'],
      ]
    },
    {
      name: 'U',
      items: [
        ['U', 'Open Controls & Keys help (this dialog)'],
        ['Shift+U', 'Delete faded / multi-state cells only'],
      ]
    },
    {
      name: 'V',
      items: [
        ['V', 'Increase panStep (camera speed)'],
        ['Shift+V', 'Toggle reverse-time (rewind) mode -- not available in Larger-than-Life mode'],
        ['Ctrl+V', 'Toggle Live Cluster Highlight overlay (sensitivity slider) -- not available in Hex Mode'],
      ]
    },
    {
      name: 'W',
      items: [
        ['W', 'Reset tick rate to default'],
        ['Shift+W', 'Reset camera to origin (offsetX/offsetY = 0)'],
      ]
    },
    {
      name: 'X',
      items: [
        ['Ctrl+X', 'Open quick preset-scan menu (choose a preset, scan map, preview matches, download image)'],
        ['X (hold)', 'Draw at cursor (create live cells)'],
        ['Shift+X (hold)', 'Place invincible permanent wall pixels; while template attached place template as invincible'],
        ['Alt+X', 'Open Ancestor Finder: searches for 5-10 predecessor states of the current board (B3/S23 only, not available in Hex Mode or Larger-than-Life mode). Strict mode (on by default) excludes incidental non-interacting extra cells from results; optional multi-generation chaining and a "thorough" search-effort setting are also available.'],
        ['X (in Cluster Tracking mode)', 'Starts the camera following whatever cluster is under the mouse; while already following, X retargets to the cluster now under the mouse instead of drawing.'],
      ]
    },
    {
      name: 'Y',
      items: [
        ['Y', 'Open presets modal (attach/copy contraptions) -- not available in Hex Mode'],
        ['Shift+Y', 'Open rule-presets modal (load rules) -- not available in Hex Mode, not available in Larger-than-Life mode'],
        ['Alt+Y', 'Open LTL Presets modal: a separate contraption library built for Larger-than-Life mode (e.g. Bug-Collection)'],
      ]
    },
    {
      name: 'Z',
      items: [
        ['Ctrl+Z', 'Toggle next-generation preview (white dots = births; black dots = deaths)'],
        ['Z (hold)', 'Erase at cursor (remove live or invincible)'],
        ['Shift+Z', 'Toggle age-color spatial blending (disable/enable)'],
        ['Alt+Z', 'Export every cell on the board as a .mc (macrocell) file (automatic download)'],
        ['Z (while following a cluster)', 'Stops following and returns full keyboard control'],
      ]
    },
    {
      name: 'Cluster Tracking (Alt+A)',
      items: [
        ['Alt+A', 'Toggle Cluster Tracking mode on/off. A hidden version of Ctrl+V\'s Live Cluster Highlight -- it silently groups nearby live cells (fixed sensitivity of 5) but draws no polygons.'],
        ['X', 'While tracking mode is on and nothing is being followed: picks the cluster under the mouse and locks the camera onto it.'],
        ['A / S', 'Zoom in/out while following -- stays centered on the tracked cluster.'],
        ['Z', 'Stops following.'],
        ['X (while following)', 'Retargets to whichever cluster is currently under the mouse.'],
        ['Everything else', 'Blocked while following, including arrow-key panning, since the camera is driven by the tracked cluster\'s own movement each frame.'],
      ]
    },
    {
      name: 'Arrows & Space',
      items: [
        ['Arrow keys', 'Pan view (or move crosshair when crosshair mode + Space held)'],
        ['Space (hold)', 'With crosshair mode: enable arrow-based crosshair movement; alone used to skip startup when active'],
      ]
    },
    {
      name: 'Hex Mode',
      items: [
        ['Ctrl+I', 'Toggle Hex Mode: animated pixelate/fade transition into a hexagonal 6-neighbor grid (default rule B2/S34)'],
        ['Ctrl+I (again)', 'Transition back to the normal square grid (default rule B3/S23)'],
        ['Ctrl+B (while active)', 'Resets rules to Hex Mode\'s own default, B2/S34, instead of B3/S23'],
        ['Allowed while active', 'A S Z X, J / Ctrl+J / Shift+J, F, Arrow keys, Q W E, R / Shift+R / Ctrl+R, P, Shift+O, Shift+L, C V D B / Ctrl+B, Shift+Z, U, G / Ctrl+G'],
        ['Blocked while active', 'RLE import/export, pattern & rule presets, Macrocell import, the Identification scanner, the Ancestor Finder (Alt+X), Rule Spots, FastForward, Live Cluster Highlight, and any other key not listed above -- these are built around the square grid and don\'t have a meaningful hex equivalent'],
        ['Snapshots (Ctrl+K/Ctrl+M)', 'Still work, but a snapshot can only be loaded back in the same mode (square or hex) it was taken in -- the menu shows a "Hex" tag on snapshots captured in Hex Mode'],
      ]
    },
    {
      name: 'Larger-than-Life Mode',
      items: [
        ['Alt+H', 'Toggle Larger-than-Life (LTL) mode: switches from the usual 8-neighbor Moore rule to a radius-based neighbor-count rule. Applies the default rule R5,C0,S33-57,B34-45 on entry, and remembers whatever B/S rule was active beforehand so it can be restored.'],
        ['Alt+H (again)', 'Leave LTL mode and restore the B/S rule that was active before it was turned on'],
        ['B', 'Open the LTL rule prompt: R<radius>,C<states>,S<min>-<max>,B<min>-<max> (S/B may also be a single number). S/B\'s max is capped by the current radius (a bigger window fits more neighbors) -- change R to raise or lower that ceiling. C works like classic mode\'s /G: C>=3 makes cells that fail survival fade over C-1 steps instead of dying immediately.'],
        ['Ctrl+B', 'Reset the LTL rule back to the default rule (R5,C0,S33-57,B34-45) and clear any mid-fade cells'],
        ['Alt+J', 'Spawn a 250×250 noise block at 44% density -- empirically tuned to keep LTL\'s default Bosco\'s-rule lively (works outside LTL mode too, just less useful there)'],
        ['Alt+Y', 'Open the LTL Presets modal, a separate contraption library (e.g. Bug-Collection) built for LTL\'s rule model rather than classic Life'],
        ['Blocked while active', 'Ctrl+H (FastForward), Alt+X (Ancestor Finder), Ctrl+I (Hex Mode), Shift+V (reverse-time), Shift+Y (rule presets), Alt+N (Portal mode), and Ctrl+E (Rule Spot panel) -- these are built around a fixed small Moore neighborhood or B3/S23-family rules and don\'t translate to LTL\'s much larger radius'],
        ['Mutually exclusive with Hex Mode', 'Entering Hex Mode force-exits LTL mode (and vice versa) since the two use incompatible grid topologies'],
      ]
    },
    {
      name: 'Mouse & Templates',
      items: [
        ['Mouse move', 'Position template preview or cursor for draw/erase'],
        ['Drag-and-drop files', 'Drop .txt RLE into import modal to load template'],
        ['File input/ZIP', 'Load folder ZIP of .txt instances in Identification modal'],
      ]
    },
    {
      name: 'Modifiers',
      items: [
        ['Shift (modifier)', 'Used in many combos (Shift+Key) to alter behavior'],
        ['Ctrl (modifier)', 'Used for hard-wipe (Ctrl+G) and ultra-J (Ctrl+J)'],
        ['Alt/Meta', 'Alt is used for several combos (Alt+H/J/Y toggle & seed Larger-than-Life mode; Alt+X Ancestor Finder; Alt+N Portal mode; Alt+D Tutorial; Alt+F/Z/G exports; Alt+A Cluster Tracking); Meta is unused/reserved'],
        ['/', 'Toggle small FPS counter'],
      ]
    },
    {
      name: 'Other',
      items: [
        ['Shift+Escape', 'Return to main menu overlay'],
        ['` (backtick)', 'Show cell info for cell under pointer'],
        ['-', 'Decrease crosshair speed'],
        ['Shift+-', 'Center crosshair (when crosshair mode active)'],
        ['=', 'Increase crosshair speed'],
        ['Shift+=', 'Reset crosshair speed to default'],
      ]
    }
  ];

  // render sections and items
  for (const sec of sections) {
    const header = document.createElement('div');
    header.textContent = sec.name;
    Object.assign(header.style, { fontWeight: '700', marginTop: '10px', marginBottom: '6px' });
    modal.appendChild(header);

    for (const [k, desc] of sec.items) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.padding = '6px 4px';
      row.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
      const keyEl = document.createElement('div');
      keyEl.textContent = k;
      Object.assign(keyEl.style, { fontWeight: '700', color: '#fff', minWidth: '140px' });
      const descEl = document.createElement('div');
      descEl.textContent = desc;
      Object.assign(descEl.style, { color: 'rgba(255,255,255,0.85)', marginLeft: '12px', flex: '1' });
      row.appendChild(keyEl);
      row.appendChild(descEl);
      modal.appendChild(row);
    }
  }

  const closeRow = document.createElement('div');
  closeRow.style.display = 'flex';
  closeRow.style.justifyContent = 'flex-end';
  closeRow.style.marginTop = '8px';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 12px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    const el = document.getElementById('help-modal');
    if (el) el.remove();
  });
  closeRow.appendChild(closeBtn);
  modal.appendChild(closeRow);

  document.body.appendChild(modal);
}

/* Modal explaining the age-color stages and their meaning. Opened with L. */
function openAgeLegendModal() {
  if (document.getElementById('age-legend-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'age-legend-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '14px', borderRadius: '8px', zIndex: 10001,
    width: 'min(90vw,520px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  // top-right close button for scrolling age legend modal
  const topCloseBtn_legend = document.createElement('button');
  topCloseBtn_legend.textContent = 'Close';
  Object.assign(topCloseBtn_legend.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    padding: '6px 10px',
    cursor: 'pointer',
    zIndex: 10002
  });
  topCloseBtn_legend.addEventListener('click', () => {
    const el = document.getElementById('age-legend-modal');
    if (el) el.remove();
  });
  modal.appendChild(topCloseBtn_legend);

  const title = document.createElement('div');
  title.textContent = 'Age Colors — Legend & Guide';
  Object.assign(title.style, { marginBottom: '8px', fontWeight: '700', fontSize: '16px' });
  modal.appendChild(title);

  const desc = document.createElement('div');
  desc.style.fontSize = '13px';
  desc.style.color = 'rgba(255,255,255,0.9)';
  desc.style.lineHeight = '1.4';
  desc.innerHTML = `
    The age overlay colors each live cell according to how long it has been continuously alive
    (excluding time spent paused). Colors progress through stages over time to help you spot
    old structures, long-lived regions, and recent births.<br><br>
    Stages and durations:
    <ul>
      <li><strong>Light green → Navy</strong> — first 23.5 seconds: brand-new cells grow from light green to navy.</li>
      <li><strong>Navy → Dark purple</strong> — next 35 seconds.</li>
      <li><strong>Dark purple → Dark red</strong> — next 47.5 seconds.</li>
      <li><strong>Dark red → Dark yellow</strong> — next 65 seconds.</li>
      <li><strong>Dark yellow → Dark green</strong> — next 90 seconds.</li>
      <li><strong>Dark green → Very dark teal</strong> — next 100 seconds, ending at a terminal very-dark-teal.</li>
    </ul>
    Use the F key to toggle the age overlay on/off. Press L to view this guide again.
  `;
  modal.appendChild(desc);

  const closeRow = document.createElement('div');
  closeRow.style.display = 'flex';
  closeRow.style.justifyContent = 'flex-end';
  closeRow.style.marginTop = '12px';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 12px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    const el = document.getElementById('age-legend-modal');
    if (el) el.remove();
  });
  closeRow.appendChild(closeBtn);
  modal.appendChild(closeRow);

  document.body.appendChild(modal);
}

/* Rule presets modal (Shift+Y)
   Each preset shows a live preview canvas that runs a tiny local Life simulation under its rule.
   Previews start with the same "J" noise block and reset when they hit 3750 alive cells or 20s.
   Clicking "Load" copies the rule string into the main rule state (birthRules/survivalRules). */

/* Preset rule definitions with classes (Class I..IV) updated to match the supplied classification. */
const rulePresets = [
  { name: 'Walled Cities', rule: 'B45678/S2345' },
  // Ordered from least explosive (top) to most explosive (bottom).
  { name: 'Sierpinski Madness', rule: 'B1/S12' },
  { name: 'ChronalLife', rule: 'B3/S23/G3' },
  { name: 'Conway (Life)', rule: 'B3/S23' },
  { name: 'Loosely Stable (Gasket)', rule: 'B3/S012345678' }, // Gasket - full survival
  { name: 'Inlife', rule: 'B2/S2345' },
  { name: 'SoftMac', rule: 'B34/S23/G4' },

  { name: 'HighLife (replicator)', rule: 'B36/S23' },
  { name: 'Glitter', rule: 'B36/S245' },
  { name: 'Plow', rule: 'B37/S2378' },
  { name: 'Ebb and Flow', rule: 'B37/S012468' },
  { name: 'Assimilation', rule: 'B345/S4567' },
  { name: 'Move', rule: 'B3457/S2367' },
  { name: '34 Life', rule: 'B34/S34' },
  { name: 'Coral', rule: 'B3/S45678' },
  { name: 'Fungi', rule: 'B35678/S4678' },
  { name: 'Puffers Paradise', rule: 'B3568/S24678' },
  { name: 'The Amoeba', rule: 'B357/S1358' },
  { name: 'Morley', rule: 'B3578/S24678' },
  { name: 'Honeylife', rule: 'B3/S238' },
  { name: 'Replicator', rule: 'B1357/S1357' },
  { name: 'Diamoeba', rule: 'B35678/S5678' },
  { name: 'BelZhab', rule: 'B23/S23/G8' },
  { name: 'HydroDynamics', rule: 'B2345/S2345/G4' },
  { name: 'Oscillotto', rule: 'B3/S234/G10' },
  { name: 'Starwars', rule: 'B2/S34/G4' },
  { name: "Brian's Brain", rule: 'B2/S/G3' },
  { name: 'Fader', rule: 'B2/S2/G5' },
  { name: 'Meteor Guns', rule: 'B012478/S01235678/G8' },
  { name: 'Seeds (explosive)', rule: 'B2/S' },
  { name: 'Sparse Fizzler (B12/S)', rule: 'B12/S' }
];

/* Utility: parse rule string like "B3/S23" or "B3/S23/4" into two Sets and optional state count C.
   Returns { b: Set<number>, s: Set<number>, c: number } where c >= 2 (default 2). */
function parseRuleString(str) {
  if (!str) return { b: new Set(), s: new Set(), c: 2 };
  const up = str.toUpperCase().trim();

  // Accept optional third section that may start with 'G' (e.g. /G4) or be plain numeric when coming from internal presets.
  // We accept both "/G4" and "/4" for backwards compatibility in parsing, but the input prompt enforces that
  // user-typed generational sections must include the leading 'G'.
  // Regex breakdown:
  //  ^B([0-8]*)\/S([0-8]*)(?:\/(?:G)?([0-9]+))?$
  const m = up.match(/^B([0-8]*)\/S([0-8]*)(?:\/(?:G)?([0-9]+))?$/);
  if (!m) return { b: new Set(), s: new Set(), c: 2 };
  const b = new Set(); const s = new Set();
  for (const ch of (m[1] || '')) { const n = ch.charCodeAt(0) - 48; if (n >= 0 && n <= 8) b.add(n); }
  for (const ch of (m[2] || '')) { const n = ch.charCodeAt(0) - 48; if (n >= 0 && n <= 8) s.add(n); }
  // parse optional C; clamp to at least 2 and to a reasonable max (now 256)
  let c = 2;
  if (m[3]) {
    const parsed = parseInt(m[3], 10);
    if (!isNaN(parsed) && parsed >= 2) c = Math.min(256, parsed);
  }
  return { b, s, c };
}

 // Tiny in-memory simulation for previews: square grid with wrap disabled (clamped)
 // now supports generational C-state rules where C>=2 (C==2 is classic binary life).
 function createPreviewSim(size = 64, cellStatesCount = 2) {
   const sim = {
     size,
     // store uint8 states 0..C-1 where 1 is the "alive" neighbor-counting state;
     // states >=2 are fading states that auto-advance each generation.
     grid: new Uint8Array(size * size),
     temp: new Uint8Array(size * size),
     birthRule: new Set([3]),
     survRule: new Set([2,3]),
     cellStatesCount: Math.max(2, Math.min(256, Math.floor(cellStatesCount))),
     startTime: performance.now(),
     stepCount: 0,
     aliveCount: 0,
   };
   function idx(x,y){ return y*size + x; }
   // seed with J-like 15x15 noise centered: set cells to state==1
   function seedNoise() {
     sim.grid.fill(0);
     const half = 7;
     const cx = Math.floor(size/2);
     const cy = Math.floor(size/2);
     sim.aliveCount = 0;
     for (let dx=-half; dx<=half; dx++){
       for (let dy=-half; dy<=half; dy++){
         if (Math.random() < 0.5) {
           const x = cx + dx, y = cy + dy;
           if (x>=0 && x<size && y>=0 && y<size) {
             sim.grid[idx(x,y)] = 1; // state 1 = alive
             sim.aliveCount++;
           }
         }
       }
     }
     sim.startTime = performance.now();
     sim.stepCount = 0;
   }
   seedNoise();
   sim.seedNoise = seedNoise;

   sim.step = function() {
     const s = size;
     let alive = 0;
     // neighbor counts consider only state==1 cells
     for (let y=0;y<s;y++){
       for (let x=0;x<s;x++){
         let n = 0;
         for (let oy=-1; oy<=1; oy++){
           for (let ox=-1; ox<=1; ox++){
             if (ox===0 && oy===0) continue;
             const nx = x+ox, ny = y+oy;
             if (nx<0 || nx>=s || ny<0 || ny>=s) continue; // clamp (no wrapping)
             if (sim.grid[idx(nx,ny)] === 1) n += 1;
           }
         }
         const cur = sim.grid[idx(x,y)];
         let outState = 0;
         if (cur === 1) {
           // alive: survive -> remain state 1; else go to first fading state (2) or die if C==2
           if (sim.survRule.has(n)) {
             outState = 1;
           } else {
             if (sim.cellStatesCount >= 3) {
               outState = 2; // first fading state
             } else {
               outState = 0; // die
             }
           }
         } else if (cur === 0) {
           // dead: birth only creates state 1
           outState = sim.birthRule.has(n) ? 1 : 0;
         } else {
           // fading state >=2: auto-advance by 1; if reaches cellStatesCount -> 0
           const advanced = cur + 1;
           outState = (advanced < sim.cellStatesCount) ? advanced : 0;
         }
         sim.temp[idx(x,y)] = outState;
         if (outState === 1) alive++;
       }
     }
     // swap buffers
     const t = sim.grid; sim.grid = sim.temp; sim.temp = t;
     sim.aliveCount = alive;
     sim.stepCount++;
     return alive;
   };
   return sim;
 }

// Create a small animation loop for a preview canvas element
function startPreviewLoop(canvas, ruleString) {
  const size = 96; // internal sim size (keeps preview crisp but small)
  const parsed = parseRuleString(ruleString);
  const sim = createPreviewSim(size, parsed.c || 2);
  // apply ruleString to sim
  sim.birthRule = parsed.b;
  sim.survRule = parsed.s;

  sim.seedNoise();

  const ctxp = canvas.getContext('2d');
  canvas.width = 160; canvas.height = 120;
  // draw scale: map sim grid to canvas; visualize state==1 green, fading states as dimming shades
  function drawOnce() {
    const s = sim.size;
    const cellW = canvas.width / s;
    const cellH = canvas.height / s;
    ctxp.fillStyle = '#000';
    ctxp.fillRect(0,0,canvas.width,canvas.height);
    for (let y=0;y<s;y++){
      for (let x=0;x<s;x++){
        const st = sim.grid[y*s + x];
        if (st === 0) continue;
        const sx = Math.floor(x*cellW);
        const sy = Math.floor(y*cellH);
        if (st === 1) {
          ctxp.fillStyle = '#0f0';
        } else {
          // fading states: map 2..C-1 to a gray-to-dark gradient
          const maxFade = Math.max(2, sim.cellStatesCount - 1);
          const idx = st - 2;
          const t = Math.max(0, Math.min(1, idx / Math.max(1, maxFade - 1)));
          // lerp from light gray to dark gray
          const v = Math.round(200 - (160 * t)); // 200 -> 40
          ctxp.fillStyle = `rgb(${v},${v},${v})`;
        }
        ctxp.fillRect(sx, sy, Math.max(1,Math.ceil(cellW)), Math.max(1,Math.ceil(cellH)));
      }
    }
  }

  let rafId = null;
  let lastTick = performance.now();
  function loop() {
    const now = performance.now();
    // step simulation at a modest speed to make preview lively (30 steps/sec)
    if (now - lastTick >= 33) {
      // re-parse rule in case external UI changed string (keeps preview responsive)
      const parsedNow = parseRuleString(ruleString);
      sim.birthRule = parsedNow.b;
      sim.survRule = parsedNow.s;
      // ensure sim.cellStatesCount matches parsed c (if changed, recreate would be ideal,
      // but for preview we clamp and continue with current grid)
      sim.step();
      lastTick = now;
    }
    drawOnce();
    // Reset conditions: alive >= 3750 OR zero alive OR elapsed > 20s
    if (sim.aliveCount >= 3750 || sim.aliveCount === 0 || (now - sim.startTime) > 20000) {
      sim.seedNoise();
    }
    rafId = requestAnimationFrame(loop);
  }
  loop();

  // return a stop function to cancel animation
  return () => { if (rafId) cancelAnimationFrame(rafId); };
}

// Build and open the rule preset modal
function openRulePresetModal() {
  if (document.getElementById('rule-preset-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'rule-preset-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 9999,
    width: 'min(92vw,560px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  // top-right close button for scrolling rule presets modal
  const topCloseBtn_rules = document.createElement('button');
  topCloseBtn_rules.textContent = 'Close';
  Object.assign(topCloseBtn_rules.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    padding: '6px 10px',
    cursor: 'pointer',
    zIndex: 10001
  });
  topCloseBtn_rules.addEventListener('click', () => {
    const el = document.getElementById('rule-preset-modal');
    if (el) el.remove();
  });
  modal.appendChild(topCloseBtn_rules);

  const title = document.createElement('div');
  title.textContent = 'Rule Presets (ordered least → most explosive)';
  Object.assign(title.style, { marginBottom: '6px', fontWeight: '600' });
  modal.appendChild(title);

  const info = document.createElement('div');
  info.style.fontSize = '13px';
  info.style.color = 'rgba(255,255,255,0.88)';
  info.style.marginBottom = '10px';
  info.textContent = 'Presets are listed from least explosive (top) to most explosive (bottom). Rules with larger B-sets and minimal S-sets are considered more explosive.';
  modal.appendChild(info);

  // container for preview rows
  const previewStops = []; // will hold cleanup functions

  // Render presets in their defined order (top -> bottom)
  for (const p of rulePresets) {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' });

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { width: '160px', height: '120px', flex: '0 0 auto', border: '1px solid rgba(255,255,255,0.06)', background: '#000' });
    row.appendChild(canvas);

    const meta = document.createElement('div');
    meta.style.flex = '1';
    const name = document.createElement('div');
    name.textContent = p.name || '(unnamed)';
    name.style.fontWeight = '700';
    const ruleLine = document.createElement('div');
    ruleLine.textContent = p.rule;
    ruleLine.style.fontSize = '13px';
    ruleLine.style.color = 'rgba(255,255,255,0.85)';
    meta.appendChild(name);
    meta.appendChild(ruleLine);

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.flexDirection = 'column';
    controls.style.gap = '6px';
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    Object.assign(loadBtn.style, { padding: '6px 10px', cursor: 'pointer' });
    loadBtn.addEventListener('click', () => {
      const parsed = parseRuleString(p.rule);
      birthRules = parsed.b;
      survivalRules = parsed.s;
      cellStatesCount = parsed.c || 2;
      flashTinyToast(`Loaded rule: ${p.rule}${cellStatesCount>2?('/'+cellStatesCount):''}`);
    });

    // New "Load & Close" button: loads the rule and closes the modal, cleaning up previews.
    const loadCloseBtn = document.createElement('button');
    loadCloseBtn.textContent = 'Load & Close';
    Object.assign(loadCloseBtn.style, { padding: '6px 10px', cursor: 'pointer' });
    loadCloseBtn.addEventListener('click', () => {
      const parsed = parseRuleString(p.rule);
      birthRules = parsed.b;
      survivalRules = parsed.s;
      cellStatesCount = parsed.c || 2;
      flashTinyToast(`Loaded rule: ${p.rule}${cellStatesCount>2?('/'+cellStatesCount):''}`);
      // cleanup preview loops and remove the modal
      for (const s of previewStops) try { s(); } catch (e) {}
      const el = document.getElementById('rule-preset-modal');
      if (el) el.remove();
    });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    Object.assign(copyBtn.style, { padding: '6px 10px', cursor: 'pointer' });
    copyBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(p.rule);
        else {
          const ta = document.createElement('textarea'); ta.value = p.rule; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        }
        flashTinyToast(`Copied rule: ${p.rule}`);
      } catch (err) {
        alert('Copy failed: ' + err);
      }
    });

    controls.appendChild(loadBtn);
    controls.appendChild(loadCloseBtn);
    controls.appendChild(copyBtn);

    row.appendChild(meta);
    row.appendChild(controls);
    modal.appendChild(row);

    // start live preview for this canvas
    const stopFn = startPreviewLoop(canvas, p.rule);
    previewStops.push(stopFn);
  }

  const closeRow = document.createElement('div');
  closeRow.style.display = 'flex';
  closeRow.style.justifyContent = 'flex-end';
  closeRow.style.marginTop = '8px';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 12px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    // cleanup preview loops
    for (const s of previewStops) try { s(); } catch (e) {}
    const el = document.getElementById('rule-preset-modal');
    if (el) el.remove();
  });
  closeRow.appendChild(closeBtn);
  modal.appendChild(closeRow);

  // if modal removed by other means ensure cleanup using MutationObserver
  const observer = new MutationObserver(() => {
    if (!document.getElementById('rule-preset-modal')) {
      for (const s of previewStops) try { s(); } catch (e) {}
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  document.body.appendChild(modal);
}

/* Cluster-scan modal and scanning routine:
   - Ctrl+F opens the cluster-scan UI where the user can set sensitivity (cells radius).
   - Scan groups alive cells into clusters if any two cells are within the sensitivity distance,
     using union-find to form connected components and then display a preview with cluster highlights.
   - Sensitivity ranges from 5..750 (default 10). */
function openClusterScanModal() {
  if (document.getElementById('cluster-scan-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'cluster-scan-modal';
  // make modal more compact: reduced padding and tighter max width
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '8px', borderRadius: '8px', zIndex: 14000,
    width: 'min(90vw,640px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontSize: '13px', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Cluster Scanner';
  Object.assign(title.style, { fontWeight: '700', marginBottom: '6px', fontSize: '15px' });
  modal.appendChild(title);

  const help = document.createElement('div');
  help.textContent = 'Detect clusters where cells are within a sensitivity radius; default 10 (min 5, max 750).';
  Object.assign(help.style, { color: 'rgba(255,255,255,0.85)', marginBottom: '8px' });
  modal.appendChild(help);

  // compact controls row with inline download select
  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.alignItems = 'center';
  controls.style.gap = '8px';
  controls.style.marginBottom = '8px';

  const label = document.createElement('label');
  label.textContent = 'Sensitivity:';
  label.style.fontWeight = '600';
  controls.appendChild(label);

  const input = document.createElement('input');
  input.type = 'number';
  input.min = '5';
  input.max = '750';
  input.value = '10';
  input.style.width = '78px';
  input.style.padding = '4px';
  input.style.fontSize = '13px';
  controls.appendChild(input);

  const scanBtn = document.createElement('button');
  scanBtn.textContent = 'Scan';
  Object.assign(scanBtn.style, { padding: '6px 8px', cursor: 'pointer', fontSize: '13px' });
  controls.appendChild(scanBtn);

  // compact download controls: select + button
  const dlSel = document.createElement('select');
  ['image/png','image/jpeg','image/webp'].forEach(mime => {
    const o = document.createElement('option'); o.value = mime; o.textContent = mime.split('/')[1].toUpperCase();
    dlSel.appendChild(o);
  });
  dlSel.style.padding = '4px';
  dlSel.style.fontSize = '13px';
  controls.appendChild(dlSel);

  const downloadBtn = document.createElement('button');
  downloadBtn.textContent = 'Download as…';
  Object.assign(downloadBtn.style, { padding: '6px 8px', cursor: 'pointer', fontSize: '13px' });
  controls.appendChild(downloadBtn);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '6px 8px', cursor: 'pointer', fontSize: '13px' });
  closeBtn.addEventListener('click', () => {
    const el = document.getElementById('cluster-scan-modal');
    if (el) el.remove();
  });
  controls.appendChild(closeBtn);

  modal.appendChild(controls);

  // compact canvas preview area (improved: stable backing store, smooth CSS scaling & transitions)
  const canvasWrap = document.createElement('div');
  canvasWrap.style.background = 'rgba(255,255,255,0.02)';
  canvasWrap.style.padding = '8px';
  canvasWrap.style.borderRadius = '6px';
  canvasWrap.style.display = 'flex';
  canvasWrap.style.flexDirection = 'column';
  canvasWrap.style.alignItems = 'center';
  canvasWrap.style.justifyContent = 'center';
  canvasWrap.style.minHeight = '180px';

  // Create a high-DPR backing store once and keep CSS size independent to avoid bitmap resampling jitter.
  const preview = document.createElement('canvas');
  // target logical CSS size (keeps layout compact)
  const cssW = Math.min(900, Math.max(360, Math.floor(window.innerWidth * 0.6)));
  const cssH = Math.min(600, Math.max(220, Math.floor(window.innerHeight * 0.45)));
  // backing store uses DPR to keep pixels crisp
  preview.width = Math.max(1, Math.floor(cssW * DPR));
  preview.height = Math.max(1, Math.floor(cssH * DPR));
  preview.style.width = cssW + 'px';
  preview.style.height = cssH + 'px';
  preview.style.maxWidth = '100%';
  preview.style.border = '1px solid rgba(255,255,255,0.06)';
  // smooth scaling transition and hint to browser to avoid jank
  // NOTE: this transition must be OFF while the user is actively dragging or wheel-zooming,
  // otherwise every pointermove/wheel tick gets eased over 180ms and the preview visibly
  // lags/rubber-bands behind the cursor. We toggle it on only for discrete actions
  // (zoom buttons, reset, double-click) via setPreviewTransition() below.
  preview.style.transition = 'none';
  preview.style.willChange = 'transform';
  preview.style.transformOrigin = '0 0';
  function setPreviewTransition(on) {
    preview.style.transition = on ? 'transform 180ms ease' : 'none';
  }
  // keep a stable 2d context and set transform once for DPR
  const __pctx = preview.getContext('2d');
  __pctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  canvasWrap.appendChild(preview);

  // compact zoom controls (inline, unobtrusive)
  const zoomRow = document.createElement('div');
  zoomRow.style.display = 'flex';
  zoomRow.style.justifyContent = 'center';
  zoomRow.style.gap = '8px';
  zoomRow.style.marginTop = '8px';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.textContent = '−';
  Object.assign(zoomOutBtn.style, { width: '36px', height: '28px', fontSize: '18px', cursor: 'pointer' });
  const resetZoomBtn = document.createElement('button');
  resetZoomBtn.textContent = 'Reset';
  Object.assign(resetZoomBtn.style, { padding: '6px 10px', cursor: 'pointer' });
  const zoomInBtn = document.createElement('button');
  zoomInBtn.textContent = '+';
  Object.assign(zoomInBtn.style, { width: '36px', height: '28px', fontSize: '18px', cursor: 'pointer' });

  zoomRow.appendChild(zoomOutBtn);
  zoomRow.appendChild(resetZoomBtn);
  zoomRow.appendChild(zoomInBtn);
  canvasWrap.appendChild(zoomRow);

  // maintain a stable numeric scale and apply CSS transform only (no canvas resizing) to avoid warping.
  // track visual transforms: scale + translate. translate values stored in dataset as tx/ty in CSS pixels
  preview.dataset.scale = '1';
  preview.dataset.tx = '0';
  preview.dataset.ty = '0';

  function applyPreviewScale(s, animate = true) {
    // clamp and round requested scale
    s = Math.max(0.5, Math.min(4, Math.round(s * 100) / 100));
    // preserve previous scale/translation
    const prevScale = parseFloat(preview.dataset.scale || '1');
    const prevTx = Number(preview.dataset.tx || 0);
    const prevTy = Number(preview.dataset.ty || 0);

    // compute the player's screen center in CSS pixels
    const playerCenterX = window.innerWidth / 2;
    const playerCenterY = window.innerHeight / 2;

    // compute preview's bounding rect so we can express the player's center relative to the preview element
    const rect = preview.getBoundingClientRect();
    // center point relative to preview's top-left (CSS pixels)
    const centerRelX = playerCenterX - rect.left;
    const centerRelY = playerCenterY - rect.top;

    // If the player's center is outside the preview element, do NOT attempt to re-anchor or pan the preview.
    // In that case we only change the scale while preserving current translation (so the preview does not move).
    const centerInsidePreview = (centerRelX >= 0 && centerRelX <= rect.width && centerRelY >= 0 && centerRelY <= rect.height);

    let newTx, newTy;
    if (!centerInsidePreview) {
      // Keep the current translation, only update scale. Avoid any centering/panning.
      newTx = prevTx;
      newTy = prevTy;
    } else {
      // Convert anchored coords into the preview's local coordinate system before scaling,
      // then compute a translation delta so that after scaling the anchored point remains visually
      // at the same screen location (anchored at player's center).
      const dx = (centerRelX - prevTx) / prevScale;
      const dy = (centerRelY - prevTy) / prevScale;

      // New translation (in CSS pixels) to keep anchored point stable:
      newTx = centerRelX - dx * s;
      newTy = centerRelY - dy * s;
    }

    // store new transform values
    preview.dataset.scale = String(s);
    preview.dataset.tx = String(newTx);
    preview.dataset.ty = String(newTy);

    // Briefly enable the eased transition only for this discrete change (button/reset/wheel-settle),
    // then turn it back off immediately after so a subsequent drag isn't laggy.
    if (animate) {
      setPreviewTransition(true);
      // turn it off again once the transition would have finished
      clearTimeout(preview._transitionOffTimer);
      preview._transitionOffTimer = setTimeout(() => setPreviewTransition(false), 200);
    } else {
      setPreviewTransition(false);
    }

    // Apply transform using the computed translation and scale.
    preview.style.transform = `translate(${newTx}px, ${newTy}px) scale(${s})`;

    // Keep transform-origin fixed at top-left always, so the drag math (which assumes 0,0)
    // and the anchoring math above stay consistent across scale changes -- switching origin
    // mid-interaction was causing a visible "jump" whenever zoom crossed back through 1x.
    preview.style.transformOrigin = '0 0';

    // When zoomed in, prevent the surrounding scanner modal from scrolling so only the preview is zoomable.
    try {
      if (s > 1) {
        canvasWrap.style.overflow = 'hidden';
      } else {
        canvasWrap.style.overflow = 'auto';
      }
      preview.style.pointerEvents = 'auto'; // keep pointer events so user can still drag/zoom at any scale
    } catch (e) {
      // fail silently
    }
    resetZoomBtn.title = `Zoom: ${s.toFixed(2)}×`;
  }

  // Click-and-drag panning support for the preview canvas.
  (function enablePreviewDrag() {
    let dragging = false;
    let startX = 0, startY = 0;
    let startTx = 0, startTy = 0;
    // pointer down
    preview.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      preview.setPointerCapture(ev.pointerId);
      dragging = true;
      startX = ev.clientX;
      startY = ev.clientY;
      startTx = Number(preview.dataset.tx || 0);
      startTy = Number(preview.dataset.ty || 0);
      // dragging must be instant -- kill any in-flight/pending eased transition immediately
      clearTimeout(preview._transitionOffTimer);
      setPreviewTransition(false);
      // add subtle pressed style
      preview.style.cursor = 'grabbing';
    });
    // pointer move
    preview.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const newTx = startTx + dx;
      const newTy = startTy + dy;
      preview.dataset.tx = String(newTx);
      preview.dataset.ty = String(newTy);
      const s = Number(preview.dataset.scale || 1);
      preview.style.transform = `translate(${newTx}px, ${newTy}px) scale(${s})`;
    });
    // pointer up / cancel
    function endDrag(ev) {
      if (!dragging) return;
      try { preview.releasePointerCapture(ev.pointerId); } catch(e) {}
      dragging = false;
      preview.style.cursor = 'zoom-in';
    }
    preview.addEventListener('pointerup', endDrag);
    preview.addEventListener('pointercancel', endDrag);

    // double-click to reset pan and scale
    preview.addEventListener('dblclick', () => {
      preview.dataset.tx = '0';
      preview.dataset.ty = '0';
      applyPreviewScale(1);
    });

    // keyboard-friendly nudges: arrow keys when hover to nudge translation slightly
    preview.addEventListener('mouseenter', () => {
      window.addEventListener('keydown', nudgeHandler);
    });
    preview.addEventListener('mouseleave', () => {
      window.removeEventListener('keydown', nudgeHandler);
    });
    function nudgeHandler(e) {
      const step = 8;
      let changed = false;
      let tx = Number(preview.dataset.tx || 0);
      let ty = Number(preview.dataset.ty || 0);
      if (e.key === 'ArrowLeft') { tx -= step; changed = true; }
      else if (e.key === 'ArrowRight') { tx += step; changed = true; }
      else if (e.key === 'ArrowUp') { ty -= step; changed = true; }
      else if (e.key === 'ArrowDown') { ty += step; changed = true; }
      if (changed) {
        // nudges should also be instant, not eased
        clearTimeout(preview._transitionOffTimer);
        setPreviewTransition(false);
        preview.dataset.tx = String(tx);
        preview.dataset.ty = String(ty);
        const s = Number(preview.dataset.scale || 1);
        preview.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
        e.preventDefault();
      }
    }
  })();

  zoomInBtn.addEventListener('click', () => {
    const s = Math.min(4, (parseFloat(preview.dataset.scale) || 1) * 1.5);
    applyPreviewScale(s, true);
  });
  zoomOutBtn.addEventListener('click', () => {
    const s = Math.max(0.5, (parseFloat(preview.dataset.scale) || 1) / 1.5);
    applyPreviewScale(s, true);
  });
  resetZoomBtn.addEventListener('click', () => applyPreviewScale(1, true));

  // click is intentionally disabled to prevent zooming when preview is clicked; wheel still zooms smoothly.
  preview.style.cursor = 'grab';
  preview.addEventListener('click', (ev) => {
    // noop: prevent accidental zoom on click
    ev.stopPropagation();
    ev.preventDefault();
  });
  preview.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const delta = ev.deltaY || ev.wheelDelta;
    const cur = parseFloat(preview.dataset.scale) || 1;
    const factor = delta > 0 ? (1 / 1.15) : 1.15;
    const next = Math.max(0.5, Math.min(4, cur * factor));
    // wheel fires rapidly in succession -- animating each tick fights itself and feels laggy,
    // so apply wheel zoom instantly (no easing) for a responsive feel.
    applyPreviewScale(next, false);
  }, { passive: false });

  // initialize with identity scale
  applyPreviewScale(1, false);

  modal.appendChild(canvasWrap);

  document.body.appendChild(modal);

  // helper: take current world alive + states as a set of integer coords
  function collectAllLiveCoords() {
    const coords = [];
    for (const k of alive) { const [x, y] = parseKey(k); coords.push({ x, y }); }
    for (const [k, st] of states.entries()) { const [x, y] = parseKey(k); coords.push({ x, y }); }
    return coords;
  }

  // union-find helpers
  function ufInit(n) { const p = new Array(n); for (let i=0;i<n;i++) p[i] = i; return p; }
  function ufFind(p, a) { if (p[a] === a) return a; p[a] = ufFind(p, p[a]); return p[a]; }
  function ufUnion(p, a, b) { const ra = ufFind(p, a), rb = ufFind(p, b); if (ra === rb) return; p[rb] = ra; }

  function computeClusters(coords, sensitivity) {
    const s = Math.max(1, Math.floor(sensitivity));
    const buckets = new Map();
    function bucketKey(ix, iy) { return ix + ',' + iy; }
    for (let i=0;i<coords.length;i++) {
      const c = coords[i];
      const bx = Math.floor(c.x / s);
      const by = Math.floor(c.y / s);
      const key = bucketKey(bx, by);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }
    const p = ufInit(coords.length);
    const offsets = [-1,0,1];
    for (const [key, list] of buckets.entries()) {
      const parts = parseKey(key);
      const bx = parts[0], by = parts[1];
      for (const di of list) {
        const a = coords[di];
        for (const ox of offsets) for (const oy of offsets) {
          const nk = bucketKey(bx + ox, by + oy);
          const neighborList = buckets.get(nk);
          if (!neighborList) continue;
          for (const dj of neighborList) {
            if (di >= dj) continue;
            const b = coords[dj];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            if ((dx*dx + dy*dy) <= (s*s)) ufUnion(p, di, dj);
          }
        }
      }
    }
    const comps = new Map();
    for (let i=0;i<coords.length;i++) {
      const r = ufFind(p, i);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(coords[i]);
    }
    return Array.from(comps.values());
  }

  function renderClusters(clusters) {
    const ctx = preview.getContext('2d');
    preview._lastClusters = clusters;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const cl of clusters) for (const c of cl) { if (c.x < minx) minx = c.x; if (c.x > maxx) maxx = c.x; if (c.y < miny) miny = c.y; if (c.y > maxy) maxy = c.y; }
    if (!isFinite(minx)) { ctx.fillStyle = invertColors ? '#fff' : '#000'; ctx.fillRect(0,0,preview.width, preview.height); preview._currentScale = 1; return; }
    minx -= 2; miny -= 2; maxx += 2; maxy += 2;
    const gw = maxx - minx + 1, gh = maxy - miny + 1;
    const maxLogicalW = preview.width / DPR, maxLogicalH = preview.height / DPR;
    // IMPORTANT: do NOT floor-and-clamp-to-1 here. Clamping to a minimum scale of 1 clips any
    // scan whose bounding box is larger than the preview canvas -- the whole point of a "scan"
    // is to show every cluster found, not just whatever happens to fit at 1px/cell. Instead,
    // allow the fit scale to shrink below 1 (fractional) so the entire scanned area always fits,
    // however large the world is; only use a floor of 1 when the content is actually small enough
    // to enlarge without needing to clip anything.
    const fitScale = Math.min(maxLogicalW / gw, maxLogicalH / gh);
    const scale = fitScale > 0 && isFinite(fitScale) ? fitScale : 1;
    const drawW = gw * scale, drawH = gh * scale;
    const offX = Math.floor((preview.width/DPR - drawW)/2), offY = Math.floor((preview.height/DPR - drawH)/2);
    ctx.save(); ctx.setTransform(DPR,0,0,DPR,0,0); ctx.fillStyle = invertColors ? '#fff' : '#000'; ctx.fillRect(0,0,preview.width/DPR, preview.height/DPR);
    ctx.fillStyle = invertColors ? '#000' : '#fff';
    const coords = collectAllLiveCoords();
    // cell footprint in preview pixels: never let it shrink to literally 0 (invisible) even at extreme zoom-out
    const cellPx = Math.max(0.4, scale);
    for (const c of coords) { const sx = offX + (c.x - minx) * scale; const sy = offY + (c.y - miny) * scale; ctx.fillRect(sx, sy, cellPx, cellPx); }
    function convexHull(points) {
      if (!points || points.length <= 2) return points.slice();
      const expandedSet = new Map();
      const neigh = [[0,0],[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
      for (const p of points) for (const n of neigh) { const ex = p.x + n[0], ey = p.y + n[1]; const key = ex + ',' + ey; if (!expandedSet.has(key)) expandedSet.set(key, [ex, ey]); }
      const pts = Array.from(expandedSet.values()); pts.sort((a,b)=>a[0]===b[0]?a[1]-b[1]:a[0]-b[0]);
      const cross = (o,a,b)=> (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
      const lower = []; for (const p of pts){ while (lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop(); lower.push(p); }
      const upper = []; for (let i=pts.length-1;i>=0;i--){ const p=pts[i]; while (upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], p) <=0) upper.pop(); upper.push(p); }
      upper.pop(); lower.pop(); const hull = lower.concat(upper); return hull.map(h=>({x:h[0], y:h[1]}));
    }
    const palette = ['rgba(255,64,64,0.18)','rgba(255,160,64,0.14)','rgba(255,255,64,0.14)','rgba(160,255,64,0.14)','rgba(64,255,160,0.14)','rgba(64,160,255,0.14)','rgba(180,64,255,0.14)','rgba(255,64,200,0.14)'];
    ctx.lineWidth = Math.max(1, Math.ceil(scale/3));
    for (let i=0;i<clusters.length;i++){
      const cl = clusters[i]; if (!cl || cl.length===0) continue;
      let hull = convexHull(cl); if (!hull || hull.length < 3) { let cminx=Infinity,cminy=Infinity,cmaxx=-Infinity,cmaxy=-Infinity; for (const p of cl){ if(p.x<cminx) cminx=p.x; if(p.x>cmaxx) cmaxx=p.x; if(p.y<cminy) cminy=p.y; if(p.y>cmaxy) cmaxy=p.y; } hull=[{x:cminx,y:cminy},{x:cmaxx,y:cminy},{x:cmaxx,y:cmaxy},{x:cminx,y:cmaxy}]; }
      ctx.beginPath(); for (let vi=0; vi<hull.length; vi++){ const vx = offX + (hull[vi].x - minx) * scale + 0.5, vy = offY + (hull[vi].y - miny) * scale + 0.5; if (vi===0) ctx.moveTo(vx,vy); else ctx.lineTo(vx,vy); } ctx.closePath();
      ctx.fillStyle = palette[i % palette.length]; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.stroke();
      let sumx=0,sumy=0; for (const p of cl){ sumx+=p.x; sumy+=p.y; } const cx = sumx / cl.length, cy = sumy / cl.length;
      const sx = offX + (cx - minx) * scale, sy = offY + (cy - miny) * scale; ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.font = `${Math.max(9, Math.floor(scale*0.8))}px system-ui`; ctx.fillText(String(cl.length), sx + 4, sy + 4);
    }
    ctx.restore();
    preview._renderMeta = { minx, miny, gw, gh, scale, offX, offY, DPR };
    preview.style.cursor = 'zoom-in'; preview.style.userSelect = 'none';
    preview._currentScale = 1;
  }

  // attach scan action
  scanBtn.addEventListener('click', () => {
    let s = Number(input.value || 10); if (isNaN(s)) s = 10; s = Math.max(5, Math.min(750, Math.floor(s))); input.value = String(s);
    flashTinyToast(`Scanning clusters with sensitivity ${s}...`);
    const coords = collectAllLiveCoords();
    if (coords.length === 0) { renderClusters([]); flashTinyToast('No live cells to scan'); return; }
    setTimeout(()=>{ const clusters = computeClusters(coords, s); clusters.sort((a,b)=>b.length-a.length); renderClusters(clusters); flashTinyToast(`Found ${clusters.length} cluster(s) (sensitivity ${s})`, 2000); }, 20);
  });

  // download button handler: export current preview as selected mime type (png, webp, jpeg)
  downloadBtn.addEventListener('click', async () => {
    const mime = dlSel.value || 'image/png';
    if (!preview._renderMeta) {
      flashTinyToast('Nothing to download yet: run a scan first');
      return;
    }
    try {
      // build a high-res canvas from render meta: create offscreen canvas and redraw clusters (reuse prior render pipeline minimally)
      const meta = preview._renderMeta;
      const clusters = preview._lastClusters || [];
      // Determine hi-res scale for the export. We want the ENTIRE scanned area represented,
      // however large it is -- not clamped to a minimum of 1px/cell (which used to clip large
      // scans) and not left unbounded (which could exceed the browser's max canvas size / memory).
      // So: target a reasonably large export, but cap the final canvas dimensions to a safe max.
      const MAX_EXPORT_DIM = 8000; // safe well under typical browser canvas limits
      const desiredHiScale = Math.max(meta.scale * 2, 1); // prefer at least 1px/cell when it fits
      let hiScale = desiredHiScale;
      if (meta.gw * hiScale > MAX_EXPORT_DIM || meta.gh * hiScale > MAX_EXPORT_DIM) {
        hiScale = Math.min(MAX_EXPORT_DIM / meta.gw, MAX_EXPORT_DIM / meta.gh);
      }
      hiScale = Math.max(0.05, hiScale); // never fully collapse to 0 for extremely large worlds
      const w = Math.max(1, Math.round(meta.gw * hiScale));
      const h = Math.max(1, Math.round(meta.gh * hiScale));
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.floor(w * DPR)); off.height = Math.max(1, Math.floor(h * DPR));
      off.style.width = (w) + 'px'; off.style.height = (h) + 'px';
      const ctx = off.getContext('2d');
      ctx.setTransform(DPR,0,0,DPR,0,0);
      ctx.fillStyle = invertColors ? '#fff' : '#000'; ctx.fillRect(0,0,w,h);
      // draw base cells
      const coords = collectAllLiveCoords();
      const cellFill = invertColors ? '#000' : '#fff';
      ctx.fillStyle = cellFill;
      const hiCellPx = Math.max(0.4, hiScale);
      for (const c of coords) { const sx = (c.x - meta.minx) * hiScale; const sy = (c.y - meta.miny) * hiScale; ctx.fillRect(sx, sy, hiCellPx, hiCellPx); }
      // draw cluster hulls
      function convexHullLocal(points){
        if(!points||points.length<=2) return points.slice();
        const expanded=new Map(); const neigh=[[0,0],[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
        for(const p of points) for(const n of neigh){ const ex=p.x+n[0], ey=p.y+n[1]; const key=ex+','+ey; if(!expanded.has(key)) expanded.set(key,[ex,ey]); }
        const pts=Array.from(expanded.values()); pts.sort((a,b)=>a[0]===b[0]?a[1]-b[1]:a[0]-b[0]);
        const cross=(o,a,b)=> (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
        const lower=[]; for(const p of pts){ while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<=0) lower.pop(); lower.push(p); }
        const upper=[]; for(let i=pts.length-1;i>=0;i--){ const p=pts[i]; while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<=0) upper.pop(); upper.push(p); }
        upper.pop(); lower.pop(); const hull=lower.concat(upper); return hull.map(h=>({x:h[0],y:h[1]}));
      }
      const paletteHi=['rgba(255,64,64,0.18)','rgba(255,160,64,0.14)','rgba(255,255,64,0.14)','rgba(160,255,64,0.14)','rgba(64,255,160,0.14)','rgba(64,160,255,0.14)','rgba(180,64,255,0.14)','rgba(255,64,200,0.14)'];
      ctx.lineWidth = Math.max(1, Math.ceil(hiScale/3));
      for (let i=0;i<clusters.length;i++){ const cl=clusters[i]; if(!cl||cl.length===0) continue; let hull=convexHullLocal(cl); if(!hull||hull.length<3){ let cminx=Infinity,cminy=Infinity,cmaxx=-Infinity,cmaxy=-Infinity; for(const p of cl){ if(p.x<cminx) cminx=p.x; if(p.x>cmaxx) cmaxx=p.x; if(p.y<cminy) cminy=p.y; if(p.y>cmaxy) cmaxy=p.y; } hull=[{x:cminx,y:cminy},{x:cmaxx,y:cminy},{x:cmaxx,y:cmaxy},{x:cminx,y:cmaxy}]; }
        ctx.beginPath();
        for(let vi=0;vi<hull.length;vi++){ const vx=(hull[vi].x - meta.minx)*hiScale; const vy=(hull[vi].y - meta.miny)*hiScale; if(vi===0) ctx.moveTo(vx,vy); else ctx.lineTo(vx,vy); } ctx.closePath();
        ctx.fillStyle = paletteHi[i % paletteHi.length]; ctx.fill(); ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.stroke();
      }
      // convert to blob and download
      off.toBlob((blob)=> {
        if(!blob){ flashTinyToast('Export failed'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        const ext = mimeToExtension(dlSel.value || 'image/png'); a.download = `clusters.${ext}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),3000);
        flashTinyToast(`Preview downloaded (${ext.toUpperCase()})`);
      }, dlSel.value || 'image/png', 0.92);
    } catch (err) { console.error(err); flashTinyToast('Download failed'); }
  });

  // small helper for extension
  function mimeToExtension(m) { if(!m) return 'png'; if(m.includes('png')) return 'png'; if(m.includes('webp')) return 'webp'; if(m.includes('jpeg')||m.includes('jpg')) return 'jpg'; return 'png'; }

  // focus input by default
  input.focus();
}

function openIdentificationModal() {
  if (document.getElementById('identify-modal')) {
    const existing = document.getElementById('identify-modal');
    if (existing.style.display === 'none') { existing.style.display = 'block'; }
    return;
  }
  const modal = document.createElement('div');
  modal.id = 'identify-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 11000,
    width: 'min(94vw,900px)', maxHeight: '86vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Identification Scanner (Shift+M)';
  Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
  modal.appendChild(title);

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '10px';
  row.style.alignItems = 'flex-start';

  // left: presets + paste area
  const left = document.createElement('div');
  left.style.flex = '0 0 360px';
  left.style.display = 'flex';
  left.style.flexDirection = 'column';
  left.style.gap = '8px';

  // track a selected preset name so created folders can be named after what was scanned for
  let selectedPresetName = null;
  // when true, scans run indefinitely until the player presses Force Stop
  let scanNeverEnd = false;

  const presetLabel = document.createElement('div');
  presetLabel.textContent = 'Pick a preset or paste an RLE:';
  presetLabel.style.fontWeight = '600';
  left.appendChild(presetLabel);

  const presetList = document.createElement('div');
  presetList.style.display = 'grid';
  presetList.style.gridTemplateColumns = '1fr 1fr';
  presetList.style.gap = '6px';
  presetList.style.maxHeight = '220px';
  presetList.style.overflow = 'auto';
  for (const p of presets.slice(0, 40)) { // show up to first 40 presets to keep UI reasonable
    const b = document.createElement('button');
    b.textContent = p.name;
    Object.assign(b.style, { padding: '6px', fontSize: '12px', cursor: 'pointer', textAlign: 'left' });
    b.addEventListener('click', () => {
      // record the preset name so folders created from this scan use it
      selectedPresetName = p.name;
      // set textarea to that preset RLE
      ta.value = p.rle;
      flashTinyToast(`Selected preset: ${p.name}`);
    });
    presetList.appendChild(b);
  }
  left.appendChild(presetList);

  const ta = document.createElement('textarea');
  ta.placeholder = 'Paste RLE here (or pick a preset above).';
  ta.style.width = '100%';
  ta.style.height = '120px';
  ta.style.boxSizing = 'border-box';
  left.appendChild(ta);

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.gap = '8px';
  controls.style.flexWrap = 'wrap';

  const startBtn = document.createElement('button');
  startBtn.textContent = 'Start 15× scans';
  Object.assign(startBtn.style, { padding: '8px 10px', cursor: 'pointer' });

  const autoBtn = document.createElement('button');
  autoBtn.textContent = 'Auto: OFF';
  Object.assign(autoBtn.style, { padding: '8px 10px', cursor: 'pointer' });

  const stopAll = document.createElement('button');
  stopAll.textContent = 'Close';
  Object.assign(stopAll.style, { padding: '8px 10px', cursor: 'pointer' });

  // New: file input to load a zip of instance .txt files and create a folder
  const zipLabel = document.createElement('label');
  zipLabel.textContent = 'Load folder ZIP:';
  Object.assign(zipLabel.style, { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px', fontSize: '13px' });

  const zipInput = document.createElement('input');
  zipInput.type = 'file';
  zipInput.accept = '.zip,application/zip';
  Object.assign(zipInput.style, { cursor: 'pointer' });

  zipLabel.appendChild(zipInput);

  // Handler: load ZIP, extract .txt files, parse RLEs and store as a new identification folder.
  zipInput.addEventListener('change', async (ev) => {
    const f = zipInput.files && zipInput.files[0];
    if (!f) return;
    try {
      // dynamic import of JSZip (importmap alias "jszip" is present in index.html)
      const JSZipModule = await import('jszip');
      const JSZip = JSZipModule.default || JSZipModule;
      const data = await f.arrayBuffer();
      const zip = await JSZip.loadAsync(data);
      const entries = Object.keys(zip.files).filter(n => /\.txt$/i.test(n));
      if (entries.length === 0) {
        alert('ZIP contains no .txt files.');
        return;
      }

      // create a folder named after the zip file base (fallback "Inst-Folder")
      const baseName = (f.name || '').replace(/\.[^.]+$/, '') || 'Inst-Folder';
      const folder = { name: baseName, instances: [] };

      for (const name of entries) {
        try {
          const fileData = await zip.files[name].async('string');
          // try to parse RLE; on failure store raw text minimally
          let parsed = null;
          try {
            parsed = parseRLE(fileData);
          } catch (e) {
            parsed = null;
          }

          // minimal instance record: try to produce a small snapshot grid if parse succeeded,
          // otherwise store raw text in rleText field for later inspection.
          if (parsed && parsed.length > 0) {
            // compute bounds and create minimal square snapshot
            let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
            for (const c of parsed) {
              if (c.x < minx) minx = c.x;
              if (c.x > maxx) maxx = c.x;
              if (c.y < miny) miny = c.y;
              if (c.y > maxy) maxy = c.y;
            }
            const w = maxx - minx + 1;
            const h = maxy - miny + 1;
            const size = Math.max( Math.min(128, Math.max(w,h) + 4), 8 ); // clamp size reasonably
            const grid = new Uint8Array(size * size);
            const offsetX = Math.floor((size - w) / 2) - minx;
            const offsetY = Math.floor((size - h) / 2) - miny;
            for (const c of parsed) {
              const sx = c.x + offsetX;
              const sy = c.y + offsetY;
              if (sx >= 0 && sx < size && sy >= 0 && sy < size) {
                grid[sy * size + sx] = (c.s && c.s > 0) ? 1 : 0;
              }
            }
            folder.instances.push({
              sim: 0,
              gen: 0,
              pos: { x: 0, y: 0 },
              t: performance.now(),
              snapshot: grid,
              size: size
            });
          } else {
            // fallback minimal instance wrapper (no snapshot highlight support)
            folder.instances.push({
              sim: 0,
              gen: 0,
              pos: { x: 0, y: 0 },
              t: performance.now(),
              rleText: fileData,
              snapshot: new Uint8Array(0),
              size: 0
            });
          }
        } catch (innerErr) {
          // skip problematic files but continue processing others
          console.warn('Failed to load entry', name, innerErr);
        }
      }

      // push into global folders array and refresh UI
      if (!window.identificationFolders) window.identificationFolders = [];
      window.identificationFolders.push(folder);
      refreshFolderButtons();
      flashTinyToast(`Loaded folder "${baseName}" (${folder.instances.length} files)`);
      // clear input so same file can be re-selected later if desired
      zipInput.value = '';
    } catch (err) {
      alert('Failed to load ZIP: ' + err);
      console.error(err);
    }
  });

  controls.appendChild(startBtn);
  controls.appendChild(autoBtn);
  controls.appendChild(stopAll);

  // Scan duration input (seconds): min 1, max 3600, default 13, plus "Never End" toggle.
  const scanDurRow = document.createElement('div');
  scanDurRow.style.display = 'flex';
  scanDurRow.style.alignItems = 'center';
  scanDurRow.style.gap = '8px';
  scanDurRow.style.marginTop = '6px';
  const scanDurLabel = document.createElement('label');
  scanDurLabel.textContent = 'Scan duration (s):';
  scanDurLabel.style.fontSize = '13px';
  const scanDurInput = document.createElement('input');
  scanDurInput.type = 'number';
  scanDurInput.min = '1';
  scanDurInput.max = '3600';
  scanDurInput.value = '13';
  scanDurInput.id = 'scan-duration-input';
  Object.assign(scanDurInput.style, { width: '84px', padding: '6px' });

  // "Never End" toggle: when enabled scans run until Force Stop; disabled during active scan rounds.
  const neverEndBtn = document.createElement('button');
  neverEndBtn.textContent = 'Never End: OFF';
  Object.assign(neverEndBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  neverEndBtn.addEventListener('click', () => {
    // can't toggle while a scan is running
    if (runningHandles.length > 0) {
      flashTinyToast('Cannot change Never End during active scan');
      return;
    }
    scanNeverEnd = !scanNeverEnd;
    neverEndBtn.textContent = scanNeverEnd ? 'Never End: ON' : 'Never End: OFF';
    // when enabling Never End, visually disable the numeric input
    scanDurInput.disabled = scanNeverEnd;
    flashTinyToast(`Never End ${scanNeverEnd ? 'enabled' : 'disabled'}`);
  });

  // ensure user input respects the 1..3600 bound and clamp if necessary on change
  scanDurInput.addEventListener('change', () => {
    let v = Number(scanDurInput.value);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 3600) v = 3600;
    scanDurInput.value = String(Math.floor(v));
  });

  // Force Stop button: when pressed during scanning, forcibly ends the round early and stops all sims.
  const forceStopBtn = document.createElement('button');
  forceStopBtn.textContent = 'Force Stop';
  Object.assign(forceStopBtn.style, { padding: '8px 10px', cursor: 'pointer', marginLeft: '8px' });
  forceStopBtn.addEventListener('click', () => {
    if (runningHandles.length === 0) {
      flashTinyToast('No active scans');
      return;
    }
    forceStop = true;
    // stop running handles immediately
    for (const h of runningHandles) try { if (h.stop) h.stop(); } catch (e) {}
    runningHandles = [];
    flashTinyToast('Force stop triggered — ending round');
  });

  scanDurRow.appendChild(scanDurLabel);
  scanDurRow.appendChild(scanDurInput);
  scanDurRow.appendChild(neverEndBtn);
  scanDurRow.appendChild(forceStopBtn);

  // Clean up button: fully reset the identification UI to initial state (stop scans, clear results, clear folders, reset inputs)
  const cleanBtn = document.createElement('button');
  cleanBtn.textContent = 'Clean up';
  Object.assign(cleanBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  cleanBtn.addEventListener('click', () => {
    // Stop any running scan handles
    try {
      forceStop = true;
    } catch(e) {}
    try {
      if (typeof runningHandles !== 'undefined' && runningHandles && runningHandles.length) {
        for (const h of runningHandles) {
          try { if (h && h.stop) h.stop(); } catch (e) {}
        }
      }
    } catch (e) {}

    // Clear handles array
    try { runningHandles = []; } catch(e) {}

    // Clear preview canvases
    try {
      for (const cv of previewCanvases) {
        const cctx = cv.getContext('2d');
        cctx.fillStyle = '#000';
        cctx.fillRect(0,0,cv.width,cv.height);
      }
    } catch(e) {}

    // Clear results area and reset aggregated finds
    try {
      resultsList.innerHTML = '';
      aggregatedFinds = [];
    } catch(e) {}

    // Reset paste area and preset selection
    try { ta.value = ''; selectedPresetName = null; } catch(e) {}

    // Reset scan options
    try {
      scanNeverEnd = false;
      if (neverEndBtn) neverEndBtn.textContent = 'Never End: OFF';
      if (scanDurInput) { scanDurInput.disabled = false; scanDurInput.value = '13'; }
      autoMode = false;
      if (autoBtn) autoBtn.textContent = 'Auto: OFF';
    } catch(e) {}

    // Remove any saved identification folders (full wipe for identification menu)
    try {
      if (window.identificationFolders) {
        window.identificationFolders.length = 0;
      } else {
        window.identificationFolders = [];
      }
      refreshFolderButtons();
    } catch(e) {}

    // Force UI feedback
    flashTinyToast('Identification menu cleaned up');
  });

  // append the Clean up button next to Force Stop and other controls
  scanDurRow.appendChild(cleanBtn);

  controls.appendChild(scanDurRow);

  controls.appendChild(zipLabel);
  left.appendChild(controls);

  // Folders area: persistent during page lifetime (cleared on refresh)
  const folderAreaLabel = document.createElement('div');
  folderAreaLabel.textContent = 'Saved folders:';
  Object.assign(folderAreaLabel.style, { marginTop: '8px', fontWeight: '600' });
  left.appendChild(folderAreaLabel);

  const folderButtonsWrap = document.createElement('div');
  folderButtonsWrap.style.display = 'flex';
  folderButtonsWrap.style.flexDirection = 'column';
  folderButtonsWrap.style.gap = '6px';
  folderButtonsWrap.style.maxHeight = '18vh';
  folderButtonsWrap.style.overflow = 'auto';
  left.appendChild(folderButtonsWrap);

  // right: previews and results
  const right = document.createElement('div');
  right.style.flex = '1';
  right.style.display = 'flex';
  right.style.flexDirection = 'column';
  right.style.gap = '8px';

  const canvasesRow = document.createElement('div');
  canvasesRow.style.display = 'grid';
  canvasesRow.style.gridTemplateColumns = 'repeat(5, 1fr)';
  canvasesRow.style.gap = '6px';
  canvasesRow.style.alignItems = 'start';

  // create 15 preview canvases placeholders
  const previewCanvases = [];
  for (let i = 0; i < 15; i++) {
    const cwrap = document.createElement('div');
    cwrap.style.display = 'flex';
    cwrap.style.flexDirection = 'column';
    cwrap.style.alignItems = 'center';
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 120;
    Object.assign(cv.style, { width: '160px', height: '120px', background: '#000', border: '1px solid rgba(255,255,255,0.06)' });
    const label = document.createElement('div');
    label.textContent = `Sim ${i+1}`;
    label.style.fontSize = '12px';
    label.style.marginTop = '4px';
    cwrap.appendChild(cv);
    cwrap.appendChild(label);
    canvasesRow.appendChild(cwrap);
    previewCanvases.push(cv);
  }
  right.appendChild(canvasesRow);

  const resultsBox = document.createElement('div');
  resultsBox.style.flex = '1';
  resultsBox.style.minHeight = '120px';
  resultsBox.style.background = 'rgba(255,255,255,0.02)';
  resultsBox.style.padding = '8px';
  resultsBox.style.borderRadius = '6px';
  resultsBox.style.overflow = 'auto';

  const resultsTitle = document.createElement('div');
  resultsTitle.textContent = 'Found instances (aggregated across sims):';
  resultsTitle.style.fontWeight = '700';
  resultsBox.appendChild(resultsTitle);

  const resultsList = document.createElement('div');
  resultsList.style.fontSize = '12px';
  resultsList.style.marginTop = '6px';
  resultsBox.appendChild(resultsList);
  right.appendChild(resultsBox);

  row.appendChild(left);
  row.appendChild(right);
  modal.appendChild(row);
  document.body.appendChild(modal);

  // persistent folders stored in window (cleared on refresh)
  if (!window.identificationFolders) window.identificationFolders = []; // each: { name, instances: [] }

  // populate folder buttons UI from existing folders
  function refreshFolderButtons() {
    folderButtonsWrap.innerHTML = '';

    // Clear all folders button (appears only when there is at least one folder)
    if (window.identificationFolders.length > 0) {
      const clearAllRow = document.createElement('div');
      clearAllRow.style.display = 'flex';
      clearAllRow.style.gap = '6px';
      clearAllRow.style.justifyContent = 'space-between';
      clearAllRow.style.alignItems = 'center';
      const lbl = document.createElement('div');
      lbl.textContent = `Folders: ${window.identificationFolders.length}`;
      lbl.style.fontSize = '13px';
      lbl.style.fontWeight = '600';
      clearAllRow.appendChild(lbl);

      const clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear all';
      Object.assign(clearBtn.style, { padding: '6px 8px', cursor: 'pointer' });
      clearBtn.addEventListener('click', () => {
        if (!confirm('Clear ALL identification folders? This cannot be undone (page refresh also clears them).')) return;
        window.identificationFolders.length = 0;
        refreshFolderButtons();
        flashTinyToast('All folders cleared');
      });
      clearAllRow.appendChild(clearBtn);
      folderButtonsWrap.appendChild(clearAllRow);
    }

    for (let fi = 0; fi < window.identificationFolders.length; fi++) {
      const f = window.identificationFolders[fi];

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.gap = '6px';

      const infoWrap = document.createElement('div');
      infoWrap.style.display = 'flex';
      infoWrap.style.flexDirection = 'column';
      infoWrap.style.alignItems = 'flex-start';
      const nameDiv = document.createElement('div');
      nameDiv.textContent = f.name;
      nameDiv.style.fontSize = '13px';
      nameDiv.style.fontWeight = '600';
      const countDiv = document.createElement('div');
      countDiv.textContent = `${f.instances.length} instance(s)`;
      countDiv.style.fontSize = '12px';
      countDiv.style.color = 'rgba(255,255,255,0.75)';
      infoWrap.appendChild(nameDiv);
      infoWrap.appendChild(countDiv);

      const controlsWrap = document.createElement('div');
      controlsWrap.style.display = 'flex';
      controlsWrap.style.gap = '6px';

      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open';
      Object.assign(openBtn.style, { padding: '6px', cursor: 'pointer' });
      openBtn.addEventListener('click', () => openFolderModal(fi));

      const downloadBtn = document.createElement('button');
      downloadBtn.textContent = 'Download ZIP';
      Object.assign(downloadBtn.style, { padding: '6px', cursor: 'pointer' });
      downloadBtn.addEventListener('click', async () => {
        try {
          await downloadFolderAsZip(fi);
        } catch (err) {
          alert('Download failed: ' + err);
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      Object.assign(deleteBtn.style, { padding: '6px', cursor: 'pointer' });
      deleteBtn.addEventListener('click', () => {
        if (!confirm(`Delete folder "${f.name}"?`)) return;
        window.identificationFolders.splice(fi, 1);
        refreshFolderButtons();
        flashTinyToast(`Folder "${f.name}" deleted`);
      });

      controlsWrap.appendChild(openBtn);
      controlsWrap.appendChild(downloadBtn);
      controlsWrap.appendChild(deleteBtn);

      row.appendChild(infoWrap);
      row.appendChild(controlsWrap);
      folderButtonsWrap.appendChild(row);
    }
  }
  refreshFolderButtons();

  // Show a centered processing overlay with ellipses
  function showProcessingOverlay(text = 'Processing') {
    let ov = document.getElementById('id-processing-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'id-processing-overlay';
      Object.assign(ov.style, {
        position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
        background: 'rgba(0,0,0,0.8)', color: '#fff', padding: '18px 26px', borderRadius: '10px',
        zIndex: 200000, fontSize: '18px', fontFamily: 'Times New Roman, Times, serif', textAlign: 'center'
      });
      const txt = document.createElement('div');
      txt.id = 'id-processing-text';
      txt.textContent = text;
      const dots = document.createElement('div');
      dots.id = 'id-processing-dots';
      dots.style.marginTop = '8px';
      dots.textContent = '...';
      ov.appendChild(txt);
      ov.appendChild(dots);
      document.body.appendChild(ov);
      // animate dots
      let i = 0;
      ov._int = setInterval(() => {
        i = (i + 1) % 4;
        dots.textContent = '.'.repeat(i) + (i === 0 ? '.' : '');
      }, 360);
    } else {
      const txt = document.getElementById('id-processing-text');
      if (txt) txt.textContent = text;
      ov.style.display = 'block';
      if (!ov._int) {
        let i = 0;
        const dots = document.getElementById('id-processing-dots');
        ov._int = setInterval(() => {
          i = (i + 1) % 4;
          if (dots) dots.textContent = '.'.repeat(i) + (i === 0 ? '.' : '');
        }, 360);
      }
    }
  }
  function hideProcessingOverlay() {
    const ov = document.getElementById('id-processing-overlay');
    if (ov) {
      if (ov._int) { clearInterval(ov._int); ov._int = null; }
      ov.remove();
    }
  }

  // Convert a folder's instances into multiple .txt RLEs and package into a zip using jszip
  async function downloadFolderAsZip(folderIndex) {
    const folder = window.identificationFolders[folderIndex];
    if (!folder || !folder.instances || folder.instances.length === 0) {
      alert('Folder is empty');
      return;
    }
    // dynamic import of JSZip from importmap alias
    let JSZip;
    try {
      JSZip = (await import('jszip')).default || (await import('jszip'));
    } catch (err) {
      alert('Failed to load zip library: ' + err.message);
      return;
    }

    showProcessingOverlay(`Zipping "${folder.name}"`);

    try {
      const zip = new JSZip();
      // for each instance, convert snapshot to cell list then RLE text and add as .txt
      for (let idx = 0; idx < folder.instances.length; idx++) {
        const inst = folder.instances[idx];
        // convert snapshot grid (Uint8Array) to {x,y,s} cell list
        const grid = inst.snapshot;
        const s = inst.size;
        const cells = [];
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const st = grid[y * s + x];
            if (!st || st === 0) continue;
            cells.push({ x, y, s: st });
            if (x < minx) minx = x;
            if (y < miny) miny = y;
            if (x > maxx) maxx = x;
            if (y > maxy) maxy = y;
          }
        }
        if (cells.length === 0) continue;
        // normalize to top-left
        const norm = cells.map(c => ({ x: c.x - minx, y: c.y - miny, s: c.s }));
        const ruleHint = `B${[...birthRules].sort((a,b)=>a-b).join('')}/S${[...survivalRules].sort((a,b)=>a-b).join('')}${cellStatesCount>2?('/G'+cellStatesCount):''}`;
        const rleText = cellsToRLE(norm, ruleHint);
        const fname = `inst_sim${inst.sim}_gen${inst.gen}_x${inst.pos.x}_y${inst.pos.y}.txt`;
        zip.file(fname, rleText);
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      const safeName = folder.name.replace(/[<>:"/\\|?*]+/g, '_').slice(0, 120) || 'folder';
      a.download = `${safeName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      flashTinyToast(`Downloaded ZIP: ${safeName}.zip`);
    } catch (err) {
      alert('Zipping failed: ' + err.message);
    } finally {
      hideProcessingOverlay();
    }
  }

  // state for running sims
  let runningHandles = [];
  // allow an immediate "force stop" that ends a round early
  let forceStop = false;
  // store found instances with snapshots: { simIndex, gen, pos, timestamp, snapshot: Uint8Array, size }
  let aggregatedFinds = [];
  // set to track simple dedup keys so a new detection is rejected if it matches ANY of:
  //  - same sim & same position
  //  - same sim & same generation
  //  - same position & same generation
  const aggregatedKeySet = new Set();
  let stopped = false;

  // automode flag: when true the scanner will immediately restart another 13s round after completing
  let autoMode = false;

  stopAll.addEventListener('click', () => {
    // Hide the identification UI but keep any active scans running in the background.
    const el = document.getElementById('identify-modal');
    if (el) {
      el.style.display = 'none';
      flashTinyToast('Identification UI hidden — scans continue in background');
    }
  });

  autoBtn.addEventListener('click', () => {
    autoMode = !autoMode;
    autoBtn.textContent = autoMode ? 'Auto: ON' : 'Auto: OFF';
    flashTinyToast(`Auto mode ${autoMode ? 'enabled' : 'disabled'}`);
  });

  // helper: parse target RLE and produce array of relative coords (x,y)
  function parseTargetRLE(text) {
    try {
      const rel = parseRLE(text);
      if (!rel || rel.length === 0) throw new Error('No cells parsed');
      // produce set of relative coords and bounding box
      const coords = rel.map(c => ({ x: c.x, y: c.y }));
      // compute normalized list with origin chosen as top-left of pattern bounding box for consistent scanning
      let minx = Infinity, miny = Infinity;
      for (const c of coords) { if (c.x < minx) minx = c.x; if (c.y < miny) miny = c.y; }
      const norm = coords.map(c => ({ x: c.x - minx, y: c.y - miny }));
      // compute width/height
      let maxx = -Infinity, maxy = -Infinity;
      for (const c of norm) { if (c.x > maxx) maxx = c.x; if (c.y > maxy) maxy = c.y; }
      return { norm, w: maxx - 0 + 1, h: maxy - 0 + 1 };
    } catch (err) {
      return null;
    }
  }

  // scanning routine: given sim.grid (Uint8Array), size, and target descriptor, find positions where
  // every target cell equals state==1 in grid and no other alive cell (state==1) touches the matched pattern.
  // This stricter check ensures no alive cell exists adjacent (including diagonally) to any pattern cell
  // unless that cell is part of the pattern itself.
  function scanForPattern(grid, size, target) {
    const found = [];
    if (!target) return found;
    const { norm, w, h } = target;
    // Build a quick lookup set of pattern coords for fast containment checks.
    const patternSetOffsets = new Set(norm.map(c => `${c.x},${c.y}`));

    // brute-force slide over all possible top-left origins where pattern fits
    for (let oy = 0; oy <= size - h; oy++) {
      for (let ox = 0; ox <= size - w; ox++) {
        let match = true;
        // check all pattern cells exist (state==1)
        for (let k = 0; k < norm.length; k++) {
          const px = ox + norm[k].x;
          const py = oy + norm[k].y;
          if (grid[py * size + px] !== 1) { match = false; break; }
        }
        if (!match) continue;

        // Now ensure no other alive cell (state==1) touches any pattern cell.
        // For each pattern cell, examine its 3x3 neighborhood; any neighbor that is state==1
        // and not part of the pattern (translated into this origin) disqualifies the match.
        let touching = false;
        for (let k = 0; k < norm.length && !touching; k++) {
          const baseX = ox + norm[k].x;
          const baseY = oy + norm[k].y;
          for (let ny = -1; ny <= 1 && !touching; ny++) {
            for (let nx = -1; nx <= 1; nx++) {
              const sx = baseX + nx;
              const sy = baseY + ny;
              if (sx < 0 || sx >= size || sy < 0 || sy >= size) continue;
              // if this neighbor coordinate corresponds to a pattern cell at this origin, skip it
              const relX = sx - ox;
              const relY = sy - oy;
              if (patternSetOffsets.has(`${relX},${relY}`)) continue;
              if (grid[sy * size + sx] === 1) { touching = true; break; }
            }
          }
        }

        if (!touching) found.push({ x: ox, y: oy });
      }
    }
    return found;
  }

  // helper to open a preview modal for a saved instance; allows applying snapshot to world center
  function openInstancePreview(inst) {
    // inst: { sim, gen, pos, t, snapshot, size }
    if (document.getElementById('instance-preview-modal')) return;
    const pm = document.createElement('div');
    pm.id = 'instance-preview-modal';
    Object.assign(pm.style, {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
      background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 12000,
      width: 'min(84vw,560px)', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
    });

    const title = document.createElement('div');
    title.textContent = `Preview — Sim ${inst.sim} gen ${inst.gen} @ (${inst.pos.x},${inst.pos.y})`;
    Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
    pm.appendChild(title);

    const canvas = document.createElement('canvas');
    canvas.width = Math.min(480, inst.size * 4);
    canvas.height = Math.min(360, inst.size * 4);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    canvas.style.background = '#000';
    canvas.style.border = '1px solid rgba(255,255,255,0.06)';
    pm.appendChild(canvas);

    // render snapshot onto canvas
    (function renderSnapshot() {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
      const s = inst.size;
      const cellW = Math.max(1, Math.floor(canvas.width / s));
      const cellH = Math.max(1, Math.floor(canvas.height / s));
      const grid = inst.snapshot;
      for (let y=0;y<s;y++){
        for (let x=0;x<s;x++){
          const st = grid[y * s + x];
          if (st === 0) continue;
          ctx.fillStyle = (st === 1) ? '#0f0' : '#666';
          ctx.fillRect(x*cellW, y*cellH, cellW, cellH);
        }
      }
      // Draw highlight rectangle around the matched pattern region (inst.pos is top-left of match)
      if (typeof inst.targetW === 'number' && typeof inst.targetH === 'number') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,32,32,0.95)';
        ctx.lineWidth = Math.max(2, Math.min(4, Math.ceil((cellW+cellH)/8)));
        // rectangle coordinates in pixels
        const rx = inst.pos.x * cellW;
        const ry = inst.pos.y * cellH;
        const rw = inst.targetW * cellW;
        const rh = inst.targetH * cellH;
        ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1, rw - 1), Math.max(1, rh - 1));
        // subtle semi-transparent fill for extra emphasis
        ctx.fillStyle = 'rgba(255,32,32,0.06)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.restore();
      }
    })();

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '8px';

    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply to center';
    Object.assign(applyBtn.style, { padding: '8px 10px', cursor: 'pointer' });
    applyBtn.addEventListener('click', () => {
      // replace current world with the snapshot centered on screen
      // clear everything first
      alive.clear(); birth.clear(); states.clear(); invincible.clear(); pendingPlacement.clear();
      activatePendingOnly = false; pendingPlacementStart = 0;
      generation = inst.gen || 0;
      // center snapshot: snapshot grid has origin at 0..size-1; we'll center its live cells
      const s = inst.size;
      const cx = Math.floor(s/2);
      const cy = Math.floor(s/2);
      const now = performance.now();
      for (let y=0;y<s;y++){
        for (let x=0;x<s;x++){
          const st = inst.snapshot[y * s + x];
          if (st === 0) continue;
          const wx = Math.floor(offsetX) + (x - cx);
          const wy = Math.floor(offsetY) + (y - cy);
          const k = `${wx},${wy}`;
          if (st === 1) {
            alive.add(k);
            birth.set(k, { t: now, p: pausedAccum, gen: generation });
          } else {
            states.set(k, st);
          }
        }
      }
      flashTinyToast('Snapshot applied to world center');
      // close preview modal
      const el = document.getElementById('instance-preview-modal');
      if (el) el.remove();
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Download RLE';
    Object.assign(downloadBtn.style, { padding: '8px 10px', cursor: 'pointer' });
    downloadBtn.addEventListener('click', () => {
      try {
        // convert snapshot Uint8Array to cell list {x,y,s}
        const grid = inst.snapshot;
        const s = inst.size;
        const cells = [];
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (let y = 0; y < s; y++) {
          for (let x = 0; x < s; x++) {
            const st = grid[y * s + x];
            if (!st || st === 0) continue;
            cells.push({ x, y, s: st });
            if (x < minx) minx = x;
            if (y < miny) miny = y;
            if (x > maxx) maxx = x;
            if (y > maxy) maxy = y;
          }
        }
        if (cells.length === 0) {
          alert('No live cells in snapshot to export.');
          return;
        }
        // normalize coords to top-left of bounding box (so RLE is compact)
        const norm = cells.map(c => ({ x: c.x - minx, y: c.y - miny, s: c.s }));
        // build rule hint from current active rules
        const ruleHint = `B${[...birthRules].sort((a,b)=>a-b).join('')}/S${[...survivalRules].sort((a,b)=>a-b).join('')}${cellStatesCount>2?('/G'+cellStatesCount):''}`;
        const rleText = cellsToRLE(norm, ruleHint);
        const blob = new Blob([rleText], { type: 'text/plain;charset=utf-8' });
        const fname = `instance_sim${inst.sim}_gen${inst.gen}_x${inst.pos.x}_y${inst.pos.y}.txt`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        flashTinyToast('Downloaded instance RLE');
      } catch (err) {
        alert('Download failed: ' + err.message);
      }
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
    closeBtn.addEventListener('click', () => {
      const el = document.getElementById('instance-preview-modal');
      if (el) el.remove();
    });

    btnRow.appendChild(applyBtn);
    btnRow.appendChild(downloadBtn);
    btnRow.appendChild(closeBtn);
    pm.appendChild(btnRow);

    document.body.appendChild(pm);
  }

  // folder modal: show folder instances and allow applying individual instances
  function openFolderModal(folderIndex) {
    const folder = window.identificationFolders[folderIndex];
    if (!folder) return;
    if (document.getElementById('folder-modal')) return;
    const fm = document.createElement('div');
    fm.id = 'folder-modal';
    Object.assign(fm.style, {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
      background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 12000,
      width: 'min(86vw,560px)', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
    });

    const title = document.createElement('div');
    title.textContent = `Folder: ${folder.name} (${folder.instances.length})`;
    Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
    fm.appendChild(title);

    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '8px';

    for (let i = 0; i < folder.instances.length; i++) {
      const inst = folder.instances[i];
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.padding = '6px';
      row.style.border = '1px solid rgba(255,255,255,0.04)';
      const info = document.createElement('div');
      info.textContent = `Sim ${inst.sim} gen ${inst.gen} @ (${inst.pos.x},${inst.pos.y})`;
      info.style.fontSize = '13px';
      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';
      const previewBtn = document.createElement('button');
      previewBtn.textContent = 'Preview';
      previewBtn.addEventListener('click', () => openInstancePreview(inst));
      const applyBtn = document.createElement('button');
      applyBtn.textContent = 'Apply';
      applyBtn.addEventListener('click', () => {
        openInstancePreview(inst);
        // user can then Apply to center from preview modal
      });
      actions.appendChild(previewBtn);
      actions.appendChild(applyBtn);
      row.appendChild(info);
      row.appendChild(actions);
      list.appendChild(row);
    }

    fm.appendChild(list);

    const closeRow = document.createElement('div');
    closeRow.style.display = 'flex';
    closeRow.style.justifyContent = 'flex-end';
    closeRow.style.marginTop = '8px';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    Object.assign(closeBtn.style, { padding: '8px 12px', cursor: 'pointer' });
    closeBtn.addEventListener('click', () => {
      const el = document.getElementById('folder-modal');
      if (el) el.remove();
    });
    closeRow.appendChild(closeBtn);
    fm.appendChild(closeRow);

    document.body.appendChild(fm);
  }

  // core scan runner: runs one full round of sims+scanning and returns when complete
  async function runOneScanRound(text) {
    if (runningHandles.length > 0) {
      flashTinyToast('Already running; please wait or Close first.');
      return;
    }
    const target = parseTargetRLE(text);
    if (!target) { alert('Failed to parse RLE.'); return; }

    // Disable some UI controls while scanning to prevent changing the target or presets mid-scan
    const presetButtons = presetList.querySelectorAll('button');
    function disableUI() {
      try {
        presetButtons.forEach(b => b.disabled = true);
        ta.disabled = true;
        startBtn.disabled = true;
        // Note: autoBtn intentionally remains enabled per user's request
        stopAll.disabled = false;
      } catch (e) {}
    }
    function enableUI() {
      try {
        presetButtons.forEach(b => b.disabled = false);
        ta.disabled = false;
        startBtn.disabled = false;
        // keep autoBtn enabled
      } catch (e) {}
    }

    disableUI();

    resultsList.innerHTML = '';
    aggregatedFinds = [];
    aggregatedKeySet.clear();
    stopped = false;

    // determine scanDurationMs prior to starting sims
    // honor 'Never End' toggle
    let scanDurationMs = 13000;
    if (scanNeverEnd) {
      scanDurationMs = Infinity;
    } else {
      const durInput = document.getElementById('scan-duration-input');
      if (durInput) {
        const sec = Number(durInput.value || 13);
        // clamp to 1..3600 seconds (enforced client-side), fallback to 13 if invalid
        const clamped = Math.max(1, Math.min(3600, isNaN(sec) ? 13 : sec));
        scanDurationMs = clamped * 1000;
        // ensure numeric input reflects clamped value
        durInput.value = String(Math.floor(clamped));
      }
    }

    // For each of 15 sims, create sim and start fast loop.
    for (let i = 0; i < 15; i++) {
      const canvas = previewCanvases[i];
      // create a sim of size 96 for reasonable scanning performance
      const sim = createPreviewSim(96, 2);
      sim.seedNoise();
      sim.birthRule = new Set([3]);
      sim.survRule = new Set([2,3]);

      const ctxp = canvas.getContext('2d');
      let runningFlag = true;
      let startT = performance.now();
      const simFinds = new Set();

      function drawSim() {
        const s = sim.size;
        const cellW = canvas.width / s;
        const cellH = canvas.height / s;
        ctxp.fillStyle = '#000';
        ctxp.fillRect(0,0,canvas.width,canvas.height);
        for (let y=0;y<s;y++){
          for (let x=0;x<s;x++){
            const st = sim.grid[y*s + x];
            if (st === 0) continue;
            const sx = Math.floor(x*cellW);
            const sy = Math.floor(y*cellH);
            ctxp.fillStyle = (st === 1) ? '#0f0' : '#666';
            ctxp.fillRect(sx, sy, Math.max(1,Math.ceil(cellW)), Math.max(1,Math.ceil(cellH)));
          }
        }
      }

      function makeDedupKeys(simIndexOneBased, gen, pos) {
        const simPosKey = `S${simIndexOneBased}|P${pos.x},${pos.y}`;
        const simGenKey = `S${simIndexOneBased}|G${gen}`;
        const posGenKey = `P${pos.x},${pos.y}|G${gen}`;
        return [simPosKey, simGenKey, posGenKey];
      }

      let raf = null;
      function loop() {
        if (!runningFlag || stopped) {
          if (raf) cancelAnimationFrame(raf);
          return;
        }
        // run a small batch of ticks per frame for speed
        // increased from 3 -> 15 to make identification sims run ~5× faster (more generations per animation frame)
        const ticksToRun = 15;
        for (let t=0;t<ticksToRun;t++) {
          // advance one generation
          sim.step();
          const found = scanForPattern(sim.grid, sim.size, target);
          if (found.length > 0) {
            const gen = sim.stepCount;
            for (const pos of found) {
              const instSimIndex = i + 1;
              const keys = makeDedupKeys(instSimIndex, gen, pos);
              let already = false;
              for (const k of keys) {
                if (aggregatedKeySet.has(k)) { already = true; break; }
              }
              if (already) continue;

              const tripleKey = `${i}|g${gen}|${pos.x},${pos.y}`;
              if (simFinds.has(tripleKey)) continue;

              simFinds.add(tripleKey);
              for (const k of keys) aggregatedKeySet.add(k);

              const snap = new Uint8Array(sim.grid.length);
              snap.set(sim.grid);
              const inst = { sim: instSimIndex, gen, pos: { x: pos.x, y: pos.y }, t: performance.now(), snapshot: snap, size: sim.size, targetW: target.w, targetH: target.h };
              aggregatedFinds.push(inst);

              const el = document.createElement('div');
              el.textContent = `Sim ${inst.sim} gen ${inst.gen} @ (${inst.pos.x},${inst.pos.y})`;
              el.style.fontSize = '12px';
              el.style.cursor = 'pointer';
              el.style.padding = '4px 2px';
              el.addEventListener('click', () => {
                openInstancePreview(inst);
              });
              resultsList.appendChild(el);
              resultsBox.scrollTop = resultsBox.scrollHeight;
            }
          }

          // improved stagnation detection using a tiny recent-state hash ring:
          // compute a fast checksum of the sim grid each step and compare against a small ring buffer
          // of previous checksums; if a checksum repeats we treat the sim as cycling and reseed immediately.
          if (typeof sim._recentHashes === 'undefined') {
            sim._recentHashes = new Uint32Array(16); // small history (16 recent states)
            sim._hashPos = 0;
            sim._hashFilled = 0;
          }

          // fast non-cryptographic hash over the boolean grid (only state==1 matters)
          // using FNV-1a style mix but integer-only to keep it fast.
          let h = 2166136261 >>> 0;
          const gridLen = sim.grid.length;
          for (let gi = 0; gi < gridLen; gi++) {
            if (sim.grid[gi] === 1) {
              // incorporate index; +1 so empty doesn't contribute zero
              h ^= (gi + 1);
              // multiply by prime (32-bit)
              h = Math.imul(h, 16777619) >>> 0;
            }
          }

          // check for repeat in the recent ring quickly (small fixed-size loop)
          let seenRepeat = false;
          const rh = sim._recentHashes;
          for (let ri = 0; ri < sim._hashFilled; ri++) {
            if (rh[ri] === h) { seenRepeat = true; break; }
          }

          if (seenRepeat) {
            // immediate reseed on detected cycle to avoid leaving sim behind
            sim.seedNoise();
            // reset recent history so the new random state is not instantly considered a repeat
            sim._recentHashes.fill(0);
            sim._hashPos = 0;
            sim._hashFilled = 0;
          } else {
            // push current hash into ring
            rh[sim._hashPos] = h;
            sim._hashPos = (sim._hashPos + 1) % rh.length;
            if (sim._hashFilled < rh.length) sim._hashFilled++;
            // Also keep the older simple alive-count fallback to catch very slow drift cases
            if (typeof sim._prevAlive === 'undefined') sim._prevAlive = sim.aliveCount;
            if (typeof sim._stagnantCount === 'undefined') sim._stagnantCount = 0;
            if (sim.aliveCount === sim._prevAlive) {
              sim._stagnantCount++;
            } else {
              sim._stagnantCount = 0;
              sim._prevAlive = sim.aliveCount;
            }
            // keep a modest fallback threshold (short) to catch tiny stalls
            const STAGNANT_THRESHOLD = 240; // larger, but rare due to hash check
            if (sim._stagnantCount >= STAGNANT_THRESHOLD) {
              sim.seedNoise();
              sim._prevAlive = sim.aliveCount;
              sim._stagnantCount = 0;
              sim._recentHashes.fill(0);
              sim._hashPos = 0;
              sim._hashFilled = 0;
            }
          }
        }
        drawSim();

        if (performance.now() - startT >= scanDurationMs || stopped) {
          runningFlag = false;
          return;
        }
        raf = requestAnimationFrame(loop);
      }
      raf = requestAnimationFrame(loop);

      runningHandles.push({
        stop: () => { runningFlag = false; if (raf) cancelAnimationFrame(raf); }
      });
    }

    // wait for the configured round duration (from the UI input) or until stopped/forceStop is triggered,
    // then stop handles and summarize.
    forceStop = false;
    const roundStart = performance.now();
    // poll periodically until time elapsed or user requested stop/forceStop
    while (!stopped && !forceStop && (performance.now() - roundStart) < scanDurationMs) {
      await new Promise(r => setTimeout(r, 200));
    }
    // stop any running handles immediately
    for (const h of runningHandles) try { if (h.stop) h.stop(); } catch (e) {}
    runningHandles = [];
    // ensure flags reflect end-of-round
    forceStop = false;

    const summary = document.createElement('div');
    summary.style.marginTop = '8px';
    summary.style.fontWeight = '600';
    summary.textContent = `Scan complete — found ${aggregatedFinds.length} instance(s) across 15 sims.`;
    resultsList.insertBefore(summary, resultsList.firstChild);
    flashTinyToast('Identification complete');

    // When a scan round completes, create a folder (persisting only for this page session).
    // Prefer the selected preset name (if user picked a preset), else try to read the #N header name,
    // otherwise fall back to the fixed name "Inst-Folder" (do NOT use raw RLE text).
    let folderName = 'Inst-Folder';
    if (selectedPresetName) {
      folderName = selectedPresetName;
    } else {
      const firstLine = (ta.value || '').split(/\r?\n/).find(l => l.trim() !== '');
      if (firstLine) {
        // try to extract a name from a typical RLE header line starting with #N
        const m = firstLine.match(/^#N\s*(.*)$/);
        if (m && m[1]) {
          const candidate = m[1].trim();
          if (candidate) folderName = candidate;
        } else {
          // no suitable header name found -> keep default "Inst-Folder"
          folderName = 'Inst-Folder';
        }
      } else {
        folderName = 'Inst-Folder';
      }
    }

    // Create folder entry and move all current aggregatedFinds into it (finalized snapshot)
    const folder = { name: folderName, instances: [] };
    for (const inst of aggregatedFinds) {
      folder.instances.push(inst);
    }
    // push into global folders array so folders persist while page is open
    window.identificationFolders.push(folder);

    // Immediately refresh folder buttons UI so new folder appears under controls (below scan/auto/close)
    refreshFolderButtons();

    // Re-enable UI controls now that scanning completed
    enableUI();
  }

  // Start button triggers a single round; if autoMode is ON it will loop until toggled off.
  startBtn.addEventListener('click', async () => {
    if (!ta.value.trim()) { alert('Please paste or select an RLE pattern to scan for.'); return; }
    if (runningHandles.length > 0) {
      flashTinyToast('Already running; please wait or Close first.');
      return;
    }
    // run at least one round, then if autoMode true continue until disabled or modal closed
    do {
      await runOneScanRound(ta.value.trim());
      if (stopped) break;
    } while (autoMode && !stopped);
    // if autoMode was turned off externally, ensure button states reflect that
    if (!autoMode) autoBtn.textContent = 'Auto: OFF';
  });


}

 // MAIN MENU: show an interactive main menu that runs background gliders and starts the startup sequence when X pressed.
let showMainMenu = false;
let _mainMenuOverlay = null;
let _menuGliderInterval = null;
// When true, the main menu is in its initial boosted period and input/start is blocked; _menuBlackCover is the fullscreen black div.
let menuInitialBoostActive = false;
let _menuBlackCover = null;

function openSuperSpeedMenu() {
  // if already open, focus it
  if (document.getElementById('super-speed-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'super-speed-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '14px', borderRadius: '8px', zIndex: 12000,
    width: 'min(84vw,420px)', boxSizing: 'border-box', textAlign: 'left', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Super-speed multiplier';
  Object.assign(title.style, { fontWeight: '700', marginBottom: '8px', fontSize: '16px' });
  modal.appendChild(title);

  const desc = document.createElement('div');
  desc.textContent = 'Choose how many discrete generations to run per animation frame (1× — 100×).';
  Object.assign(desc.style, { fontSize: '13px', color: 'rgba(255,255,255,0.85)', marginBottom: '12px' });
  modal.appendChild(desc);

  // slider row
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '8px';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '100';
  slider.value = String(Math.max(1, Math.min(100, superStepMultiplier || 1)));
  slider.style.flex = '1';

  const val = document.createElement('div');
  val.textContent = slider.value + '×';
  Object.assign(val.style, { minWidth: '54px', textAlign: 'right', fontWeight: '700' });

  slider.addEventListener('input', () => {
    val.textContent = slider.value + '×';
  });

  row.appendChild(slider);
  row.appendChild(val);
  modal.appendChild(row);

  // buttons: Close, Reset, Set Speed
  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.justifyContent = 'flex-end';
  btnRow.style.gap = '8px';
  btnRow.style.marginTop = '12px';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    const el = document.getElementById('super-speed-modal');
    if (el && el.parentElement) el.parentElement.removeChild(el);
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  Object.assign(resetBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  resetBtn.addEventListener('click', () => {
    superStepMultiplier = 1;
    slider.value = '1';
    val.textContent = '1×';
    flashTinyToast('Super-speed reset to 1×', 900);
  });

  const setBtn = document.createElement('button');
  setBtn.textContent = 'Set speed';
  Object.assign(setBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  setBtn.addEventListener('click', () => {
    const n = Math.max(1, Math.min(100, Math.round(Number(slider.value) || 1)));
    superStepMultiplier = n;
    // if user sets >1 ensure sim runs
    if (superStepMultiplier > 1) { running = true; lastStep = performance.now(); }
    flashTinyToast(superStepMultiplier === 1 ? 'Super-speed: OFF' : `Super-speed: ${superStepMultiplier}×`, 1200);
    const el = document.getElementById('super-speed-modal');
    if (el && el.parentElement) el.parentElement.removeChild(el);
  });

  btnRow.appendChild(closeBtn);
  btnRow.appendChild(resetBtn);
  btnRow.appendChild(setBtn);
  modal.appendChild(btnRow);

  document.body.appendChild(modal);
  slider.focus();
}

/* FastForward panel (Ctrl+H): toggles the bulk-step + finite-cycle accelerator on/off and
   lets the player tune how many generations it attempts per batch and its per-frame time
   budget. Mirrors openSuperSpeedMenu()'s modal styling for a consistent feel. A small live
   status line explains whether the accelerator is currently able to engage, and if not, why
   (e.g. "rule spots are active" / "generational fading is active") so it's never a silent
   no-op -- the player always knows whether FastForward or the exact per-feature simulation
   is actually running. */
function openFastForwardPanel() {
  if (document.getElementById('fast-forward-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'fast-forward-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '14px', borderRadius: '8px', zIndex: 12000,
    width: 'min(88vw,440px)', boxSizing: 'border-box', textAlign: 'left', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'FastForward (bulk-step accelerator)';
  Object.assign(title.style, { fontWeight: '700', marginBottom: '8px', fontSize: '16px' });
  modal.appendChild(title);

  const desc = document.createElement('div');
  desc.textContent = 'Runs many generations per frame with less overhead than Super-Speed, only re-examines regions near recent activity once a pattern gets large (so big, mostly-static or oscillating patterns run far faster), and detects when a pattern has settled into an exact repeating cycle so it can skip ahead instead of resimulating it. Falls back to normal stepping automatically whenever Rule Spots, invincible walls, generational fading, or reverse-time are in use.';
  Object.assign(desc.style, { fontSize: '12px', color: 'rgba(255,255,255,0.75)', marginBottom: '12px', lineHeight: '1.4' });
  modal.appendChild(desc);

  // --- master on/off toggle row ---
  const toggleRow = document.createElement('div');
  toggleRow.style.display = 'flex';
  toggleRow.style.alignItems = 'center';
  toggleRow.style.justifyContent = 'space-between';
  toggleRow.style.marginBottom = '10px';

  const toggleLabel = document.createElement('div');
  toggleLabel.textContent = 'Enabled';
  Object.assign(toggleLabel.style, { fontSize: '13px', fontWeight: '700' });

  const toggleBtn = document.createElement('button');
  function refreshToggleBtn() {
    toggleBtn.textContent = fastForwardEnabled ? 'ON' : 'OFF';
    toggleBtn.style.background = fastForwardEnabled ? '#1f7a3d' : '#333';
  }
  Object.assign(toggleBtn.style, { padding: '6px 14px', cursor: 'pointer', fontWeight: '700', border: 'none', borderRadius: '4px', color: '#fff' });
  refreshToggleBtn();
  toggleBtn.addEventListener('click', () => {
    fastForwardEnabled = !fastForwardEnabled;
    fastForwardResetCycleMemory();
    refreshToggleBtn();
    refreshStatusLine();
    if (fastForwardEnabled) { running = true; lastStep = performance.now(); }
    flashTinyToast(fastForwardEnabled ? 'FastForward: ON' : 'FastForward: OFF', 1200);
  });

  toggleRow.appendChild(toggleLabel);
  toggleRow.appendChild(toggleBtn);
  modal.appendChild(toggleRow);

  function makeLabel(text) {
    const l = document.createElement('div');
    l.textContent = text;
    Object.assign(l.style, { fontSize: '12px', fontWeight: '700', marginTop: '8px', marginBottom: '4px' });
    return l;
  }

  // --- generations-per-batch input ---
  modal.appendChild(makeLabel('Generations per batch (target)'));
  const genInput = document.createElement('input');
  genInput.type = 'number';
  genInput.min = '1';
  genInput.max = '5000000';
  genInput.value = String(fastForwardGenerations);
  Object.assign(genInput.style, { width: '100%', boxSizing: 'border-box', padding: '6px', fontSize: '13px' });
  genInput.addEventListener('input', () => {
    const v = Math.floor(Number(genInput.value));
    if (Number.isFinite(v) && v > 0) fastForwardGenerations = Math.max(1, Math.min(5000000, v));
  });
  modal.appendChild(genInput);

  // --- per-frame time budget input ---
  modal.appendChild(makeLabel('Per-frame time budget (ms) — lower = less lag, slower overall'));
  const budgetInput = document.createElement('input');
  budgetInput.type = 'number';
  budgetInput.min = '1';
  budgetInput.max = '250';
  budgetInput.value = String(fastForwardFrameBudgetMs);
  Object.assign(budgetInput.style, { width: '100%', boxSizing: 'border-box', padding: '6px', fontSize: '13px' });
  budgetInput.addEventListener('input', () => {
    const v = Math.floor(Number(budgetInput.value));
    if (Number.isFinite(v) && v > 0) fastForwardFrameBudgetMs = Math.max(1, Math.min(250, v));
  });
  modal.appendChild(budgetInput);

  // --- live status line: explains whether the accelerator is currently able to engage ---
  const statusLine = document.createElement('div');
  Object.assign(statusLine.style, { fontSize: '12px', marginTop: '10px', padding: '8px', borderRadius: '4px', background: 'rgba(255,255,255,0.06)', lineHeight: '1.4' });
  modal.appendChild(statusLine);

  function refreshStatusLine() {
    if (!fastForwardEnabled) {
      statusLine.textContent = 'FastForward is OFF. Turn it on to use bulk-stepping.';
      statusLine.style.color = 'rgba(255,255,255,0.6)';
      return;
    }
    const reasons = [];
    if (reverseTime) reasons.push('reverse-time is active');
    if (activatePendingOnly || pendingPlacement.size > 0) reasons.push('a contraption is mid-placement');
    if (ruleSpots.length > 0) reasons.push('Rule Spots are placed');
    if (invincible.size > 0) reasons.push('invincible walls are placed');
    if (cellStatesCount > 2 || states.size > 0) reasons.push('generational fading is active');
    if (hexMode) reasons.push('Hex Mode is active (6-neighbor rules aren\'t supported by the accelerator)');
    if (reasons.length > 0) {
      statusLine.textContent = `Deferring to exact simulation right now: ${reasons.join(', ')}. FastForward will resume automatically once that clears.`;
      statusLine.style.color = '#ffce6b';
    } else if (fastForwardLastStats) {
      const s = fastForwardLastStats;
      const jumpTxt = s.cyclePeriod > 0 ? `, detected period-${s.cyclePeriod} cycle (skipped ${s.jumped} gens)` : '';
      statusLine.textContent = `Active. Last batch: ${s.simulated} simulated${jumpTxt}, now at generation ${s.endGen} (${s.elapsedMs ? s.elapsedMs.toFixed(1) : '0'}ms).`;
      statusLine.style.color = '#8fd68f';
    } else {
      statusLine.textContent = 'Active. Waiting for the next frame to run a batch.';
      statusLine.style.color = '#8fd68f';
    }
  }
  refreshStatusLine();
  const statusInterval = setInterval(() => {
    if (!document.getElementById('fast-forward-modal')) { clearInterval(statusInterval); return; }
    refreshStatusLine();
  }, 300);

  // --- buttons: Close, Reset ---
  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.justifyContent = 'flex-end';
  btnRow.style.gap = '8px';
  btnRow.style.marginTop = '12px';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    clearInterval(statusInterval);
    const el = document.getElementById('fast-forward-modal');
    if (el && el.parentElement) el.parentElement.removeChild(el);
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset defaults';
  Object.assign(resetBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  resetBtn.addEventListener('click', () => {
    fastForwardGenerations = 5000;
    fastForwardFrameBudgetMs = 14;
    genInput.value = '5000';
    budgetInput.value = '14';
    flashTinyToast('FastForward settings reset to defaults', 900);
  });

  btnRow.appendChild(closeBtn);
  btnRow.appendChild(resetBtn);
  modal.appendChild(btnRow);

  function escHandler(ev) {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      clearInterval(statusInterval);
      modal.remove();
      window.removeEventListener('keydown', escHandler, true);
    }
  }
  window.addEventListener('keydown', escHandler, true);

  document.body.appendChild(modal);
}

/* Snapshot menu (Ctrl+K): lists every saved snapshot (see the Snapshot System
   block above rewindStep() for the underlying take/load/rename/delete/
   download API). Each row shows the snapshot's name (click to rename inline),
   cell count, generation it was captured at, and Load / Download / Delete
   buttons. Loading fully replaces the current board state. Styled to match
   the other modals (openSuperSpeedMenu / openFastForwardPanel) for
   consistency. */
function openSnapshotMenu() {
  if (document.getElementById('snapshot-menu-modal')) {
    // already open -- just refresh its contents rather than stacking a duplicate
    const existing = document.getElementById('snapshot-menu-modal');
    if (existing._refreshList) existing._refreshList();
    return;
  }
  const modal = document.createElement('div');
  modal.id = 'snapshot-menu-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '14px', borderRadius: '8px', zIndex: 12000,
    width: 'min(92vw,520px)', maxHeight: '80vh', overflowY: 'auto',
    boxSizing: 'border-box', textAlign: 'left', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Snapshots';
  Object.assign(title.style, { fontWeight: '700', marginBottom: '6px', fontSize: '16px' });
  modal.appendChild(title);

  const desc = document.createElement('div');
  desc.textContent = 'Ctrl+M saves a new snapshot of the current board. Loading a snapshot replaces the entire current board (alive cells, fading states, invincible walls, and generation count).';
  Object.assign(desc.style, { fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginBottom: '10px', lineHeight: '1.4' });
  modal.appendChild(desc);

  // Quick "take a snapshot now" button, so the menu is a one-stop place for the whole feature
  const takeBtn = document.createElement('button');
  takeBtn.textContent = '+ Take snapshot now';
  Object.assign(takeBtn.style, { padding: '8px 12px', cursor: 'pointer', fontWeight: '700', marginBottom: '10px', width: '100%' });
  takeBtn.addEventListener('click', () => {
    const snap = takeSnapshot();
    flashTinyToast(`Snapshot saved: "${snap.name}" (${snap.cellCount} cells)`, 1200);
    refreshList();
  });
  modal.appendChild(takeBtn);

  const listContainer = document.createElement('div');
  modal.appendChild(listContainer);

  function makeRow(entry) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', flexDirection: 'column', gap: '6px',
      padding: '8px', marginBottom: '8px', borderRadius: '6px',
      background: 'rgba(255,255,255,0.06)'
    });

    const topLine = document.createElement('div');
    Object.assign(topLine.style, { display: 'flex', alignItems: 'center', gap: '8px' });

    // Inline-renamable name: click to turn into a text input
    const nameSpan = document.createElement('span');
    nameSpan.textContent = entry.name;
    Object.assign(nameSpan.style, { fontWeight: '700', cursor: 'text', flex: '1', padding: '2px 4px', borderRadius: '3px' });
    nameSpan.title = 'Click to rename';
    nameSpan.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = entry.name;
      Object.assign(input.style, { flex: '1', padding: '3px 4px', fontSize: '14px', fontWeight: '700' });
      function commit() {
        const val = input.value.trim();
        if (val && val !== entry.name) {
          renameSnapshotById(entry.id, val);
          entry.name = val.slice(0, 80);
        }
        nameSpan.textContent = entry.name;
        input.replaceWith(nameSpan);
      }
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); input.value = entry.name; input.blur(); }
        ev.stopPropagation(); // don't let the main keydown handler eat these keystrokes while typing a name
      });
      nameSpan.replaceWith(input);
      input.focus();
      input.select();
    });
    topLine.appendChild(nameSpan);
    row.appendChild(topLine);

    const meta = document.createElement('div');
    const when = new Date(entry.createdAt);
    // Surface which topology this snapshot was captured under (parsed from its #H tag) so the
    // player isn't surprised when Load refuses to fire in the wrong mode -- see loadSnapshotById.
    const snapWasHex = /^#H\s+1\s*$/m.test(entry.rle || '');
    const modeTag = snapWasHex ? ' · Hex' : '';
    meta.textContent = `${entry.cellCount} cells · generation ${entry.generation}${modeTag} · ${when.toLocaleString()}`;
    Object.assign(meta.style, { fontSize: '11px', color: 'rgba(255,255,255,0.6)' });
    row.appendChild(meta);

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });

    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    Object.assign(loadBtn.style, { padding: '6px 10px', cursor: 'pointer', fontWeight: '700' });
    loadBtn.addEventListener('click', () => {
      loadSnapshotById(entry.id);
      modal.remove();
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = 'Download .rle';
    Object.assign(downloadBtn.style, { padding: '6px 10px', cursor: 'pointer' });
    downloadBtn.addEventListener('click', () => {
      downloadSnapshotById(entry.id);
      flashTinyToast(`Downloaded "${entry.name}.rle"`, 1000);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    Object.assign(deleteBtn.style, { padding: '6px 10px', cursor: 'pointer', color: '#ff8a8a' });
    deleteBtn.addEventListener('click', () => {
      if (deleteBtn.dataset.confirm === '1') {
        deleteSnapshotById(entry.id);
        refreshList();
      } else {
        deleteBtn.dataset.confirm = '1';
        deleteBtn.textContent = 'Confirm delete?';
        setTimeout(() => { deleteBtn.dataset.confirm = '0'; deleteBtn.textContent = 'Delete'; }, 2500);
      }
    });

    btnRow.appendChild(loadBtn);
    btnRow.appendChild(downloadBtn);
    btnRow.appendChild(deleteBtn);
    row.appendChild(btnRow);

    return row;
  }

  function refreshList() {
    listContainer.innerHTML = '';
    const list = __snapshotLoadAll();
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No snapshots yet. Press Ctrl+M to save one, or use the button above.';
      Object.assign(empty.style, { fontSize: '13px', color: 'rgba(255,255,255,0.6)', padding: '10px 0', textAlign: 'center' });
      listContainer.appendChild(empty);
      return;
    }
    // newest first
    const sorted = list.slice().sort((a, b) => b.createdAt - a.createdAt);
    for (const entry of sorted) listContainer.appendChild(makeRow(entry));
  }
  refreshList();
  modal._refreshList = refreshList;

  const closeRow = document.createElement('div');
  Object.assign(closeRow.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '10px' });
  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 10px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    window.removeEventListener('keydown', escHandler, true);
    modal.remove();
  });
  closeRow.appendChild(closeBtn);
  modal.appendChild(closeRow);

  function escHandler(ev) {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      window.removeEventListener('keydown', escHandler, true);
      modal.remove();
    }
  }
  window.addEventListener('keydown', escHandler, true);

  document.body.appendChild(modal);
}

function createMainMenuOverlay() {
  if (_mainMenuOverlay) return;
  showMainMenu = true;

  // apply a moderate blur to the canvas to emphasize menu
  canvas.style.filter = 'blur(4px)';

  const overlay = document.createElement('div');
  _mainMenuOverlay = overlay;
  Object.assign(overlay.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '100vw',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20000,
    pointerEvents: 'auto',
    background: 'rgba(0,0,0,0.45)',
    color: '#fff',
    fontSize: '34px',
    fontFamily: 'Times New Roman, Times, serif',
    letterSpacing: '0.6px',
    textAlign: 'center'
  });

  const title = document.createElement('div');
  title.textContent = 'The Game of Life';
  // class-based styling for animated shine (shimmer is applied only within the glyph area)
  title.className = 'menu-title-shine';
  Object.assign(title.style, {
    fontFamily: 'TitleFront, "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial',
    fontSize: '88px',
    fontWeight: '800',
    marginBottom: '8px',
    // keep the title white as requested and add subtle base text-shadow for depth
    color: '#ffffff',
    textShadow: '0 2px 8px rgba(0,0,0,0.55)'
  });
  overlay.appendChild(title);

  const subtitle = document.createElement('div');
  subtitle.textContent = 'Press X to start';
  Object.assign(subtitle.style, {
    fontSize: '18px',
    marginTop: '6px',
    opacity: '0.9'
  });
  overlay.appendChild(subtitle);

  // pulsating small hint on the bottom
  const hint = document.createElement('div');
  hint.textContent = 'X key to start';
  Object.assign(hint.style, {
    position: 'absolute',
    bottom: '18px',
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: '13px',
    color: '#fff',
    opacity: '0.95',
    padding: '6px 10px',
    borderRadius: '6px',
    pointerEvents: 'none',
    animation: 'pulseLight 1400ms ease-in-out infinite'
  });
  overlay.appendChild(hint);

  // Small consistency hint (matches the intro sequence's equivalent hint styling/wording)
  // clarifying that clicking anywhere also works, not just the X key.
  const clickHint = document.createElement('div');
  clickHint.textContent = 'Click anywhere to continue';
  Object.assign(clickHint.style, {
    position: 'absolute',
    bottom: '44px',
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: '12px',
    color: 'rgba(200,200,200,0.7)',
    pointerEvents: 'none'
  });
  overlay.appendChild(clickHint);

  // Add keyframes for pulse and animated shine (inject basic style)
  const styleTag = document.createElement('style');
  styleTag.textContent = `
    @keyframes pulseLight {
      0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.08); transform: translateX(-50%) scale(1); }
      50% { box-shadow: 0 0 20px 6px rgba(255,255,255,0.06); transform: translateX(-50%) scale(1.02); }
      100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.08); transform: translateX(-50%) scale(1); }
    }

    /* Animated shine applied only to the title glyphs (text clipping). 
       Title color remains white; the gradient slide creates a lighter "shine" sweep. */
    .menu-title-shine {
      position: relative;
      display: inline-block;
      /* background gradient for the moving shine; mostly transparent except a bright center */
      background-image: linear-gradient(
        90deg,
        rgba(255,255,255,0) 0%,
        rgba(255,255,255,0.28) 42%,
        rgba(255,255,255,0.72) 50%,
        rgba(255,255,255,0.28) 58%,
        rgba(255,255,255,0) 100%
      );
      background-size: 200% 100%;
      /* clip the background to text so shine shows only across glyphs */
      -webkit-background-clip: text;
      background-clip: text;
      /* keep base glyph color white (so non-shining areas remain white) */
      -webkit-text-fill-color: #ffffff;
      color: #ffffff;
      /* animate background position to create a swipe */
      animation: shine 2.2s linear infinite;
      /* ensure the shine doesn't bleed outside letter bounds */
      overflow: hidden;
    }

    @keyframes shine {
      0% {
        background-position: -120% 50%;
      }
      100% {
        background-position: 220% 50%;
      }
    }
  `;
  overlay.appendChild(styleTag);

  // Create a fullscreen black cover that will hide the menu text during the initial boost.
  // It sits above the overlay content visually but below other page UI and blocks starting input.
  // Added: a pixel-art animated canvas showing a pixelated gray ring with a single white pixel
  // that marches around transferring "aliveness" (fade timeline: 0.3s light gray -> 0.3s darker -> dead).
  const blackCover = document.createElement('div');
  _menuBlackCover = blackCover;
  menuInitialBoostActive = true;

  Object.assign(blackCover.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '100vw',
    height: '100vh',
    background: '#000',
    zIndex: 21000,
    pointerEvents: 'auto', // block clicks/keys targeting overlay
    opacity: '1',
    fontFamily: 'Times New Roman, Times, serif',
    transition: 'opacity 600ms ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  });

  // pixel canvas overlay (centered)
  const pixCanvas = document.createElement('canvas');
  pixCanvas.width = 256;
  pixCanvas.height = 256;
  Object.assign(pixCanvas.style, {
    width: '256px',
    height: '256px',
    imageRendering: 'pixelated',
    pointerEvents: 'none'
  });
  blackCover.appendChild(pixCanvas);

  // bottom cycling dots indicator (".", "..", "...")
  const dotsEl = document.createElement('div');
  dotsEl.textContent = '.';
  Object.assign(dotsEl.style, {
    position: 'absolute',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    color: '#fff',
    fontWeight: '700',
    fontSize: '22px',
    letterSpacing: '0.8px',
    pointerEvents: 'none'
  });
  blackCover.appendChild(dotsEl);

  // start interval to cycle dots every 300ms; store id on element for cleanup
  let _dotsState = 0;
  blackCover._dotsInterval = setInterval(() => {
    _dotsState = (_dotsState + 1) % 3;
    dotsEl.textContent = '.'.repeat(_dotsState + 1);
  }, 300);

  document.body.appendChild(blackCover);

  // Animation state for ring + transferring white pixel
  (function startBlackCoverPixelRing(canvasEl) {
    const ctxp = canvasEl.getContext('2d');
    const W = canvasEl.width;
    const H = canvasEl.height;
    // Define a low-res grid inside the canvas for the pixel circle (e.g., 24x24)
    const GRID = 24;
    const cellW = Math.floor(W / GRID);
    const cellH = Math.floor(H / GRID);
    const cx = Math.floor(GRID / 2);
    const cy = Math.floor(GRID / 2);
    const radius = Math.floor(GRID * 0.28); // ring radius
    // Compute integer ring coordinates (approximate circle perimeter)
    const ring = [];
    for (let ay = 0; ay < GRID; ay++) {
      for (let ax = 0; ax < GRID; ax++) {
        const dx = ax - cx;
        const dy = ay - cy;
        const dist = Math.hypot(dx, dy);
        if (Math.abs(dist - radius) < 0.9) ring.push({ x: ax, y: ay });
      }
    }
    // sort ring clockwise by angle for consistent traversal
    ring.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

    // Per-pixel state: 0 = base gray ring, 1 = light gray (just used), 2 = dark gray (later), 9 = white (active)
    // We'll track timestamps for transitions. Initialize ring as mid-gray (stable).
    const state = new Map(); // key -> { stage: number, t0: timestamp (when entered current stage) }
    const now = performance.now();
    for (const p of ring) {
      state.set(`${p.x},${p.y}`, { stage: 0, t0: now }); // 0 -> base gray
    }

    // Start with a single white pixel at ring[0]
    let whiteIndex = 0;
    const whiteKey = k => {
      const p = ring[whiteIndex % ring.length];
      return `${p.x},${p.y}`;
    };
    // Make initial white pixel live (we use stage 9 for "white alive" to draw special white)
    state.set(whiteKey(), { stage: 9, t0: performance.now() });

    // Timing constants
    // Make the ring transfer much faster so the white pixel can loop multiple times during the black-screen boost.
    // TRANSFER_INTERVAL controls how often the white pixel moves to the next ring cell.
    // FADE_STEP controls the fade durations after the white pixel moves; shorten so fades complete quickly.
    const TRANSFER_INTERVAL = 8; // ms between transfers (very fast marching)
    const FADE_STEP = 100; // ms for each fade stage (light -> darker -> base)
    let lastTransfer = performance.now();

    let raf = null;
    let stopped = false;

    function drawFrame() {
      ctxp.clearRect(0, 0, W, H);
      // fill black background (canvas sits on black cover, but fill to be explicit)
      ctxp.fillStyle = '#000';
      ctxp.fillRect(0, 0, W, H);

      const tnow = performance.now();

      // perform transfer if enough time and still active
      if (tnow - lastTransfer >= TRANSFER_INTERVAL) {
        lastTransfer = tnow;
        // current white position becomes light gray stage (stage 1) and starts its fade cycle
        const curKey = whiteKey();
        state.set(curKey, { stage: 1, t0: tnow }); // light gray
        // advance white to next ring cell
        whiteIndex = (whiteIndex + 1) % ring.length;
        const nxtKey = whiteKey();
        // set next to white (stage 9)
        state.set(nxtKey, { stage: 9, t0: tnow });
      }

      // update fade stages by time elapsed and draw each ring cell
      for (const p of ring) {
        const key = `${p.x},${p.y}`;
        const rec = state.get(key) || { stage: 0, t0: tnow };
        let drawColor = null;
        // stage mapping:
        // 9 -> current white alive pixel (draw bright white)
        // 1 -> light gray for FADE_STEP ms, then -> 2
        // 2 -> darker gray for FADE_STEP ms, then -> 0 (return to base ring state)
        // 0 -> steady mid-gray ring
        if (rec.stage === 9) {
          drawColor = '#fff';
        } else if (rec.stage === 1) {
          const dt = tnow - rec.t0;
          if (dt >= FADE_STEP) {
            // advance to stage 2
            state.set(key, { stage: 2, t0: rec.t0 + FADE_STEP });
            drawColor = '#bfbfbf'; // darker light gray
          } else {
            drawColor = '#e6e6e6'; // light gray
          }
        } else if (rec.stage === 2) {
          const dt = tnow - rec.t0;
          if (dt >= FADE_STEP) {
            // cycle back to base ring state (don't let pixels die)
            state.set(key, { stage: 0, t0: rec.t0 + FADE_STEP });
            drawColor = '#5b5b5b';
          } else {
            drawColor = '#9a9a9a'; // darker
          }
        } else {
          // base gray ring (stage 0)
          drawColor = '#5b5b5b';
        }

        if (drawColor) {
          const sx = p.x * cellW;
          const sy = p.y * cellH;
          ctxp.fillStyle = drawColor;
          ctxp.fillRect(sx, sy, cellW, cellH);
        }
      }

      if (!stopped) raf = requestAnimationFrame(drawFrame);
    }

    // start animation
    raf = requestAnimationFrame(drawFrame);

    // attach a stop/cleanup handle to the cover element so removal code can cancel RAF
    canvasEl._pixelRingStop = () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    };

  })(pixCanvas);

  document.body.appendChild(overlay);

  // Click anywhere on the title screen to start (mirrors the X-key shortcut).
  // Respects the same initial-boost lock the keydown handler uses, so a click during the
  // opening black-cover boost doesn't skip past it early.
  overlay.addEventListener('click', () => {
    if (menuInitialBoostActive) return;
    try { dismissMainMenuAndStart(); } catch (err) {}
  });

  // spawn background gliders periodically while menu is active
  startMenuGliderSpawning();
  // start sir robin spawner for menu decorations
  startMenuSirRobinSpawner();

  // Boost gens-per-second (GPS) briefly while the main menu shows:
  // Save current stepInterval, set very fast rate for 1000 GPS, then restore after 5s.
  // During this initial boosted period the blackCover remains fully opaque and X is blocked.
  try {
    const prevStepInterval = stepInterval;
    // 1000 generations per second -> ms per generation
    stepInterval = 1000 / 1000;
    running = true;
    // After boost ends, restore stepInterval and fade/remove the black cover then re-enable X.
    setTimeout(() => {
      stepInterval = prevStepInterval;
      // fade out black cover
      try {
        if (_menuBlackCover) {
          _menuBlackCover.style.opacity = '0';
          // remove after transition completes; clear dots interval before removing
          setTimeout(() => {
            try {
              if (_menuBlackCover && _menuBlackCover._dotsInterval) {
                clearInterval(_menuBlackCover._dotsInterval);
                _menuBlackCover._dotsInterval = null;
              }
            } catch (e) {}
            if (_menuBlackCover && _menuBlackCover.parentElement) {
              _menuBlackCover.parentElement.removeChild(_menuBlackCover);
            }
            _menuBlackCover = null;
            menuInitialBoostActive = false;
            flashTinyToast('Ready');
          }, 700);
        } else {
          menuInitialBoostActive = false;
        }
      } catch (e) {
        menuInitialBoostActive = false;
      }
    }, 5000);
  } catch (e) {
    // fail silently if any variable not available
    console.warn('Failed to apply main menu GPS boost', e);
    // ensure we still clear the cover if something goes wrong
    setTimeout(() => {
      if (_menuBlackCover && _menuBlackCover.parentElement) _menuBlackCover.parentElement.removeChild(_menuBlackCover);
      _menuBlackCover = null;
      menuInitialBoostActive = false;
    }, 5000);
  }
}

function dismissMainMenuAndStart() {
  if (!showMainMenu) return;
  showMainMenu = false;
  // remove overlay
  if (_mainMenuOverlay) {
    try {
      _mainMenuOverlay.style.transition = 'opacity 220ms ease';
      _mainMenuOverlay.style.opacity = '0';
    } catch (e) {}
  }
  // clear canvas blur
  canvas.style.filter = '';
  // stop spawning menu gliders
  stopMenuGliderSpawning();
  setTimeout(() => {
    if (_mainMenuOverlay && _mainMenuOverlay.parentElement) _mainMenuOverlay.remove();
    _mainMenuOverlay = null;
    // Clear all world state so no alive/faded/pending/invincible cells remain when main menu finishes
    alive.clear();
    birth.clear();
    states.clear();
    invincible.clear();
    pendingPlacement.clear();
    activatePendingOnly = false;
    pendingPlacementStart = 0;
    generation = 0;
    historyStack.length = 0;
    // now start the original startup sequence
    startStartupSequence();
  }, 200);
}

/* ================= Developer skip keys (0 / 9, title screen ONLY) =================
   Undocumented shortcuts that only function while the main menu/title screen is showing
   (showMainMenu === true): pressing 0 or 9 bypasses BOTH the main menu AND the entire typed
   introduction sequence in one step, landing directly in the normal playable game exactly as
   if the player had clicked through the whole intro and answered the mobile/PC question --
   0 pretends the player chose "PC", 9 pretends the player chose "Mobile" (which also brings up
   the on-screen virtual keyboard, same as a real mobile player finishing the intro normally
   would get). Neither key does anything at any other point in the game; the gate that gives
   these keys their meaning is the same `showMainMenu` check the title screen's own X-to-start
   key uses, immediately above this function.

   This intentionally does NOT reuse dismissMainMenuAndStart()/startStartupSequence(), since
   those still run the full typed segments -- it instead replicates the END state that
   endStartupSequence() (the intro's own normal finishing point, see startStartupSequence
   above) leaves the game in, so the world/rules/UI end up identical to a normally-completed
   intro, just without ever displaying or waiting on any of the typed text. */
function devSkipToGame(platformChoice) {
  if (!showMainMenu) return; // only meaningful from the title screen
  showMainMenu = false;

  // Tear down every piece of title-screen state the same way dismissMainMenuAndStart() does,
  // plus the black-cover boost overlay in case this is pressed during that initial period.
  stopMenuGliderSpawning();
  stopMenuSirRobinSpawner();
  canvas.style.filter = '';
  if (_mainMenuOverlay && _mainMenuOverlay.parentElement) _mainMenuOverlay.remove();
  _mainMenuOverlay = null;
  if (_menuBlackCover) {
    if (_menuBlackCover._dotsInterval) { clearInterval(_menuBlackCover._dotsInterval); _menuBlackCover._dotsInterval = null; }
    if (_menuBlackCover.parentElement) _menuBlackCover.parentElement.removeChild(_menuBlackCover);
    _menuBlackCover = null;
  }
  menuInitialBoostActive = false;
  menuSirRobins.length = 0;

  // Startup sequence never actually ran, so make sure its own flag/lock state can't linger.
  startupActive = false;
  controlsLockedUntil = 0;

  // Pretend the player answered the intro's mobile/PC question with the requested choice.
  playerPlatformChoice = platformChoice;

  // Reset world/rules to the exact same clean defaults endStartupSequence() leaves behind.
  alive.clear();
  birth.clear();
  states.clear();
  invincible.clear();
  pendingPlacement.clear();
  activatePendingOnly = false;
  pendingPlacementStart = 0;
  generation = 0;
  historyStack.length = 0;

  birthRules = new Set([3]);
  survivalRules = new Set([2, 3]);
  cellStatesCount = 2;
  ltlMode = false;
  __ltlPrevBirthRules = null;
  __ltlPrevSurvivalRules = null;
  __ltlPrevCellStatesCount = null;

  try { deadLanding.clear(); landingMapVisible = false; } catch (e) {}

  try { if (playerPlatformChoice === 'mobile') showVirtualKeyboard(); } catch (e) {}

  flashTinyToast('Ready');
  flashTinyToast('Press U for controls', 3200);
  flashTopBannerToast('Need help? Just do Alt + D for important instructions');
}

function startMenuGliderSpawning() {
  // ensure rules are set to Conway for background motion
  birthRules = new Set([3]);
  survivalRules = new Set([2,3]);
  cellStatesCount = 2;

  // spawn an initial flock
  for (let i = 0; i < 6; i++) spawnMenuGlider();

  // spawn more every ~1100ms while menu active
  _menuGliderInterval = setInterval(() => {
    if (!showMainMenu) return;
    spawnMenuGlider();
  }, 1100);
}

function stopMenuGliderSpawning() {
  if (_menuGliderInterval) { clearInterval(_menuGliderInterval); _menuGliderInterval = null; }
}

 // Standard glider pattern relative coords (one orientation that moves down-right)
 const GLIDER = [{x:1,y:0},{x:2,y:1},{x:0,y:2},{x:1,y:2},{x:2,y:2}];
 
 // ---------- Sir Robin (menu decor) and anomaly scanner ----------
 // Sir Robins are drawn behind gliders and do NOT participate in the life simulation:
 // they are tracked as moving decorative objects (positions float) and are ignored by the scanner.
 const menuSirRobins = []; // each: { x: floatWorldX, y: floatWorldY, vx, vy, cells: Array<{x,y}> , bbox: {w,h} }
 let _menuSirRobinTimer = null;
 const SIR_ROBIN_SPAWN_INTERVAL_MS = 15000; // spawn every 15 seconds
 
 // Try to find Sir Robin pattern from the presets (uses parseRLE which returns relative coords)
 let SIR_ROBIN_TEMPLATE = null;
 try {
   const sr = presets.find(p => /Sir Robin/i.test(p.name));
   if (sr) SIR_ROBIN_TEMPLATE = parseRLE(sr.rle); // array of {x,y,s}
 } catch (e) { SIR_ROBIN_TEMPLATE = null; }
 // fallback minimal shape if parse failed
 if (!SIR_ROBIN_TEMPLATE) SIR_ROBIN_TEMPLATE = [{x:0,y:0},{x:1,y:0},{x:0, y:1},{x:1,y:1},{x:2,y:1},{x:1,y:2}];
 // Normalize template to just coords (ignore states)
 SIR_ROBIN_TEMPLATE = SIR_ROBIN_TEMPLATE.map(c => ({ x: c.x, y: c.y }));
 
 // Spawn a single Sir Robin off-screen bottom-right; they'll be drawn behind gliders and move diagonally up-left.
 function spawnMenuSirRobin() {
   // compute rough world bounds based on view
   const halfW = innerWidth / 2;
   const halfH = innerHeight / 2;
   const left = Math.floor(( -halfW) / cellSize + offsetX) - 1;
   const right = Math.ceil(( halfW) / cellSize + offsetX) + 1;
   const top = Math.floor(( -halfH) / cellSize + offsetY) - 1;
   const bottom = Math.ceil(( halfH) / cellSize + offsetY) + 1;
 
   // choose spawn area off-screen bottom-right
   const spawnXMin = right + 8;
   const spawnXMax = right + 40;
   const spawnYMin = bottom + 8;
   const spawnYMax = bottom + 40;
 
   const baseX = Math.floor(Math.random() * (spawnXMax - spawnXMin + 1)) + spawnXMin;
   const baseY = Math.floor(Math.random() * (spawnYMax - spawnYMin + 1)) + spawnYMin;
 
   // velocity: move up-left at a modest speed (world cells per second)
   const speed = 6 + Math.random() * 8; // cells/sec
   const angle = -Math.PI * 3/4 + (Math.random() - 0.5) * 0.3; // roughly up-left
   const vx = Math.cos(angle) * speed;
   const vy = Math.sin(angle) * speed;
 
   // compute bbox for quick offscreen removal
   let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
   for (const c of SIR_ROBIN_TEMPLATE) {
     if (c.x < minx) minx = c.x;
     if (c.x > maxx) maxx = c.x;
     if (c.y < miny) miny = c.y;
     if (c.y > maxy) maxy = c.y;
   }
   const bbox = { w: maxx - minx + 1, h: maxy - miny + 1 };
 
   menuSirRobins.push({
     x: baseX,
     y: baseY,
     vx, vy,
     cells: SIR_ROBIN_TEMPLATE,
     bbox
   });
 }
 
 // Move and cull Sir Robins each frame. Called from the main frame loop.
 function updateMenuSirRobins(dtMs) {
   if (menuSirRobins.length === 0) return;
   // dtMs in ms; convert to seconds for world movement in cells
   const dt = dtMs / 1000;
   for (let i = menuSirRobins.length - 1; i >= 0; i--) {
     const sr = menuSirRobins[i];
     sr.x += sr.vx * dt;
     sr.y += sr.vy * dt;
     // cull when largely out of view plus margin
     const margin = 48;
     const halfW = innerWidth / 2, halfH = innerHeight / 2;
     const left = Math.floor(( -halfW) / cellSize + offsetX) - margin;
     const right = Math.ceil(( halfW) / cellSize + offsetX) + margin;
     const top = Math.floor(( -halfH) / cellSize + offsetY) - margin;
     const bottom = Math.ceil(( halfH) / cellSize + offsetY) + margin;
     if (sr.x + sr.bbox.w < left || sr.x > right || sr.y + sr.bbox.h < top || sr.y > bottom) {
       menuSirRobins.splice(i,1);
     }
   }
 }
 
 // Draw Sir Robins behind main-life cells (called from draw() before alive cells rendering)
 function drawMenuSirRobins() {
   if (menuSirRobins.length === 0) return;
   // dark color for sir robin (respects invert by choosing contrast)
   const col = invertColors ? 'rgba(30,30,30,0.95)' : 'rgba(12,12,12,0.95)';
   ctx.save();
   ctx.fillStyle = col;
   for (const sr of menuSirRobins) {
     // draw each template cell at integer-rounded positions
     for (const c of sr.cells) {
       const tx = Math.round(sr.x + c.x);
       const ty = Math.round(sr.y + c.y);
       const sx = Math.round((tx - offsetX) * cellSize + innerWidth/2);
       const sy = Math.round((ty - offsetY) * cellSize + innerHeight/2);
       ctx.fillRect(sx, sy, Math.max(1, Math.ceil(cellSize)), Math.max(1, Math.ceil(cellSize)));
     }
   }
   ctx.restore();
 }
 
 // Anomaly scanner: during main menu, periodically check for connected components of alive cells
 // that are not simple glider-sized groups; ignore sir robins (they are separate visuals) and pendingPlacement.
 // If any component with size > 5 is found, clear the main-menu alive cells (not sir robins).
 // This is intentionally conservative and lightweight.
 function scanMenuForAnomalies() {
   // build a quick set of sir robin occupied keys (rounded integer positions) to ignore
   const sirSet = new Set();
   for (const sr of menuSirRobins) {
     for (const c of sr.cells) {
       const k = `${Math.round(sr.x + c.x)},${Math.round(sr.y + c.y)}`;
       sirSet.add(k);
     }
   }
   // BFS components over alive Set excluding sirSet and excluding pendingPlacement
   const visited = new Set();
   for (const key of alive) {
     if (visited.has(key)) continue;
     if (sirSet.has(key)) continue;
     // flood fill
     const stack = [key];
     const comp = [];
     visited.add(key);
     while (stack.length) {
       const cur = stack.pop();
       comp.push(cur);
       const [cx, cy] = parseKey(cur);
       for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++) {
         if (dx===0 && dy===0) continue;
         const nk = `${cx+dx},${cy+dy}`;
         if (visited.has(nk)) continue;
         if (sirSet.has(nk)) continue;
         if (pendingPlacement.has(nk)) continue;
         if (alive.has(nk)) {
           visited.add(nk);
           stack.push(nk);
         }
       }
     }
     // If this component size is larger than a glider (5) and not exactly 5, treat as anomaly.
     if (comp.length > 5) {
       // reset main-menu alive state (but keep sir robins intact). We clear alive/pending/states/invincible as little as possible:
       alive.clear();
       birth.clear();
       pendingPlacement.clear();
       states.clear();
       invincible.clear();
       flashTinyToast('Menu anomaly detected: clearing alive cells');
       return; // one reset is enough
     }
     // if comp.length == 5 we assume it's a glider (conservative) and let it be
   }
 }
 
 // Start/stop sir robin spawner when menu glider spawning is toggled
 function startMenuSirRobinSpawner() {
   // spawn one immediately, then periodic
   try { spawnMenuSirRobin(); } catch (e) {}
   if (_menuSirRobinTimer) clearInterval(_menuSirRobinTimer);
   _menuSirRobinTimer = setInterval(() => {
     // spawn only a single Sir Robin (no groups)
     spawnMenuSirRobin();
   }, SIR_ROBIN_SPAWN_INTERVAL_MS);
 }
 function stopMenuSirRobinSpawner() {
   if (_menuSirRobinTimer) { clearInterval(_menuSirRobinTimer); _menuSirRobinTimer = null; }
 }
 
 // Spawn a glider off-screen in the top/left band so it emerges into view, and avoid placing them overlapping existing live cells.
 function spawnMenuGlider() {
   // compute visible world bounds same as renderer
   const halfW = innerWidth / 2;
   const halfH = innerHeight / 2;
   const left = Math.floor(( -halfW) / cellSize + offsetX) - 1;
   const right = Math.ceil(( halfW) / cellSize + offsetX) + 1;
   const top = Math.floor(( -halfH) / cellSize + offsetY) - 1;
   const bottom = Math.ceil(( halfH) / cellSize + offsetY) + 1;
 
   // pick spawn region: x from (left - 40 .. left - 8), y from (top - 40 .. top - 8)
   const spawnXMin = left - 40;
   const spawnXMax = left - 8;
   const spawnYMin = top - 40;
   const spawnYMax = top - 8;
 
   // attempt a few times to find a non-conflicting spot
   for (let attempt = 0; attempt < 8; attempt++) {
     const baseX = Math.floor(Math.random() * (spawnXMax - spawnXMin + 1)) + spawnXMin;
     const baseY = Math.floor(Math.random() * (spawnYMax - spawnYMin + 1)) + spawnYMin;
     // verify no alive within a 6-cell radius of the placement to avoid overlap
     let conflict = false;
     for (const c of GLIDER) {
       const gx = baseX + c.x, gy = baseY + c.y;
       for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
         const nk = `${gx+dx},${gy+dy}`;
         if (alive.has(nk) || pendingPlacement.has(nk) || invincible.has(nk) || states.has(nk)) { conflict = true; break; }
       }
       if (conflict) break;
     }
     if (conflict) continue;
 
     // place the glider as immediate alive cells (they should move under the same rules already set)
     const now = performance.now();
     let placed = 0;
     for (const c of GLIDER) {
       const x = baseX + c.x, y = baseY + c.y;
       const k = `${x},${y}`;
       // ensure we don't place on top of Sir Robin visual positions (so gliders visually pass in front)
       let onSir = false;
       for (const sr of menuSirRobins) {
         for (const sc of sr.cells) {
           if (Math.round(sr.x + sc.x) === x && Math.round(sr.y + sc.y) === y) { onSir = true; break; }
         }
         if (onSir) break;
       }
       if (onSir) continue;
       if (invincible.has(k)) continue;
       if (!alive.has(k)) {
         alive.add(k);
         birth.set(k, { t: now, p: pausedAccum, gen: generation });
         placed++;
       }
     }
     if (placed > 0) return;
   }
   // If failed to find non-conflicting spot, skip this spawn.
 }

presets.push({
  name: 'Side Gun',
  category: 'Guns',
  rle: `#N Slide gun
#O Jason Summers
#C A diagonal slide gun constructed on September 3, 1999
#C https://www.conwaylife.com/wiki/index.php?title=Slide_gun
x = 109, y = 59, rule = b3/s23
56b2o51b$56b2o51b2$78bo30b$78bobo28b$81b2o6b2o18b$38b2o27b2o12b2o4bo3bo17b$38b2o16b3o8b2o12b2o3bo5bo8b2o6b$78bobo4b2obo3bo8b2o6b$56bobo19bo7bo5bo16b$55b5o27bo3bo17b$54b2o3b2o4b2o22b2o18b$54b2o3b2o3bo2bo11bo29b$64bo12b2o30b$64bo13b2o29b$64bob2o41b$66b2o41b2$83b2o24b$59b2o4b2o15b2o10bobo12b$59bo5b2o17bo8bo2bo12b$60b3o16b2o11b2o10b2o3b$62bo16bobo8b2o3bo8b2o3b$74b2o6bo9b2o5b2o8b$73bo2bo2bo2bo10bo2bo4bo7b$73b3o6bo11bobo12b$46b3o22b3o5bobo27b$48bo15bo5bobo6b2o28b$47bo14b2o6bo38b$63b2o4b2o38b$55bo53b$35b2o17bobo52b$35bo18b2obo14b2o35b$24bo8bobo18b2ob2o14bo35b$24b4o5b2o19b2obo15bobo10bo22b$8bo16b4o15b2o8bobo4b2o11b2o9b4o20b$7bobo5b2o8bo2bo14bobo9bo5bobo7bo12b2ob4o5b2o11b$5b2o3bo14b4o14bo19bo6b2o11b3ob2o3bo3bo2bo9b$2o3b2o3bo4bobob2o3b4o14b2o19b2o5bobo11b2ob2o3bo7bo8b$2o3b2o3bo5b2o3bo2bo60b5o3bo6bo6b2o$7bobo10bo18b2o45bo3b3o7bo6b2o$8bo8bo2bo10b3o4bobo27b2o26bo2bo9b$33bo3b3o28bo2bo24b2o11b$32bo4b2o70b$40b2o26bo2bo12bo24b$27bo11b3o25bo2bo11b2o25b$28bo38bobo12b3o24b$28bo39bo11b3o26b$24bo2bo11b2o39b2o27b$6bo5b2o9bo15b2o27b2o39b$4bo3bo3b3o10bo42b2o16b2o9bo11b$8bo5b2obo11bo55b4o7bobo10b$3bo5bo4bo2bo10b2o50bobo2bo2b3o5b2obo9b$3b2o9b2obo9b2o4b2o2b2o40bo2bo2b2o9b2ob2o3b2o3b$12b3o11b3o4b2o2b2o31b2o6b2o9bo6b2obo4b2o3b$12b2o13b2o4b2o35b2o4b2o3bo8bo5bobo10b$28b2o48b2o10bo6bo11b$29bo49bo2bo26b$80bobo!`
});
 presets.push({
  name: 'Time Bomb',
  category: 'Special',
  tag: 'Rake',
  rle: `#N Time bomb
#O Doug Petrie
#C An infinite-growth mechanism that is a predecessor of the diagonal period 384 c/12 glider-producing switch engine.
#C www.conwaylife.com/wiki/index.php?title=Glider-producing_switch_eng
#C ine
x = 15, y = 6, rule = B3/S23
bo11b2o$obo4bo6bo$7bo4bo2b$2bo2bo3bo2bo2b$2b2o6bo4b$3bo!`
});

 // Start by showing the main menu overlay instead of immediately starting startup sequence
createMainMenuOverlay();

/* Ctrl+X Preset Scanner
   Opens a modal listing all Y-presets; choosing one and pressing Start will:
   - build a full snapshot of the current world (alive + faded states)
   - compute minimal canvas size that contains all live/faded cells
   - render the world to that canvas and search for the chosen preset pattern occurrences
   - highlight each match region on the canvas
   - offer download of the preview image as png/jpeg/webp
*/
function openCtrlXPresetScanner() {
  if (document.getElementById('ctrlx-scan-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'ctrlx-scan-modal';
  Object.assign(modal.style, {
    position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
    background: '#111', color: '#fff', padding: '12px', borderRadius: '8px', zIndex: 13000,
    width: 'min(92vw,820px)', maxHeight: '86vh', overflow: 'auto', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Preset Map Scanner (Ctrl+X)';
  Object.assign(title.style, { fontWeight: '700', marginBottom: '8px' });
  modal.appendChild(title);

  const help = document.createElement('div');
  help.textContent = 'Select a preset, or paste your own RLE, to scan your entire map for instances; Start builds a minimal preview and highlights all matches.';
  Object.assign(help.style, { fontSize: '13px', color: 'rgba(255,255,255,0.88)', marginBottom: '10px' });
  modal.appendChild(help);

  const content = document.createElement('div');
  content.style.display = 'flex';
  content.style.gap = '12px';

  // left: preset list (reuse presets array) + independent RLE paste area below it.
  // The preset list scrolls on its own (fixed height); the RLE box is a separate, non-scrolling
  // block underneath it so it's always fully visible and never gets clipped/scrolled out of view.
  const left = document.createElement('div');
  left.style.flex = '0 0 320px';
  left.style.display = 'flex';
  left.style.flexDirection = 'column';
  left.style.gap = '8px';
  // left itself does not scroll or clip -- only the preset sub-list below does
  left.style.maxHeight = '60vh';
  left.style.overflow = 'visible';

  // scrollable preset sub-container (independent scroll region)
  const presetScroll = document.createElement('div');
  presetScroll.style.flex = '1 1 auto';
  presetScroll.style.minHeight = '80px';
  presetScroll.style.maxHeight = '40vh';
  presetScroll.style.overflow = 'auto';
  presetScroll.style.display = 'flex';
  presetScroll.style.flexDirection = 'column';
  presetScroll.style.gap = '6px';

  const presetHeader = document.createElement('div');
  presetHeader.textContent = 'Presets (Y list)';
  presetHeader.style.fontWeight = '700';
  presetScroll.appendChild(presetHeader);

  let selectedPresetIndex = -1;
  let selectedPresetName = null;
  function makePresetButton(p, idx) {
    const b = document.createElement('button');
    b.textContent = p.name;
    Object.assign(b.style, { textAlign: 'left', padding: '8px', cursor: 'pointer' });
    b.addEventListener('click', () => {
      // clear previous selection visuals
      const prev = presetScroll.querySelectorAll('button');
      prev.forEach(btn => btn.style.outline = '');
      b.style.outline = '2px solid rgba(0,200,255,0.9)';
      selectedPresetIndex = idx;
      selectedPresetName = p.name;
      // mirror Shift+M's identification modal: picking a preset fills the RLE textarea
      // so the player can see/edit it, and typing/pasting into the textarea overrides the preset.
      ta.value = p.rle || '';
    });
    return b;
  }

  presets.forEach((p, i) => {
    presetScroll.appendChild(makePresetButton(p, i));
  });

  left.appendChild(presetScroll);
  content.appendChild(left);

  // RLE paste area, same idea as the Shift+M Identification Scanner: pick a preset above
  // (which fills this box) or paste/type any RLE directly to scan your whole map for it.
  // This block sits OUTSIDE presetScroll's scroll region, in `left` itself, so scrolling the
  // preset list never covers or hides it -- it's always fully visible beneath the list.
  const rleSection = document.createElement('div');
  rleSection.style.flex = '0 0 auto';
  rleSection.style.display = 'flex';
  rleSection.style.flexDirection = 'column';
  rleSection.style.gap = '4px';

  const rleLabel = document.createElement('div');
  rleLabel.textContent = 'Or paste an RLE to scan for: (Enter or Ctrl+Enter to scan)';
  Object.assign(rleLabel.style, { fontWeight: '700', marginTop: '4px', fontSize: '12px' });
  rleSection.appendChild(rleLabel);

  const rleInputRow = document.createElement('div');
  rleInputRow.style.display = 'flex';
  rleInputRow.style.gap = '6px';
  rleInputRow.style.alignItems = 'stretch';

  const ta = document.createElement('textarea');
  ta.placeholder = 'Paste RLE here (or pick a preset above).';
  Object.assign(ta.style, { flex: '1 1 auto', width: '100%', height: '110px', boxSizing: 'border-box', fontSize: '12px' });
  // typing/pasting a custom pattern deselects the active preset button so the display name
  // and folder/download naming reflect that this is now a custom pattern, not the preset.
  ta.addEventListener('input', () => {
    if (selectedPresetIndex >= 0) {
      const prevBtns = presetScroll.querySelectorAll('button');
      prevBtns.forEach(btn => btn.style.outline = '');
    }
    selectedPresetIndex = -1;
    selectedPresetName = null;
  });
  // Enter (or Ctrl+Enter) inside the textarea triggers the scan directly, same as clicking
  // Start Scan. Plain Enter alone is used (rather than requiring Shift/Ctrl) since RLE text
  // pasted from external sources is typically single-line or already newline-formatted by the
  // paste itself; Shift+Enter still inserts a literal newline for anyone editing by hand.
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      if (!startBtn.disabled) startBtn.click();
    }
  });
  rleInputRow.appendChild(ta);

  const rleEnterBtn = document.createElement('button');
  rleEnterBtn.textContent = 'Enter';
  Object.assign(rleEnterBtn.style, { padding: '8px 10px', cursor: 'pointer', flex: '0 0 auto', alignSelf: 'flex-start' });
  rleEnterBtn.addEventListener('click', () => {
    if (!startBtn.disabled) startBtn.click();
  });
  rleInputRow.appendChild(rleEnterBtn);

  rleSection.appendChild(rleInputRow);

  left.appendChild(rleSection);

  // right: preview area + controls
  const right = document.createElement('div');
  right.style.flex = '1';
  right.style.display = 'flex';
  right.style.flexDirection = 'column';
  right.style.gap = '8px';

  const canvasWrap = document.createElement('div');
  canvasWrap.style.display = 'flex';
  canvasWrap.style.justifyContent = 'center';
  canvasWrap.style.alignItems = 'center';
  canvasWrap.style.minHeight = '220px';
  canvasWrap.style.background = 'rgba(255,255,255,0.02)';
  canvasWrap.style.borderRadius = '6px';
  canvasWrap.style.padding = '8px';
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = 640;
  previewCanvas.height = 360;
  previewCanvas.style.maxWidth = '100%';
  previewCanvas.style.border = '1px solid rgba(255,255,255,0.06)';
  previewCanvas.style.background = invertColors ? '#fff' : '#000';
  canvasWrap.appendChild(previewCanvas);
  right.appendChild(canvasWrap);

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.gap = '8px';
  controls.style.alignItems = 'center';

  const startBtn = document.createElement('button');
  startBtn.textContent = 'Start Scan';
  Object.assign(startBtn.style, { padding: '8px 12px', cursor: 'pointer' });

  const downloadSelect = document.createElement('select');
  ['image/png','image/jpeg','image/webp'].forEach(mime => {
    const o = document.createElement('option');
    o.value = mime;
    o.textContent = mime.split('/')[1].toUpperCase();
    downloadSelect.appendChild(o);
  });
  downloadSelect.style.padding = '6px';

  const downloadBtn = document.createElement('button');
  downloadBtn.textContent = 'Download Preview';
  Object.assign(downloadBtn.style, { padding: '8px 12px', cursor: 'pointer' });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { padding: '8px 12px', cursor: 'pointer' });
  closeBtn.addEventListener('click', () => {
    const el = document.getElementById('ctrlx-scan-modal');
    if (el) el.remove();
  });

  controls.appendChild(startBtn);
  controls.appendChild(downloadSelect);
  controls.appendChild(downloadBtn);
  controls.appendChild(closeBtn);
  right.appendChild(controls);

  // result count label
  const resultLabel = document.createElement('div');
  resultLabel.textContent = 'Matches: 0';
  resultLabel.style.fontWeight = '700';
  right.appendChild(resultLabel);

  content.appendChild(right);
  modal.appendChild(content);
  document.body.appendChild(modal);

  // Helper: build a full snapshot grid from world (alive + fading states) and return { grid: Uint8Array, minx, miny, w, h }
  function buildWorldSnapshot() {
    // gather keys from alive and states
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    function touch(x,y){ if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    let any = false;
    for (const k of alive) {
      const [x, y] = parseKey(k);
      touch(x,y); any = true;
    }
    for (const [k, st] of states.entries()) {
      const [x, y] = parseKey(k);
      touch(x,y); any = true;
    }
    // if nothing present, fallback to a small centered area
    if (!any) {
      const cx = Math.floor(offsetX);
      const cy = Math.floor(offsetY);
      minx = cx - 16; maxx = cx + 16; miny = cy - 12; maxy = cy + 12;
    }
    // add small padding
    minx -= 2; miny -= 2; maxx += 2; maxy += 2;
    const w = Math.min(2000, maxx - minx + 1);
    const h = Math.min(2000, maxy - miny + 1);
    const grid = new Uint8Array(w * h);
    // fill alive
    for (const k of alive) {
      const [x, y] = parseKey(k);
      const gx = x - minx;
      const gy = y - miny;
      if (gx >= 0 && gx < w && gy >= 0 && gy < h) grid[gy * w + gx] = 1;
    }
    // fading states: treat as alive for matching view preview but they won't be considered in neighbor counts of the scanning;
    for (const [k, st] of states.entries()) {
      const [x, y] = parseKey(k);
      const gx = x - minx;
      const gy = y - miny;
      if (gx >= 0 && gx < w && gy >= 0 && gy < h) grid[gy * w + gx] = 1;
    }
    return { grid, minx, miny, w, h };
  }

  // local pattern parsing (returns {norm,w,h} with norm coords)
  function parseTargetRLELocal(text) {
    try {
      const rel = parseRLE(text);
      if (!rel || rel.length === 0) return null;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const c of rel) {
        if (c.x < minx) minx = c.x;
        if (c.x > maxx) maxx = c.x;
        if (c.y < miny) miny = c.y;
        if (c.y > maxy) maxy = c.y;
      }
      const w = maxx - minx + 1;
      const h = maxy - miny + 1;
      const norm = rel.map(c => ({ x: c.x - minx, y: c.y - miny }));
      return { norm, w, h };
    } catch (e) { return null; }
  }

  // scan routine: brute-force slide pattern across big grid; returns array of {x,y} top-left matches
  function scanForPatternOnGrid(grid, gw, gh, target) {
    const found = [];
    if (!target) return found;
    const { norm, w: tw, h: th } = target;
    // make pattern set for quick containment
    const pset = new Set(norm.map(c => `${c.x},${c.y}`));
    // iterate positions where pattern fits
    for (let oy = 0; oy <= gh - th; oy++) {
      for (let ox = 0; ox <= gw - tw; ox++) {
        let ok = true;
        // verify every pattern cell present as 1
        for (let k = 0; k < norm.length; k++) {
          const px = ox + norm[k].x;
          const py = oy + norm[k].y;
          if (grid[py * gw + px] !== 1) { ok = false; break; }
        }
        if (!ok) continue;
        // ensure no other alive cell touches pattern (3x3 around each pattern cell)
        let touching = false;
        for (let k = 0; k < norm.length && !touching; k++) {
          const baseX = ox + norm[k].x;
          const baseY = oy + norm[k].y;
          for (let ny = -1; ny <= 1 && !touching; ny++) {
            for (let nx = -1; nx <= 1; nx++) {
              const sx = baseX + nx;
              const sy = baseY + ny;
              const relX = sx - ox;
              const relY = sy - oy;
              if (relX >= 0 && relY >= 0 && relX < tw && relY < th && pset.has(`${relX},${relY}`)) continue;
              if (sx < 0 || sx >= gw || sy < 0 || sy >= gh) continue;
              if (grid[sy * gw + sx] === 1) { touching = true; break; }
            }
          }
        }
        if (!touching) found.push({ x: ox, y: oy });
      }
    }
    return found;
  }

  // render world snapshot into the previewCanvas and highlight matches (matches are in grid coords)
  function renderPreviewAndHighlight(snapshot, matches, target) {
    const ctx = previewCanvas.getContext('2d');
    // compute canvas dims respecting maximum width
    const maxRenderW = Math.min(1400, Math.max(300, Math.floor(window.innerWidth * 0.8)));
    const maxRenderH = Math.min(1200, Math.max(200, Math.floor(window.innerHeight * 0.6)));
    const gw = snapshot.w, gh = snapshot.h;
    // choose scale to fit into maxRenderW x maxRenderH while preserving aspect
    const scale = Math.max(1, Math.floor(Math.min(maxRenderW / gw, maxRenderH / gh)));
    previewCanvas.width = gw * scale;
    previewCanvas.height = gh * scale;
    previewCanvas.style.width = (previewCanvas.width > window.innerWidth * 0.8 ? (window.innerWidth * 0.8 + 'px') : previewCanvas.width + 'px');
    previewCanvas.style.height = previewCanvas.height + 'px';
    // fill background
    ctx.fillStyle = invertColors ? '#fff' : '#000';
    ctx.fillRect(0,0,previewCanvas.width, previewCanvas.height);

    // draw each cell (alive=white/black depending on invert)
    const aliveColor = invertColors ? '#000' : '#fff';
    const deadColor = invertColors ? '#fff' : '#000';
    ctx.fillStyle = deadColor;
    ctx.fillRect(0,0,previewCanvas.width, previewCanvas.height);

    ctx.fillStyle = aliveColor;
    for (let y=0;y<gh;y++){
      for (let x=0;x<gw;x++){
        if (snapshot.grid[y * gw + x] === 1) {
          ctx.fillRect(x*scale, y*scale, Math.max(1,scale), Math.max(1,scale));
        }
      }
    }

    // highlight matches with semi-transparent rectangles
    ctx.save();
    ctx.strokeStyle = 'rgba(255,0,64,0.95)';
    ctx.lineWidth = Math.max(1, Math.ceil(scale * 0.6));
    ctx.fillStyle = 'rgba(255,0,64,0.12)';
    for (const m of matches) {
      const rx = m.x * scale;
      const ry = m.y * scale;
      const rw = (target.w) * scale;
      const rh = (target.h) * scale;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(1,rw-1), Math.max(1,rh-1));
    }
    ctx.restore();

    resultLabel.textContent = `Matches: ${matches.length}`;
  }

  // Start scan button logic
  startBtn.addEventListener('click', async () => {
    const pastedRLE = ta.value.trim();
    if (!pastedRLE && (selectedPresetIndex < 0 || selectedPresetIndex >= presets.length)) {
      alert('Please select a preset from the left list, or paste an RLE to scan for.');
      return;
    }
    startBtn.disabled = true;
    resultLabel.textContent = 'Scanning...';
    await new Promise(r => setTimeout(r, 40)); // small yield for UI

    // Resolve which RLE text to scan for. Priority:
    // 1) If a preset is selected AND it has a filePath (external .txt), fetch that file fresh --
    //    this preserves the original preset-scanning behavior for file-backed presets.
    // 2) Otherwise use whatever is currently in the textarea (covers both a preset's inline RLE,
    //    which auto-fills the box on selection, and any custom RLE the player pasted/typed by hand).
    let rleText = pastedRLE;
    let selNameDisplay = 'Custom pasted pattern';
    if (selectedPresetIndex >= 0 && selectedPresetIndex < presets.length) {
      const preset = presets[selectedPresetIndex];
      selNameDisplay = preset.name || '(unnamed preset)';
      if (preset.filePath) {
        try {
          const resp = await fetch(preset.filePath);
          if (resp.ok) rleText = await resp.text();
        } catch (e) { /* fallback to whatever is in the textarea if fetch fails */ }
      }
    }
    if (!rleText) {
      startBtn.disabled = false;
      alert('Please select a preset from the left list, or paste an RLE to scan for.');
      return;
    }
    flashTinyToast(`Scanning for: ${selNameDisplay}`);

    const target = parseTargetRLELocal(rleText);
    if (!target) {
      startBtn.disabled = false;
      alert('Failed to parse the RLE (preset or pasted). Please check the pattern and try again.');
      return;
    }

    // Build initial full world snapshot (alive + fading states)
    const baseSnapshot = buildWorldSnapshot();
    const gw = baseSnapshot.w, gh = baseSnapshot.h;
    if (!baseSnapshot.grid || gw <= 0 || gh <= 0) {
      startBtn.disabled = false;
      alert('World snapshot empty.');
      return;
    }

    // We'll simulate the player's map for 50 gens, scanning each generation.
    // Work on a copy of the snapshot grid (Uint8Array) and evolve it using current birthRules/survivalRules.
    // Keep the generation that yields the most matches and render that afterward.
    const rounds = 50;
    let bestMatches = [];
    let bestGen = 0;
    let bestSnapshot = { grid: baseSnapshot.grid.slice(0), w: gw, h: gh, minx: baseSnapshot.minx, miny: baseSnapshot.miny };

    // Helper: perform one Game-of-Life step on a binary grid (state 1 counts, 0 dead)
    function stepGrid(grid, gw, gh, birthSet, survSet) {
      const next = new Uint8Array(gw * gh);
      // neighbor counts via map-like array
      const counts = new Uint8Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          if (grid[y * gw + x] !== 1) continue;
          for (let oy = -1; oy <= 1; oy++) {
            const yy = y + oy;
            if (yy < 0 || yy >= gh) continue;
            for (let ox = -1; ox <= 1; ox++) {
              const xx = x + ox;
              if (xx < 0 || xx >= gw) continue;
              if (ox === 0 && oy === 0) continue;
              counts[yy * gw + xx] = Math.min(255, counts[yy * gw + xx] + 1);
            }
          }
        }
      }
      // apply rules
      for (let i = 0; i < gw * gh; i++) {
        const n = counts[i];
        if (grid[i] === 1) {
          next[i] = survSet.has(n) ? 1 : 0;
        } else {
          next[i] = birthSet.has(n) ? 1 : 0;
        }
      }
      return next;
    }

    // perform scan at generation 0 (base snapshot) and then iterate
    try {
      let workingGrid = baseSnapshot.grid.slice(0);
      for (let gen = 0; gen < rounds; gen++) {
        // scan current workingGrid
        const matches = scanForPatternOnGrid(workingGrid, gw, gh, target);

        if (matches.length > bestMatches.length) {
          bestMatches = matches.slice();
          bestGen = gen;
          bestSnapshot = { grid: workingGrid.slice(0), w: gw, h: gh, minx: baseSnapshot.minx, miny: baseSnapshot.miny };
        }

        // step forward quickly (use current active birth/survival rules)
        workingGrid = stepGrid(workingGrid, gw, gh, birthRules, survivalRules);
      }

      // After rounds, render the bestSnapshot with highlights (bestMatches)
      // annotate target size for highlighting
      target.w = target.w; target.h = target.h;
      renderPreviewAndHighlight(bestSnapshot, bestMatches, target);

      // store lastSnapshot & lastMatches for download
      previewCanvas._lastSnapshot = bestSnapshot;
      previewCanvas._lastMatches = bestMatches;
      previewCanvas._lastTarget = target;

      startBtn.disabled = false;
      resultLabel.textContent = `Matches: ${bestMatches.length} (best at gen ${bestGen})`;
      flashTinyToast(`Scan complete: best generation ${bestGen} with ${bestMatches.length} match(es)`);
    } catch (err) {
      startBtn.disabled = false;
      alert('Scan failed: ' + err);
      console.error(err);
    }
  });

  // download button: export previewCanvas as blob with chosen mime type
  downloadBtn.addEventListener('click', () => {
    const mime = downloadSelect.value || 'image/png';
    // ensure canvas updated
    const cv = previewCanvas;
    if (!cv._lastSnapshot) {
      alert('Nothing to download: run a scan first.');
      return;
    }
    cv.toBlob((blob) => {
      if (!blob) { alert('Export failed'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ext = mime.split('/')[1];
      a.download = `map_scan.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      flashTinyToast(`Preview downloaded (${ext.toUpperCase()})`);
    }, mime, 0.92);
  });
}

/* ================= Scramble (Ctrl+D) =================
   A just-for-fun toy: nudges every cell on the board 1 space in its own random direction.
   No gameplay purpose -- purely for messing around and scrambling the current pattern.
   Collision handling: if a cell's chosen destination is already taken (by another cell that
   got there first, or by a cell that hasn't moved yet), it gets pushed one further cell in
   the SAME direction, repeating until it lands on a free spot. Nothing is ever deleted or
   silently merged -- cells just get shoved out of each other's way. */
function scrambleCells() {
  // Union of every kind of occupied cell: alive (state==1, fast-path set), states (any
  // non-zero state, including fading/ghost cells), and invincible (permanent, separate set).
  // We snapshot each cell's associated data so it travels with the cell to its new spot.
  const allKeys = new Set();
  for (const k of alive) allKeys.add(k);
  for (const k of states.keys()) allKeys.add(k);
  for (const k of invincible) allKeys.add(k);

  if (allKeys.size === 0) {
    flashTinyToast('Nothing to scramble -- the board is empty.');
    return;
  }

  const DIRS = [
    [-1,-1], [0,-1], [1,-1],
    [-1, 0],          [1, 0],
    [-1, 1], [0, 1], [1, 1]
  ];

  // Shuffle the order cells are processed in so collision resolution doesn't systematically
  // favor cells in scan order (which would look biased, e.g. always top-left wins).
  const keysArr = Array.from(allKeys);
  for (let i = keysArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keysArr[i], keysArr[j]] = [keysArr[j], keysArr[i]];
  }

  const claimed = new Set(); // destination keys already taken this scramble pass
  const moveTo = new Map();  // original key -> final destination key

  for (const k of keysArr) {
    const [x, y] = parseKey(k);
    const [dx, dy] = DIRS[Math.floor(Math.random() * DIRS.length)];
    let nx = x + dx, ny = y + dy;
    let nk = `${nx},${ny}`;
    let guard = 0;
    // Keep stepping one further cell in the same direction until we find a spot that's
    // neither already claimed by another moved cell this pass, nor still occupied by an
    // original cell that hasn't been processed yet (checked against the pre-scramble set).
    while ((claimed.has(nk) || allKeys.has(nk)) && guard < 5000) {
      nx += dx; ny += dy;
      nk = `${nx},${ny}`;
      guard++;
    }
    claimed.add(nk);
    moveTo.set(k, nk);
  }

  // Build fresh structures at the new positions, carrying over each cell's original data,
  // then swap them in atomically so nothing reads a half-scrambled board mid-update.
  const newAlive = new Set();
  const newStates = new Map();
  const newInvincible = new Set();
  const newBirth = new Map();

  for (const [oldKey, newKey] of moveTo.entries()) {
    if (alive.has(oldKey)) newAlive.add(newKey);
    if (states.has(oldKey)) newStates.set(newKey, states.get(oldKey));
    if (invincible.has(oldKey)) newInvincible.add(newKey);
    if (birth.has(oldKey)) newBirth.set(newKey, birth.get(oldKey));
  }

  alive.clear(); for (const k of newAlive) alive.add(k);
  states.clear(); for (const [k, v] of newStates) states.set(k, v);
  invincible.clear(); for (const k of newInvincible) invincible.add(k);
  birth.clear(); for (const [k, v] of newBirth) birth.set(k, v);

  flashTinyToast(`Scrambled ${keysArr.length} cell${keysArr.length === 1 ? '' : 's'}.`);
}

/* ================= Rule Spots (Ctrl+E) =================
   Lets the player place a rectangular region on the board with its own independent B/S rule
   string. Any cell inside a rule spot uses that spot's birth/survival rules instead of the
   global ones (see getRuleSpotAt(), consulted from stepLife()). A freshly-placed spot defaults
   to whatever the current global rule string is, so it behaves exactly like the rest of the
   board -- normal -- until the player edits its rule string.
   Fully in-game UI: Ctrl+E opens a side panel with live Width/Height/Rule inputs and a Close
   button (no browser prompt()/alert() involved). While the panel is open, a dashed ghost
   preview of the region follows the mouse (rendered in draw()); pressing X places a spot
   centered at the current mouse position, sized/ruled by whatever the panel's inputs currently
   say. The panel stays open so the player can place several spots with different settings
   without reopening it each time; Close (or Escape) exits placement mode. */

function openRuleSpotPanel() {
  if (document.getElementById('rule-spot-panel')) {
    closeRuleSpotPanel();
    return;
  }

  ruleSpotPlacementMode = true;
  // seed the draft rule string with whatever the global rule currently is, so a freshly
  // opened panel places spots that act normal until the player changes the rule field.
  ruleSpotDraftRuleStr = `B${[...birthRules].sort((a,b)=>a-b).join('')}/S${[...survivalRules].sort((a,b)=>a-b).join('')}`;

  const panel = document.createElement('div');
  panel.id = 'rule-spot-panel';
  Object.assign(panel.style, {
    position: 'fixed', top: '50%', right: '16px', transform: 'translateY(-50%)',
    background: '#111', color: '#fff', padding: '14px', borderRadius: '8px', zIndex: 13000,
    width: 'min(88vw,260px)', boxSizing: 'border-box', fontFamily: 'Times New Roman, Times, serif'
  });

  const title = document.createElement('div');
  title.textContent = 'Rule Spot';
  Object.assign(title.style, { fontWeight: '700', fontSize: '16px', marginBottom: '4px' });
  panel.appendChild(title);

  const help = document.createElement('div');
  help.textContent = 'Move the mouse over the board to preview, then press X to place. Spots can\'t overlap. Hover an existing spot and press Z to delete it. Adjust the fields below at any time.';
  Object.assign(help.style, { fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginBottom: '10px' });
  panel.appendChild(help);

  function makeLabel(text) {
    const l = document.createElement('div');
    l.textContent = text;
    Object.assign(l.style, { fontSize: '12px', fontWeight: '700', marginTop: '8px', marginBottom: '4px' });
    return l;
  }

  panel.appendChild(makeLabel('Width'));
  const widthInput = document.createElement('input');
  widthInput.type = 'number';
  widthInput.min = '1';
  widthInput.max = '2000';
  widthInput.value = String(ruleSpotDraftWidth);
  Object.assign(widthInput.style, { width: '100%', boxSizing: 'border-box', padding: '6px', fontSize: '13px' });
  widthInput.addEventListener('input', () => {
    const v = Math.floor(Number(widthInput.value));
    if (Number.isFinite(v) && v > 0) ruleSpotDraftWidth = Math.max(1, Math.min(2000, v));
  });
  panel.appendChild(widthInput);

  panel.appendChild(makeLabel('Height'));
  const heightInput = document.createElement('input');
  heightInput.type = 'number';
  heightInput.min = '1';
  heightInput.max = '2000';
  heightInput.value = String(ruleSpotDraftHeight);
  Object.assign(heightInput.style, { width: '100%', boxSizing: 'border-box', padding: '6px', fontSize: '13px' });
  heightInput.addEventListener('input', () => {
    const v = Math.floor(Number(heightInput.value));
    if (Number.isFinite(v) && v > 0) ruleSpotDraftHeight = Math.max(1, Math.min(2000, v));
  });
  panel.appendChild(heightInput);

  panel.appendChild(makeLabel('Rule string (Bn/Snn, optional /G#)'));
  const ruleInput = document.createElement('input');
  ruleInput.type = 'text';
  ruleInput.value = ruleSpotDraftRuleStr;
  Object.assign(ruleInput.style, { width: '100%', boxSizing: 'border-box', padding: '6px', fontSize: '13px' });
  panel.appendChild(ruleInput);

  const ruleError = document.createElement('div');
  Object.assign(ruleError.style, { fontSize: '11px', color: 'rgba(255,120,120,0.9)', minHeight: '14px', marginTop: '4px' });
  panel.appendChild(ruleError);

  // Live-validate on every keystroke: accept the value into the draft as soon as it's valid,
  // and show an inline error (rather than a blocking alert()) when it isn't, so the mouse
  // preview label always reflects the last-known-good rule string. The optional /G section sets
  // this spot's OWN generational state count (genCount), independent of the global
  // cellStatesCount: cells that fail survival inside this spot fade using its /G value, not the
  // board's. Omitting /G defaults the spot to 2 (binary: cells just die, no fading).
  ruleInput.addEventListener('input', () => {
    const trimmed = ruleInput.value.trim();
    if (!/^[Bb][0-8]*\/[Ss][0-8]*(?:\/(?:[Gg])?[0-9]+)?$/.test(trimmed)) {
      ruleError.textContent = 'Format: B{digits}/S{digits}, optional /G{count}, e.g. B3/S23 or B3/S23/G4';
      return;
    }
    const parsed = parseRuleString(trimmed);
    if (!parsed || !(parsed.b instanceof Set) || !(parsed.s instanceof Set)) {
      ruleError.textContent = 'Format: B{digits}/S{digits}, optional /G{count}, e.g. B3/S23 or B3/S23/G4';
      return;
    }
    ruleError.textContent = '';
    // Preserve the /G section in the stored/displayed string exactly as typed, so what the
    // player sees reflected back matches what they entered (and what genCount will be applied).
    const hasG = /\/(?:[Gg])?[0-9]+$/.test(trimmed);
    const gPart = hasG ? trimmed.slice(trimmed.lastIndexOf('/')) : '';
    ruleSpotDraftRuleStr = `B${[...parsed.b].sort((a,b)=>a-b).join('')}/S${[...parsed.s].sort((a,b)=>a-b).join('')}${gPart}`;
  });

  const placedCountLabel = document.createElement('div');
  Object.assign(placedCountLabel.style, { fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginTop: '10px' });
  placedCountLabel.textContent = `Placed so far: ${ruleSpots.length}`;
  panel.appendChild(placedCountLabel);
  panel._updatePlacedCount = () => { placedCountLabel.textContent = `Placed so far: ${ruleSpots.length}`; };

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  Object.assign(closeBtn.style, { width: '100%', padding: '8px 12px', cursor: 'pointer', marginTop: '12px' });
  closeBtn.addEventListener('click', closeRuleSpotPanel);
  panel.appendChild(closeBtn);

  document.body.appendChild(panel);

  function escHandler(ev) {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      closeRuleSpotPanel();
    }
  }
  panel._escHandler = escHandler;
  window.addEventListener('keydown', escHandler, true);

  flashTinyToast('Rule Spot: move mouse over the board, press X to place', 2200);
}

function closeRuleSpotPanel() {
  ruleSpotPlacementMode = false;
  const panel = document.getElementById('rule-spot-panel');
  if (panel) {
    if (panel._escHandler) window.removeEventListener('keydown', panel._escHandler, true);
    panel.remove();
  }
}

/* Places a rule spot centered at the current mouse world position, using the panel's current
   draft width/height/rule values. Called when X is pressed while ruleSpotPlacementMode is on. */
function placeRuleSpotAtMouse() {
  if (!mousePos) {
    flashTinyToast('Move the mouse over the board first.');
    return;
  }
  const parsed = parseRuleString(ruleSpotDraftRuleStr);
  if (!parsed || !(parsed.b instanceof Set) || !(parsed.s instanceof Set)) {
    flashTinyToast('Fix the rule string before placing.');
    return;
  }

  const center = screenToWorld(mousePos.x, mousePos.y);
  const width = ruleSpotDraftWidth;
  const height = ruleSpotDraftHeight;
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const minx = center.wx - halfW;
  const maxx = minx + width - 1;
  const miny = center.wy - halfH;
  const maxy = miny + height - 1;

  // Overlap prevention: reject placement if this rectangle would intersect any existing rule
  // spot. Standard axis-aligned-rectangle overlap test (two rects DON'T overlap if one is
  // entirely to one side of the other on either axis; they overlap otherwise).
  for (const existing of ruleSpots) {
    const overlaps = !(maxx < existing.minx || minx > existing.maxx || maxy < existing.miny || miny > existing.maxy);
    if (overlaps) {
      flashTinyToast('Rule Spots can\'t overlap -- move the mouse and try again.');
      return;
    }
  }

  ruleSpots.push({
    id: __ruleSpotNextId++,
    minx, miny, maxx, maxy,
    birthRules: parsed.b,
    survivalRules: parsed.s,
    // genCount is this spot's own generational state count (the /G value), independently of
    // the global cellStatesCount. Defaults to 2 (no fading, i.e. binary death) if the player
    // didn't include a /G section -- consistent with how parseRuleString itself defaults.
    genCount: parsed.c || 2,
    ruleStr: ruleSpotDraftRuleStr
  });

  const panel = document.getElementById('rule-spot-panel');
  if (panel && panel._updatePlacedCount) panel._updatePlacedCount();

  flashTinyToast(`Rule Spot placed (${width}×${height}, ${ruleSpotDraftRuleStr})`);
}
/* ============================================================================
   VIRTUAL KEYBOARD (mobile support)
   ----------------------------------------------------------------------------
   Shown only if the player answered "Mobile" in the intro. Renders a floating,
   draggable panel containing a compact QWERTY layout (no function-key row, no
   numpad) plus Ctrl/Shift/Alt modifier keys and a "Sticky Mode" toggle.

   Design:
   - Every key button dispatches REAL synthetic KeyboardEvent objects on
     `window` (keydown on touch-start, keyup on touch-end/cancel). Because the
     game's entire input system already listens for native keydown/keyup and
     reads e.key/e.shiftKey/e.ctrlKey/e.altKey, dispatching real events means
     none of that existing logic has to change -- the game can't tell the
     difference between a real key and a virtual one.
   - True multi-touch: each active touch point is tracked independently by
     its Touch.identifier, so holding two on-screen keys with two fingers
     holds both keys down simultaneously (this is how modifier+key combos
     like Ctrl+X work from the virtual keyboard).
   - Sticky Mode (toggled by its own button on the panel) makes Ctrl/Shift/Alt
     latch independently when tapped -- they light up and stay "held" (their
     state is merged into every subsequent synthetic key event) until tapped
     again to release, or until Sticky Mode itself is turned off. This is
     separate from the existing PC-only "P-mode" cycle, which is untouched.
   ============================================================================ */

let _vkPanel = null;
let _vkStickyMode = false; // sticky-mode ON/OFF (mobile-only concept)
const _vkSticky = { ctrl: false, shift: false, alt: false }; // latched modifier states while sticky mode is on
// Real (non-sticky) physical hold state of the Ctrl/Alt/Shift virtual keys: true for exactly as
// long as that modifier button itself is actively touched/held, mirroring how a physical
// keyboard's modifier keys work. This is what makes holding Alt with one finger and tapping X
// with another correctly dispatch X's keydown with altKey:true -- without this, each virtual
// key's own KeyboardEvent only reflects sticky-mode latches, never another key's simultaneous
// physical hold, so Alt+X / Ctrl+X / Shift+X (and similar combos) silently never fire correctly.
const _vkHeld = { ctrl: false, shift: false, alt: false };
const _vkActiveTouches = new Map(); // touchIdentifier -> { keyEl, key, code }

function _vkDispatchKey(type, key, code, extraModifiers) {
  const mods = extraModifiers || {};
  const ev = new KeyboardEvent(type, {
    key,
    code,
    bubbles: true,
    cancelable: true,
    shiftKey: !!mods.shiftKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey
  });
  window.dispatchEvent(ev);
}

// Combines latched sticky-mode modifiers with actually-held (physically pressed right now)
// modifiers into one flags object -- every non-modifier key's dispatched event uses this, so it
// picks up whichever modifiers are currently "on" by either mechanism.
function _vkCurrentMods() {
  return {
    ctrlKey: _vkSticky.ctrl || _vkHeld.ctrl,
    shiftKey: _vkSticky.shift || _vkHeld.shift,
    altKey: _vkSticky.alt || _vkHeld.alt
  };
}

// Compact QWERTY layout, no F-row, no numpad. Each row is an array of
// { label, key, code, width? }. 'key'/'code' follow standard KeyboardEvent values.
const VK_LAYOUT = [
  [
    { label: '1', key: '1', code: 'Digit1' }, { label: '2', key: '2', code: 'Digit2' },
    { label: '3', key: '3', code: 'Digit3' }, { label: '4', key: '4', code: 'Digit4' },
    { label: '5', key: '5', code: 'Digit5' }, { label: '6', key: '6', code: 'Digit6' },
    { label: '7', key: '7', code: 'Digit7' }, { label: '8', key: '8', code: 'Digit8' },
    { label: '9', key: '9', code: 'Digit9' }, { label: '0', key: '0', code: 'Digit0' },
    { label: '⌫', key: 'Backspace', code: 'Backspace', width: 1.6 }
  ],
  [
    { label: 'Q', key: 'q', code: 'KeyQ' }, { label: 'W', key: 'w', code: 'KeyW' },
    { label: 'E', key: 'e', code: 'KeyE' }, { label: 'R', key: 'r', code: 'KeyR' },
    { label: 'T', key: 't', code: 'KeyT' }, { label: 'Y', key: 'y', code: 'KeyY' },
    { label: 'U', key: 'u', code: 'KeyU' }, { label: 'I', key: 'i', code: 'KeyI' },
    { label: 'O', key: 'o', code: 'KeyO' }, { label: 'P', key: 'p', code: 'KeyP' }
  ],
  [
    { label: 'A', key: 'a', code: 'KeyA' }, { label: 'S', key: 's', code: 'KeyS' },
    { label: 'D', key: 'd', code: 'KeyD' }, { label: 'F', key: 'f', code: 'KeyF' },
    { label: 'G', key: 'g', code: 'KeyG' }, { label: 'H', key: 'h', code: 'KeyH' },
    { label: 'J', key: 'j', code: 'KeyJ' }, { label: 'K', key: 'k', code: 'KeyK' },
    { label: 'L', key: 'l', code: 'KeyL' }
  ],
  [
    { label: 'Z', key: 'z', code: 'KeyZ' }, { label: 'X', key: 'x', code: 'KeyX' },
    { label: 'C', key: 'c', code: 'KeyC' }, { label: 'V', key: 'v', code: 'KeyV' },
    { label: 'B', key: 'b', code: 'KeyB' }, { label: 'N', key: 'n', code: 'KeyN' },
    { label: 'M', key: 'm', code: 'KeyM' }, { label: ',', key: ',', code: 'Comma' },
    { label: '.', key: '.', code: 'Period' }, { label: '/', key: '/', code: 'Slash' }
  ],
  [
    { label: 'Ctrl', key: 'Control', code: 'ControlLeft', isModifier: 'ctrl', width: 1.3 },
    { label: 'Alt', key: 'Alt', code: 'AltLeft', isModifier: 'alt', width: 1.3 },
    { label: 'Space', key: ' ', code: 'Space', width: 3.4 },
    { label: 'Shift', key: 'Shift', code: 'ShiftLeft', isModifier: 'shift', width: 1.3 },
    { label: 'Esc', key: 'Escape', code: 'Escape', width: 1.3 }
  ],
  [
    { label: '↑', key: 'ArrowUp', code: 'ArrowUp' },
    { label: '↓', key: 'ArrowDown', code: 'ArrowDown' },
    { label: '←', key: 'ArrowLeft', code: 'ArrowLeft' },
    { label: '→', key: 'ArrowRight', code: 'ArrowRight' }
  ]
];

function _vkMakeKeyButton(def) {
  const btn = document.createElement('div');
  btn.textContent = def.label;
  btn.dataset.vkKey = def.key;
  Object.assign(btn.style, {
    flex: def.width ? String(def.width) : '1',
    minWidth: '0',
    height: '38px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.10)',
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '13px',
    fontFamily: 'Times New Roman, Times, serif',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'none',
    cursor: 'pointer'
  });

  function highlight(on) {
    if (def.isModifier && _vkStickyMode) {
      // sticky modifier keys show latched state via highlight, managed separately below
      return;
    }
    btn.style.background = on ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.10)';
  }

  // OS-style key-repeat simulation: real keyboards fire repeated keydown events while a key
  // is physically held (after an initial delay, then at a steady interval). Several game
  // actions -- normal-mode arrow panning, A/S zoom -- rely on that repeated keydown firing
  // rather than a hold-state flag, so without this a held virtual button would only fire once.
  // Modifier keys are excluded (real keyboards don't auto-repeat modifiers either).
  const VK_REPEAT_DELAY_MS = 400;
  const VK_REPEAT_INTERVAL_MS = 60;
  let repeatTimeout = null;
  let repeatInterval = null;

  function clearRepeat() {
    if (repeatTimeout) { clearTimeout(repeatTimeout); repeatTimeout = null; }
    if (repeatInterval) { clearInterval(repeatInterval); repeatInterval = null; }
  }

  function fireKeydown() {
    const mods = _vkCurrentMods();
    // A modifier key's own dispatched event should also carry its own flag true (matches how a
    // real keyboard reports e.g. ctrlKey:true on the Control keydown event itself), even though
    // pressStart below already set _vkHeld[def.isModifier] = true a moment earlier -- this line
    // just guards against any timing edge case where fireKeydown could run before that update.
    if (def.isModifier === 'ctrl') mods.ctrlKey = true;
    if (def.isModifier === 'shift') mods.shiftKey = true;
    if (def.isModifier === 'alt') mods.altKey = true;
    _vkDispatchKey('keydown', def.key, def.code, mods);
  }

  function pressStart() {
    if (def.isModifier) {
      if (_vkStickyMode) {
        // Sticky mode: tapping a modifier LATCHES/UNLATCHES it; it does not
        // itself send a keydown/keyup, it just changes what gets merged into
        // every other key's events until toggled off again.
        _vkSticky[def.isModifier] = !_vkSticky[def.isModifier];
        btn.style.background = _vkSticky[def.isModifier] ? 'rgba(120,200,255,0.55)' : 'rgba(255,255,255,0.10)';
        return;
      }
      // Non-sticky mode: modifier behaves like a normal held key (real multi-touch hold).
      // Mark it held BEFORE dispatching anything, so if another finger is already holding a
      // different key with active key-repeat, that key's very next repeated keydown already
      // picks up this modifier -- and so this modifier's own keydown below correctly reflects
      // itself as held too.
      _vkHeld[def.isModifier] = true;
    }
    highlight(true);
    fireKeydown();

    // Start repeat-fire while held, matching native OS key-repeat, for non-modifier keys.
    if (!def.isModifier) {
      clearRepeat();
      repeatTimeout = setTimeout(() => {
        repeatInterval = setInterval(fireKeydown, VK_REPEAT_INTERVAL_MS);
      }, VK_REPEAT_DELAY_MS);
    }
  }

  function pressEnd() {
    if (def.isModifier && _vkStickyMode) return; // latched modifiers release only via re-tap
    clearRepeat();
    highlight(false);
    const mods = _vkCurrentMods();
    _vkDispatchKey('keyup', def.key, def.code, mods);
    if (def.isModifier && !_vkStickyMode) {
      // Release the physical hold AFTER dispatching this modifier's own keyup (which should
      // still report itself as true, matching a real keyboard's modifier-release event), so
      // any other key still held by a different finger stops seeing this modifier on its next
      // repeated keydown.
      _vkHeld[def.isModifier] = false;
    }
  }

  // Mouse support (desktop testing) in addition to touch.
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); pressStart(); });
  window.addEventListener('mouseup', () => { /* handled per-button via mouseleave/mouseup below */ });
  btn.addEventListener('mouseup', (e) => { e.preventDefault(); pressEnd(); });
  btn.addEventListener('mouseleave', () => { pressEnd(); });

  // True multi-touch: each touch on this button is tracked by identifier so
  // holding several different key buttons with several fingers works.
  btn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      _vkActiveTouches.set(t.identifier, { btn, def });
    }
    pressStart();
  }, { passive: false });

  function releaseTouch(e) {
    e.preventDefault();
    let releasedThis = false;
    for (const t of e.changedTouches) {
      if (_vkActiveTouches.has(t.identifier)) {
        _vkActiveTouches.delete(t.identifier);
        releasedThis = true;
      }
    }
    if (releasedThis) pressEnd();
  }
  btn.addEventListener('touchend', releaseTouch, { passive: false });
  btn.addEventListener('touchcancel', releaseTouch, { passive: false });

  return btn;
}

function _vkBuildPanel() {
  const panel = document.createElement('div');
  panel.id = 'virtual-keyboard-panel';
  Object.assign(panel.style, {
    position: 'fixed',
    left: '50%',
    bottom: '16px',
    transform: 'translateX(-50%)',
    width: 'min(94vw, 480px)',
    background: 'rgba(15,15,20,0.92)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '10px',
    padding: '8px',
    boxSizing: 'border-box',
    zIndex: 15000,
    touchAction: 'none',
    boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
    // Cascades to every child that doesn't set its own fontFamily, so all the panel's
    // buttons stay consistent with the rest of the game's UI font without needing to
    // repeat this on each one individually.
    fontFamily: 'Times New Roman, Times, serif'
  });

  // Top row: title + controls (sticky/close) on one line.
  const topRow = document.createElement('div');
  Object.assign(topRow.style, { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '6px' });

  // Drag handle / title bar
  const handle = document.createElement('div');
  Object.assign(handle.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '2px 4px 4px 4px',
    cursor: 'grab',
    touchAction: 'none'
  });

  const title = document.createElement('div');
  title.textContent = 'Virtual Keyboard';
  Object.assign(title.style, { color: 'rgba(255,255,255,0.7)', fontSize: '12px', fontFamily: 'Times New Roman, Times, serif' });
  handle.appendChild(title);

  const controlsWrap = document.createElement('div');
  Object.assign(controlsWrap.style, { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });

  // Sticky Mode toggle button
  const stickyBtn = document.createElement('div');
  stickyBtn.textContent = 'Sticky: Off';
  Object.assign(stickyBtn.style, {
    fontSize: '11px', padding: '4px 8px', borderRadius: '6px',
    background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.3)',
    color: '#fff', cursor: 'pointer', userSelect: 'none', touchAction: 'none'
  });
  stickyBtn.addEventListener('click', () => {
    _vkStickyMode = !_vkStickyMode;
    stickyBtn.textContent = _vkStickyMode ? 'Sticky: On' : 'Sticky: Off';
    stickyBtn.style.background = _vkStickyMode ? 'rgba(120,200,255,0.4)' : 'rgba(255,255,255,0.12)';
    if (!_vkStickyMode) {
      // turning sticky mode off releases any latched modifiers immediately
      _vkSticky.ctrl = _vkSticky.shift = _vkSticky.alt = false;
      panel.querySelectorAll('[data-vk-key="Control"],[data-vk-key="Shift"],[data-vk-key="Alt"]').forEach(el => {
        el.style.background = 'rgba(255,255,255,0.10)';
      });
    }
  });
  controlsWrap.appendChild(stickyBtn);

  // Hide/close button
  const closeBtn = document.createElement('div');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    fontSize: '13px', padding: '4px 9px', borderRadius: '6px',
    background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.3)',
    color: '#fff', cursor: 'pointer', userSelect: 'none', touchAction: 'none'
  });
  closeBtn.addEventListener('click', () => {
    hideVirtualKeyboard();
  });
  controlsWrap.appendChild(closeBtn);

  handle.appendChild(controlsWrap);
  topRow.appendChild(handle);

  panel.appendChild(topRow);

  // Key rows
  for (const row of VK_LAYOUT) {
    const rowEl = document.createElement('div');
    Object.assign(rowEl.style, { display: 'flex', gap: '4px', marginBottom: '4px' });
    for (const def of row) {
      rowEl.appendChild(_vkMakeKeyButton(def));
    }
    panel.appendChild(rowEl);
  }

  // Dragging logic (touch + mouse) using the handle
  let dragging = false;
  let dragOffsetX = 0, dragOffsetY = 0;

  function startDrag(clientX, clientY) {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffsetX = clientX - rect.left;
    dragOffsetY = clientY - rect.top;
    // switch from centered transform to absolute left/top once drag begins
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.bottom = '';
    panel.style.transform = 'none';
  }
  function moveDrag(clientX, clientY) {
    if (!dragging) return;
    let nx = clientX - dragOffsetX;
    let ny = clientY - dragOffsetY;
    const maxX = window.innerWidth - panel.offsetWidth;
    const maxY = window.innerHeight - panel.offsetHeight;
    nx = Math.max(0, Math.min(maxX, nx));
    ny = Math.max(0, Math.min(maxY, ny));
    panel.style.left = nx + 'px';
    panel.style.top = ny + 'px';
  }
  function endDrag() { dragging = false; }

  handle.addEventListener('mousedown', (e) => { startDrag(e.clientX, e.clientY); });
  window.addEventListener('mousemove', (e) => { moveDrag(e.clientX, e.clientY); });
  window.addEventListener('mouseup', endDrag);

  handle.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t) startDrag(t.clientX, t.clientY);
  }, { passive: true });
  handle.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (t) moveDrag(t.clientX, t.clientY);
  }, { passive: true });
  handle.addEventListener('touchend', endDrag);
  handle.addEventListener('touchcancel', endDrag);

  return panel;
}

function showVirtualKeyboard() {
  if (!_vkPanel) {
    _vkPanel = _vkBuildPanel();
    document.body.appendChild(_vkPanel);
  }
  try { _vmkUpdateReopenLauncher(); } catch (e) {}
}

function hideVirtualKeyboard() {
  if (_vkPanel && _vkPanel.parentElement) _vkPanel.remove();
  _vkPanel = null;
  _vkActiveTouches.clear();
  _vkSticky.ctrl = _vkSticky.shift = _vkSticky.alt = false;
  _vkHeld.ctrl = _vkHeld.shift = _vkHeld.alt = false;
  try { _vmkUpdateReopenLauncher(); } catch (e) {}
}

/* ============================================================================
   TUTORIAL MODE (Alt+D)
   ----------------------------------------------------------------------------
   An easier, guided alternative to reading the full U-key manual: dims and blurs the board,
   fades in a read-only (functionless) copy of the on-screen virtual keyboard layout, then
   walks through the Arrow keys, X, Z, A, S, Q, W, E, R, C, V, D, J, Shift+J, Ctrl+J in that
   exact order -- highlighting the key (or, for the arrow keys, all 4 of them at once as a
   single combined step) being explained, drawing a thin connecting line from each highlighted
   key out to an explanation panel, and advancing to the next control on click. After Ctrl+J,
   one final step shows no highlight at all and just points the player at the U-key manual for
   everything else. Clicking through that last step ends the tutorial: only the keyboard fades
   out and the dim/blur clears, returning the player to a normal board. This reuses VK_LAYOUT
   purely for key geometry (so the tutorial's keyboard visually matches the real virtual
   keyboard) but renders its own separate, inert copy -- no touch/mouse handler here ever
   dispatches a KeyboardEvent, matching the "functionless" requirement.
   ============================================================================ */
let _tutorialOverlay = null;   // the dim/blur backdrop + explanation panel container
let _tutorialKeyboardEl = null; // the read-only keyboard element
let _tutorialStepIndex = -1;
let _tutorialActive = false;

// Ordered exactly as requested: Arrow keys (all 4 highlighted together, one combined step),
// X, Z, A, S, Q, W, E, R, C, V, D, J, Shift+J, Ctrl+J, then a final no-highlight step. `code`
// (or `codes` for a multi-key step like the arrows) matches a VK_LAYOUT key's own `code` field
// so the tutorial can find and highlight the same visual key the read-only keyboard renders.
const TUTORIAL_STEPS = [
  { codes: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], modifier: null, text: 'Use the Arrow keys to pan the camera around the board.' },
  { code: 'KeyX', modifier: null, text: 'Hold X to draw -- this creates live cells wherever your cursor is.' },
  { code: 'KeyZ', modifier: null, text: 'Hold Z to erase -- this removes live or invincible cells at your cursor.' },
  { code: 'KeyA', modifier: null, text: 'Press A to zoom out, centered on the middle of the screen.' },
  { code: 'KeyS', modifier: null, text: 'Press S to zoom in, centered on the middle of the screen.' },
  { code: 'KeyQ', modifier: null, text: 'Press Q to pause or resume the simulation.' },
  { code: 'KeyW', modifier: null, text: 'Press W to reset the tick rate (simulation speed) back to default.' },
  { code: 'KeyE', modifier: null, text: 'Press E to slow the tick rate down -- the simulation advances more slowly.' },
  { code: 'KeyR', modifier: null, text: 'Press R to speed the tick rate up -- the simulation advances more quickly.' },
  { code: 'KeyC', modifier: null, text: 'Press C to decrease the camera pan speed (how fast the arrow keys move the view).' },
  { code: 'KeyV', modifier: null, text: 'Press V to increase the camera pan speed.' },
  { code: 'KeyD', modifier: null, text: 'Press D to reset the camera pan speed back to default.' },
  { code: 'KeyJ', modifier: null, text: 'Press J to spawn a 15x15 patch of random noise centered on the screen.' },
  { code: 'KeyJ', modifier: 'shift', text: 'Hold Shift and press J to spawn a bigger, 31x31 patch of "super" noise.' },
  { code: 'KeyJ', modifier: 'ctrl', text: 'Hold Ctrl and press J to spawn an even bigger, 45x45 patch of "ultra" noise.' },
  { code: null, modifier: null, text: 'That covers the essentials. Press the U key to see about the extra controls.' },
];


// Builds one read-only key element for the tutorial keyboard -- visually identical in size/
// label/font to the real virtual keyboard's buttons (via _vkMakeKeyButton's own styling
// conventions), but with no event listeners attached at all, so it can never be pressed.
function _tutorialMakeKeyEl(def) {
  const el = document.createElement('div');
  el.textContent = def.label;
  el.dataset.tutorialCode = def.code;
  Object.assign(el.style, {
    flex: def.width ? String(def.width) : '1',
    minWidth: '0',
    height: '38px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.10)',
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '13px',
    fontFamily: 'Times New Roman, Times, serif',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    transition: 'background 200ms ease, box-shadow 200ms ease, border-color 200ms ease',
    position: 'relative'
  });
  return el;
}

function _tutorialBuildKeyboard() {
  const panel = document.createElement('div');
  panel.id = 'tutorial-keyboard-panel';
  Object.assign(panel.style, {
    position: 'fixed',
    left: '50%',
    bottom: '16px',
    transform: 'translateX(-50%)',
    width: 'min(94vw, 480px)',
    background: 'rgba(15,15,20,0.92)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '10px',
    padding: '8px',
    boxSizing: 'border-box',
    zIndex: 21300,
    boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
    fontFamily: 'Times New Roman, Times, serif',
    opacity: '0',
    transition: 'opacity 500ms ease',
    pointerEvents: 'none' // purely visual -- never intercepts clicks meant to advance the tutorial
  });

  const title = document.createElement('div');
  title.textContent = 'Tutorial Mode';
  Object.assign(title.style, { color: 'rgba(255,255,255,0.7)', fontSize: '12px', marginBottom: '6px', padding: '2px 4px' });
  panel.appendChild(title);

  for (const row of VK_LAYOUT) {
    const rowEl = document.createElement('div');
    Object.assign(rowEl.style, { display: 'flex', gap: '4px', marginBottom: '4px' });
    for (const def of row) {
      rowEl.appendChild(_tutorialMakeKeyEl(def));
    }
    panel.appendChild(rowEl);
  }

  return panel;
}

// Finds the rendered element for a given VK_LAYOUT `code`, searching the tutorial keyboard.
function _tutorialFindKeyEl(code) {
  if (!_tutorialKeyboardEl || !code) return null;
  return _tutorialKeyboardEl.querySelector(`[data-tutorial-code="${code}"]`);
}

function _tutorialHighlightKey(el, on) {
  if (!el) return;
  el.style.background = on ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.10)';
  el.style.borderColor = on ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.25)';
  el.style.boxShadow = on ? '0 0 12px 2px rgba(255,255,255,0.5)' : 'none';
}

// The modifier keys' own VK_LAYOUT codes, used to look up and highlight e.g. Ctrl/Shift
// alongside the main key when a step calls for a modifier combo.
const TUTORIAL_MODIFIER_CODE = { ctrl: 'ControlLeft', shift: 'ShiftLeft', alt: 'AltLeft' };

// Renders the current tutorial step: highlights the right key(s), draws a thin SVG line from
// the (last) highlighted key out to the explanation panel, and sets the panel's text. Clears
// any previous step's highlight first. When a step has no `code` at all (the final step), no
// key is highlighted and no connecting line is drawn -- the explanation panel simply floats on
// its own, per the requested behavior.
let _tutorialLineSvg = null;
let _tutorialExplainEl = null;
let _tutorialPrevHighlighted = [];

function _tutorialRenderStep() {
  const step = TUTORIAL_STEPS[_tutorialStepIndex];
  if (!step) return;

  // clear previous highlight(s)
  for (const el of _tutorialPrevHighlighted) _tutorialHighlightKey(el, false);
  _tutorialPrevHighlighted = [];

  // A step highlights either a single main key (`code`) or several at once (`codes`, used only
  // by the combined Arrow-keys step) -- never both on the same step.
  const keyCodes = step.codes ? step.codes : (step.code ? [step.code] : []);
  const keyEls = keyCodes.map(c => _tutorialFindKeyEl(c)).filter(Boolean);
  const modifierEl = step.modifier ? _tutorialFindKeyEl(TUTORIAL_MODIFIER_CODE[step.modifier]) : null;

  for (const el of keyEls) { _tutorialHighlightKey(el, true); _tutorialPrevHighlighted.push(el); }
  if (modifierEl) { _tutorialHighlightKey(modifierEl, true); _tutorialPrevHighlighted.push(modifierEl); }

  if (_tutorialExplainEl) _tutorialExplainEl.textContent = step.text;

  // Defer the line-drawing to the next frame so the just-applied highlight styles (and any
  // browser layout they trigger) have settled before we read getBoundingClientRect() -- reading
  // synchronously right after the style change can occasionally report stale/pre-highlight
  // positions in some browsers.
  requestAnimationFrame(() => _tutorialDrawConnectorLine(keyEls, modifierEl));
}

function _tutorialDrawConnectorLine(keyEls, modifierEl) {
  if (!_tutorialLineSvg || !_tutorialExplainEl) return;
  _tutorialLineSvg.innerHTML = '';

  // Draw one thin line from EVERY highlighted key (all of `keyEls` -- one for a normal step,
  // all 4 arrow keys for the combined arrows step -- plus the modifier if the step has one)
  // out to the explanation panel, so every highlighted key visibly connects to the text, not
  // just one of them. Draws nothing at all when there's nothing highlighted (the final step).
  //
  // Each line's key-side endpoint is that key's OWN top edge, so it visibly touches the key
  // it's pointing at regardless of which row that key is in -- clamping this to the keyboard
  // panel's own top edge (rather than each individual key's) looked "cleaner" in isolation but
  // left the line floating disconnected above the panel for every key that isn't in the very
  // top row, which defeats the point of the connector line entirely.
  const explainRect = _tutorialExplainEl.getBoundingClientRect();
  const x2 = explainRect.left + explainRect.width / 2;
  const y2 = explainRect.bottom;

  const anchors = modifierEl ? [...keyEls, modifierEl] : keyEls;
  for (const anchorEl of anchors) {
    if (!anchorEl) continue;
    const anchorRect = anchorEl.getBoundingClientRect();
    const x1 = anchorRect.left + anchorRect.width / 2;
    const y1 = anchorRect.top;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', 'rgba(255,255,255,0.85)');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-dasharray', '4,4');
    _tutorialLineSvg.appendChild(line);
  }
}


function _tutorialAdvance() {
  if (!_tutorialActive) return;
  _tutorialStepIndex++;
  if (_tutorialStepIndex >= TUTORIAL_STEPS.length) {
    endTutorialMode();
    return;
  }
  _tutorialRenderStep();
}

function startTutorialMode() {
  if (_tutorialActive) return;
  _tutorialActive = true;
  _tutorialStepIndex = -1;

  canvas.style.transition = 'filter 400ms ease';
  canvas.style.filter = 'blur(6px)';

  const overlay = document.createElement('div');
  _tutorialOverlay = overlay;
  Object.assign(overlay.style, {
    position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh',
    background: 'rgba(0,0,0,0.5)', zIndex: 21000, cursor: 'pointer',
    opacity: '0', transition: 'opacity 400ms ease'
  });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => { overlay.style.opacity = '1'; });

  // SVG layer for the thin connector line, sized to the full viewport so absolute coordinates
  // from getBoundingClientRect() can be used directly without any extra offset math.
  const lineSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  _tutorialLineSvg = lineSvg;
  Object.assign(lineSvg.style, {
    position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh',
    zIndex: 21400, pointerEvents: 'none'
  });
  overlay.appendChild(lineSvg);

  // Explanation panel: sits above the keyboard, its text swaps per step.
  const explainEl = document.createElement('div');
  _tutorialExplainEl = explainEl;
  Object.assign(explainEl.style, {
    position: 'fixed', left: '50%', bottom: 'min(46vh, 340px)', transform: 'translateX(-50%)',
    width: 'min(88vw, 460px)', boxSizing: 'border-box',
    background: 'rgba(20,20,26,0.95)', border: '1px solid rgba(255,255,255,0.45)',
    borderRadius: '10px', padding: '14px 18px', color: '#fff', fontSize: '15px',
    fontFamily: 'Times New Roman, Times, serif', textAlign: 'center', lineHeight: '1.4',
    zIndex: 21500, boxShadow: '0 6px 20px rgba(0,0,0,0.5)'
  });
  overlay.appendChild(explainEl);

  const hintEl = document.createElement('div');
  hintEl.textContent = 'Click anywhere to continue';
  Object.assign(hintEl.style, {
    position: 'fixed', left: '50%', bottom: 'calc(min(46vh, 340px) + 66px)', transform: 'translateX(-50%)',
    fontSize: '12px', color: 'rgba(200,200,200,0.7)', zIndex: 21500, pointerEvents: 'none'
  });
  overlay.appendChild(hintEl);

  const keyboardEl = _tutorialBuildKeyboard();
  _tutorialKeyboardEl = keyboardEl;
  overlay.appendChild(keyboardEl);
  requestAnimationFrame(() => { keyboardEl.style.opacity = '1'; });

  overlay.addEventListener('click', () => _tutorialAdvance());

  _tutorialAdvance(); // shows step 0 (X)
}

function endTutorialMode() {
  if (!_tutorialActive) return;
  _tutorialActive = false;

  // Per the requested behavior: ending only fades the keyboard away and clears the dim/blur --
  // the keyboard fade and the backdrop/explanation-panel removal happen together here since
  // the whole overlay (backdrop, line, explanation panel, hint, keyboard) is one fade-out unit,
  // and the board simply returns to normal underneath it.
  if (_tutorialKeyboardEl) _tutorialKeyboardEl.style.opacity = '0';
  if (_tutorialOverlay) _tutorialOverlay.style.opacity = '0';
  canvas.style.filter = '';

  const overlayToRemove = _tutorialOverlay;
  const keyboardRefForCleanup = _tutorialKeyboardEl;
  _tutorialOverlay = null;
  _tutorialKeyboardEl = null;
  _tutorialLineSvg = null;
  _tutorialExplainEl = null;
  _tutorialPrevHighlighted = [];
  _tutorialStepIndex = -1;

  setTimeout(() => {
    if (overlayToRemove && overlayToRemove.parentElement) overlayToRemove.remove();
  }, 450);
}

function toggleTutorialMode() {
  if (_tutorialActive) endTutorialMode();
  else startTutorialMode();
}

/* ============================================================================
   REOPEN LAUNCHER (mobile support)
   ----------------------------------------------------------------------------
   A small persistent floating widget, shown only for mobile players, that lets
   them bring back the virtual keyboard after closing it via its own '✕' button.
   Stays hidden entirely while the keyboard panel is open.
   ============================================================================ */

let _vmkLauncher = null;

function _vmkBuildLauncher() {
  const wrap = document.createElement('div');
  wrap.id = 'virtual-io-reopen-launcher';
  Object.assign(wrap.style, {
    position: 'fixed',
    left: '10px',
    top: '10px', // top-left, not bottom-left, so it never overlaps/covers the toast stack
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    zIndex: 15500
  });

  function makeReopenBtn(label, onClick) {
    const btn = document.createElement('div');
    btn.textContent = label;
    Object.assign(btn.style, {
      fontSize: '12px',
      padding: '8px 12px',
      borderRadius: '8px',
      background: 'rgba(15,15,20,0.85)',
      border: '1px solid rgba(255,255,255,0.3)',
      color: '#fff',
      cursor: 'pointer',
      userSelect: 'none',
      touchAction: 'none',
      fontFamily: 'Times New Roman, Times, serif',
      boxShadow: '0 4px 14px rgba(0,0,0,0.4)'
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  const kbBtn = makeReopenBtn('⌨ Show Keyboard', () => { try { showVirtualKeyboard(); } catch (e) {} });
  kbBtn.dataset.role = 'reopen-keyboard';

  wrap.appendChild(kbBtn);
  return wrap;
}

// Called whenever the keyboard panel opens/closes; shows/hides the reopen button based on
// current state, and hides the whole launcher if nothing needs reopening.
function _vmkUpdateReopenLauncher() {
  if (playerPlatformChoice !== 'mobile') return; // this UI only exists for mobile players

  if (!_vmkLauncher) {
    _vmkLauncher = _vmkBuildLauncher();
    document.body.appendChild(_vmkLauncher);
  }

  const kbBtn = _vmkLauncher.querySelector('[data-role="reopen-keyboard"]');
  if (kbBtn) kbBtn.style.display = _vkPanel ? 'none' : 'block';
}
