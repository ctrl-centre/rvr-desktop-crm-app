'use strict';

/**
 * Thin wrapper around the EspoCRM REST API.
 *
 * Design (per infrastructure-status.md / RVR_Handover.md, confirmed 2026-08-12):
 * - Each staff member logs in with their OWN real EspoCRM username/password.
 * - The app is a genuine EspoCRM API client — it inherits EspoCRM's existing
 *   6-role ACL model for free. No permission logic is duplicated here.
 * - Auth uses EspoCRM's HTTP Basic Auth support on the REST API (base64-encoded
 *   in the Authorization header, sent per request). This is the standard
 *   EspoCRM API auth method for a "real user" login, distinct from the
 *   separate API-Key auth used by the n8n automation user.
 * - 2026-09-01: the password is used ONCE, to sign in. EspoCRM hands back an
 *   auth token, and every request after that sends the token in place of the
 *   password. That is what makes two-factor authentication work at all (see
 *   the long note in login()), and it also means the staff member's actual
 *   password is no longer held for the life of the session.
 * - Whatever is held is held ONLY in memory in the main process for the life
 *   of the session (never written to disk in plaintext). A future iteration
 *   could use the OS keychain (e.g. via `keytar`) for an opt-in "remember me".
 *
 * The Claim a Case screen is the one deliberate exception: it calls the
 * dedicated n8n webhooks (rvr-case-claim-list / rvr-case-claim-submit) instead
 * of the logged-in user's own EspoCRM token, since a Caseworker's own ACL
 * can't see unassigned cases outside their scope.
 */

const BASE_URL = 'https://crm.rvrratingpartners.co.uk/api/v1';

// 2026-08-28: every fetch in this file and in n8nClient.js was issued with no
// time limit. Node's fetch will not give up on a stalled connection in any
// useful timeframe, so a CRM that was up but wedged produced a promise that
// never settled - no error, no report, and every screen stuck on "Loading..."
// until the app was force-quit. 20 seconds is comfortably longer than any
// real call here and short enough that a staff member gets a real answer.
const REQUEST_TIMEOUT_MS = 20000;

// 2026-09-08: the limit above is right for an ordinary API call and wrong for
// a file transfer. Maria's document upload died on it at 12:40 (app error
// report, v0.2.41, "API call: POST Attachment") and told her "The CRM did not
// respond within 20 seconds" - which reads as the CRM being down. It was not:
// n8n was calling the same CRM successfully every two minutes either side of
// her attempt (executions 5831-5839, all under seven seconds). A 10MB scan -
// the app's own cap in case-detail.js - is about 13.5MB once base64'd into
// JSON, and on a slow uplink that is minutes rather than seconds.
//
// So a file transfer gets its own, much longer limit and its own honest
// wording. This does NOT relax the 20 seconds for anything else: the wedged-
// CRM problem the original limit was added for is unchanged for every screen.
const TRANSFER_TIMEOUT_MS = 120000;

// Anything whose JSON body is bigger than this is a file, not a form. The
// base64 payload of an upload is the only thing in this app that comes near
// it - the largest ordinary request here is a few kilobytes.
const LARGE_BODY_BYTES = 256 * 1024;

function requestTimeoutSignal(ms = REQUEST_TIMEOUT_MS) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch (_) { /* fall through - an older runtime simply gets no timeout */ }
  return undefined;
}

/**
 * True for the calls that move a file rather than a record. Both the path and
 * the body size are checked: the path catches an Attachment call whatever its
 * size, and the size catches anything else that ever carries base64 (a future
 * screen, a different entity) without needing this list updated.
 */
