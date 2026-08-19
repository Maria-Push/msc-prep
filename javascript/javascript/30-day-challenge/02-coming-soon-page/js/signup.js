/* ==========================================================================
   SIGNUP FORM
   --------------------------------------------------------------------------
   Flow:
     validate  ->  honeypot check  ->  transmission animation + network call
               ->  success dialog | error dialog

   Kept separate from countdown.js and signals.js: three scripts that share
   nothing, and a failure in one must not take the others down.

   Loaded with `defer`, so the DOM is parsed before this runs - which is why
   there is no DOMContentLoaded wrapper.
   ========================================================================== */

(function () {
    'use strict';

    const form       = document.querySelector('.signup');
    const input      = document.querySelector('#signup-email');
    const button     = form && form.querySelector('button[type="submit"]');
    const trap       = document.querySelector('#signup-website');
    const transmit   = document.querySelector('[data-transmit]');
    const statusEl   = document.querySelector('[data-transmit-status]');
    const successDlg = document.querySelector('#signup-success');
    const errorDlg   = document.querySelector('#signup-error');
    const emailEl    = document.querySelector('.dialog-neon__email');
    const errorMsgEl = document.querySelector('[data-error-message]');

    if (!form || !input || !successDlg || !errorDlg) return;

    /* Endpoint lives in the markup, not here. Empty string = demo mode. */
    const ENDPOINT = (form.dataset.endpoint || '').trim();

    /* Minimum time the animation is shown, read from tokens.css so the
       pacing lives with the rest of the design system. */
    const MIN_MS = parseInt(
        getComputedStyle(document.documentElement)
            .getPropertyValue('--transmit-min-ms'), 10
    ) || 1900;

    /* The stages the status line steps through. Each entry is
       [milliseconds from start, text]. Deliberately in the page's voice -
       "Loading…" would break the fiction everything else maintains. */
    const STAGES = [
        [0,    'opening channel'],
        [550,  'encrypting payload'],
        [1100, 'transmitting'],
        [1650, 'awaiting handshake']
    ];


    /* ----------------------------------------------------------------------
       SMALL HELPERS
       ---------------------------------------------------------------------- */

    /* A promise that resolves after n milliseconds. Used below to race the
       network against a minimum display time. */
    function wait(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function setBusy(busy) {
        input.disabled = busy;
        if (button) {
            button.disabled = busy;
            /* aria-busy tells assistive tech something is in progress, which
               a visual-only spinner never communicates. */
            button.setAttribute('aria-busy', busy ? 'true' : 'false');
        }
    }

    let stageTimers = [];

    function runStages() {
        stageTimers.forEach(clearTimeout);
        stageTimers = STAGES.map(function (stage) {
            return setTimeout(function () {
                if (statusEl) statusEl.textContent = stage[1];
            }, stage[0]);
        });
    }

    function stopStages() {
        stageTimers.forEach(clearTimeout);
        stageTimers = [];
    }

    /* JS flips ONE attribute; every visual state lives in CSS. Far easier to
       reason about than a script reaching in and setting styles directly -
       and it means restyling a state never means touching this file. */
    function showTransmit(state) {
        if (!transmit) return;
        transmit.hidden = false;
        transmit.dataset.state = state;
    }

    function hideTransmit() {
        if (!transmit) return;
        transmit.hidden = true;
        transmit.removeAttribute('data-state');
        if (statusEl) statusEl.textContent = '';
    }


    /* ----------------------------------------------------------------------
       WHAT WENT WRONG?
       --------------------------------------------------------------------
       Because the form carries `novalidate`, the browser draws no bubble -
       but the ValidityState object is still populated. novalidate turns off
       the UI, not the API. Reading it here means our messages can be
       specific without giving up the built-in constraint checking.
       ---------------------------------------------------------------------- */
    function describeProblem(field) {
        const v = field.validity;
        if (v.valueMissing) {
            return 'You left the channel empty. Drop an email address in and we can reach you.';
        }
        if (v.typeMismatch) {
            return 'That is not a shape an email address comes in. Check for a missing @ or a stray space.';
        }
        return field.validationMessage ||
               'Something about that address did not parse. Try again?';
    }

    function fail(message) {
        if (errorMsgEl) errorMsgEl.textContent = message;
        errorDlg.showModal();
    }


    /* ----------------------------------------------------------------------
       THE NETWORK CALL
       --------------------------------------------------------------------
       Endpoint-agnostic. FormData posts as multipart, which Formspree,
       Web3Forms, Basin, Netlify Forms and a Google Apps Script web app all
       accept without configuration - so switching providers is a URL change,
       not a rewrite.

       Two things people get wrong with fetch:

       1. fetch does NOT reject on 4xx or 5xx. It only rejects when the
          request could not be made at all - offline, DNS failure, CORS.
          A 500 arrives as a perfectly resolved promise with ok === false.
          Forgetting to check `response.ok` is the single most common fetch
          bug, and it shows the user a success screen for a failed request.

       2. A network error and a server error need different messages. "We
          could not reach the server" and "the server refused this" send the
          user to two different remedies.
       ---------------------------------------------------------------------- */
    async function send(value) {
        /* DEMO MODE. No endpoint configured, so pretend. This keeps the whole
           flow testable before you have chosen a provider - and means the
           page is never in a broken half-state while you decide. */
        if (!ENDPOINT) {
            await wait(700);
            return { ok: true, demo: true };
        }

        const body = new FormData();
        body.append('email', value);

        const response = await fetch(ENDPOINT, {
            method: 'POST',
            body: body,
            headers: { 'Accept': 'application/json' }
        });

        return { ok: response.ok, status: response.status };
    }


    /* ----------------------------------------------------------------------
       SUBMIT
       ---------------------------------------------------------------------- */
    form.addEventListener('submit', async function (event) {

        /* Always first. Without it the browser navigates and the page
           reloads, wiping the countdown and everything else. */
        event.preventDefault();

        /* HONEYPOT. Bots fill every field they find; a human cannot see this
           one, so anything in it is automated. Fail SILENTLY and pretend it
           worked - telling a bot it was caught only teaches whoever wrote it
           to adapt. */
        if (trap && trap.value !== '') {
            successDlg.showModal();
            form.reset();
            return;
        }

        if (!input.checkValidity()) {
            fail(describeProblem(input));
            return;
        }

        const value = input.value.trim();

        setBusy(true);
        showTransmit('sending');
        runStages();

        try {
            /* THE MINIMUM-DISPLAY TRICK.
               Promise.all waits for the SLOWER of the two. If the network
               answers in 80ms the animation still plays for its full
               duration; if it takes three seconds, no extra delay is added.

               This is not padding for its own sake. A progress indicator
               that flashes up and vanishes within one frame reads as a
               glitch, and users report those pages as "broken" more often
               than slower ones that acknowledge the action. Perceived
               responsiveness is about acknowledgement, not raw speed. */
            const [result] = await Promise.all([ send(value), wait(MIN_MS) ]);

            stopStages();

            if (!result.ok) {
                showTransmit('failed');
                if (statusEl) statusEl.textContent = 'channel refused';
                await wait(900);
                hideTransmit();
                fail('The server turned us away (error ' + result.status +
                     '). Not your fault - try again in a moment.');
                return;
            }

            /* Landed. Hold the completed state briefly before the dialog, so
               the animation resolves instead of being cut off mid-thought. */
            showTransmit('done');
            if (statusEl) statusEl.textContent = 'signal locked';
            await wait(650);
            hideTransmit();

            /* textContent, never innerHTML. This string came from a user, and
               innerHTML with user input is the classic XSS hole. */
            if (emailEl) emailEl.textContent = value;

            /* showModal(), not show(): backdrop, Tab trapped inside, Escape
               closes, rest of the page inert. All four free. */
            successDlg.showModal();
            form.reset();

        } catch (err) {
            /* Reached only when the request could not be made at all -
               offline, DNS, CORS. Distinct from a server error above. */
            stopStages();
            showTransmit('failed');
            if (statusEl) statusEl.textContent = 'no carrier';
            await wait(900);
            hideTransmit();
            fail('We could not reach the relay. Check your connection and try again.');

        } finally {
            /* finally runs on every path - success, handled failure, thrown
               error, even an early return inside try. Re-enabling here is
               what guarantees the form is never left permanently dead. */
            setBusy(false);
        }
    });


    /* ----------------------------------------------------------------------
       CLOSING — both dialogs
       Escape already works natively; these are the other two ways out.
       ---------------------------------------------------------------------- */
    [successDlg, errorDlg].forEach(function (dlg) {

        const closeBtn = dlg.querySelector('[data-dialog-close]');
        if (closeBtn) {
            closeBtn.addEventListener('click', function () { dlg.close(); });
        }

        /* A modal <dialog> fills the viewport but its visible box is only
           content-sized, so a click on the dark surround still targets the
           <dialog> itself. target === dlg therefore means "outside". */
        dlg.addEventListener('click', function (event) {
            if (event.target === dlg) dlg.close();
        });

        /* Return focus to the field rather than dumping a keyboard user at
           the top of the document. After an error this lands the caret
           exactly where the fix is needed. */
        dlg.addEventListener('close', function () { input.focus(); });
    });

}());
