/**
 * Monarch Money — Gmail Receipt → Inbox Uploader (Google Apps Script)
 * ------------------------------------------------------------------
 * Scans your Gmail for grocery receipt emails and, instead of saving the PDF
 * to Drive, uploads it to the Monarch Money *general receipt inbox*. Monarch's
 * AI then categorizes the receipt and matches it to a transaction on its own.
 * (It is NOT attached to a specific transaction.)
 *
 * Faithfully replicates the `upload_receipt_to_inbox` flow from monarchmoneycommunity
 * PR #44: create bulk retail sync -> POST file to /retail-sync/{id}/files -> start sync.
 *
 * AUTH = COOKIES (NOT email/password)
 * -----------------------------------
 * Apps Script runs on Google's servers, and Monarch's /auth/login/ endpoint is
 * behind Cloudflare, which blocks programmatic logins from datacenter IPs
 * (you'll get a Cloudflare "Sorry, you have been blocked" page). The fix —
 * same as the Python library's login_with_cookies() — is to reuse your browser
 * session cookies and skip the login endpoint entirely.
 *
 * HOW TO GET YOUR COOKIES + USER-AGENT
 *   1) In Chrome, log into https://app.monarch.com.
 *   2) Open DevTools (F12) -> Network tab.
 *   3) Click around so a request to "api.monarch.com/graphql" appears; click it.
 *   4) Under "Request Headers", copy the FULL value of the `cookie:` header and
 *      paste it into CONFIG.monarchCookie below. It must contain session_id and
 *      csrftoken (copying everything, including cf_clearance, is best).
 *   5) From the same request, copy the `user-agent:` value into CONFIG.userAgent.
 *
 * Cookies expire periodically (typically weeks). When uploads start failing with
 * 401/403, re-copy a fresh cookie string. NOTE: because cf_clearance is tied to
 * an IP, Cloudflare may still challenge requests from Google's servers; if even
 * the cookie approach returns a Cloudflare HTML page, this can't run from Apps
 * Script and would need to run from a residential IP (e.g. the Python library).
 *
 * SETUP
 *   1) https://script.google.com -> New project -> paste this whole file.
 *   2) Fill in CONFIG.
 *   3) Run `testMonarchAuth` to confirm the cookies work, then `processGroceryReceipts`.
 *   4) Optional: add a time-based trigger for processGroceryReceipts.
 */

// ===================== CONFIG =====================
var CONFIG = {
  // Full cookie header string from your browser (must include session_id + csrftoken).
  monarchCookie: 'PASTE_FULL_COOKIE_STRING_HERE',

  // The exact User-Agent your browser sent (helps pass Cloudflare / match the session).
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // Same Gmail search you already use.
  searchQuery: '(from:receipts@aisleonekosher.com OR from:info@evergreenkosher.com OR from:receipts@hivediscount.com) after:2025/04/30',

  // Trash the email once all its PDFs upload successfully (matches your old behavior).
  trashOnSuccess: true
};
// ==================================================

var MM_BASE = 'https://api.monarch.com';

/**
 * Main entry point — scan Gmail and upload each receipt PDF to the Monarch inbox.
 */
function processGroceryReceipts() {
  requireCookie_();
  var threads = GmailApp.search(CONFIG.searchQuery);
  var uploaded = 0, failed = 0;

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();

    for (var j = 0; j < messages.length; j++) {
      var message = messages[j];
      var attachments = message.getAttachments();
      var foundPdf = false;
      var allUploaded = true;

      for (var k = 0; k < attachments.length; k++) {
        var attachment = attachments[k];

        if (attachment.getContentType() === 'application/pdf' ||
            attachment.getName().toLowerCase().endsWith('.pdf')) {
          foundPdf = true;
          var blob = attachment.copyBlob().setName(attachment.getName());
          try {
            uploadReceiptToInbox(blob);
            uploaded++;
            Logger.log('Uploaded to Monarch inbox: ' + attachment.getName());
          } catch (e) {
            allUploaded = false;
            failed++;
            Logger.log('FAILED: ' + attachment.getName() + ' -> ' + e.message);
          }
        }
      }

      // Trash only if every PDF uploaded; otherwise mark unread so it retries next run.
      if (foundPdf && allUploaded && CONFIG.trashOnSuccess) {
        message.moveToTrash();
      } else if (!foundPdf || !allUploaded) {
        message.markUnread();
      }
    }
  }

  Logger.log('Done. Uploaded: ' + uploaded + ', Failed: ' + failed);
}

/**
 * Full inbox upload flow for a single file (one retail-sync session per receipt).
 */
function uploadReceiptToInbox(blob) {
  var syncId = createRetailSync();
  uploadReceiptFile(syncId, blob);
  return startRetailSync(syncId);
}

// ---------- Monarch API calls ----------

/** Step 1: create a bulk retail sync session (count: 1) -> returns sync id. */
function createRetailSync() {
  var query =
    'mutation Common_CreateBulkRetailSync($input: CreateBulkRetailSyncInput!) {' +
    '  createBulkRetailSync(input: $input) {' +
    '    retailSyncs { id vendor status startedAt endedAt createdAt updatedAt }' +
    '    errors { fieldErrors { field messages } message code }' +
    '  }' +
    '}';
  var data = monarchGraphQL('Common_CreateBulkRetailSync', query, { input: { count: 1 } });
  var result = data.createBulkRetailSync || {};
  var syncs = result.retailSyncs || [];
  var errors = result.errors || [];
  if (!syncs.length || errors.length) {
    throw new Error('Failed to create retail sync session: ' + JSON.stringify(errors));
  }
  return syncs[0].id;
}

