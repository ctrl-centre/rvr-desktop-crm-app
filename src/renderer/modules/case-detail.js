'use strict';

(function () {
  // A local copy of the same escaping used everywhere else in this app
  // (app.js's escapeHtml, also handed in as ctx.escapeHtml to render()) —
  // needed here because renderCaseDetailsView/renderCaseDetailsEditForm are
  // pure template helpers that don't receive ctx.
  function esc(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  // EspoCRM wants a plain YYYY-MM-DD for its date-only fields.
  // 2026-08-28: this lived inside wireCaseDetailsPanel, but the document
  // upload in wireDocumentsPanel calls it too -- a sibling function, so it
  // could not see it. Every staff upload threw "todayIsoDate is not defined"
  // before anything was saved, which is the fault v0.2.26 was meant to fix.
  // Kept at module level so both callers share one definition.
  // 2026-08-29: today in BRITAIN. It used to take the date from whatever
  // timezone the machine was set to, so a document uploaded late in the
  // evening from a machine set to UTC got filed under the wrong day.
  function todayIsoDate() { return window.rvrTime.todayDateStr(); }

  // What EspoCRM's Document.file field will actually accept. Read live from
  // GET /api/v1/Metadata on 2026-08-28 (entityDefs.Document.fields.file.accept)
  // and it DOES include images: .jpg .jpeg .png .heic. An earlier note in this
  // file said it did not -- that was wrong, and it is why photos looked blocked.
  const ALLOWED_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'odt', 'ods', 'odp', 'rtf', 'csv', 'md', 'txt',
    'jpg', 'jpeg', 'png', 'heic'];

  // Real 12-stage pipeline + disputed flag, per EspoCRM_Case_Entity_Scope_DRAFT.md.
  const STAGE_ORDER = [
    'Enquiry Received', 'Onboarding', 'Bill & Document Review', 'Relief Assessment',
    'Evidence Gathering / Site Inspection', 'Site Inspection / Case Rejection',
  'Check', 'Challenge', 'Appeal',
    'Senior Sign-Off & Savings Confirmation', 'Invoiced', 'Payment / Arrears',
    'Closed', 'Closed Without Payment - Disputed'
  ];

  // Fallback only — the real options are fetched live from EspoCRM's own
  // Metadata at render time (see loadDocumentOptions), same principle as
  // loadReliefTypes below, so this list can never silently drift out of
  // sync with the CRM's actual cDocumentsReceived / Document.cCategory
  // enums (e.g. the Fee Agreement + Terms of Engagement merge, or a future
  // document type being added/renamed in the CRM only).
  const DOCUMENTS_RECEIVED_FALLBACK = [
    'Business Rates Bill', 'Lease / Tenancy Agreement', 'Letter of Authority (signed)',
    'Floor Plans', 'Property Photographs', 'Rental Evidence', 'Comparable Properties Evidence',
    'Market Reports', 'VOA / Council Correspondence', 'Council Relief Application Form',
    'Savings Confirmation', 'Questionnaire Form', 'Other', 'Fee Agreement & Terms of Engagement (signed)'
  ];

  const DOCUMENT_CATEGORY_FALLBACK = [
    'Business Rates Bill', 'Lease / Tenancy Agreement', 'Letter of Authority (signed)',
    'Floor Plans', 'Property Photographs', 'Rental Evidence', 'Comparable Properties Evidence',
    'Market Reports', 'VOA / Council Correspondence', 'Council Relief Application Form',
    'Savings Confirmation', 'Other', 'Fee Agreement & Terms of Engagement (signed)', 'Questionnaire Form'
  ];

  // Fetches the live option lists for both the "Documents received" checklist
  // (Case.cDocumentsReceived) and the upload-category dropdown
  // (Document.cCategory) from EspoCRM's Metadata API in one request, falling
  // back to the baked-in lists above only if that fetch fails (offline, etc).
  async function loadDocumentOptions() {
    try {
      const res = await window.rvr.espo.request('Metadata');
      if (res && res.ok && res.data && res.data.entityDefs) {
        const caseFields = res.data.entityDefs.Case && res.data.entityDefs.Case.fields;
        const docFields = res.data.entityDefs.Document && res.data.entityDefs.Document.fields;
        const received = caseFields && caseFields.cDocumentsReceived && caseFields.cDocumentsReceived.options;
        const category = docFields && docFields.cCategory && docFields.cCategory.options;
        return {
          received: Array.isArray(received) && received.length ? received : DOCUMENTS_RECEIVED_FALLBACK,
          category: Array.isArray(category) && category.length ? category : DOCUMENT_CATEGORY_FALLBACK
        };
      }
    } catch (err) { /* fall through to the baked-in lists */ }
    return { received: DOCUMENTS_RECEIVED_FALLBACK, category: DOCUMENT_CATEGORY_FALLBACK };
  }

  const SIGNOFF_STAGES = [
    { field: 'cSeniorSignOffCheck', label: 'Check' },
    { field: 'cSeniorSignOffChallenge', label: 'Challenge' },
    { field: 'cSeniorSignOffAppeal', label: 'Appeal' }
  ];
  const SIGNOFF_STATUSES = ['Not Requested', 'Requested', 'Approved'];

  // Fallback only, mirroring case-new.js's own note on this exact list: the
  // real options are fetched from Metadata at render time so an edit can
  // never drift out of sync with EspoCRM's actual cReliefType enum.
  const RELIEF_TYPES_FALLBACK = [
    'Small Business Rate Relief (SBRR)', 'Retail, Hospitality & Leisure Relief',
    'Empty Property Relief', 'Charitable Relief', 'Rural Rate Relief',
    'Improvement Relief', 'Heat Network Relief', 'Exemption', 'None'
  ];

  async function loadReliefTypes() {
    try {
      const res = await window.rvr.espo.request('Metadata');
      const opts = res && res.ok && res.data && res.data.entityDefs
        && res.data.entityDefs.Case && res.data.entityDefs.Case.fields
        && res.data.entityDefs.Case.fields.cReliefType
        && res.data.entityDefs.Case.fields.cReliefType.options;
      if (Array.isArray(opts) && opts.length) return opts;
    } catch (err) { /* fall through to the baked-in list */ }
    return RELIEF_TYPES_FALLBACK;
  }

  // The staff who can be assigned/reassigned a case — real caseworkers only
  // (EspoCRM User.type "regular"), not the admin/API/portal accounts that
  // also live in the Users table. Used to populate the "Assigned to"
  // dropdown on every case, per Tyrone's request that David be able to
  // reassign any case (unassigned or already assigned) to anyone else.
  // Falls back to an empty list on failure — the dropdown then degrades to
  // just showing whoever the case is already assigned to (see
  // wireAssignPanel), same "don't duplicate EspoCRM's own ACL" principle
  // used everywhere else in this app: if this staff member's role can't see
  // the Users list, they simply won't be offered a picker.
  async function loadAssignableUsers() {
    try {
      const res = await window.rvr.espo.request('User', {
        query: {
          'where[0][type]': 'equals',
          'where[0][attribute]': 'type',
          'where[0][value]': 'regular',
          // 'isTrue', NOT equals+true. `query` is serialised with
          // URLSearchParams, so a JS boolean becomes the STRING "true", and
          // EspoCRM's `equals` comparison against a real bool column then
          // matches nothing at all — a silent, total wipe of the result set
          // rather than an error. Proven live 2026-08-20 with a throwaway
          // account: equals+true -> total 0, isTrue -> total 7.
          'where[1][type]': 'isTrue',
          'where[1][attribute]': 'isActive',
          orderBy: 'name',
          maxSize: 200,
          select: 'id,name'
        }
      });
      if (res && res.ok && res.data && Array.isArray(res.data.list)) return res.data.list;
    } catch (err) { /* fall through */ }
    return [];
  }

  // Every document on a case — client-uploaded and staff-uploaded — shown in
  // one place, per Tyrone's request: "if they need to pull up someones file
  // they can accsess all the documents from the app that are for that file."
  // No new backend needed here: EspoCRM's own Document ACL (mirrored to each
  // role's Case scope) already governs what a given staff member can see,
  // same as every other screen in this app.
  function reviewPillClass(status) {
    if (status === 'Verified') return 'good';
    if (status === 'Rejected') return 'bad';
    return 'warn';
  }

  function sourceBadgeClass(source) {
    return source === 'Client Upload' ? 'client' : 'staff';
  }

  function uploaderLabel(d) {
    if (d.cSource === 'Client Upload') {
      return d.cUploadedByContactName || 'Client';
    }
    return d.createdByName || d.assignedUserName || 'Staff';
  }

  function renderDocumentsList(documents, ctx) {
    if (!documents.length) {
      return '<div class="empty-state">No documents uploaded on this case yet.</div>';
    }
    return documents.map((d) => {
      const pending = d.cReviewStatus === 'Pending Review';
      return `
        <div class="doc-row ${pending ? 'pending-highlight' : ''}" data-doc-id="${ctx.escapeHtml(d.id)}">
          <div class="doc-main">
            <div class="doc-cat">
              <span class="doc-source-badge ${sourceBadgeClass(d.cSource)}">${d.cSource === 'Client Upload' ? 'Client' : 'Staff'}</span>
              ${ctx.escapeHtml(d.cCategory || d.name || 'Document')}
            </div>
            <div class="doc-meta">Uploaded by ${ctx.escapeHtml(uploaderLabel(d))} &middot; ${formatDateTime(d.createdAt)}</div>
          </div>
          <div class="doc-actions">
            <span class="pill ${reviewPillClass(d.cReviewStatus)}">${ctx.escapeHtml(d.cReviewStatus || 'Pending Review')}</span>
            <button class="btn btn-secondary btn-doc-download" data-doc-id="${ctx.escapeHtml(d.id)}" data-file-id="${ctx.escapeHtml(d.fileId || '')}" data-file-name="${ctx.escapeHtml(d.name || 'document')}">Download</button>
            ${pending ? `<button class="btn btn-ok btn-doc-verify" data-doc-id="${ctx.escapeHtml(d.id)}" data-category="${ctx.escapeHtml(d.cCategory || '')}">Verify</button>` : ''}
            ${pending ? `<button class="btn btn-danger btn-doc-reject" data-doc-id="${ctx.escapeHtml(d.id)}">Reject</button>` : ''}
            <button class="btn btn-danger btn-doc-delete" data-doc-id="${ctx.escapeHtml(d.id)}">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }

  async function wireDocumentsPanel(panel, caseId, ctx, categoryOptions, receivedOptions, documentsReceived, onDocumentsReceivedChanged) {
    // A running local copy of the Case's own cDocumentsReceived list, kept
    // in sync with what's actually been saved -- verifying a second document
    // in the same category should not fire a redundant PUT, and a failed
    // PUT should not be treated as if it had ticked.
    let receivedNow = Array.isArray(documentsReceived) ? documentsReceived.slice() : [];
    const listEl = panel.querySelector('#doc-list');
    const uploadBtn = panel.querySelector('#doc-upload-btn');
    const categorySelect = panel.querySelector('#doc-upload-category');
    const otherSpecifyWrap = panel.querySelector('#doc-upload-other-specify-wrap');
    const otherSpecifyInput = panel.querySelector('#doc-upload-other-specify');
    const fileInput = panel.querySelector('#doc-upload-file');
    const statusEl = panel.querySelector('#doc-upload-status');

    categorySelect.innerHTML = categoryOptions.map((d) => `<option value="${ctx.escapeHtml(d)}">${ctx.escapeHtml(d)}</option>`).join('');

    // "Other" needs a free-text "please specify" field, mirroring the same
    // Dynamic Logic condition set up on Document.cCategoryOtherSpecify in
    // EspoCRM (visible + required only when Category = Other).
    function syncOtherSpecifyVisibility() {
      const isOther = categorySelect.value === 'Other';
      otherSpecifyWrap.style.display = isOther ? '' : 'none';
      if (!isOther) otherSpecifyInput.value = '';
    }
    categorySelect.addEventListener('change', syncOtherSpecifyVisibility);
    syncOtherSpecifyVisibility();

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      statusEl.className = 'status-banner';
    }

    // 2026-08-28. Two faults fixed in one place:
    //   B8 - only the Verify path ticked the checklist, so staff uploads
    //        (which arrive already verified) never did.
    //   B9 - the tick wrote back the WHOLE list from a page-load snapshot,
    //        so a colleague's tick made in the meantime was silently wiped.
    //        Last save won, on the field that gates case progress.
    // The current value is now re-read immediately before writing, and only
    // the one new item is added to whatever is actually there.
    async function tickDocumentsReceived(category) {
      if (!category) return;
      if (!Array.isArray(receivedOptions) || !receivedOptions.includes(category)) return;

      const freshRes = await window.rvr.espo.request(`Case/${caseId}`, { query: { select: 'cDocumentsReceived' } });
      if (!freshRes.ok) {
        showStatus('Saved, but the Documents Received checklist could not be updated - it can be ticked in the CRM.', 'err');
        return;
      }
      const live = Array.isArray(freshRes.data && freshRes.data.cDocumentsReceived)
        ? freshRes.data.cDocumentsReceived
        : [];
      if (live.includes(category)) {
        receivedNow = live;
        if (typeof onDocumentsReceivedChanged === 'function') onDocumentsReceivedChanged(receivedNow);
        return;
      }
      const nextReceived = live.concat([category]);
      const caseRes = await window.rvr.espo.request(`Case/${caseId}`, { method: 'PUT', body: { cDocumentsReceived: nextReceived } });
      if (!caseRes.ok) {
        showStatus('Saved, but the Documents Received checklist could not be updated - it can be ticked in the CRM.', 'err');
        return;
      }
      receivedNow = nextReceived;
      if (typeof onDocumentsReceivedChanged === 'function') onDocumentsReceivedChanged(receivedNow);
    }

    async function loadDocuments() {
      listEl.innerHTML = '<div class="loading-state">Loading documents…</div>';
      const res = await window.rvr.espo.request('Document', {
        query: {
          'where[0][type]': 'equals',
          'where[0][attribute]': 'cCaseId',
          'where[0][value]': caseId,
          orderBy: 'createdAt',
          order: 'desc',
          maxSize: 100
        }
      });
      if (!res.ok) {
        listEl.innerHTML = `<div class="empty-state">Could not load documents (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        return;
      }
      const documents = (res.data && res.data.list) || [];
      listEl.innerHTML = renderDocumentsList(documents, ctx);
      wireRowActions();
    }

    function wireRowActions() {
      listEl.querySelectorAll('.btn-doc-download').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const fileId = btn.dataset.fileId;
          const fileName = btn.dataset.fileName;
          if (!fileId) { showStatus('This document has no file attached.', 'err'); return; }
          btn.disabled = true;
          const res = await window.rvr.espo.downloadFile(fileId, fileName);
          btn.disabled = false;
          if (res.ok) {
            showStatus(`Saved to ${res.path}`, 'ok');
          } else if (!res.canceled) {
            showStatus(res.message || 'Could not download that file.', 'err');
          }
        });
      });

      listEl.querySelectorAll('.btn-doc-verify').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const category = btn.dataset.category;
          const res = await window.rvr.espo.request(`Document/${btn.dataset.docId}`, { method: 'PUT', body: { cReviewStatus: 'Verified' } });
          if (!res.ok) { showStatus(res.message || 'Could not verify this document.', 'err'); btn.disabled = false; return; }

          showStatus('Document verified.', 'ok');
          loadDocuments();

          // Verifying a document is the real-world signal that its matching
          // "Documents Received" checklist item is now actually in hand --
          // previously nothing on this page reflected that, so the checklist
          // (which is also what gates moving a case past "Evidence Gathering
          // / Site Inspection") silently drifted out of sync with what staff
          // had genuinely verified, unless someone remembered to go tick it
          // separately. If this document's category matches one of the
          // case's own Documents Received options and isn't already ticked,
          // tick it here, in the same action -- no separate manual step.
          await tickDocumentsReceived(category);
        });
      });

      listEl.querySelectorAll('.btn-doc-reject').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const res = await window.rvr.espo.request(`Document/${btn.dataset.docId}`, { method: 'PUT', body: { cReviewStatus: 'Rejected' } });
          if (res.ok) { showStatus('Document rejected.', 'ok'); loadDocuments(); }
          else { showStatus(res.message || 'Could not reject this document.', 'err'); btn.disabled = false; }
        });
      });

      listEl.querySelectorAll('.btn-doc-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!window.confirm('Delete this document? This can be undone by an admin if needed.')) return;
          btn.disabled = true;
          const res = await window.rvr.espo.request(`Document/${btn.dataset.docId}`, { method: 'DELETE' });
          if (res.ok) { showStatus('Document deleted.', 'ok'); loadDocuments(); }
          else { showStatus(res.message || 'Could not delete this document — you may not have permission.', 'err'); btn.disabled = false; }
        });
      });
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          const comma = result.indexOf(',');
          resolve(comma > -1 ? result.slice(comma + 1) : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    uploadBtn.addEventListener('click', async () => {
      clearStatus();
      const file = fileInput.files && fileInput.files[0];
      if (!file) { showStatus('Choose a file to upload.', 'err'); return; }

      // 2026-08-28: there was no size check and no type check here at all.
      // Two separate problems that both showed up as an unexplained error:
      //   1. The file is sent base64-encoded inside the request body, and
      //      every CRM call is now abandoned after 20 seconds, so a big scan
      //      failed with 'The CRM did not respond within 20 seconds' -- which
      //      reads as the CRM being down rather than the file being too big.
      //   2. EspoCRM's Document.file field has its own allowed-type list and
      //      refuses anything else with a bare 403. Photos ARE on that list
      //      (.jpg .jpeg .png .heic), confirmed live on 2026-08-28. Say what
      //      is wrong plainly instead of letting the CRM answer with a 403
      //      nobody can read.
      // ALLOWED_EXTENSIONS must stay in step with the CRM's own list
      // (Administration > Entity Manager > Document > file). If that list is
      // changed, change ALLOWED_EXTENSIONS to match, or this screen will block
      // what the CRM would now accept -- which is exactly what happened with
      // photos before v0.2.28.
      const MAX_UPLOAD_MB = 10;
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        showStatus(`That file is ${(file.size / 1024 / 1024).toFixed(1)}MB and the limit is ${MAX_UPLOAD_MB}MB. Scan it at a lower quality, or split it into two documents.`, 'err');
        return;
      }
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ALLOWED_EXTENSIONS.indexOf(ext) === -1) {
        showStatus(`The CRM does not accept .${ext} files. It takes ${ALLOWED_EXTENSIONS.join(', ')}.`, 'err');
        return;
      }
      const otherSpecify = otherSpecifyInput.value.trim();
      if (categorySelect.value === 'Other' && !otherSpecify) {
        showStatus('Please specify the document type in the box below "Other".', 'err');
        return;
      }
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Uploading…';
      try {
        const fileBase64 = await fileToBase64(file);
        const mimeType = file.type || 'application/octet-stream';
        // 2026-09-08: this call used to share the app-wide 20-second request
        // budget with every small JSON call. The body here is the file
        // itself, base64-encoded (up to ~13.3MB for the 10MB cap above), and
        // on a slow connection that legitimately takes longer than 20s to
        // upload -- which showed up as "The CRM did not respond within 20
        // seconds" and read as the CRM being down. Give uploads their own,
        // longer budget instead (see espoClient.js's FILE_TRANSFER_TIMEOUT_MS).
        const attachRes = await window.rvr.espo.request('Attachment', {
          method: 'POST',
          body: { name: file.name, type: mimeType, role: 'Attachment', relatedType: 'Document', field: 'file', file: `data:${mimeType};base64,${fileBase64}` },
          timeoutMs: 120000
        });
        if (!attachRes.ok) { showStatus(attachRes.message || 'Could not upload the file.', 'err'); return; }

        // 2026-08-28: this body was missing two required things, stacked, so
        // fixing either one alone just moves the error.
        //   1. `publishDate` is required on Document and EspoCRM refuses the
        //      create without it (400). The portal proxy learned this on
        //      2026-08-16; this path never did. Six failed uploads in the
        //      server log on 2026-08-27 between 23:19 and 23:26.
        //   2. No owner. Since assignmentPermission went to `team` on
        //      2026-08-20, EspoCRM refuses any record carrying neither an
        //      assigned user nor a team (403 "Assignment failure"), and the
        //      team stamping formula runs too late to save it.
        const docBody = {
          name: file.name,
          fileId: attachRes.data.id,
          cCategory: categorySelect.value,
          cSource: 'Staff Upload',
          cReviewStatus: 'Verified',
          cCaseId: caseId,
          publishDate: todayIsoDate()
        };
        if (ctx.user && ctx.user.id) docBody.assignedUserId = ctx.user.id;
        if (categorySelect.value === 'Other') docBody.cCategoryOtherSpecify = otherSpecify;

        const docRes = await window.rvr.espo.request('Document', {
          method: 'POST',
          body: docBody
        });
        if (!docRes.ok) { showStatus(docRes.message || 'Could not save the document.', 'err'); return; }

        // 2026-08-28: a staff upload is created already Verified, so the
        // Verify button never appears for it and the auto-tick above never
        // fired. Upload the rates bill yourself and the checklist stayed
        // empty, which keeps the case blocked from moving past Evidence
        // Gathering with nothing on screen explaining why. Tick it here too.
        await tickDocumentsReceived(categorySelect.value);

        showStatus('Document uploaded.', 'ok');
        fileInput.value = '';
        otherSpecifyInput.value = '';
        syncOtherSpecifyVisibility();
        await loadDocuments();
      } catch (e) {
        showStatus('Could not upload the file.', 'err');
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload';
      }
    });

    await loadDocuments();
  }

  // ---------------------------------------------------------------------------
  // Case details — view/edit toggle.
  //
  // Permission is NOT decided here, same principle as case-new.js: the Save
  // button just PATCHes /Case/{id} as the logged-in user, and a 403 comes back
  // with a plain-English message rather than the app trying to duplicate
  // EspoCRM's own role/team ACL logic (own vs team edit rights differ by
  // role — Caseworker is "own" only, Surveyor/Admin are "team" — see
  // infrastructure-status.md's role-scope table). The Edit button is always
  // shown; EspoCRM's own ACL is the single source of truth for whether a
  // save actually succeeds.
  // ---------------------------------------------------------------------------
  function renderCaseDetailsView(c) {
    return `
      <div class="detail-grid">
        <div><label>Contact</label><div>${esc(c.contactName || '—')}</div></div>
        <div><label>Company</label><div>${esc(c.accountName || '—')}</div></div>
        <div><label>Property address</label><div>${esc(formatAddress(c))}</div></div>
        <div><label>Relief type</label><div>${esc(c.cReliefType || '—')}</div></div>
        <div><label>Rateable value (before)</label><div>${formatCurrency(c.cRateableValueBefore)}</div></div>
        <div><label>Rateable value (after)</label><div>${formatCurrency(c.cRateableValueAfter)}</div></div>
        <div><label>Annual saving</label><div style="color:var(--ok); font-weight:600;">${formatCurrency(c.cAnnualSaving)}</div></div>
        <div><label>Created</label><div>${formatDate(c.createdAt)}</div></div>
      </div>
    `;
  }

  // Only relevant when cCaseStage = 'Closed Without Payment - Disputed' -- matches
  // the cDisputeReason field's options in EspoCRM exactly (Field Manager, added
  // 2026-08-17). Tick-all-that-apply; the automated client email composes a
  // paragraph per reason selected. Required server-side (Dynamic Logic +
  // beforeSaveCustomScript both enforce this) whenever the case moves to that
  // stage, whether via this app's own PATCH or EspoCRM's own web UI.
  const DISPUTE_REASON_OPTIONS = [
  'Client disputes the outcome', 'VOA/council dispute unresolved', 'Internal/fee dispute'
  ];

  async function renderCaseDetailsEditForm(c, reliefOptions, linkedContact, linkedAccount) {
  const currentDisputeReasons = Array.isArray(c.cDisputeReason) ? c.cDisputeReason : [];
  const disputeReasonHidden = c.cCaseStage !== 'Closed Without Payment - Disputed';
    return `
      <div class="form-grid">
        <div class="field">
          <label for="edit-contact-search">Find existing contact</label>
          <input type="text" id="edit-contact-search" placeholder="Type a name, email or phone number…" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-contact-select">Contact</label>
          <select id="edit-contact-select"><option value="">Loading contacts…</option></select>
          <span class="field-hint">Pick an existing contact, or leave as “— No contact linked —” and fill in the fields below to add a new one.</span>
        </div>
        <div class="field">
          <label for="edit-contact-name">Contact name</label>
          <input type="text" id="edit-contact-name" value="${esc(linkedContact ? `${linkedContact.firstName || ''} ${linkedContact.lastName || ''}`.trim() : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-contact-phone">Contact phone</label>
          <input type="text" id="edit-contact-phone" value="${esc(linkedContact ? (linkedContact.phoneNumber || '') : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-contact-email">Contact email</label>
          <input type="email" id="edit-contact-email" value="${esc(linkedContact ? (linkedContact.emailAddress || '') : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-company-name">Company name</label>${linkedAccount ? ' <button type="button" id="edit-company-remove" style="background:none;border:none;padding:0;margin-left:8px;color:#2563eb;text-decoration:underline;cursor:pointer;font-size:0.85em;">Remove company</button>' : ''}
          <input type="text" id="edit-company-name" value="${esc(linkedAccount ? (linkedAccount.name || '') : '')}" autocomplete="off">
          <span class="field-hint" id="edit-company-hint">Leave blank for no company. Enter a name to link an existing company of that name or create a new one.</span>
        </div>
        <div class="field">
          <label for="edit-company-phone">Company phone</label>
          <input type="text" id="edit-company-phone" value="${esc(linkedAccount ? (linkedAccount.phoneNumber || '') : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-company-email">Company email</label>
          <input type="email" id="edit-company-email" value="${esc(linkedAccount ? (linkedAccount.emailAddress || '') : '')}" autocomplete="off">
        </div>
        <div class="field">
          <label for="edit-stage">Case stage</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <select id="edit-stage" style="flex:1;">
              ${STAGE_ORDER.map((s) => `<option value="${esc(s)}" ${c.cCaseStage === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-primary" id="edit-stage-move-btn">Move case</button>
          </div>
          <span class="field-hint">The stage moves on its <strong>own button</strong>, not with Save -- so fixing an address can never move a case by accident. Moving a case on may be guarded by EspoCRM's own rules (Documents Received, Director-only stages); any block comes back as a message below.</span>
        </div>
        <div class="field" id="edit-dispute-reason-field" style="${disputeReasonHidden ? 'display:none;' : ''}">
          <label>Dispute reason(s) <span class="req">*</span></label>
            ${DISPUTE_REASON_OPTIONS.map((r) => `<label style="display:flex; align-items:center; gap:6px; font-weight:400; margin:4px 0;"><input type="checkbox" class="edit-dispute-reason-cb" value="${esc(r)}" ${currentDisputeReasons.includes(r) ? 'checked' : ''}> ${esc(r)}</label>`).join('')}
          <span class="field-hint">Tick all that apply -- the client email adapts to match. Required to close a case this way.</span>
        </div>
        <div class="field">
          <label for="edit-relief">Relief type</label>
          <select id="edit-relief">
            <option value="">Not decided yet</option>
            ${reliefOptions.map((r) => `<option value="${esc(r)}" ${c.cReliefType === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="edit-rv-before">Rateable value (before)</label>
          <input type="number" id="edit-rv-before" min="0" step="1" value="${c.cRateableValueBefore != null ? c.cRateableValueBefore : ''}">
        </div>
        <div class="field">
          <label for="edit-rv-after">Rateable value (after)</label>
          <input type="number" id="edit-rv-after" min="0" step="1" value="${c.cRateableValueAfter != null ? c.cRateableValueAfter : ''}">
        </div>
        <div class="field">
          <label for="edit-street">Street</label>
          <input type="text" id="edit-street" value="${esc(c.cPropertyAddressStreet || '')}">
        </div>
        <div class="field">
          <label for="edit-city">Town / city</label>
          <input type="text" id="edit-city" value="${esc(c.cPropertyAddressCity || '')}">
        </div>
        <div class="field">
          <label for="edit-state">County</label>
          <input type="text" id="edit-state" value="${esc(c.cPropertyAddressState || '')}">
        </div>
        <div class="field">
          <label for="edit-postcode">Postcode</label>
          <input type="text" id="edit-postcode" value="${esc(c.cPropertyAddressPostalCode || '')}">
        </div>
      </div>
      <div class="form-actions" style="margin-bottom:0;">
        <button class="btn btn-secondary" id="edit-cancel-btn">Cancel</button>
        <button class="btn btn-primary" id="edit-save-btn">Save</button>
      </div>
    `;
  }

  async function wireCaseDetailsPanel(panel, initialCase, caseId, ctx, onStageChanged) {
    let current = initialCase;
    const bodyEl = panel.querySelector('#details-body');
    const editBtn = panel.querySelector('#details-edit-btn');
    const statusEl = panel.querySelector('#details-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      statusEl.className = 'status-banner';
    }

    function paintView() {
      editBtn.style.display = '';
      editBtn.textContent = 'Edit';
      bodyEl.innerHTML = renderCaseDetailsView(current);
    }

    // 2026-08-28: `"Madonna".split(' ')` never reaches pop(), so the old
    // inline version put the whole name in BOTH firstName and lastName and
    // the contact read "Madonna Madonna" everywhere - the CRM, the portal,
    // and any email that merges a client's name in. Not rare: a company name
    // typed into the contact box does it too.
    function splitPersonName(full) {
      const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { firstName: '', lastName: '' };
      if (parts.length === 1) return { firstName: '', lastName: parts[0] };
      const lastName = parts.pop();
      return { firstName: parts.join(' '), lastName };
    }


    async function paintEdit() {
      editBtn.style.display = 'none';
      clearStatus();
      bodyEl.innerHTML = '<div class="loading-state">Loading…</div>';
      const reliefOptions = await loadReliefTypes();
      if (ctx.isStale()) return;

      const originalContactId = current.contactId || '';
      const originalAccountId = current.accountId || '';
      const linkedContactRes = originalContactId
        ? await window.rvr.espo.request(`Contact/${originalContactId}`)
        : null;
      if (ctx.isStale()) return;
      // 2026-08-28: a FAILED read used to collapse to `null`, which is
      // indistinguishable from "this case has no contact". The edit form then
      // painted empty contact boxes, the picker fell back to "- No contact
      // linked -", and saving sent contactId: null - quietly detaching the
      // client from the case behind a green "Saved.". Fail closed: if we
      // could not read who the client is, nobody gets to edit the case.
      if (linkedContactRes && !linkedContactRes.ok) {
        paintView();
        showStatus(
          "Could not load the client on this case, so it isn't safe to edit right now. Nothing has been changed. Please try again in a moment.",
          'err'
        );
        return;
      }
      const linkedContact = linkedContactRes && linkedContactRes.ok ? linkedContactRes.data : null;
      const linkedAccountRes = originalAccountId
        ? await window.rvr.espo.request(`Account/${originalAccountId}`)
        : null;
      if (ctx.isStale()) return;
      // Same reasoning as the contact above. Here the silent version was
      // milder but just as dishonest: the company boxes rendered blank, staff
      // retyped the company name, and every company change was discarded
      // while the screen still said "Saved.".
      if (linkedAccountRes && !linkedAccountRes.ok) {
        paintView();
        showStatus(
          "Could not load the company on this case, so it isn't safe to edit right now. Nothing has been changed. Please try again in a moment.",
          'err'
        );
        return;
      }
      const linkedAccount = linkedAccountRes && linkedAccountRes.ok ? linkedAccountRes.data : null;

      bodyEl.innerHTML = await renderCaseDetailsEditForm(current, reliefOptions, linkedContact, linkedAccount);

      // --- Contact search / select -------------------------------------------
      // Same UX as case-new.js's contact typeahead: a debounced free-text
      // search box drives a <select> of matches. Selecting a different
      // existing contact just repoints the Case's contactId at save time --
      // it never edits that contact's own record. Editing the fields below
      // while the *currently linked* contact stays selected instead PUTs
      // those changes onto that Contact. Selecting "-- No contact linked --"
      // and typing a name creates a brand-new Contact, mirroring case-new.js's
      // create-or-find logic.
      const contactSearchInput = bodyEl.querySelector('#edit-contact-search');
      const contactSelectEl = bodyEl.querySelector('#edit-contact-select');
      const contactNameEl = bodyEl.querySelector('#edit-contact-name');
      const contactPhoneEl = bodyEl.querySelector('#edit-contact-phone');
      const contactEmailEl = bodyEl.querySelector('#edit-contact-email');
      const companyNameEl = bodyEl.querySelector('#edit-company-name');
      const companyPhoneEl = bodyEl.querySelector('#edit-company-phone');
      const companyEmailEl = bodyEl.querySelector('#edit-company-email');
      const companyRemoveBtn = bodyEl.querySelector('#edit-company-remove');
      const companyHintEl = bodyEl.querySelector('#edit-company-hint');
      const companyOriginalValues = {
        name: companyNameEl.value,
        phone: companyPhoneEl.value,
        email: companyEmailEl.value
      };
      const companyRemovedHintText = 'Company removed — Save to confirm.';
      const companyDefaultHintText = 'Leave blank for no company. Enter a name to link an existing company of that name or create a new one.';
      let companyRemoved = false;

      function setCompanyRemoved(removed) {
        companyRemoved = removed;
        if (companyRemoveBtn) companyRemoveBtn.textContent = removed ? 'Undo remove' : 'Remove company';
        if (companyHintEl) companyHintEl.textContent = removed ? companyRemovedHintText : companyDefaultHintText;
      }

      if (companyRemoveBtn) {
        companyRemoveBtn.addEventListener('click', () => {
          if (companyRemoved) {
            companyNameEl.value = companyOriginalValues.name;
            companyPhoneEl.value = companyOriginalValues.phone;
            companyEmailEl.value = companyOriginalValues.email;
            setCompanyRemoved(false);
          } else {
            companyNameEl.value = '';
            companyPhoneEl.value = '';
            companyEmailEl.value = '';
            setCompanyRemoved(true);
          }
        });
      }

      [companyNameEl, companyPhoneEl, companyEmailEl].forEach((el) => {
        el.addEventListener('input', () => {
          if (companyRemoved) setCompanyRemoved(false);
        });
      });

      function contactLabel(rec) {
        const name = `${rec.firstName || ''} ${rec.lastName || ''}`.trim() || rec.name || '(no name)';
        return rec.emailAddress ? `${name} — ${rec.emailAddress}` : name;
      }

      async function searchContactsForEdit(term) {
        const query = {
          select: 'firstName,lastName,name,emailAddress,phoneNumber',
          maxSize: 50,
          orderBy: 'createdAt',
          order: 'desc'
        };
        if (term) {
          query['where[0][type]'] = 'textFilter';
          query['where[0][value]'] = term;
          query.orderBy = 'name';
          query.order = 'asc';
        }
        const res = await window.rvr.espo.request('Contact', { query });
        if (!res.ok) return { ok: false, message: res.message };
        return { ok: true, list: (res.data && res.data.list) || [] };
      }

      let contactsById = {};
      if (originalContactId && linkedContact) {
        contactsById[originalContactId] = Object.assign({ id: originalContactId }, linkedContact);
      }

      function fillContactSelect(result, preselectId) {
        if (!result.ok) {
          contactSelectEl.innerHTML = '<option value="">Could not load contacts</option>';
          return;
        }
        result.list.forEach((rec) => { contactsById[rec.id] = rec; });
        const options = result.list.slice();
        if (preselectId && contactsById[preselectId] && !options.some((rec) => rec.id === preselectId)) {
          options.unshift(contactsById[preselectId]);
        }
        contactSelectEl.innerHTML =
          '<option value="">— No contact linked —</option>' +
          options.map((rec) => `<option value="${esc(rec.id)}" ${rec.id === preselectId ? 'selected' : ''}>${esc(contactLabel(rec))}</option>`).join('');
      }

      function applyContactFields(id) {
        if (id && contactsById[id]) {
          const rec = contactsById[id];
          contactNameEl.value = `${rec.firstName || ''} ${rec.lastName || ''}`.trim();
          contactPhoneEl.value = rec.phoneNumber || '';
          contactEmailEl.value = rec.emailAddress || '';
        } else if (!id) {
          contactNameEl.value = '';
          contactPhoneEl.value = '';
          contactEmailEl.value = '';
        }
      }

      fillContactSelect(await searchContactsForEdit(''), originalContactId);
      if (ctx.isStale()) return;

      contactSelectEl.addEventListener('change', () => {
        applyContactFields(contactSelectEl.value);
      });

      let contactSearchTimer = null;
      let contactSearchSeq = 0;
      contactSearchInput.addEventListener('input', () => {
        clearTimeout(contactSearchTimer);
        contactSearchTimer = setTimeout(async () => {
          const mySeq = ++contactSearchSeq;
          const prevValue = contactSelectEl.value;
          contactSelectEl.innerHTML = '<option value="">Searching…</option>';
          const result = await searchContactsForEdit(contactSearchInput.value.trim());
          if (mySeq !== contactSearchSeq || ctx.isStale()) return;
          fillContactSelect(result, prevValue);
        }, 300);
      });

      const stageSelect = bodyEl.querySelector('#edit-stage');
      const disputeReasonField = bodyEl.querySelector('#edit-dispute-reason-field');
      function syncDisputeReasonVisibility() {
        disputeReasonField.style.display = stageSelect.value === 'Closed Without Payment - Disputed' ? '' : 'none';
      }
      stageSelect.addEventListener('change', syncDisputeReasonVisibility);

      // 2026-09-01: the stage now moves on its own button rather than riding
      // along with Save. It writes ONLY cCaseStage (and the dispute reasons
      // when they apply), so a half-finished edit elsewhere on the form
      // cannot be dragged along with it, and a stage change cannot happen by
      // accident while correcting something else.
      const moveStageBtn = bodyEl.querySelector('#edit-stage-move-btn');
      moveStageBtn.addEventListener('click', async () => {
        const stageVal = stageSelect.value;
        if (stageVal === current.cCaseStage) {
          showStatus(`This case is already at "${stageVal}" — pick a different stage to move it.`, 'err');
          return;
        }

        const disputeReasonsChecked = Array.from(bodyEl.querySelectorAll('.edit-dispute-reason-cb:checked')).map((cb) => cb.value);
        if (stageVal === 'Closed Without Payment - Disputed' && disputeReasonsChecked.length === 0) {
          showStatus('Select at least one dispute reason before closing a case this way.', 'err');
          return;
        }

        const stageBody = { cCaseStage: stageVal };
        if (stageVal === 'Closed Without Payment - Disputed') stageBody.cDisputeReason = disputeReasonsChecked;

        moveStageBtn.disabled = true;
        moveStageBtn.textContent = 'Moving…';
        showStatus(`Moving this case to "${stageVal}"…`, 'info');

        const res = await window.rvr.espo.request(`Case/${caseId}`, { method: 'PUT', body: stageBody });
        if (ctx.isStale()) return;
        moveStageBtn.disabled = false;
        moveStageBtn.textContent = 'Move case';

        if (!res.ok) {
          // A guardrail refusal comes back from EspoCRM as a 400 with a real
          // sentence in it - "Cannot move this case past Evidence Gathering /
          // Site Inspection: Floor Plans has not been checked in Documents
          // Received." That wording is written for staff and is far more use
          // than anything this screen could invent, so it is shown as-is.
          if (res.status === 403) {
            showStatus("You don't have permission to move this case on. It may not be assigned to you, or this stage may be Director-only.", 'err');
          } else {
            showStatus(res.message || 'Could not move this case on. Please try again.', 'err');
          }
          // Put the dropdown back to where the case actually is, so the screen
          // never shows a stage the case is not at.
          stageSelect.value = current.cCaseStage;
          syncDisputeReasonVisibility();
          return;
        }

        current = Object.assign({}, current, res.data || stageBody);
        showStatus(`Moved to "${stageVal}".`, 'ok');
        if (typeof onStageChanged === 'function') onStageChanged(current);
      });

      bodyEl.querySelector('#edit-cancel-btn').addEventListener('click', () => {
        editBtn.style.display = '';
        clearStatus();
        paintView();
      });

      bodyEl.querySelector('#edit-save-btn').addEventListener('click', async () => {
        const saveBtn = bodyEl.querySelector('#edit-save-btn');
        const rvBeforeRaw = bodyEl.querySelector('#edit-rv-before').value.trim();
        const rvAfterRaw = bodyEl.querySelector('#edit-rv-after').value.trim();
        if ((rvBeforeRaw && Number.isNaN(Number(rvBeforeRaw))) || (rvAfterRaw && Number.isNaN(Number(rvAfterRaw)))) {
          showStatus('Rateable values must be numbers.', 'err');
          return;
        }

        // 2026-09-01: cCaseStage and cDisputeReason are deliberately NOT in
        // this body any more. The stage has its own "Move case" button (see
        // the wiring below). Reported by Tyrone as "case moves on on the edit
        // field... maybe we should make it so there's a button?" - and he is
        // right: a stage change fires guardrails, notifies staff and emails
        // clients, so it should never be a side effect of correcting a
        // postcode. Save now saves details; Move case moves the case.
        const body = {
          cReliefType: bodyEl.querySelector('#edit-relief').value || null,
          cPropertyAddressStreet: bodyEl.querySelector('#edit-street').value.trim(),
          cPropertyAddressCity: bodyEl.querySelector('#edit-city').value.trim(),
          cPropertyAddressState: bodyEl.querySelector('#edit-state').value.trim(),
          cPropertyAddressPostalCode: bodyEl.querySelector('#edit-postcode').value.trim()
        };
        // 2026-08-28: these two used to send a value only when one was
        // present, unlike every other field on this form. Emptying a figure
        // entered on the wrong case did nothing at all, while the screen said
        // "Saved." and then repainted showing the old number still there.
        // An empty box now clears the field, as the user plainly intended.
        body.cRateableValueBefore = rvBeforeRaw ? Number(rvBeforeRaw) : null;
        body.cRateableValueAfter = rvAfterRaw ? Number(rvAfterRaw) : null;

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        showStatus('Saving…', 'info');

        // Resolve the Contact/Company panel before touching the Case itself.
        // Mirrors case-new.js's create-or-find logic, plus two extra branches
        // for a Case that already has a link: editing the currently-linked
        // record in place, and switching to a different existing contact
        // without touching either contact's own fields.
        async function resolveContactAndAccount() {
          const selectedContactId = contactSelectEl.value;
          const contactNameVal = contactNameEl.value.trim();
          const contactPhoneVal = contactPhoneEl.value.trim();
          const contactEmailVal = contactEmailEl.value.trim();
          const companyNameVal = companyNameEl.value.trim();
          const companyPhoneVal = companyPhoneEl.value.trim();
          const companyEmailVal = companyEmailEl.value.trim();

          let resolvedAccountId = originalAccountId;

          if (companyRemoved) {
            resolvedAccountId = '';
          } else if (originalAccountId) {
            if (linkedAccount) {
              const accountBody = {};
              if (companyNameVal !== (linkedAccount.name || '')) accountBody.name = companyNameVal;
              if (companyPhoneVal !== (linkedAccount.phoneNumber || '')) accountBody.phoneNumber = companyPhoneVal;
              if (companyEmailVal !== (linkedAccount.emailAddress || '')) accountBody.emailAddress = companyEmailVal;
              if (Object.keys(accountBody).length) {
                const acctRes = await window.rvr.espo.request(`Account/${originalAccountId}`, { method: 'PUT', body: accountBody });
                if (ctx.isStale()) return { ok: false, stale: true };
                if (!acctRes.ok) return { ok: false, message: acctRes.message || 'Could not update the company record.' };
              }
            }
          } else if (companyNameVal) {
            const existingAccountRes = await window.rvr.espo.request('Account', {
              query: {
                'where[0][type]': 'equals',
                'where[0][attribute]': 'name',
                'where[0][value]': companyNameVal,
                select: 'id,name',
                maxSize: 1
              }
            });
            if (ctx.isStale()) return { ok: false, stale: true };
            if (existingAccountRes.ok && existingAccountRes.data && existingAccountRes.data.list && existingAccountRes.data.list.length) {
              resolvedAccountId = existingAccountRes.data.list[0].id;
            } else {
              // Must carry an assigned user — see the note in case-new.js.
              const accountBody = { name: companyNameVal };
              if (ctx.user && ctx.user.id) accountBody.assignedUserId = ctx.user.id;
              if (companyPhoneVal) accountBody.phoneNumber = companyPhoneVal;
              if (companyEmailVal) accountBody.emailAddress = companyEmailVal;
              const createAccountRes = await window.rvr.espo.request('Account', { method: 'POST', body: accountBody });
              if (ctx.isStale()) return { ok: false, stale: true };
              if (!createAccountRes.ok) return { ok: false, message: createAccountRes.message || 'Could not create the new company record.' };
              resolvedAccountId = createAccountRes.data && createAccountRes.data.id;
            }
          }

          let resolvedContactId = originalContactId;

          if (selectedContactId && selectedContactId === originalContactId) {
            if (linkedContact) {
              const { firstName, lastName } = splitPersonName(contactNameVal);
              const origName = `${linkedContact.firstName || ''} ${linkedContact.lastName || ''}`.trim();
              const contactBody = {};
              if (contactNameVal !== origName) {
                contactBody.lastName = lastName || linkedContact.lastName || '';
                contactBody.firstName = firstName;
              }
              if (contactPhoneVal !== (linkedContact.phoneNumber || '')) contactBody.phoneNumber = contactPhoneVal;
              if (contactEmailVal !== (linkedContact.emailAddress || '')) contactBody.emailAddress = contactEmailVal;
              if (Object.keys(contactBody).length) {
                const contactRes = await window.rvr.espo.request(`Contact/${originalContactId}`, { method: 'PUT', body: contactBody });
                if (ctx.isStale()) return { ok: false, stale: true };
                if (!contactRes.ok) return { ok: false, message: contactRes.message || 'Could not update the contact record.' };
              }
            }
            resolvedContactId = selectedContactId;
          } else if (selectedContactId && selectedContactId !== originalContactId) {
            resolvedContactId = selectedContactId;
          } else if (!selectedContactId && contactNameVal) {
            const { firstName, lastName } = splitPersonName(contactNameVal);
            const contactBody = { lastName };
            // Same reason as the Account create above.
            if (ctx.user && ctx.user.id) contactBody.assignedUserId = ctx.user.id;
            if (firstName) contactBody.firstName = firstName;
            if (contactPhoneVal) contactBody.phoneNumber = contactPhoneVal;
            if (contactEmailVal) contactBody.emailAddress = contactEmailVal;
            if (resolvedAccountId) contactBody.accountId = resolvedAccountId;
            const createContactRes = await window.rvr.espo.request('Contact', { method: 'POST', body: contactBody });
            if (ctx.isStale()) return { ok: false, stale: true };
            if (!createContactRes.ok) return { ok: false, message: createContactRes.message || 'Could not create the new contact record.' };
            resolvedContactId = createContactRes.data && createContactRes.data.id;
          } else {
            resolvedContactId = '';
          }

          return { ok: true, contactId: resolvedContactId, accountId: resolvedAccountId };
        }

        const resolved = await resolveContactAndAccount();
        if (resolved.stale) return;
        if (!resolved.ok) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
          showStatus(resolved.message || 'Could not save the linked contact/company.', 'err');
          return;
        }
        if (resolved.contactId !== originalContactId) body.contactId = resolved.contactId || null;
        if (resolved.accountId !== originalAccountId) body.accountId = resolved.accountId || null;

        const res = await window.rvr.espo.request(`Case/${caseId}`, { method: 'PUT', body });

        if (ctx.isStale()) return;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';

        if (!res.ok) {
          if (res.status === 403) {
            showStatus("You don't have permission to edit this case. It may not be assigned to you.", 'err');
          } else {
            showStatus(res.message || 'Could not save these changes. Please try again.', 'err');
          }
          return;
        }

        current = Object.assign({}, current, res.data || body);
        showStatus('Saved.', 'ok');
        paintView();
        // The page's own header badge and the big stage-track bar above this
        // panel are rendered once, from the Case record `render()` loaded
        // when the page first opened -- they don't automatically pick up
        // changes made in here. Without this, a stage change saves
        // correctly (confirmed via the Cases list) but LOOKS like nothing
        // happened, because the only two places a stage is visibly shown
        // on this page both go stale. Push the update up so what the user
        // is looking at matches what was actually just saved.
        if (typeof onStageChanged === 'function') onStageChanged(current);
      });
    }

    editBtn.addEventListener('click', paintEdit);
    paintView();
  }

  // ---------------------------------------------------------------------------
  // Assigned to — a standalone dropdown (not gated behind the Case details
  // Edit toggle above) so David/any staff member can reassign a case to
  // anyone else in one click, whether it's currently unassigned or already
  // held by a colleague. PATCHes assignedUserId directly on the Case, same
  // as every other in-place edit in this app; EspoCRM's own ACL is still the
  // real gatekeeper (a 403 here just means this role can't reassign).
  // ---------------------------------------------------------------------------
  async function wireAssignPanel(panel, initialCase, caseId, ctx) {
    let currentAssignedId = initialCase.assignedUserId || '';
    const selectEl = panel.querySelector('#assign-user-select');
    const statusEl = panel.querySelector('#assign-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      statusEl.className = 'status-banner';
    }

    selectEl.disabled = true;
    selectEl.innerHTML = '<option>Loading…</option>';

    const users = await loadAssignableUsers();
    if (ctx.isStale()) return;

    // If the case is currently assigned to someone who isn't in the fetched
    // (active, regular-staff) list — e.g. a deactivated account — keep them
    // selectable so this control never silently reassigns the case just by
    // rendering it.
    const options = users.slice();
    if (currentAssignedId && !options.some((u) => u.id === currentAssignedId)) {
      options.unshift({ id: currentAssignedId, name: initialCase.assignedUserName || 'Currently assigned user' });
    }

    selectEl.innerHTML = `
      <option value="">Unassigned</option>
      ${options.map((u) => `<option value="${ctx.escapeHtml(u.id)}" ${u.id === currentAssignedId ? 'selected' : ''}>${ctx.escapeHtml(u.name)}</option>`).join('')}
    `;
    selectEl.disabled = false;

    if (!users.length) {
      showStatus('Could not load the staff list — you may not have permission to view all users.', 'err');
    }

    selectEl.addEventListener('change', async () => {
      const newUserId = selectEl.value;
      clearStatus();
      selectEl.disabled = true;
      const res = await window.rvr.espo.request(`Case/${caseId}`, { method: 'PUT', body: { assignedUserId: newUserId || null } });
      if (ctx.isStale()) return;
      selectEl.disabled = false;

      if (!res.ok) {
        if (res.status === 403) {
          showStatus("You don't have permission to reassign this case.", 'err');
        } else {
          showStatus(res.message || 'Could not reassign this case. Please try again.', 'err');
        }
        selectEl.value = currentAssignedId;
        return;
      }

      currentAssignedId = newUserId;
      const selectedOption = options.find((u) => u.id === newUserId);
      showStatus(newUserId ? `Reassigned to ${selectedOption ? selectedOption.name : 'selected user'}.` : 'Case unassigned.', 'ok');
    });
  }

  // ---------------------------------------------------------------------------
  // Senior Sign-Off — Check/Challenge/Appeal each need a senior sign-off
  // before the case can move past that stage (enforced server-side by the
  // Case entity's Before-Save Formula script). Setting a row to "Requested"
  // triggers the EspoCRM webhook -> n8n automation that emails the senior
  // caseworkers; a senior/director then sets it to "Approved" to unblock the
  // case. Shown here so the status is visible without leaving the app, and
  // actionable by whoever's role/permissions allow it (EspoCRM ACL decides,
  // same principle as everywhere else — a 403 here is expected for staff who
  // shouldn't be able to grant their own sign-off).
  // ---------------------------------------------------------------------------
  function signOffPillClass(status) {
    if (status === 'Approved') return 'good';
    if (status === 'Requested') return 'warn';
    return 'neutral';
  }

  function renderSignOffRow(stage, c) {
    const value = c[stage.field] || 'Not Requested';
    return `
      <div class="signoff-row" data-stage-field="${stage.field}">
        <label>${esc(stage.label)} sign-off</label>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="pill ${signOffPillClass(value)}">${esc(value)}</span>
          <select class="signoff-select" data-stage-field="${stage.field}">
            ${SIGNOFF_STATUSES.map((s) => `<option value="${esc(s)}" ${s === value ? 'selected' : ''}>${esc(s)}</option>`).join('')}
          </select>
        </div>
      </div>
    `;
  }

  async function wireSignOffPanel(panel, initialCase, caseId, ctx) {
    const statusEl = panel.querySelector('#signoff-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }
    function clearStatus() {
      statusEl.className = 'status-banner';
    }

    panel.querySelectorAll('.signoff-select').forEach((selectEl) => {
      const field = selectEl.dataset.stageField;
      const rowEl = panel.querySelector(`.signoff-row[data-stage-field="${field}"]`);
      const pillEl = rowEl.querySelector('.pill');
      let previousValue = selectEl.value;

      selectEl.addEventListener('change', async () => {
        const newValue = selectEl.value;
        clearStatus();
        selectEl.disabled = true;
        const res = await window.rvr.espo.request(`Case/${caseId}`, { method: 'PUT', body: { [field]: newValue } });
        if (ctx.isStale()) return;
        selectEl.disabled = false;

        if (!res.ok) {
          if (res.status === 403) {
            showStatus("You don't have permission to change this sign-off status.", 'err');
          } else {
            showStatus(res.message || 'Could not update sign-off status. Please try again.', 'err');
          }
          selectEl.value = previousValue;
          return;
        }

        previousValue = newValue;
        pillEl.textContent = newValue;
        pillEl.className = `pill ${signOffPillClass(newValue)}`;
        let message = 'Sign-off status updated.';
        if (newValue === 'Requested') {
          message = 'Sign-off requested — the senior caseworkers have been emailed automatically.';
        } else if (newValue === 'Approved') {
          message = 'Sign-off approved — the caseworker has been emailed automatically.';
        }
        showStatus(message, 'ok');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Notes — a thin UI over EspoCRM's own Stream/Note API (POST /Note with
  // type:'Post', parentType/parentId pointing at this Case), so notes show up
  // in EspoCRM's own activity stream too rather than living in a second,
  // bespoke store nobody else can see. Marked isInternal so they never
  // surface anywhere client-facing.
  // ---------------------------------------------------------------------------
  function renderNotesList(notes, ctx) {
    if (!notes.length) {
      return '<div class="empty-state">No notes on this case yet.</div>';
    }
    return notes.map((n) => `
      <div class="note-row">
        <div class="note-meta"><strong>${ctx.escapeHtml(n.createdByName || 'Staff')}</strong> &middot; ${formatDateTime(n.createdAt)}</div>
        <div class="note-body">${ctx.escapeHtml(n.post || '')}</div>
      </div>
    `).join('');
  }

  async function wireNotesPanel(panel, caseId, ctx) {
    const listEl = panel.querySelector('#notes-list');
    const textEl = panel.querySelector('#notes-new-text');
    const addBtn = panel.querySelector('#notes-add-btn');
    const statusEl = panel.querySelector('#notes-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }

    async function loadNotes() {
      listEl.innerHTML = '<div class="loading-state">Loading notes…</div>';
      // 2026-08-28: this used to pull the 100 most recent ACTIVITY entries
      // and then filter them down to human notes in the browser. The stream
      // also records every stage change, field edit, reassignment and
      // document verification - all of which this app generates freely - so
      // on a busy case the real notes fell off the end and the panel said
      // "No notes on this case yet." while the notes still existed.
      // `filter=posts` makes EspoCRM do the filtering. Proven live against
      // the running CRM: the same case returned total 2 unfiltered (Post +
      // Create) and total 1 with the filter, Post only.
      const res = await window.rvr.espo.request(`Case/${caseId}/stream`, {
        query: { maxSize: 200, orderBy: 'createdAt', order: 'desc', filter: 'posts' }
      });
      if (ctx.isStale()) return;
      if (!res.ok) {
        if (res.status === 403) {
          // 2026-08-28: this used to promise "we've received a report of
          // this and are working on a fix" for a fault nobody had looked at.
          // Reassuring copy that asserts an unverified diagnosis is
          // camouflage - it is why the Messages fault hid for a week. Say
          // what happened and that it has been reported; claim nothing else.
          listEl.innerHTML = '<div class="empty-state">Notes could not be loaded. This has been reported to the team.</div>';
        } else {
          listEl.innerHTML = `<div class="empty-state">Could not load notes (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        }
        return;
      }
      const all = (res.data && res.data.list) || [];
      // The stream mixes system entries (stage changes, field updates) in
      // with genuine human notes — only "Post" type entries are notes
      // someone actually wrote, which is what this panel is for.
      const notes = all.filter((n) => n.type === 'Post');
      listEl.innerHTML = renderNotesList(notes, ctx);
    }

    addBtn.addEventListener('click', async () => {
      const text = textEl.value.trim();
      if (!text) { showStatus('Write something before adding a note.', 'err'); return; }
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      const res = await window.rvr.espo.request('Note', {
        method: 'POST',
        body: { type: 'Post', parentType: 'Case', parentId: caseId, post: text, isInternal: true }
      });
      if (ctx.isStale()) return;
      addBtn.disabled = false;
      addBtn.textContent = 'Add note';
      if (!res.ok) {
        if (res.status === 403) {
          showStatus('Your note was NOT added — notes on this case aren\'t working right now. We\'ve received a report of this and are working on a fix; please try again later.', 'err');
        } else {
          showStatus(res.message || 'Could not add the note. Please try again.', 'err');
        }
        return;
      }
      textEl.value = '';
      showStatus('', '');
      await loadNotes();
    });

    await loadNotes();
  }

  // ---------------------------------------------------------------------------
  // Client messages — reads/writes CPortalMessage directly with the logged-in
  // staff member's own EspoCRM session (no proxy needed; the proxy pattern
  // elsewhere in this project exists specifically because *portal clients*
  // can't be trusted with a privileged credential — staff already have their
  // own real, role-scoped EspoCRM login for everything else in this app).
  // Requires the CPortalMessage staff-role ACL grant (read/create, team-
  // scoped) — see infrastructure-status.md; until that lands, this panel
  // degrades to a plain "can't load messages" state rather than erroring,
  // same 403-handling convention as the rest of the app.
  // ---------------------------------------------------------------------------
  function renderMessagesThread(messages, ctx) {
    if (!messages.length) {
      return '<div class="empty-state">No messages on this case yet.</div>';
    }
    return messages.map((m) => {
      const fromClient = m.direction === 'From Client';
      return `
        <div class="message-bubble ${fromClient ? 'from-client' : 'to-client'}">
          <div class="message-meta">
            <strong>${ctx.escapeHtml(m.senderName || (fromClient ? 'Client' : 'Staff'))}</strong>
            &middot; ${formatDateTime(m.createdAt)}
          </div>
          <div class="message-body">${ctx.escapeHtml(m.messageBody || '')}</div>
        </div>
      `;
    }).join('');
  }

  async function wireMessagesPanel(panel, c, caseId, ctx) {
    const threadEl = panel.querySelector('#messages-thread');
    const textEl = panel.querySelector('#messages-reply-text');
    const sendBtn = panel.querySelector('#messages-reply-btn');
    const statusEl = panel.querySelector('#messages-status');

    function showStatus(msg, kind) {
      statusEl.textContent = msg;
      statusEl.className = `status-banner show ${kind}`;
    }

    let latestClientMessageAt = null;

    async function loadMessages() {
      threadEl.innerHTML = '<div class="loading-state">Loading messages…</div>';
      const res = await window.rvr.espo.request('CPortalMessage', {
        query: {
          'where[0][type]': 'equals',
          'where[0][attribute]': 'caseId',
          'where[0][value]': caseId,
          // 2026-08-28: this used to be order 'asc' with a hard cap, so past
          // 200 messages the NEWEST were the ones silently dropped - exactly
          // the wrong end of a conversation - and the "seen" marker below was
          // then set from an old message, so that case's badge never cleared.
          // Fetch newest-first and reverse for display.
          orderBy: 'createdAt',
          order: 'desc',
          maxSize: 200
        }
      });
      if (ctx.isStale()) return;
      if (!res.ok) {
        if (res.status === 403) {
          // See the note on the Notes panel above - same reason.
          threadEl.innerHTML = '<div class="empty-state">Messages could not be loaded. This has been reported to the team.</div>';
        } else {
          threadEl.innerHTML = `<div class="empty-state">Could not load messages (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
        }
        return;
      }
      const messages = ((res.data && res.data.list) || []).slice().reverse();
      threadEl.innerHTML = renderMessagesThread(messages, ctx);
      threadEl.scrollTop = threadEl.scrollHeight;

      // Mark this case's newest client message as "seen" so the Messages
      // nav badge and dashboard stop counting it — local-only bookkeeping,
      // see main.js's Store defaults comment.
      const clientMessages = messages.filter((m) => m.direction === 'From Client');
      if (clientMessages.length) {
        latestClientMessageAt = clientMessages[clientMessages.length - 1].createdAt;
        await window.rvr.messages.setSeen(caseId, latestClientMessageAt);
        if (window.rvrRefreshMessagesBadge) window.rvrRefreshMessagesBadge();
      }
    }

    sendBtn.addEventListener('click', async () => {
      const text = textEl.value.trim();
      if (!text) { showStatus('Write a reply before sending.', 'err'); return; }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      const senderName = (ctx.user && (`${ctx.user.firstName || ''} ${ctx.user.lastName || ''}`.trim() || ctx.user.userName)) || 'Staff';

      // 2026-08-28: this create had no owner on it, so EspoCRM refused it
      // outright - the same assignmentPermission trap that stopped David
      // adding a company. v0.2.25 fixed that for Account and Contact and
      // never came back for messages. Proven in the server log: 403
      // "Assignment failure" on POST /CPortalMessage at 23:01 on 2026-08-27.
      const messageBody = {
        caseId,
        contactId: c.contactId || null,
        direction: 'To Client',
        senderName,
        messageBody: text
      };
      if (ctx.user && ctx.user.id) messageBody.assignedUserId = ctx.user.id;

      const res = await window.rvr.espo.request('CPortalMessage', {
        method: 'POST',
        body: messageBody
      });

      if (ctx.isStale()) return;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';

      if (!res.ok) {
        if (res.status === 403) {
          showStatus('Your reply was NOT sent — case messages aren\'t working right now. We\'ve received a report of this and are working on a fix; please try again later.', 'err');
        } else {
          showStatus(res.message || 'Could not send the reply. Please try again.', 'err');
        }
        return;
      }

      textEl.value = '';
      showStatus('', '');
      await loadMessages();
    });

    await loadMessages();
  }

  function formatCurrency(value) {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    return num.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  }

  function formatAddress(c) {
    return [c.cPropertyAddressStreet, c.cPropertyAddressCity, c.cPropertyAddressState, c.cPropertyAddressPostalCode]
      .filter(Boolean).join(', ') || '—';
  }

  // The Director/Administrator role - the same id security.js gates its
  // colleague password reset panel on.
  const DIRECTOR_ADMIN_ROLE_ID = '6a6d2924bb6f8918c';

  async function wireCaseDelete(container, caseId, c, ctx) {
    const slot = container.querySelector('#case-detail-danger');
    const status = container.querySelector('#case-detail-top-status');
    if (!slot || !ctx.user || !ctx.user.id) return;

    const rolesRes = await window.rvr.espo.request(`User/${ctx.user.id}`, { query: { select: 'rolesIds' } });
    if (ctx.isStale()) return;
    // Fail CLOSED: if we could not read the roles, do not show a destructive
    // control on the strength of a guess.
    if (!rolesRes.ok) return;
    const rolesIds = (rolesRes.data && rolesRes.data.rolesIds) || [];
    if (!rolesIds.includes(DIRECTOR_ADMIN_ROLE_ID)) return;

    // 2026-09-01: DELETE COULD NEVER WORK IN THE APP. This used
    // window.confirm() followed by window.prompt() for the typed case-number
    // check. Electron implements confirm() but NOT prompt() - calling it
    // throws "prompt() is and will not be supported." So the click threw
    // before a single request was made, and the only sign of it was an
    // unhandled promise rejection reaching App Error Tracking. Reported by
    // Tyrone as "delete cases isn't working for Director/administrator (works
    // when logging into espoCRM)" - correct, because EspoCRM runs in a real
    // browser where prompt() exists.
    //
    // Both dialogs are now drawn in the page. That also means the whole thing
    // can be driven in a test, which a native dialog never could be.
    //
    // The safety bar is deliberately unchanged: an explicit warning, and the
    // case number typed by hand before the button will do anything.
    const caseNumber = String(c.number || '').trim();
    const label = `Case #${c.number || ''}${c.name ? ` - ${c.name}` : ''}`.trim();

    slot.innerHTML = `
      <button class="btn btn-danger" id="case-delete-btn">Delete case</button>
      <div id="case-delete-confirm" class="case-delete-confirm" style="display:none;">
        <p class="case-delete-warning">
          <strong>Delete ${ctx.escapeHtml(label)}?</strong><br>
          This removes the case, and its documents and messages go with it.
          It cannot be undone from inside this app.
        </p>
        <label class="field-label" for="case-delete-number">
          To confirm, type the case number (${ctx.escapeHtml(caseNumber)}) below.
        </label>
        <input type="text" id="case-delete-number" autocomplete="off" spellcheck="false">
        <div class="case-delete-actions">
          <button class="btn btn-danger" id="case-delete-go">Delete permanently</button>
          <button class="btn btn-secondary" id="case-delete-cancel">Cancel</button>
        </div>
      </div>`;

    const btn = slot.querySelector('#case-delete-btn');
    const panel = slot.querySelector('#case-delete-confirm');
    const numberInput = slot.querySelector('#case-delete-number');
    const goBtn = slot.querySelector('#case-delete-go');
    const cancelBtn = slot.querySelector('#case-delete-cancel');

    function closeConfirm() {
      panel.style.display = 'none';
      btn.style.display = '';
      numberInput.value = '';
      goBtn.disabled = false;
      goBtn.textContent = 'Delete permanently';
    }

    btn.addEventListener('click', () => {
      btn.style.display = 'none';
      panel.style.display = '';
      numberInput.focus();
    });

    cancelBtn.addEventListener('click', () => {
      closeConfirm();
      status.textContent = '';
      status.className = 'status-banner';
    });

    goBtn.addEventListener('click', async () => {
      if (String(numberInput.value).trim() !== caseNumber) {
        status.textContent = 'Case number did not match - nothing has been deleted.';
        status.className = 'status-banner show err';
        numberInput.focus();
        return;
      }

      goBtn.disabled = true;
      goBtn.textContent = 'Deleting…';
      const del = await window.rvr.espo.request(`Case/${caseId}`, { method: 'DELETE' });
      if (ctx.isStale()) return;

      if (!del.ok) {
        goBtn.disabled = false;
        goBtn.textContent = 'Delete permanently';
        status.textContent = del.message || 'Could not delete this case.';
        status.className = 'status-banner show err';
        return;
      }
      ctx.goBack();
    });
  }

  // 2026-08-29: was `new Date(value)`, which reads the CRM's unmarked
  // "2026-08-27 14:03:11" as local time. Used for created dates, invoice
  // dates and payment due dates, any of which could show the wrong day
  // either side of midnight. One shared converter now.
  function formatDate(value) { return window.rvrTime.formatDate(value); }

  // 2026-08-28: Tyrone asked for the time messages were sent. Everything with
  // a real timestamp on it - messages, notes, document uploads - used
  // formatDate, which prints day/month/year and nothing else, so a thread of
  // replies sent across one afternoon showed the same date against every
  // bubble and read as having no timestamp at all.
  //
  // EspoCRM hands these back as "2026-08-27 14:03:11" - UTC, space-separated,
  // no zone marker - which JavaScript would otherwise read as local time.
  // The Z is added explicitly so it is parsed as what it actually is.
  // 2026-08-29: that NOTE is now done. This used to render in whatever
  // timezone the machine was set to - and Tyrone's own machine was set to
  // UTC, which is exactly how a whole-estate hour offset stays invisible to
  // the person testing it. It is pinned to Europe/London.
  function formatDateTime(value) {
    if (!value) return '—';
    const d = window.rvrTime.parseCrm(value);
    if (!d) return String(value);
    const time = window.rvrTime.formatTime(d);
    if (window.rvrTime.isToday(d)) return `Today, ${time}`;
    return `${window.rvrTime.formatDate(d)}, ${time}`;
  }

  // Full pipeline stage-track — every stage as a pill, grey if upcoming,
  // green if passed, gold if current. The disputed terminal state is shown
  // as a single standalone red pill instead of the track, matching the
  // mockup's rvr_crm_mockup.html #detStageTrack behaviour exactly.
  // 2026-09-01: two stages are ENDINGS rather than steps on the way through,
  // so neither belongs in the track. A case rejected at the site inspection
  // never goes on to gather evidence - that is the whole point of it - and
  // showing it as pill six of fourteen with eight greyed-out steps after it
  // would suggest the case is still travelling somewhere. Both are drawn as a
  // single standalone pill instead.
  const TERMINAL_STAGES = ['Closed Without Payment - Disputed', 'Site Inspection / Case Rejection'];

  function renderStageTrack(c) {
    if (TERMINAL_STAGES.indexOf(c.cCaseStage) !== -1) {
      return `<span class="stage-pill now disputed">${c.cCaseStage}</span>`;
    }
    const stageIndex = STAGE_ORDER.indexOf(c.cCaseStage);
    return STAGE_ORDER
      .filter((s) => TERMINAL_STAGES.indexOf(s) === -1)
      .map((s) => {
        const idx = STAGE_ORDER.indexOf(s);
        const cls = idx < stageIndex ? 'done' : (s === c.cCaseStage ? 'now' : '');
        return `<span class="stage-pill ${cls}">${s}</span>`;
      })
      .join('');
  }

  async function render(container, ctx) {
    const caseId = ctx.params && ctx.params.caseId;

    if (!caseId) {
      container.innerHTML = '<div class="empty-state">No case selected. Go back and pick one from Cases or the Pipeline.</div>';
      return;
    }

    container.innerHTML = `
      <div class="case-detail-topbar" style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <a class="back-link" id="case-detail-back">&larr; Back</a>
        <div id="case-detail-danger"></div>
      </div>
      <div class="status-banner" id="case-detail-top-status"></div>
      <div id="case-detail-body"><div class="loading-state">Loading case…</div></div>
    `;
    container.querySelector('#case-detail-back').addEventListener('click', () => ctx.goBack());

    const res = await window.rvr.espo.request(`Case/${caseId}`);
    const body = container.querySelector('#case-detail-body');
    if (!body) return;

    if (!res.ok) {
      body.innerHTML = `<div class="empty-state">Could not load this case (${ctx.escapeHtml(res.message || 'unknown error')}).</div>`;
      return;
    }

    const c = res.data || {};
    // 2026-08-28: Tyrone asked for a way for David to delete a case. Director
    // /Administrator only, which is his decision - and it needs no permission
    // change, because that role already holds delete on Case. Every other
    // role does not, so for them the button is both hidden here AND refused
    // by EspoCRM if they ever reached it; the gating below is a convenience,
    // not the security boundary.
    wireCaseDelete(container, caseId, c, ctx);
    const documentsReceived = Array.isArray(c.cDocumentsReceived) ? c.cDocumentsReceived : [];
    const docOptions = await loadDocumentOptions();
    if (ctx.isStale()) return;

    body.innerHTML = `
      <h1 class="module-title">${ctx.escapeHtml(c.cClientRef || ('Case #' + c.number))}${c.name ? ` — ${ctx.escapeHtml(c.name)}` : ''}</h1>
      <p class="module-subtitle">
        ${c.cClientRef ? `Case #${ctx.escapeHtml(c.number)} · ` : ''}${ctx.escapeHtml(formatAddress(c))}
        <span class="${window.rvrStageBadgeClass(c.cCaseStage)}" style="margin-left:8px;">${ctx.escapeHtml(c.cCaseStage || 'No stage set')}</span>
      </p>
      <div class="stage-track">${renderStageTrack(c)}</div>

      <div class="case-columns">
        <div>
          <div class="panel" id="details-panel">
            <div class="panel-heading-row">
              <h3 class="panel-heading">Case details</h3>
              <button class="btn btn-secondary btn-sm" id="details-edit-btn">Edit</button>
            </div>
            <div class="status-banner" id="details-status"></div>
            <div class="field" style="margin-bottom:14px;">
              <label for="assign-user-select">Assigned to</label>
              <select id="assign-user-select"><option>Loading…</option></select>
              <div class="status-banner" id="assign-status"></div>
            </div>
            <div id="details-body"></div>
          </div>

          <div class="panel" id="documents-received-panel">
            <h3 class="panel-heading" id="documents-received-heading">Documents received (${documentsReceived.length}/${docOptions.received.length})</h3>
            <div class="doc-checklist" id="documents-received-checklist">
              ${docOptions.received.map((doc) => `
                <span class="pill ${documentsReceived.includes(doc) ? 'good' : 'neutral'}">${documentsReceived.includes(doc) ? '&#10003; ' : ''}${ctx.escapeHtml(doc)}</span>
              `).join('')}
            </div>
          </div>

          <div class="panel" id="notes-panel">
            <h3 class="panel-heading">Notes</h3>
            <p style="color:var(--muted); font-size:12px; margin-top:-8px;">Internal staff notes on this case &mdash; not visible to the client.</p>
            <div class="status-banner" id="notes-status"></div>
            <div class="note-add-row">
              <textarea id="notes-new-text" rows="2" placeholder="Add a note about this case…"></textarea>
              <button class="btn btn-primary" id="notes-add-btn">Add note</button>
            </div>
            <div id="notes-list"><div class="loading-state">Loading notes…</div></div>
          </div>
        </div>

        <div>
          <div class="panel">
            <h3 class="panel-heading">Invoicing</h3>
            <div class="detail-grid">
              <div><label>Invoice date</label><div>${formatDate(c.cInvoiceDate)}</div></div>
              <div><label>Payment due</label><div>${formatDate(c.cPaymentDueDate)}</div></div>
              <div><label>Invoice paid</label><div><span class="pill ${c.cInvoicePaid ? 'good' : 'neutral'}">${c.cInvoicePaid ? 'Paid' : 'Not yet paid'}</span></div></div>
              <div><label>Reminder sent</label><div>${c.cPaymentReminderSent ? 'Yes' : 'No'}</div></div>
            </div>
          </div>

          <div class="panel" id="signoff-panel">
            <h3 class="panel-heading">Senior Sign-Off</h3>
            <p style="color:var(--muted); font-size:12px; margin-top:-8px;">Required before this case can move past Check, Challenge, or Appeal. Setting a stage to "Requested" automatically emails the senior caseworkers.</p>
            <div class="status-banner" id="signoff-status"></div>
            <div class="signoff-list">
              ${SIGNOFF_STAGES.map((stage) => renderSignOffRow(stage, c)).join('')}
            </div>
          </div>
        </div>
      </div>

      <div class="panel" id="doc-panel">
        <h3 class="panel-heading">Documents</h3>
        <p style="color:var(--muted); font-size:12px; margin-top:-8px;">Every document on this case &mdash; uploaded by the client through the portal, or by staff here. A pending client upload is highlighted until it's verified or rejected.</p>
        <div class="status-banner" id="doc-upload-status"></div>
        <div class="doc-upload-row">
          <div>
            <label for="doc-upload-category">Document type</label>
            <select id="doc-upload-category"></select>
          </div>
          <div id="doc-upload-other-specify-wrap" style="display:none;">
            <label for="doc-upload-other-specify">Please specify</label>
            <input type="text" id="doc-upload-other-specify" placeholder="What kind of document is this?">
          </div>
          <div>
            <label for="doc-upload-file">File</label>
            <input type="file" id="doc-upload-file">
          </div>
          <button class="btn btn-primary" id="doc-upload-btn">Upload</button>
        </div>
        <div id="doc-list"><div class="loading-state">Loading documents…</div></div>
      </div>

      <div class="panel" id="messages-panel">
        <h3 class="panel-heading">Client messages</h3>
        <p style="color:var(--muted); font-size:12px; margin-top:-8px;">
          Messages sent through the client portal for this case. Visible to any teammate who can see this case;
          replying is limited to whoever can edit it, same as everywhere else in this app.
        </p>
        <div class="status-banner" id="messages-status"></div>
        <div id="messages-thread"><div class="loading-state">Loading messages…</div></div>
        <div class="message-reply-row">
          <textarea id="messages-reply-text" rows="2" placeholder="Reply to the client…"></textarea>
          <button class="btn btn-primary" id="messages-reply-btn">Send</button>
        </div>
      </div>

      <p style="color:var(--muted); font-size:12px;">
        Open the full record in EspoCRM for the record's own activity stream:
        <a href="https://crm.rvrratingpartners.co.uk/#Case/view/${encodeURIComponent(caseId)}" target="_blank" rel="noopener">Open in EspoCRM &rarr;</a>
      </p>
    `;

    // The "Documents received" checklist panel above is built once, right
    // here, from `documentsReceived` -- it has no other way to learn that
    // verifying a document in the panel below just ticked one of its items.
    // This callback lets that panel push a fresh copy up so the checklist
    // (and its own gating effect on stage advancement) reflects reality
    // immediately, without a page reload.
    const receivedHeadingEl = body.querySelector('#documents-received-heading');
    const receivedChecklistEl = body.querySelector('#documents-received-checklist');
    function refreshDocumentsReceived(updatedReceived) {
      if (receivedHeadingEl) {
        receivedHeadingEl.textContent = `Documents received (${updatedReceived.length}/${docOptions.received.length})`;
      }
      if (receivedChecklistEl) {
        receivedChecklistEl.innerHTML = docOptions.received.map((doc) => `
          <span class="pill ${updatedReceived.includes(doc) ? 'good' : 'neutral'}">${updatedReceived.includes(doc) ? '&#10003; ' : ''}${ctx.escapeHtml(doc)}</span>
        `).join('');
      }
    }

    const docPanel = body.querySelector('#doc-panel');
    if (docPanel) {
      await wireDocumentsPanel(docPanel, caseId, ctx, docOptions.category, docOptions.received, documentsReceived, refreshDocumentsReceived);
    }

    // The stage badge in the header and the stage-track bar just above the
    // two-column layout are both built once, right here, from `c` -- they
    // have no other way to learn that the Case details panel below changed
    // the stage. This callback lets that panel push a fresh copy up after a
    // successful save so both stay in sync with what was actually saved.
    const stageBadgeEl = body.querySelector('.module-subtitle span');
    const stageTrackEl = body.querySelector('.stage-track');
    function refreshStageDisplay(updatedCase) {
      if (stageBadgeEl) {
        stageBadgeEl.className = window.rvrStageBadgeClass(updatedCase.cCaseStage);
        stageBadgeEl.textContent = updatedCase.cCaseStage || 'No stage set';
      }
      if (stageTrackEl) {
        stageTrackEl.innerHTML = renderStageTrack(updatedCase);
      }
    }

    const detailsPanel = body.querySelector('#details-panel');
    if (detailsPanel) {
      await wireCaseDetailsPanel(detailsPanel, c, caseId, ctx, refreshStageDisplay);
      await wireAssignPanel(detailsPanel, c, caseId, ctx);
    }

    const signoffPanel = body.querySelector('#signoff-panel');
    if (signoffPanel) {
      await wireSignOffPanel(signoffPanel, c, caseId, ctx);
    }

    const notesPanel = body.querySelector('#notes-panel');
    if (notesPanel) {
      await wireNotesPanel(notesPanel, caseId, ctx);
    }

    const messagesPanel = body.querySelector('#messages-panel');
    if (messagesPanel) {
      await wireMessagesPanel(messagesPanel, c, caseId, ctx);
    }
  }

  window.rvrModules['case-detail'] = { render };
})();
