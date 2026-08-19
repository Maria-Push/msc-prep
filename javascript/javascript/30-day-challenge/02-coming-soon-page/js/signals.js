/* ==========================================================================
   SIGNAL DOTS
   --------------------------------------------------------------------------
   Bright points running an invisible grid, turning at right angles, each
   dragging a tail that holds briefly and then fades out completely.

   WHY CANVAS AND NOT CSS:
     - paths are decided at runtime, so @keyframes cannot describe them
     - a fading tail needs per-frame memory
     - 60 glowing DOM nodes is 60 composited layers; this is one element

   ---------------------------------------------------------------------------
   WHY THE TRAILS USED TO TURN INTO A NET
   ---------------------------------------------------------------------------
   The previous version used the standard trick: never clear the canvas,
   and each frame erase a few percent of alpha everywhere with
   globalCompositeOperation = 'destination-out'.

   That fade is MULTIPLICATIVE - each frame the remaining alpha becomes
   alpha * (1 - 0.045). Mathematically it approaches zero and never arrives.
   Normally that is fine, because it gets close enough to invisible.

   It is not fine on a canvas, because canvas alpha is an 8-BIT INTEGER.
   Once a pixel's alpha reaches 1/255, the next frame computes
   1 * 0.955 = 0.955, which ROUNDS BACK TO 1. The pixel is now permanently
   stuck at 1/255 and can never be erased. Thousands of pixels reach that
   floor, and over a couple of minutes every path the dots have ever taken
   is still faintly on screen. That is your net.

   Raising the erase alpha only moves the floor - it does not remove it.

   THE FIX: stop using the canvas as memory. Clear it completely every
   frame, and have each signal remember its own recent positions in a plain
   array. Redrawing from that array means the fade is computed fresh each
   frame from actual data, so it reaches true zero and the dark background
   stays visible. It also gives exact control over the tail's shape, which
   an exponential decay never did.
   ========================================================================== */

