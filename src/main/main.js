'use strict';

const { app, BrowserWindow, ipcMain, shell, session, dialog, screen } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');

const { EspoClient, EspoAuthError, BASE_URL } = require('./espoClient');
const { n8nClient } = require('./n8nClient');

const store = new Store({
  name: 'rvr-crm-preferences',
  // Only non-sensitive preferences live here — never a password or auth token.
  // seenMessagesAt: { [caseId]: isoTimestamp } — the newest portal-message
  // createdAt this staff member has actually opened/viewed on that case, used
  // purely client-side to drive the unread badge/poll (Messages screen).
  // Per-install, not per-user — acceptable since the app is single-user per
  // machine login session and this is a convenience indicator, not a source
  // of truth (EspoCRM's own createdAt timestamps are that).
  defaults: { lastUserName: '', windowBounds: null, seenMessagesAt: {}, onboarding: {} }
});

const espo = new EspoClient();

let mainWindow = null;
let appVersion = app.getVersion();

function getOsLabel() {
  const platform = process.platform;
  if (platform === 'win32') return `Windows (${process.getSystemVersion ? process.getSystemVersion() : 'unknown build'})`;
  if (platform === 'darwin') return `macOS (${process.getSystemVersion ? process.getSystemVersion() : 'unknown build'})`;
  return platform;
}

function currentStaffName() {
  const info = espo.getSessionInfo();
  return info.userName || '(not logged in)';
}

/**
 * Background error capture — Electron main + renderer process error handlers
 * both funnel here, which reports to the App Error Tracking n8n workflow.
 * Deliberately no AI/LLM involvement; raw and readable only, per the
 * standing "no LLM calls at runtime" project principle.
 */
function reportError({ errorMessage, stackTrace, userAction }) {
  n8nClient
    .reportError({
      errorMessage: errorMessage || 'Unknown error',
      stackTrace: stackTrace || '(no stack trace)',
      userAction: userAction || '(not supplied)',
      appVersion,
      os: getOsLabel(),
      staffName: currentStaffName(),
      timestamp: new Date().toISOString()
    })
    .catch(() => {
      // Deliberately swallow — we don't want error reporting itself to crash
      // the app or surface a second error to the user.
    });
}

/**
 * 2026-08-18: prompted by a real gap — David hit a bare EspoCRM 403
 * (org-wide 2FA setting was off) that showed a friendly inline error in the
 * app, exactly as designed, and therefore never surfaced anywhere: it wasn't
 * an uncaught exception or an unhandled rejection, so App Error Tracking
 * never fired and Tyrone never heard about it until David mentioned it
 * directly. This closes that specific gap for API-call failures without
 * changing what staff see on screen at all — every screen still shows its
 * own friendly inline message exactly as before; this only adds a silent,
 * additional report to `tech@` for the subset that looks like a genuine bug.
 *
 * "Unexpected" here means: NOT a routine 401 (not logged in / session
 * expired / wrong password / needs a 2FA code — all normal, frequent,
 * staff-facing outcomes not worth an email), and NOT an error EspoCRM itself
 * gave a specific, known reason for (a validation message, a real
 * permission explanation). Everything else — a bare/generic failure with no
 * reason given, a malformed response, a network-level error — gets reported
 * in the background, in addition to (never instead of) the on-screen
 * message. See espoClient.js's `EspoAuthError.expected` for where each
 * failure path decides which bucket it's in.
 */
// De-duplication window for App Error Tracking. Added 2026-08-20 after a
// single unresolved 403 on the Messages badge poller (which fires every 2
// minutes for the whole time the app is open) sent tech@ roughly 40
// identical emails in one afternoon. A repeating background failure is one
// problem, not forty, and burying the inbox is how the next genuinely new
// error gets missed. First occurrence reports immediately; identical
// repeats inside the window are counted and folded into a single follow-up
// report when the window closes, so nothing is silently dropped.
const ERROR_REPORT_WINDOW_MS = 30 * 60 * 1000;
const recentErrorReports = new Map(); // key -> { firstReportedAt, suppressed }
const MAX_TRACKED_ERROR_KEYS = 200;