/** Step 2: POST the file as multipart/form-data to the sync's files endpoint. */
function uploadReceiptFile(syncId, blob) {
  var mime = blob.getContentType() || 'application/octet-stream';
  var metadata = JSON.stringify({
    orderId: Utilities.getUuid(),
    vendor: 'user_import',
    payloadType: 'order',
    contentType: mime
  });

  // Apps Script builds multipart/form-data automatically because one field is a Blob.
  // Do NOT set Content-Type here (the endpoint rejects an explicit content type).
  var resp = UrlFetchApp.fetch(MM_BASE + '/retail-sync/' + syncId + '/files', {
    method: 'post',
    headers: cookieHeaders_(false),
    payload: {
      'payloads_count': '1',
      'metadata_0': metadata,
      'payload_0': blob
    },
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code !== 200 && code !== 201 && code !== 204) {
    throw new Error('File upload failed (' + code + '): ' + snippet_(resp.getContentText()));
  }
}

/** Step 3: start the sync so Monarch's AI processes the uploaded receipt. */
function startRetailSync(syncId) {
  var query =
    'mutation Common_StartRetailSync($syncId: ID!) {' +
    '  startRetailSync(id: $syncId) {' +
    '    retailSync { id vendor status startedAt endedAt createdAt updatedAt }' +
    '    errors { fieldErrors { field messages } message code }' +
    '  }' +
    '}';
  var data = monarchGraphQL('Common_StartRetailSync', query, { syncId: syncId });
  var result = data.startRetailSync || {};
  var errors = result.errors || [];
  if (errors.length) {
    throw new Error('Failed to start retail sync: ' + JSON.stringify(errors));
  }
  return result.retailSync;
}

/** Generic cookie-authenticated GraphQL call against Monarch. */
function monarchGraphQL(operationName, query, variables) {
  var headers = cookieHeaders_(true);
  var resp = UrlFetchApp.fetch(MM_BASE + '/graphql', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({ operationName: operationName, query: query, variables: variables || {} }),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code === 403 && /cloudflare|attention required|you have been blocked/i.test(body)) {
    throw new Error('Cloudflare blocked the request from Google\'s servers. The cookie approach ' +
                    'cannot get past Cloudflare from this IP; this script can\'t run from Apps Script.');
  }
  if (code === 401 || code === 403) {
    throw new Error('Auth rejected (' + code + '). Your cookies are likely expired — re-copy a ' +
                    'fresh cookie string from your browser. Body: ' + snippet_(body));
  }
  if (code !== 200) {
    throw new Error('GraphQL ' + (operationName || '') + ' failed (' + code + '): ' + snippet_(body));
  }
  var json = JSON.parse(body);
  if (json.errors) {
    throw new Error('GraphQL ' + (operationName || '') + ' errors: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

// ---------- Cookie auth helpers ----------

/** Build request headers for cookie-based auth. jsonBody=true adds JSON Accept/Content. */
function cookieHeaders_(jsonBody) {
  var headers = {
    'Cookie': CONFIG.monarchCookie,
    'X-Csrftoken': getCsrfToken_(CONFIG.monarchCookie),
    'Client-Platform': 'web',
    'User-Agent': CONFIG.userAgent,
    'Origin': 'https://app.monarch.com',
    'Referer': 'https://app.monarch.com/',
    'monarch-client': 'web',
    'monarch-client-version': '2025.05'
  };
  if (jsonBody) {
    headers['Accept'] = 'application/json';
    // Content-Type is set via the fetch `contentType` option for JSON calls.
  }
  // For multipart uploads we deliberately omit Accept and Content-Type (Monarch rejects them).
  return headers;
}

/** Extract the csrftoken value from a cookie header string. */
function getCsrfToken_(cookieStr) {
  var m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(cookieStr || '');
  if (!m) {
    throw new Error('csrftoken not found in CONFIG.monarchCookie. Copy the FULL cookie header ' +
                    'from a logged-in app.monarch.com request.');
  }
  return m[1];
}

function requireCookie_() {
  if (!CONFIG.monarchCookie || CONFIG.monarchCookie.indexOf('PASTE_FULL') === 0) {
    throw new Error('Set CONFIG.monarchCookie to your browser cookie string first.');
  }
  getCsrfToken_(CONFIG.monarchCookie); // validate session_id/csrftoken presence
  if (!/(?:^|;\s*)session_id=/.test(CONFIG.monarchCookie)) {
    throw new Error('session_id not found in CONFIG.monarchCookie.');
  }
}

function snippet_(text) {
  if (!text) return '';
  text = String(text).replace(/\s+/g, ' ').trim();
  return text.length > 300 ? text.substring(0, 300) + '…' : text;
}

/** Run this once to confirm your cookies authenticate (and aren't Cloudflare-blocked). */
function testMonarchAuth() {
  requireCookie_();
  // Minimal query that any authenticated session can answer.
  var data = monarchGraphQL(null, 'query { __typename }', {});
  Logger.log('Auth OK. Server responded: ' + JSON.stringify(data));
}
