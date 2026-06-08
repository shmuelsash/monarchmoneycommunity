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
 * SETUP
 *  1) Open https://script.google.com -> New project -> paste this whole file.
 *  2) Fill in CONFIG below (email, password, and your MFA/2FA secret).
 *  3) Run `processGroceryReceipts` once and authorize Gmail + external requests.
 *  4) Optional: add a time-based trigger (Triggers -> Add Trigger ->
 *     processGroceryReceipts -> Time-driven) to run it on a schedule.
 *
 * MFA SECRET: this is the base32 "setup key" Monarch shows when you enable an
 * authenticator app (e.g. "JBSWY3DPEHPK3PXP"), NOT the rotating 6-digit code.
 * If your account has no MFA, leave it as "".
 */

// ===================== CONFIG =====================
var CONFIG = {
  email: 'YOU@example.com',
  password: 'your-monarch-password',
  mfaSecret: '',  // base32 authenticator setup key, or '' if MFA is off

  // Same search you already use. Read or unread, from these senders, from this date on.
  searchQuery: '(from:receipts@aisleonekosher.com OR from:info@evergreenkosher.com OR from:receipts@hivediscount.com) after:2025/04/30',

  // If true, the email is trashed once all its PDFs upload successfully (matches your
  // old "delete after download" behavior). If false, emails are left in place.
  trashOnSuccess: true
};
// ==================================================

var MM_BASE = 'https://api.monarch.com';
var USER_AGENT = 'MonarchMoneyAPI (https://github.com/bradleyseanf/monarchmoneycommunity)';

/**
 * Main entry point — scan Gmail and upload each receipt PDF to the Monarch inbox.
 */
function processGroceryReceipts() {
  var token = monarchLogin();
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

        // Only PDFs (same rule as your downloader)
        if (attachment.getContentType() === 'application/pdf' ||
            attachment.getName().toLowerCase().endsWith('.pdf')) {
          foundPdf = true;
          var blob = attachment.copyBlob().setName(attachment.getName());
          try {
            uploadReceiptToInbox(token, blob);
            uploaded++;
            Logger.log('Uploaded to Monarch inbox: ' + attachment.getName());
          } catch (e) {
            allUploaded = false;
            failed++;
            Logger.log('FAILED: ' + attachment.getName() + ' -> ' + e.message);
          }
        }
      }

      // Rules: trash the email only if every PDF uploaded; otherwise mark unread
      // so it stays visible and gets retried next run.
      if (foundPdf && allUploaded && CONFIG.trashOnSuccess) {
        message.moveToTrash();
      } else if (!foundPdf) {
        message.markUnread();
      } else if (!allUploaded) {
        message.markUnread();
      }
    }
  }

  Logger.log('Done. Uploaded: ' + uploaded + ', Failed: ' + failed);
}

/**
 * Full inbox upload flow for a single file (one retail-sync session per receipt).
 */
function uploadReceiptToInbox(token, blob) {
  var syncId = createRetailSync(token);
  uploadReceiptFile(token, syncId, blob);
  return startRetailSync(token, syncId);
}

// ---------- Monarch API calls ----------

/** Step 1: create a bulk retail sync session (count: 1) -> returns sync id. */
function createRetailSync(token) {
  var query =
    'mutation Common_CreateBulkRetailSync($input: CreateBulkRetailSyncInput!) {' +
    '  createBulkRetailSync(input: $input) {' +
    '    retailSyncs { id vendor status startedAt endedAt createdAt updatedAt }' +
    '    errors { fieldErrors { field messages } message code }' +
    '  }' +
    '}';
  var data = monarchGraphQL(token, 'Common_CreateBulkRetailSync', query, { input: { count: 1 } });
  var result = data.createBulkRetailSync || {};
  var syncs = result.retailSyncs || [];
  var errors = result.errors || [];
  if (!syncs.length || errors.length) {
    throw new Error('Failed to create retail sync session: ' + JSON.stringify(errors));
  }
  return syncs[0].id;
}

/** Step 2: POST the file as multipart/form-data to the sync's files endpoint. */
function uploadReceiptFile(token, syncId, blob) {
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
    headers: {
      'Authorization': 'Token ' + token,
      'User-Agent': USER_AGENT,
      'Origin': 'https://app.monarch.com'
    },
    payload: {
      'payloads_count': '1',
      'metadata_0': metadata,
      'payload_0': blob
    },
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code !== 200 && code !== 201 && code !== 204) {
    throw new Error('File upload failed (' + code + '): ' + resp.getContentText());
  }
}