function isFileTransfer(path, payload) {
  const clean = String(path || '').replace(/^\//, '');
  if (/^Attachment(\/|\?|$)/i.test(clean)) return true;
  return typeof payload === 'string' && payload.length > LARGE_BODY_BYTES;
}

/**
 * A timeout on a file transfer must never be reported as the CRM failing to
 * answer - that is what sent 8 September down the wrong path for a while.
 * Both call sites build their error here so the wording, the flags main.js
 * branches on, and the sentence that reaches tech@ all stay in one place.
 */
function reachFailureError(timedOut, isTransfer, timeoutMs) {
  let message;
  if (!timedOut) {
    message = 'Could not reach the CRM.';
  } else if (isTransfer) {
    message = `The file transfer did not finish within ${Math.round(timeoutMs / 1000)} seconds.`;
  } else {
    message = `The CRM did not respond within ${Math.round(timeoutMs / 1000)} seconds.`;
  }
  const err = new EspoAuthError(message, 0, false);
  err.timedOut = !!timedOut;
  err.transfer = !!isTransfer;
  return err;
}

class EspoAuthError extends Error {
  /**
   * `expected` marks a failure as a routine, understood, staff-facing outcome
   * (wrong password, no permission on a specific record, a validation
   * message EspoCRM itself supplied, needs-a-2FA-code) as opposed to
   * something that actually broke (a bare/generic failure with no reason
   * given, a malformed response, a network error). Added 2026-08-18 so the
   * main process can decide what's worth reporting to App Error Tracking
   * without every screen needing its own opinion — see main.js's
   * `reportUnexpectedApiFailure`. Defaults to false (report it) so a new
   * failure path added later fails safe toward visibility, not silence.
   */
  constructor(message, status, expected = false) {
    super(message);
    this.name = 'EspoAuthError';
    this.status = status;
    this.expected = expected;
  }
}

class EspoClient {
  constructor() {
    this._authHeader = null;
    this._userName = null;
    this._userId = null;
    // 2026-09-01: true once _authHeader carries an EspoCRM auth token rather
    // than the staff member's password. See the 2FA block in login().
    this._byToken = false;
  }

  isAuthenticated() {
    return !!this._authHeader;
  }

  getSessionInfo() {
    return { userName: this._userName, userId: this._userId };
  }

  /**
   * The current session's raw HTTP Basic Auth header (or null if not logged
   * in). Exposed ONLY so main.js can forward the logged-in staff member's own
   * identity to the small set of n8n webhooks that need to verify who's
   * calling (e.g. the Director/Administrator-gated colleague password reset,
   * see n8nClient.js) — the renderer never sees this value, same boundary as
   * everything else in this file.
   */
  getAuthHeader() {
    return this._authHeader;
  }

  /**
   * Attempt to log in with a real EspoCRM username/password.
   * Confirms the credentials by calling GET /App/user, which EspoCRM only
   * answers successfully for a genuinely authenticated request.
   *
   * `code` is an optional TOTP code for accounts with EspoCRM's own
   * two-factor authentication turned on (Administration > 2FA is per-user
   * self-service, confirmed live 2026-08-17 against EspoCRM's own source:
   * application/Espo/Core/Api/Auth.php's handleSecondStepRequired()). When a
   * 2FA-enabled account logs in WITHOUT a code, EspoCRM returns HTTP 401 with
   * a distinct `X-Status-Reason: second-step-required` header (not a generic
   * "wrong credentials" failure) — that's what lets the login screen tell
   * "needs a code" apart from "wrong password" and prompt accordingly rather
   * than showing a confusing error. The code, once known, is sent as its own
   * header (`Espo-Authorization-Code`), alongside the same Basic Auth header,
   * verified fresh on every request since this app doesn't keep a session.
   *
   * This only ever affects real human logins: EspoCRM's 2FA enrollment
   * (Tools/UserSecurity/Service.php) only allows admin/regular users to set
   * it up on their own account — API-key/automation users structurally can't
   * have 2FA applied to them, so this can never touch the n8n/portal-proxy
   * credentials.
   */
  async login(userName, password, code) {
    if (!userName || !password) {
      throw new EspoAuthError('Username and password are required.', 400, true);
    }

    const credentials = Buffer.from(`${userName}:${password}`).toString('base64');
    const authHeader = 'Basic ' + credentials;
    // 2026-09-01: EspoCRM only mints an auth token when the login request
    // carries its OWN `Espo-Authorization` header. Read from the running
    // container's Authentication.php: the token is created inside
    // `if (!$result->isSecondStepRequired() && $request->getHeader(
    // HeaderKey::AUTHORIZATION))`, and HeaderKey::AUTHORIZATION is the string
    // 'Espo-Authorization', NOT the standard 'Authorization'. A plain Basic
    // login authenticates perfectly well and comes back with no token at all,
    // which is why this app never had one to keep - and why 2FA locked
    // everybody out (see the token block further down).
    //
    // Both headers are sent deliberately. Espo-Authorization is the one that
    // mints the token; the standard header stays as a fallback so that if
    // anything between here and PHP ever strips the custom one we degrade to
    // the old password-on-every-request behaviour rather than failing to sign
    // in at all. EspoCRM prefers Espo-Authorization when both are present
    // (Api/Auth.php, obtainUsernamePasswordFromRequest), and its value is the
    // RAW base64 - no 'Basic ' prefix, unlike the standard header.
    //
    // We deliberately do NOT send the create-token-secret header, so the
    // token comes back with no secret and needs no cookie handling.
    const headers = {
      Authorization: authHeader,
      'Espo-Authorization': credentials
    };
    if (code) headers['Espo-Authorization-Code'] = code;

    const res = await fetch(`${BASE_URL}/App/user`, {
      method: 'GET',
      headers
    });

    if (res.status === 401 || res.status === 403) {
      const reason = res.headers.get('X-Status-Reason');
      if (reason === 'second-step-required') {
        const err = new EspoAuthError(
          code
            ? 'That code was not accepted. Please try the current code from your authenticator app.'
            : 'Enter the 6-digit code from your authenticator app.',
          res.status,
          true
        );
        err.secondStepRequired = true;
        throw err;
      }
      // A routine, staff-facing outcome (typo'd password, expired account) —
      // not worth an App Error Tracking email. Contrast with the generic
      // fallback below, which means EspoCRM refused for some OTHER reason.
      throw new EspoAuthError('Incorrect username or password.', res.status, true);
    }
    if (!res.ok) {
      // No known/expected reason for this one — genuinely unexpected.
      throw new EspoAuthError(`EspoCRM returned an unexpected error (HTTP ${res.status}). Please try again.`, res.status, false);
    }

    // GET App/user does NOT return a bare user record. EspoCRM wraps it:
    //   { user: {...}, acl: {...}, preferences: {...}, settings: {...},
    //     appParams: {...}, token: "..." }
    // (see EspoCRM's own client/src/app.js -> onAuth: `data.user`).
    // Reading `.userName`/`.id` straight off the envelope silently yields
    // undefined, which is what broke the app shell in 0.2.1 — the topbar
    // avatar called .trim() on an undefined display name and every
    // user.id-dependent call (claim-a-case, Field clock-in) sent undefined.
    // `|| payload` keeps this working if a future Espo version ever returns
    // the record unwrapped.
    const payload = await res.json();
    const user = (payload && payload.user) || payload || {};

    if (!user.id) {
      // A 200 with no usable user record is a structural surprise, not a
      // credentials problem — worth reporting even though the HTTP call
      // itself "succeeded".
      throw new EspoAuthError(
        'Signed in, but EspoCRM did not return a user record. Please contact support.',
        res.status,
        false
      );
    }

    // ---------------------------------------------------------------------
    // 2026-09-01: THE 2FA LOCKOUT FIX. Reported by Tyrone as "logs in then
    // immediately kicks out and says the session has expired."
    //
    // What was happening: login() sent the TOTP code as its own header, and
    // then threw the code away and stored ONLY `Basic base64(user:password)`.
    // Every request after that carried the password and no code. EspoCRM's
    // Authentication.php runs its second-step check whenever
    // `!$authToken && $this->getTwoFactorEnabled()` - so with no token, EVERY
    // request re-triggered the 2FA challenge, came back 401, and request()
    // below turned that into logout() plus "Your session has expired."
    //
    // Re-sending the code was never an option: a TOTP code is good for one
    // 30-second window. The answer is EspoCRM's own auth token, which the
    // second-step check explicitly skips over.
    //
    // The token goes in the password position of a normal Basic header. That
    // matters for the n8n webhooks, which are handed this exact header via
    // getAuthHeader() and forward it to GET /App/user to verify who is
    // calling: EspoCRM looks a token up from the password position
    // unconditionally (`$authToken = $this->authTokenManager->get($password)`)
    // so those calls keep working untouched.
    //
    // If no token came back we keep the old password header rather than
    // failing the sign-in. Non-2FA accounts carry on exactly as before, and a
    // 2FA account is no worse off than it is today.
    //
    // Token life on this instance, read from data/config.php on the running
    // container: authTokenLifetime 0 (no hard expiry) and authTokenMaxIdleTime
    // 48 hours. The app polls every couple of minutes while it is open, so in
    // practice a staff member stays signed in; after 48 hours idle the token
    // goes stale, the next call 401s and they get the honest "session has
    // expired" prompt this bug was falsely showing them.
    // ---------------------------------------------------------------------
    const resolvedUserName = user.userName || userName;
    const authToken = payload && typeof payload.token === 'string' ? payload.token.trim() : '';

    if (authToken) {
      this._authHeader = 'Basic ' + Buffer.from(`${resolvedUserName}:${authToken}`).toString('base64');
      this._byToken = true;
    } else {
      this._authHeader = authHeader;
      this._byToken = false;
    }

    this._userName = resolvedUserName;
    this._userId = user.id;

    return {
      id: user.id,
      userName: user.userName || userName,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      type: user.type || '',
      // Full EspoCRM-computed ACL for this user, straight from the same
      // GET /App/user response already read above (payload.acl) — not a
      // new call, not a client-side ACL re-implementation. Used only for
      // soft, best-effort UI decisions (e.g. which first-run tour steps
      // are relevant to this person's role, see shared/tour-steps.js) —
      // EspoCRM's own server-side ACL remains the only real enforcement,
      // exactly as everywhere else in this app.
      acl: payload.acl || {}
    };
  }

  logout() {
    this._authHeader = null;
    this._userName = null;
    this._userId = null;
    this._byToken = false;
  }

  /**
   * The extra headers that go alongside Authorization on every authenticated
   * call. When the session is running on an auth token rather than a
   * password, `Espo-Authorization-By-Token` tells EspoCRM to insist on a real
   * token: without it a stale token would be tried as if it were a password,
   * which is a pointless round trip and an entry in the failed-login log.
   * Either way a dead token ends as a 401 and the staff member is asked to
   * sign in again, which is the honest outcome.
   */
  _authExtraHeaders() {
    return this._byToken ? { 'Espo-Authorization-By-Token': 'true' } : {};
  }

  /**
   * Generic authenticated request against the EspoCRM REST API, using the
   * currently logged-in user's own credentials (and therefore their own ACL).
   */
  async request(path, { method = 'GET', query, body } = {}) {
    if (!this._authHeader) {
      throw new EspoAuthError('Not logged in.', 401, true);
    }

    let url = `${BASE_URL}/${path.replace(/^\//, '')}`;
    if (query && Object.keys(query).length) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        // 2026-08-28: URLSearchParams.append() runs String() over an array,
        // so an `in` filter's values reached EspoCRM as ONE comma-joined
        // value and matched zero rows — with HTTP 200 and no error at all.
        // Proven live against the running CRM: the flattened form returned
        // total 0 where repeated params returned total 10. That silently
        // emptied the Director's colleague-reset list every single time, and
        // blanked case numbers on Messages and Verification whenever more
        // than one case was involved. Append each element separately so PHP
        // parses a real array on the other end.
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item !== undefined && item !== null) params.append(key, item);
          }
          continue;
        }
        params.append(key, value);
      }
      url += `?${params.toString()}`;
    }

    // Serialised once, so the size test below and the request itself cannot
    // disagree about what is being sent.
    const payload = body ? JSON.stringify(body) : undefined;
    const transfer = isFileTransfer(path, payload);
    const timeoutMs = transfer ? TRANSFER_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: this._authHeader,
          'Content-Type': 'application/json',
          ...this._authExtraHeaders()
        },
        body: payload,
        signal: requestTimeoutSignal(timeoutMs)
      });
    } catch (err) {
      // 2026-08-28: no request in this app had a time limit. If the CRM was
      // up but wedged, the promise never settled — so the catch blocks in
      // every screen never ran either, and staff sat on "Loading…" forever
      // with nothing reported to anyone. Status 0 means "never got an
      // answer", and main.js turns that into plain copy for the user while
      // still reporting it, because a server that stops answering is a
      // fault worth seeing.
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw reachFailureError(timedOut, transfer, timeoutMs);
    }

    if (res.status === 401) {
      // Session-equivalent expired / credentials no longer valid.
      this.logout();
      throw new EspoAuthError('Your session has expired. Please log in again.', 401, true);
    }

    if (!res.ok) {
      // 2026-08-18: whether EspoCRM gave a real, specific reason is exactly
      // the signal for whether this was an "expected" outcome (a permission
      // message, a validation failure) or a genuine unexplained failure (a
      // bare/empty error body — e.g. EspoCRM's own `throw new Forbidden()`
      // with no message, as hit by the 2FA-setup 403 that prompted this).
      // See main.js's `reportUnexpectedApiFailure` for what happens with it.
      let message = `EspoCRM request failed (HTTP ${res.status}).`;
      let expected = false;

      // 2026-08-27: EspoCRM returns its 403s with an EMPTY body and puts the
      // explanation in the X-Status-Reason HEADER. Verified live against the
      // running CRM: a deliberate over-limit list request came back with a
      // zero-length body and the header reading "Max size should not exceed
      // 200. Use offset and limit." Reading only the JSON body therefore
      // discarded EspoCRM's reason on every single 403, which is why three
      // completely unrelated failures on 2026-08-27 (a blocked company
      // create, the Messages screen, a password change) all arrived as the
      // same contentless "HTTP 403" and were misdiagnosed as one permission
      // gap. Read the header first; the body still wins if it has anything,
      // since that is the richer source when EspoCRM does populate it.
      //
      // Note on `expected`: a reason header deliberately does NOT mark the
      // failure as expected. Some of these ARE our own bugs (the maxSize one
      // above), and this file's standing principle is to fail toward
      // visibility. The reports now carry a real sentence instead of nothing.
      const reasonHeader = res.headers.get('X-Status-Reason');
      if (reasonHeader && reasonHeader.trim()) {
        message = reasonHeader.trim();
      }

      try {
        const errBody = await res.json();
        if (errBody && errBody.message) {
          message = errBody.message;
          expected = true;
        }
      } catch (_) { /* ignore parse failure, keep generic message */ }
      throw new EspoAuthError(message, res.status, expected);
    }

    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * Downloads an Attachment's raw file bytes, using the logged-in user's own
   * credentials (so it's governed by the same Document ACL as everything
   * else — a caseworker can only download a file on a case they can see).
   * Returns a Node Buffer; the renderer never touches the auth header.
   */
  async downloadFile(fileId) {
    if (!this._authHeader) {
      throw new EspoAuthError('Not logged in.', 401, true);
    }

    let res;
    try {
      res = await fetch(`${BASE_URL}/Attachment/file/${encodeURIComponent(fileId)}`, {
        method: 'GET',
        headers: { Authorization: this._authHeader, ...this._authExtraHeaders() },
        signal: requestTimeoutSignal(TRANSFER_TIMEOUT_MS)
      });
    } catch (err) {
      // A download is a file transfer too - same longer limit, same wording.
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw reachFailureError(timedOut, true, TRANSFER_TIMEOUT_MS);
    }

    if (res.status === 401) {
      this.logout();
      throw new EspoAuthError('Your session has expired. Please log in again.', 401, true);
    }
    if (!res.ok) {
      // 2026-08-28: v0.2.25 taught request() to read EspoCRM's reason out of
      // the X-Status-Reason header, but this path was missed — so a failed
      // download still produced the contentless error that fix existed to
      // eliminate. Read it here too.
      const reasonHeader = res.headers.get('X-Status-Reason');
      const reason = reasonHeader && reasonHeader.trim()
        ? reasonHeader.trim()
        : `Could not download that file (HTTP ${res.status}).`;
      throw new EspoAuthError(reason, res.status, false);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

module.exports = { EspoClient, EspoAuthError, BASE_URL };