function reportUnexpectedApiFailure(err, userAction) {
  const isAuthErr = err instanceof EspoAuthError;
  const status = isAuthErr ? err.status : undefined;
  const expected = isAuthErr ? !!err.expected : false;

  if (status === 401) return;
  if (expected) return;

  const errorMessage = err && err.message ? err.message : String(err);
  const stackTrace = err && err.stack ? err.stack : '(no stack trace)';
  const key = `${errorMessage}\u241F${userAction}`;
  const now = Date.now();
  const seen = recentErrorReports.get(key);

  if (seen && now - seen.firstReportedAt < ERROR_REPORT_WINDOW_MS) {
    seen.suppressed += 1;
    // 2026-08-28: the comment below promises repeats are "folded into a
    // single follow-up report when the window closes, so nothing is silently
    // dropped". Nothing ever closed the window - the count was only ever
    // reported on the NEXT occurrence after the window elapsed. So an error
    // that fired 40 times in half an hour and then stopped, which is exactly
    // what a passing outage looks like, was reported once and the other 39
    // were lost. Schedule the flush when the window actually expires.
    if (!seen.flushTimer) {
      seen.flushTimer = setTimeout(() => {
        const entry = recentErrorReports.get(key);
        if (!entry) return;
        entry.flushTimer = null;
        if (entry.suppressed > 0) {
          reportError({
            errorMessage: `${errorMessage} [and ${entry.suppressed} further identical occurrence(s) in the ${Math.round(ERROR_REPORT_WINDOW_MS / 60000)} minutes after the first report]`,
            stackTrace,
            userAction
          });
          entry.suppressed = 0;
        }
        recentErrorReports.delete(key);
      }, Math.max(0, ERROR_REPORT_WINDOW_MS - (now - seen.firstReportedAt)));
      if (seen.flushTimer.unref) seen.flushTimer.unref();
    }
    return;
  }

  // Window has closed (or this is the first sighting). If repeats piled up
  // while it was open, say so in this report rather than losing the count.
  const repeatNote = seen && seen.suppressed > 0
    ? ` [repeated ${seen.suppressed} more time(s) in the previous ${Math.round(ERROR_REPORT_WINDOW_MS / 60000)} minutes \u2014 further identical reports are being throttled]`
    : '';

  if (recentErrorReports.size >= MAX_TRACKED_ERROR_KEYS && !seen) {
    // Cheap bound: drop the oldest tracked key rather than growing forever
    // in a long-running session. Map preserves insertion order.
    const oldest = recentErrorReports.keys().next();
    if (!oldest.done) recentErrorReports.delete(oldest.value);
  }
  recentErrorReports.set(key, { firstReportedAt: now, suppressed: 0 });

  reportError({
    errorMessage: errorMessage + repeatNote,
    stackTrace,
    userAction
  });
}

process.on('uncaughtException', (err) => {
  reportError({ errorMessage: err.message, stackTrace: err.stack, userAction: 'Background (main process uncaught exception)' });
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  reportError({ errorMessage: err.message, stackTrace: err.stack, userAction: 'Background (main process unhandled rejection)' });
});

// 2026-08-28: the saved position was restored with no check that those
// coordinates are still on a connected display. Resize while docked to a
// second monitor, undock, and the app opens off-screen - which looks exactly
// like it failing to start. Electron does not clamp this for you.
function usableBounds(saved) {
  const fallback = { width: 1280, height: 820 };
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return fallback;
  const size = { width: saved.width, height: saved.height };
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return size;
  try {
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const a = d.workArea;
      // At least a decent strip of the title bar has to land on a real screen.
      return saved.x + saved.width > a.x + 80
        && saved.x < a.x + a.width - 80
        && saved.y + 40 > a.y
        && saved.y < a.y + a.height - 40;
    });
    if (!visible) return size;
  } catch (_) {
    return size;
  }
  return Object.assign({}, size, { x: saved.x, y: saved.y });
}

function createWindow() {
  const bounds = usableBounds(store.get('windowBounds'));

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#F2EFE7',
    title: 'RVR Ratings CRM',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 2026-08-28: this fired on EVERY frame of a drag, and electron-store's
  // set() is a synchronous atomic file write - hundreds of writes and fsyncs
  // per resize, on the main process thread, which is a visibly janky drag on
  // a modest office laptop. Debounced, and `move` is captured too so the
  // position is not only ever saved as a side effect of resizing.
  let saveBoundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        store.set('windowBounds', mainWindow.getBounds());
      }
    }, 500);
    if (saveBoundsTimer.unref) saveBoundsTimer.unref();
  };
  mainWindow.on('resize', rememberBounds);
  mainWindow.on('move', rememberBounds);

  // Open any external links (e.g. "www.rvrratingpartners.co.uk" footer link)
  // in the OS default browser rather than inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// Auto-update.
