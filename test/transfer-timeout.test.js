'use strict';

/**
 * test/transfer-timeout.test.js - added 2026-09-08.
 *
 * The bug: every request in espoClient.js shared one 20-second limit, so a
 * document upload - a 10MB scan is about 13.5MB once base64'd - was given the
 * same time as a one-line GET. On 8 September at 12:40 Maria's upload hit it
 * and the app told her "The CRM did not respond within 20 seconds", which
 * reads as the CRM being down. It was not: n8n called the same CRM
 * successfully every two minutes either side of her attempt.
 *
 * The fix: a file transfer (an Attachment call, a download, or any body over
 * LARGE_BODY_BYTES) gets TRANSFER_TIMEOUT_MS instead, and a transfer timeout
 * is worded as a slow transfer rather than a dead CRM - all the way through to
 * the sentence staffFacingMessage() puts on the screen.
 *
 * Everything here runs the REAL shipped files under `vm`: espoClient.js with a
 * stubbed fetch and a stubbed AbortSignal that records the milliseconds asked
 * for, and the real staffFacingMessage() lifted out of main.js (which cannot
 * be required outside Electron). The pre-fix file is read out of git in the
 * same pass wherever git can reach it, so one run shows the old code choosing
 * 20000 and the new code choosing 120000 for the identical call - the standing
 * rule: prove the bug is present in the shipped code and absent in the fix, in
 * the same run.
 *
 * Recorded output of the full both-versions run at fix time (v0.2.42):
 *   before  POST Attachment -> 20000ms  "The CRM did not respond within 20 seconds."
 *   after   POST Attachment -> 120000ms "The file transfer did not finish within 120 seconds."
 *   after   GET Case        -> 20000ms  "The CRM did not respond within 20 seconds."
 *
 * Run with:  node test/transfer-timeout.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const SRC = path.join(APP_ROOT, 'src', 'main', 'espoClient.js');

// The commit that was live when the fault was reported (v0.2.41).
const BASELINE_COMMIT = 'b39c69f';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err && err.message}`); }
}

function makeSandbox(failureName) {
  const asked = [];
  const sandbox = {
    module: { exports: {} },
    console,
    URLSearchParams,
    AbortSignal: { timeout(ms) { asked.push(ms); return { __ms: ms }; } },
    async fetch() {
      const err = new Error(failureName === 'TimeoutError' ? 'timed out' : 'connect ECONNREFUSED');
      err.name = failureName;
      throw err;
    }
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.__asked = asked;
  vm.createContext(sandbox);
  return sandbox;
}

/**
 * Loads a version of espoClient.js and drives one call through it with a fetch
 * that always fails. Returns the milliseconds the code asked for and the real
 * error object the app would have thrown.
 */
async function probe(source, call, failureName = 'TimeoutError') {
  const sandbox = makeSandbox(failureName);
  vm.runInContext(source, sandbox, { filename: 'espoClient.js' });

  const { EspoClient } = sandbox.module.exports;
  const client = new EspoClient();
  // Skip the login round trip - the auth header is all request() needs.
  client._authHeader = 'Basic dGVzdA==';

  try {
    await call(client);
  } catch (err) {
    return {
      ms: sandbox.__asked[sandbox.__asked.length - 1],
      message: err && err.message,
      timedOut: !!(err && err.timedOut),
      transfer: !!(err && err.transfer),
      err
    };
  }
  throw new Error('the stubbed fetch should always have thrown');
}

/**
 * Pulls the real staffFacingMessage() out of main.js and returns it, running
 * in a context that already holds the real EspoAuthError class, so its
 * `instanceof` test means what it means in the app.
 */