/** Step 3: start the sync so Monarch's AI processes the uploaded receipt. */
function startRetailSync(token, syncId) {
  var query =
    'mutation Common_StartRetailSync($syncId: ID!) {' +
    '  startRetailSync(id: $syncId) {' +
    '    retailSync { id vendor status startedAt endedAt createdAt updatedAt }' +
    '    errors { fieldErrors { field messages } message code }' +
    '  }' +
    '}';
  var data = monarchGraphQL(token, 'Common_StartRetailSync', query, { syncId: syncId });
  var result = data.startRetailSync || {};
  var errors = result.errors || [];
  if (errors.length) {
    throw new Error('Failed to start retail sync: ' + JSON.stringify(errors));
  }
  return result.retailSync;
}

// ---------- Auth + helpers ----------

/** Log in (with MFA TOTP if configured) and cache the long-lived token. */
function monarchLogin() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('MONARCH_TOKEN');
  var exp = props.getProperty('MONARCH_TOKEN_EXP');
  if (cached && exp && Number(exp) > Date.now()) {
    return cached;
  }

  var data = {
    username: CONFIG.email,
    password: CONFIG.password,
    supports_mfa: true,
    trusted_device: true
  };
  if (CONFIG.mfaSecret) {
    data.totp = generateTOTP(CONFIG.mfaSecret);
  }

  var resp = UrlFetchApp.fetch(MM_BASE + '/auth/login/', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Accept': 'application/json',
      'Client-Platform': 'web',
      'User-Agent': USER_AGENT
    },
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();

  if (code === 403) {
    throw new Error('Login blocked (MFA required/CAPTCHA). Check your mfaSecret. Response: ' + body);
  }
  if (code !== 200) {
    throw new Error('Login failed (' + code + '): ' + body);
  }

  var json = JSON.parse(body);
  var token = json.token;
  if (!token) {
    throw new Error('Login succeeded but no token returned: ' + body);
  }

  // Cache the token to avoid logging in on every run (reduces CAPTCHA risk).
  props.setProperty('MONARCH_TOKEN', token);
  props.setProperty('MONARCH_TOKEN_EXP', String(Date.now() + 12 * 3600 * 1000));
  return token;
}

/** Generic authenticated GraphQL call against Monarch. */
function monarchGraphQL(token, operationName, query, variables) {
  var resp = UrlFetchApp.fetch(MM_BASE + '/graphql', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Accept': 'application/json',
      'Authorization': 'Token ' + token,
      'Client-Platform': 'web',
      'User-Agent': USER_AGENT,
      'Origin': 'https://app.monarch.com'
    },
    payload: JSON.stringify({ operationName: operationName, query: query, variables: variables }),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code !== 200) {
    throw new Error('GraphQL ' + operationName + ' failed (' + code + '): ' + body);
  }
  var json = JSON.parse(body);
  if (json.errors) {
    throw new Error('GraphQL ' + operationName + ' errors: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

/** RFC 6238 TOTP (6 digits, SHA-1, 30s) from a base32 secret. */
function generateTOTP(secret) {
  var key = base32ToBytes(secret);
  var counter = Math.floor((Date.now() / 1000) / 30);

  // 8-byte big-endian counter
  var msg = [0, 0, 0, 0, 0, 0, 0, 0];
  for (var i = 7; i >= 0; i--) {
    msg[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  var signedMsg = msg.map(function (b) { return b > 127 ? b - 256 : b; });

  var hmac = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, signedMsg, key);
  var h = hmac.map(function (b) { return b < 0 ? b + 256 : b; });

  var offset = h[19] & 0xf;
  var bin = ((h[offset] & 0x7f) << 24) |
            ((h[offset + 1] & 0xff) << 16) |
            ((h[offset + 2] & 0xff) << 8) |
            (h[offset + 3] & 0xff);
  var otp = bin % 1000000;
  return ('000000' + otp).slice(-6);
}

/** Decode a base32 string into a (signed) byte array for Apps Script HMAC. */
function base32ToBytes(base32) {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var cleaned = base32.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  var bits = 0, value = 0, bytes = [];
  for (var i = 0; i < cleaned.length; i++) {
    var idx = alphabet.indexOf(cleaned.charAt(i));
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      var b = (value >>> bits) & 0xff;
      bytes.push(b > 127 ? b - 256 : b);
    }
  }
  return bytes;
}

/** Optional: run this once to verify login + clear any stale cached token. */
function testMonarchLogin() {
  PropertiesService.getScriptProperties().deleteProperty('MONARCH_TOKEN');
  var token = monarchLogin();
  Logger.log('Login OK. Token starts with: ' + token.substring(0, 6) + '...');
}