//
// 0.2.3 and earlier called checkForUpdatesAndNotify() once, at launch, and
// relied on autoInstallOnAppQuit. That meant a staff member had to restart
// once to trigger the check, wait for a silent background download, then quit
// and reopen — and the assisted NSIS installer put up its own Next/Install
// wizard on the way. Three steps and a wizard to pick up a bug fix.
//
// Now: check at launch AND on a timer, then offer one button. "Restart now"
// runs the installer silently and relaunches the app itself, so the whole
// update is a single click with no wizard.
// ---------------------------------------------------------------------------
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;   // every 30 minutes
const UPDATE_REMIND_LATER_MS = 60 * 60 * 1000;     // re-ask an hour after "Later"

let updatePromptOpen = false;
let updateRemindTimer = null;
// 2026-08-28: electron-updater re-emits `update-downloaded` on every
// subsequent check once the file is cached, so the half-hourly poll reopened
// this dialog and cleared the one-hour reminder it had just set - a modal
// stealing focus mid-case every 30 minutes, the exact opposite of the intent
// stated below. Remember what the user said "Later" to, and stay quiet about
// that version until the reminder genuinely fires.
let updateDismissedVersion = null;

function promptToInstallUpdate(version, fromReminder) {
  if (updatePromptOpen) return;
  if (!fromReminder && updateDismissedVersion && updateDismissedVersion === version) return;
  updatePromptOpen = true;
  clearTimeout(updateRemindTimer);

  const options = {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `RVR Ratings CRM ${version || ''} is ready to install.`.replace('  ', ' '),
    detail: 'The app will close and reopen on its own — it takes a few seconds. Nothing in the CRM is affected.'
  };

  const shown = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);

  shown
    .then((result) => {
      updatePromptOpen = false;
      if (result.response === 0) {
        // isSilent: true skips the NSIS wizard; isForceRunAfter: true reopens
        // the app once it's done. Deferred to the next tick so the dialog is
        // fully closed before the app starts tearing down.
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
        return;
      }
      // "Later" — the update is already downloaded and autoInstallOnAppQuit
      // stays on, so quitting normally still applies it. Ask again in an hour
      // in case they leave the app open for days.
      updateDismissedVersion = version;
      updateRemindTimer = setTimeout(() => {
        updateDismissedVersion = null;
        promptToInstallUpdate(version, true);
      }, UPDATE_REMIND_LATER_MS);
      if (updateRemindTimer.unref) updateRemindTimer.unref();
    })
    .catch(() => { updatePromptOpen = false; });
}