function loadStaffFacingMessage(clientSource) {
  const mainSrc = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'main.js'), 'utf8');
  const marker = 'function staffFacingMessage(err, status) {';
  const start = mainSrc.indexOf(marker);
  if (start < 0) throw new Error('staffFacingMessage() not found in main.js');
  let depth = 0;
  let end = -1;
  for (let j = mainSrc.indexOf('{', start); j < mainSrc.length; j++) {
    if (mainSrc[j] === '{') depth++;
    else if (mainSrc[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('could not find the end of staffFacingMessage()');

  const sandbox = makeSandbox('TimeoutError');
  vm.runInContext(clientSource, sandbox, { filename: 'espoClient.js' });
  vm.runInContext(`${mainSrc.slice(start, end)}; module.exports.__staffFacingMessage = staffFacingMessage;`, sandbox, { filename: 'staffFacingMessage.js' });
  return sandbox.module.exports.__staffFacingMessage;
}

// A body big enough to be unmistakably a file, in the shape case-detail.js
// actually sends.
const bigUpload = {
  name: 'rates-bill.pdf',
  type: 'application/pdf',
  role: 'Attachment',
  relatedType: 'Document',
  field: 'file',
  file: `data:application/pdf;base64,${'A'.repeat(400 * 1024)}`
};

const uploadCall = (c) => c.request('Attachment', { method: 'POST', body: bigUpload });
const ordinaryCall = (c) => c.request('Case', { method: 'GET', query: { maxSize: 20 } });
const downloadCall = (c) => c.downloadFile('someattachmentid');

function baselineSource() {
  try {
    return execSync(`git show ${BASELINE_COMMIT}:src/main/espoClient.js`, {
      cwd: APP_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (_) {
    return null;
  }
}

(async () => {
  console.log('file-transfer timeout checks\n');

  const fixed = fs.readFileSync(SRC, 'utf8');
  const before = baselineSource();

  if (before) {
    const oldUpload = await probe(before, uploadCall);
    check('BEFORE: the shipped v0.2.41 code gave an upload only 20 seconds', () => {
      assert.strictEqual(oldUpload.ms, 20000, `expected 20000, got ${oldUpload.ms}`);
    });
    check('BEFORE: and blamed the CRM for it', () => {
      assert.match(oldUpload.message, /CRM did not respond within 20 seconds/);
    });
  } else {
    console.log(`  skip BEFORE half - commit ${BASELINE_COMMIT} is not in this clone (a shallow clone will not have it)`);
  }

  const newUpload = await probe(fixed, uploadCall);
  check('AFTER: an Attachment upload gets the transfer limit', () => {
    assert.strictEqual(newUpload.ms, 120000, `expected 120000, got ${newUpload.ms}`);
  });
  check('AFTER: and is described as a slow transfer, not a dead CRM', () => {
    assert.match(newUpload.message, /file transfer did not finish within 120 seconds/);
    assert.doesNotMatch(newUpload.message, /CRM did not respond/);
  });
  check('AFTER: the error carries the flags main.js branches on', () => {
    assert.strictEqual(newUpload.timedOut, true);
    assert.strictEqual(newUpload.transfer, true);
  });

  const newOrdinary = await probe(fixed, ordinaryCall);
  check('AFTER: an ordinary call still gets 20 seconds - the wedged-CRM guard is untouched', () => {
    assert.strictEqual(newOrdinary.ms, 20000, `expected 20000, got ${newOrdinary.ms}`);
    assert.match(newOrdinary.message, /CRM did not respond within 20 seconds/);
    assert.strictEqual(newOrdinary.transfer, false);
  });

  const newDownload = await probe(fixed, downloadCall);
  check('AFTER: a download is a transfer too', () => {
    assert.strictEqual(newDownload.ms, 120000, `expected 120000, got ${newDownload.ms}`);
    assert.strictEqual(newDownload.transfer, true);
  });

  // The half a staff member actually reads.
  const staffMessage = loadStaffFacingMessage(fixed);
  const unreachable = await probe(fixed, uploadCall, 'TypeError');

  check('AFTER: the staff member is told the transfer was slow, and what to do', () => {
    const msg = staffMessage(newUpload.err, 0);
    assert.match(msg, /file transfer did not finish/);
    assert.match(msg, /slow connection or a large file/);
    assert.doesNotMatch(msg, /Could not reach the CRM/);
  });

  check('AFTER: a genuinely unreachable CRM still says so', () => {
    assert.strictEqual(unreachable.timedOut, false);
    const msg = staffMessage(unreachable.err, 0);
    assert.match(msg, /Could not reach the CRM/);
  });

  check('AFTER: an ordinary timeout keeps the wording it had', () => {
    const msg = staffMessage(newOrdinary.err, 0);
    assert.match(msg, /Could not reach the CRM - check your connection/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
