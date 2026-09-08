'use strict';

/**
 * "What's new" — added 2026-09-01.
 *
 * Tyrone asked for this more than once: "The tutorial doesn't explain the new
 * features in the app, which I specifically asked that when a new update
 * happens that it should add the new features." The first-run tour only ever
 * ran once per person, so anyone already using the app never heard about
 * anything added afterwards. This is the missing half.
 *
 * How it decides whether to show:
 *   - `lastSeenVersion` is stored PER ESPOCRM USER, in the same onboarding
 *     store the tour uses. That field was reserved for this on 2026-08-18 and
 *     has sat unused ever since. Per-user rather than per-install matters for
 *     the same reason it does for the tour: accounts rotate through shared
 *     machines.
 *   - Every entry newer than `lastSeenVersion` is shown, not just the current
 *     one. Somebody who was on holiday for three releases sees all three.
 *   - A brand-new person who has just been shown the first-run tour is NOT
 *     shown this as well. Everything is new to them; the tour is the right
 *     introduction. init() marks them as up to date instead.
 *
 * WRITING AN ENTRY: staff-facing, plain English, and only things a person
 * would notice. "Fixed a scope error in doLogin()" means nothing to David.
 * "You can sign in again with two-factor turned on" does. If a release
 * changed nothing a user can see, give it no entry at all - a modal that says
 * nothing teaches people to dismiss it without reading.
 */