function initAutoUpdate() {
  // Never check in dev — it would try to read a release feed for a version
  // that doesn't exist and log noise on every run.
  // 2026-08-28: this only guarded `npm run dev`. `npm start` leaves
  // NODE_ENV unset, so auto-update ran in development, failed on "application
  // is not packaged", and the failure was swallowed by the handler below.
  // app.isPackaged is the reliable test.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => promptToInstallUpdate(info && info.version));

  // Non-fatal by design: no network, GitHub briefly unreachable, or a rate
  // limit should never interrupt someone mid-case. The next timer tick retries.
  //
  // 2026-08-28: it used to be `() => {}` - the one failure path in this whole
  // app that reported nothing at all. If the update feed ever broke (a
  // renamed account, a bad token, a repo gone private) staff would quietly
  // stop receiving new versions and nobody would find out. Still silent for
  // the user; no longer silent for us. The 30-minute de-duplication above
  // stops a persistent outage flooding the inbox.
  autoUpdater.on('error', (err) => {
    reportUnexpectedApiFailure(err, 'Checking for an app update');
  });

  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(() => {
  createWindow();

  // Field clock-in needs GPS. Electron denies permission requests by default,
  // so the renderer's navigator.geolocation call would otherwise silently
  // reject. Only geolocation is allowed here — everything else (camera, mic,
  // notifications, etc.) stays denied since the app has no use for it.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'geolocation');
  });

  initAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers — the ONLY surface the renderer can reach (via the preload
// contextBridge). The renderer never talks to EspoCRM or n8n directly.
// ---------------------------------------------------------------------------

ipcMain.handle('auth:login', async (_event, { userName, password, code }) => {
  try {
    const user = await espo.login(userName, password, code);
    store.set('lastUserName', userName);
    return { ok: true, user };
  } catch (err) {
    const status = err instanceof EspoAuthError ? err.status : undefined;
    const secondStepRequired = err instanceof EspoAuthError ? !!err.secondStepRequired : false;
    reportUnexpectedApiFailure(err, `Signing in as "${userName || '(blank)'}"`);
    return { ok: false, message: err.message, status, secondStepRequired };
  }
});

ipcMain.handle('auth:logout', async () => {
  espo.logout();
  return { ok: true };
});

ipcMain.handle('auth:lastUserName', async () => store.get('lastUserName') || '');

ipcMain.handle('auth:forgotPasswordUrl', async () => {
  // EspoCRM's own native forgot-password flow (Administration → Group Email
  // Accounts SMTP, confirmed working 2026-08-10) — the app links out to the
  // real login page rather than re-implementing password recovery itself.
  return 'https://crm.rvrratingpartners.co.uk/';
});

/**
 * EspoCRM's own wording is written for developers, not for staff. Now that
 * espoClient recovers it from the X-Status-Reason header, it reads like
 * "Assignment failure: assigned user or team not allowed." or "Max size
 * should not exceed 200." — accurate, and no use at all to David.
 *
 * So: the real reason goes to tech@ in the error report, and the app shows a
 * plain sentence. Screens that know what they were doing can still override
 * this with something more specific (`res.message || 'my own wording'`).
 */
function staffFacingMessage(err, status) {
  // EspoCRM populated a JSON body message — those are the validation-style
  // ones already aimed at whoever is using the app, so let them through.
  if (err instanceof EspoAuthError && err.expected) return err.message;

  // 2026-08-28: status 0 means the request never got an answer at all - a
  // timeout or an unreachable host. It is still reported to tech@ like any
  // other unexplained failure, but the staff member gets a plain sentence
  // they can actually act on rather than silence.
  if (status === 0) return 'Could not reach the CRM - check your connection and try again.';
  if (status === 401) return 'Your session has expired. Please log in again.';
  if (status === 403) return "This isn't working right now — a report has been sent to the team and we're working on a fix.";
  if (status === 404) return 'That record could not be found — it may have been deleted.';
  if (status >= 500) return 'The CRM is not responding right now. Please try again in a minute.';

  return 'Something went wrong — a report has been sent to the team.';
}

ipcMain.handle('espo:request', async (_event, { path: reqPath, method, query, body, expected403, timeoutMs }) => {
  try {
    const data = await espo.request(reqPath, { method, query, body, timeoutMs });
    return { ok: true, data };
  } catch (err) {
    const status = err instanceof EspoAuthError ? err.status : undefined;

    // 2026-08-28: espoClient.logout() has already run by this point on a 401,
    // so the app is signed out whether the renderer knows it or not. Tell it,
    // so it can put the login card back rather than leaving someone reading
    // "please log in again" on a screen with nothing to log in with.
    if (status === 401 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session:expired');
    }

    // `expected403` lets a caller say "a 403 here is a normal outcome, don't
    // report it" — the password screen being the case that matters, where a
    // 403 just means the current password was typed wrong.
    if (!(status === 403 && expected403)) {
      reportUnexpectedApiFailure(err, `API call: ${method || 'GET'} ${reqPath}`);
    }

    return { ok: false, message: staffFacingMessage(err, status), status };
  }
});

ipcMain.handle('espo:downloadFile', async (_event, { fileId, fileName }) => {
  try {
    const buffer = await espo.downloadFile(fileId);
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: fileName || 'document',
      title: 'Save document'
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: false, canceled: true };
    }
    require('fs').writeFileSync(saveResult.filePath, buffer);
    return { ok: true, path: saveResult.filePath };
  } catch (err) {
    const status = err instanceof EspoAuthError ? err.status : undefined;
    reportUnexpectedApiFailure(err, `Downloading file ${fileId}`);
    // 2026-08-28: this returned EspoCRM's own developer wording straight to
    // the renderer, bypassing the translation layer added in v0.2.25 - the
    // exact thing that release set out to prevent. Sanitise it like every
    // other call does.
    return { ok: false, message: staffFacingMessage(err, status), status };
  }
});

// 2026-08-29: all three of these called n8n with no Authorization header.
// The n8n side has verified the caller's EspoCRM session since 16 August, so
// the claim pool had quietly been refusing everyone, and My Cases was handing
// case numbers and property addresses to anyone who knew the address. They now
// pass the signed-in person's own session header, exactly like the password
// reset below, and refuse locally if there isn't one rather than making a call
// that cannot succeed.
function notSignedIn(message) {
  return { ok: false, status: 401, data: { success: false, message } };
}

ipcMain.handle('claimPool:list', async () => {
  const authHeader = espo.getAuthHeader();
  if (!authHeader) return notSignedIn('Please sign in to view the case list.');
  const res = await n8nClient.listClaimableCases(authHeader);
  return res;
});

ipcMain.handle('claimPool:submit', async (_event, { caseId, staffUserId }) => {
  const authHeader = espo.getAuthHeader();
  if (!authHeader) return notSignedIn('Please sign in to claim a case.');
  const res = await n8nClient.submitClaim(authHeader, caseId, staffUserId);
  return res;
});