(function () {
    'use strict';

    const canvas = document.querySelector('.signal-layer');
    if (!canvas) return;

    /* The CSS reduced-motion block in base.css does NOT reach JavaScript.
       A canvas loop has to check the preference itself. */
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const ctx  = canvas.getContext('2d');
    const root = document.documentElement;


    /* ----------------------------------------------------------------------
       CONFIG, read from CSS
       getComputedStyle resolves the whole var() chain, so the design system
       stays the single source of truth instead of being forked into JS.
       ---------------------------------------------------------------------- */
    function cssVar(name) {
        return getComputedStyle(root).getPropertyValue(name).trim();
    }
    function cssNum(name, fallback) {
        const n = parseFloat(cssVar(name));
        return Number.isFinite(n) ? n : fallback;
    }

    const GRID        = cssNum('--signal-grid', 26);
    const SPEED       = cssNum('--signal-speed', 42);
    const DENSITY     = cssNum('--signal-density', 24000);
    const MAX         = cssNum('--signal-max', 70);
    const SIZE        = cssNum('--signal-size', 1.6);

    const TRAIL_PX    = cssNum('--signal-trail-px', 150);
    const TRAIL_ALPHA = cssNum('--signal-trail-alpha', 0.30);
    const TRAIL_HOLD  = cssNum('--signal-trail-hold', 0.30);
    const SAMPLE      = cssNum('--signal-sample', 5);

    /* How many points make up TRAIL_PX of tail. +2 for the partial segment
       at each end. */
    const MAX_POINTS = Math.max(4, Math.ceil(TRAIL_PX / SAMPLE) + 2);

    const COLOURS = [
        cssVar('--signal-color-1') || '#ff2e7e',
        cssVar('--signal-color-2') || '#8b9dff',
        cssVar('--signal-color-3') || '#ffc328'
    ];

    /* Four directions only. THIS CONSTRAINT IS THE WHOLE EFFECT - allow a
       free angle and the dots read as dust rather than circuitry. */
    const DIRS = [
        { x:  1, y:  0 },
        { x: -1, y:  0 },
        { x:  0, y:  1 },
        { x:  0, y: -1 }
    ];

    /* Alpha is quantised into this many bands so consecutive segments at the
       same opacity can share one stroke() call. Without it a 30-point tail
       is 30 separate strokes per signal per frame. */
    const BANDS = 7;

    let width = 0;
    let height = 0;
    let signals = [];
    let raf = null;


    /* ----------------------------------------------------------------------
       SIZING
       A canvas has two sizes: its CSS box and its bitmap. Leave the bitmap
       at the default 300x150 and the browser stretches it to fit, which is
       why unsized canvases look soft. Bitmap = box * devicePixelRatio, then
       scale the context by the same factor, and you get crisp output while
       still thinking in CSS pixels.
       ---------------------------------------------------------------------- */
    function resize() {
        const dpr  = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();

        width  = rect.width;
        height = rect.height;
        if (!width || !height) return;

        canvas.width  = Math.round(width  * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.lineCap  = 'round';
        ctx.lineJoin = 'round';

        const target = Math.min(MAX, Math.round((width * height) / DENSITY));
        rebuild(target);
    }


    /* ----------------------------------------------------------------------
       A SIGNAL
       ---------------------------------------------------------------------- */
    function snap(v) {
        return Math.round(v / GRID) * GRID;
    }

    function makeSignal() {
        const x = snap(Math.random() * width);
        const y = snap(Math.random() * height);
        return {
            x: x,
            y: y,
            dir: Math.floor(Math.random() * DIRS.length),
            leg: GRID * (1 + Math.floor(Math.random() * 5)),
            travelled: 0,
            sinceSample: 0,
            /* Newest point last. This array IS the trail - the canvas no
               longer remembers anything between frames. */
            points: [{ x: x, y: y }],
            colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
            /* Per-signal speed variance stops the field pulsing in unison. */
            speed: SPEED * (0.6 + Math.random() * 0.9)
        };
    }

    function rebuild(count) {
        signals = [];
        for (let i = 0; i < count; i++) signals.push(makeSignal());
    }

    /* A turn is always +-90 degrees, never a reversal. Reversals read as a
       bug; right angles read as a trace routing around a component. */
    function turn(s) {
        const horizontal = DIRS[s.dir].y === 0;
        const options = horizontal ? [2, 3] : [0, 1];
        s.dir = options[Math.random() < 0.5 ? 0 : 1];

        s.x = snap(s.x);
        s.y = snap(s.y);
        s.leg = GRID * (1 + Math.floor(Math.random() * 5));
        s.travelled = 0;

        /* Record the corner exactly, so the tail turns a crisp right angle
           instead of cutting it depending on where the sample landed. */
        s.points.push({ x: s.x, y: s.y });
        s.sinceSample = 0;
    }


    /* ----------------------------------------------------------------------
       TAIL SHAPE
       --------------------------------------------------------------------
       f is position along the tail: 0 at the oldest point, 1 at the head.

       The nearest TRAIL_HOLD of the tail stays at full trail alpha - that is
       the "stays for a bit". Everything older ramps linearly to zero.

       A plain linear ramp from head to tip looks like a smear. Holding the
       first third flat and then falling away reads as a signal with a
       defined length that dissipates - which is the thing you are imitating.
       ---------------------------------------------------------------------- */
    function tailAlpha(f) {
        if (f >= 1 - TRAIL_HOLD) return TRAIL_ALPHA;
        return TRAIL_ALPHA * (f / (1 - TRAIL_HOLD));
    }


    /* ----------------------------------------------------------------------
       FRAME
       ---------------------------------------------------------------------- */
    let last = 0;

    function frame(now) {
        /* Delta time, not frame count. A frame-count animation silently runs
           at double speed on a 120Hz display; this runs at the same real
           speed everywhere. Clamped so a background tab returning does not
           teleport every dot across the screen. */
        const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
        last = now;

        /* THE FIX, one line. Full clear every frame - no accumulation, no
           8-bit alpha floor, no net. Everything visible below the canvas
           stays visible. */
        ctx.clearRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'lighter';

        for (let i = 0; i < signals.length; i++) {
            const s = signals[i];
            const d = DIRS[s.dir];
            const step = s.speed * dt;

            s.x += d.x * step;
            s.y += d.y * step;
            s.travelled += step;
            s.sinceSample += step;

            if (s.travelled >= s.leg) {
                turn(s);
            } else if (s.sinceSample >= SAMPLE) {
                s.points.push({ x: s.x, y: s.y });
                s.sinceSample = 0;
            }

            /* Drop the oldest points once the tail is long enough. This is
               what actually limits the trail - not an opacity that decays. */
            while (s.points.length > MAX_POINTS) s.points.shift();

            /* Respawn rather than wrap. Wrapping makes the same dot reappear
               on the opposite edge, which the eye reads as a loop. */
            const m = GRID * 2;
            if (s.x < -m || s.x > width + m || s.y < -m || s.y > height + m) {
                signals[i] = makeSignal();
                continue;
            }

            drawTrail(s);
        }

        drawHeads();
        raf = requestAnimationFrame(frame);
    }


    /* ----------------------------------------------------------------------
       DRAWING
       --------------------------------------------------------------------
       Segments are grouped into BANDS opacity levels so consecutive
       segments of the same band share a single path and one stroke() call.
       A naive loop would be one stroke per segment - roughly 40 signals x 30
       segments = 1200 draw calls a frame, which is where a canvas effect
       starts costing real milliseconds.
       ---------------------------------------------------------------------- */
    function drawTrail(s) {
        const pts = s.points;
        const n = pts.length;
        if (n < 2) return;

        /* The head is where the signal actually is, not the last sample. */
        const head = { x: s.x, y: s.y };

        ctx.strokeStyle = s.colour;
        ctx.lineWidth = SIZE * 0.9;

        let bandOpen = -1;

        for (let i = 1; i < n; i++) {
            const f = i / (n - 1);
            const band = Math.round(tailAlpha(f) / TRAIL_ALPHA * BANDS);

            if (band !== bandOpen) {
                if (bandOpen > 0) ctx.stroke();
                bandOpen = band;
                ctx.globalAlpha = (band / BANDS) * TRAIL_ALPHA;
                ctx.beginPath();
                ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
            }
            ctx.lineTo(pts[i].x, pts[i].y);
        }

        if (bandOpen > 0) {
            ctx.lineTo(head.x, head.y);
            ctx.stroke();
        }

        ctx.globalAlpha = 1;
    }

    /* Heads drawn last, in one pass, so no trail is ever painted over a
       head - and so shadowBlur is set and cleared once rather than per dot.
       shadowBlur is the most expensive thing in this loop; it is the first
       thing to cut if the frame budget gets tight. */
    function drawHeads() {
        ctx.shadowBlur = 9;

        for (let i = 0; i < signals.length; i++) {
            const s = signals[i];
            ctx.beginPath();
            ctx.arc(s.x, s.y, SIZE, 0, Math.PI * 2);
            ctx.fillStyle = s.colour;
            ctx.shadowColor = s.colour;
            ctx.fill();
        }

        ctx.shadowBlur = 0;
    }


    /* ----------------------------------------------------------------------
       LIFECYCLE
       ---------------------------------------------------------------------- */
    function start() {
        if (raf === null && !motionQuery.matches) {
            last = 0;
            raf = requestAnimationFrame(frame);
        }
    }

    function stop() {
        if (raf !== null) {
            cancelAnimationFrame(raf);
            raf = null;
        }
        ctx.clearRect(0, 0, width, height);
    }

    /* A background tab still runs rAF in some browsers, and burns battery
       when it does. Free win, two lines. */
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stop();
        else start();
    });

    /* Debounced: a drag-resize fires this dozens of times a second, and
       rebuilding the whole field each time is pointless work. */
    let resizeTimer = null;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 150);
    });

    /* Respond if the user changes the preference mid-session. */
    motionQuery.addEventListener('change', function (e) {
        if (e.matches) stop();
        else start();
    });

    resize();
    start();

}());