(function () {
  const rvr = window.rvr || {};

  // Newest first. Version strings must match package.json exactly.
  const ENTRIES = [
    {
      version: '0.2.42',
      headline: 'Uploading a document no longer gives up too soon',
      items: [
        'Uploading a document used to share the same 20-second limit as every other CRM request. A larger file on a slower connection could genuinely need longer than that, and it came back as "The CRM did not respond" even though nothing was wrong. Uploads now get a longer, separate wait before they give up.'
      ]
    },
    {
      version: '0.2.41',
      headline: 'Every case now has a reference you can give a client',
      items: [
        'Cases now carry a short reference that looks like RVR-2609-K7M2. It is what a client quotes on the phone or in an email, and it shows on the case list, on the case itself, and on their portal.',
        'You can search by it. Type the whole reference, or just the last few characters, into the search box on Cases.',
        'The case number has not gone anywhere - it sits next to the reference, so you can still use whichever you prefer.'
      ]
    },
    {
      version: '0.2.40',
      headline: 'The app tells you when a client messages',
      items: [
        'A new client message now pops up a desktop notification instead of only changing the number in the sidebar. Clicking it brings the app to the front and opens Messages.',
        'You will not be flooded when you sign in - only messages that arrive while the app is open are announced, and nothing pops up while you are already looking at the Messages screen.'
      ]
    },
    {
      version: '0.2.39',
      headline: 'Rejecting a case at the site inspection',
      items: [
        'A surveyor who gets to a property and can see the case will not get through can now reject it there and then, using the new "Site Inspection / Case Rejection" stage. It does not need the signed documents first, because the case is not going any further.',
        'The booking confirmation clients receive now asks them to have their rates bill, lease and floor plans to hand, and to give access to the whole property. It used to tell them there was nothing to prepare.'
      ]
    },
    {
      version: '0.2.38',
      headline: 'Returning clients, and a clearer case stage',
      items: [
        'When a client’s last case is deleted they are now archived rather than left cluttering the New Case list. Nothing is deleted - if you type the details of an archived client, the app offers you their existing record instead of making a duplicate.',
        'The case stage now moves on its own "Move case" button. Correcting an address can no longer move a case by accident.',
        'An appointment you have already answered stops offering both buttons. If you need to change your mind it now says "Decline instead", so you can see you are reversing an earlier answer.',
        'This "What’s new" note itself - you will get one each time the app updates. You can reopen it any time from the "?" menu.'
      ]
    },
    {
      version: '0.2.35',
      headline: 'Two-factor sign-in, deleting a case, and booking a visit',
      items: [
        'Signing in with two-factor authentication works again. It used to let you in and then throw you straight back out saying your session had expired.',
        'Deleting a case works from inside the app. The confirmation is now part of the page rather than a pop-up box.',
        'Booking a site visit now asks for the case number, because the CRM requires every visit to belong to a case. Previously a booking with the case box empty was silently refused and never appeared under Bookings.'
      ]
    },
    {
      version: '0.2.33',
      headline: 'Clocking in',
      items: ['Clocking in from the app works again, and the Feedback button carries your login with it.']
    },
    {
      version: '0.2.31',
      headline: 'Bookings, and lists that stop hiding things',
      items: [
        'A new Bookings screen showing every site visit from today onwards, with the visit’s status and the surveyor’s answer as two separate columns.',
        'Long lists now tell you when you are only seeing part of them, instead of showing the first page as though it were everything.',
        'The New Case screen will not start until a client contact is chosen, because the CRM now requires one.'
      ]
    }
  ];

  function parseVersion(v) {
    const parts = String(v || '').split('.').map((n) => parseInt(n, 10));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }

  // Returns > 0 when a is newer than b.
  function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    for (let i = 0; i < 3; i += 1) {
      if (x[i] !== y[i]) return x[i] - y[i];
    }
    return 0;
  }

  function entriesNewerThan(since) {
    if (!since) return [];
    return ENTRIES.filter((e) => compareVersions(e.version, since) > 0);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function closeModal() {
    const existing = document.getElementById('whats-new-overlay');
    if (existing) existing.remove();
  }

  function renderModal(entries, currentVersion, onClose) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.id = 'whats-new-overlay';
    overlay.className = 'whats-new-overlay';
    overlay.innerHTML = `
      <div class="whats-new-modal" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
        <h2 id="whats-new-title" class="whats-new-title">What&rsquo;s new</h2>
        <p class="whats-new-sub">You are now on version ${escapeHtml(currentVersion)}.</p>
        <div class="whats-new-body">
          ${entries.map((e) => `
            <section class="whats-new-entry">
              <h3>${escapeHtml(e.headline)} <span class="whats-new-version">${escapeHtml(e.version)}</span></h3>
              <ul>${e.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>
            </section>
          `).join('')}
        </div>
        <div class="whats-new-actions">
          <button type="button" class="btn btn-primary" id="whats-new-close">Got it</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    function done() {
      closeModal();
      if (typeof onClose === 'function') onClose();
    }
    overlay.querySelector('#whats-new-close').addEventListener('click', done);
    // Clicking the backdrop counts as dismissing it - but only the backdrop,
    // not a stray click inside the panel.
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) done(); });
  }

  async function currentVersion() {
    try {
      if (rvr.app && typeof rvr.app.getVersion === 'function') {
        const v = await rvr.app.getVersion();
        if (v) return String(v);
      }
    } catch (_) { /* fall through */ }
    return '';
  }

  async function markSeen(userId, version) {
    if (!userId || !version) return;
    try {
      if (rvr.onboarding && typeof rvr.onboarding.setState === 'function') {
        await rvr.onboarding.setState(userId, { lastSeenVersion: version });
      }
    } catch (_) {
      // A failed write only means they are offered it again next launch.
      // Never let it stop the modal closing.
    }
  }

  /**
   * Show the notes for everything newer than the version this person last
   * saw. Called after login. Does nothing at all on a first run - see
   * markUpToDate.
   */
  async function showIfNew(user) {
    if (!user || !user.id) return;
    const version = await currentVersion();
    if (!version) return;

    let state = {};
    try {
      if (rvr.onboarding && typeof rvr.onboarding.getState === 'function') {
        state = (await rvr.onboarding.getState(user.id)) || {};
      }
    } catch (_) {
      // If we cannot read the state we do NOT guess. Showing release notes to
      // somebody who has already read them is annoying; the quiet option is
      // the right one for a failed read.
      return;
    }

    const since = state.lastSeenVersion;
    if (!since) {
      // Never recorded. Could be a genuinely new install, or somebody who has
      // been using the app since before this feature existed. Either way,
      // showing them four releases of history is noise - record where they
      // are and start telling them from the next update onwards.
      await markSeen(user.id, version);
      return;
    }

    if (compareVersions(version, since) <= 0) return;

    const entries = entriesNewerThan(since);
    if (!entries.length) {
      // The version moved but nothing user-visible changed. Say nothing, and
      // still record it so they are not asked again.
      await markSeen(user.id, version);
      return;
    }

    renderModal(entries, version, () => markSeen(user.id, version));
  }

  /** Record this person as up to date without showing anything. */
  async function markUpToDate(user) {
    if (!user || !user.id) return;
    const version = await currentVersion();
    await markSeen(user.id, version);
  }

  /** The "?" menu entry - always shows the full list, on demand. */
  async function showAll() {
    const version = await currentVersion();
    renderModal(ENTRIES, version || '', null);
  }

  window.rvrChangelog = { ENTRIES, showIfNew, showAll, markUpToDate, compareVersions, entriesNewerThan };
}());