ipcMain.handle('clock:myCases', async () => {
  const authHeader = espo.getAuthHeader();
  if (!authHeader) return notSignedIn('Please sign in to see your cases.');
  const res = await n8nClient.listMyCases(authHeader);
  return res;
});

ipcMain.handle('clock:event', async (_event, payload) => {
  // 2026-08-30: the clock in/out webhook now verifies the caller's own
  // EspoCRM login, so this has to send it. Refusing here rather than letting
  // the post go out unsigned means the person is told to sign in, instead of
  // getting the webhook's own refusal wording back through the clock screen.
  const authHeader = espo.getAuthHeader();
  if (!authHeader) return notSignedIn('Please sign in before clocking in or out.');
  const res = await n8nClient.clockEvent(authHeader, payload);
  return res;
});

ipcMain.handle('security:resetColleaguePassword', async (_event, { targetUserId }) => {
  const authHeader = espo.getAuthHeader();
  if (!authHeader) {
    return { ok: false, data: { success: false, message: 'You must be signed in to do this.' } };
  }
  const res = await n8nClient.resetColleaguePassword(authHeader, targetUserId);
  return res;
});

ipcMain.handle('feedback:submit', async (_event, payload) => {
  // 2026-08-30: feedback now goes out with the signed-in person's own EspoCRM
  // header so the webhook can verify who is really sending it. It was the last
  // endpoint in the estate that accepted anything from anyone.
  const authHeader = espo.getAuthHeader();
  if (!authHeader) return notSignedIn('Please sign in before sending feedback.');
  const res = await n8nClient.submitFeedback(authHeader, {
    ...payload,
    staffName: payload.staffName || currentStaffName(),
    timestamp: new Date().toISOString()
  });
  return res;
});

ipcMain.handle('app:reportRendererError', async (_event, { errorMessage, stackTrace, userAction }) => {
  reportError({ errorMessage, stackTrace, userAction });
  return { ok: true };
});

ipcMain.handle('app:getVersion', async () => appVersion);
ipcMain.handle('app:getOsLabel', async () => getOsLabel());

// 2026-09-01: brings the window to the front when somebody clicks a desktop
// notification about a new client message. Without this the notification is
// close to useless - the whole point is that you are looking at something
// else when it arrives, and quite possibly have the app minimised.
//
// Deliberately uses getAllWindows()[0] rather than a captured reference, so
// it cannot go stale if the window is ever recreated (macOS re-opens on dock
// click). Wrapped because a window that has just been destroyed would
// otherwise throw into the IPC bridge.
ipcMain.handle('app:focusWindow', async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return { ok: false };
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
});

// ---------------------------------------------------------------------------
// Local "seen" tracking for the Messages screen's unread badge — purely a
// per-install convenience (see the Store defaults comment above), never
// treated as authoritative.
// ---------------------------------------------------------------------------
ipcMain.handle('messages:getSeen', async () => store.get('seenMessagesAt') || {});

ipcMain.handle('messages:setSeen', async (_event, { caseId, timestamp }) => {
  if (!caseId || !timestamp) return { ok: false };
  const map = store.get('seenMessagesAt') || {};
  // Only ever move forward — never let an out-of-order call mark an older
  // message as the "latest seen" and resurrect an already-cleared badge.
  if (!map[caseId] || new Date(timestamp) > new Date(map[caseId])) {
    map[caseId] = timestamp;
    store.set('seenMessagesAt', map);
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Onboarding — first-run tour. Per-user (not per-install, unlike
// seenMessagesAt above) since whether a given staff member has seen the
// tour is a property of the person, not the machine — matters specifically
// for the Surveyor role, where individual accounts rotate through shared
// machines over time (see the project's surveyor-rolling-role-sop.md).
// Keyed by EspoCRM user id. Shape per user: { hasSeenTour, dontShowAgain }.
// (lastSeenVersion / seenFeatureHighlights are reserved for the "what's
// new on update" follow-up feature — not used yet.)
// ---------------------------------------------------------------------------
ipcMain.handle('onboarding:getState', async (_event, { userId }) => {
  if (!userId) return {};
  const all = store.get('onboarding') || {};
  return all[userId] || {};
});

ipcMain.handle('onboarding:setState', async (_event, { userId, patch }) => {
  if (!userId || !patch) return { ok: false };
  const all = store.get('onboarding') || {};
  all[userId] = { ...(all[userId] || {}), ...patch };
  store.set('onboarding', all);
  return { ok: true };
});
