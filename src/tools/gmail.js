import { google } from 'googleapis';
import config from '../config.js';

let gmailClient = null;

function getGmail() {
  if (gmailClient) return gmailClient;
  if (!config.googleClientId || !config.googleRefreshToken) {
    throw new Error('Gmail not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env');
  }

  const oauth2 = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
  );
  oauth2.setCredentials({ refresh_token: config.googleRefreshToken });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2 });
  return gmailClient;
}

function decodeBody(part) {
  if (part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8');
  }
  if (part.parts) {
    // Prefer text/plain, fall back to text/html
    const plain = part.parts.find((p) => p.mimeType === 'text/plain');
    if (plain) return decodeBody(plain);
    const html = part.parts.find((p) => p.mimeType === 'text/html');
    if (html) {
      const raw = decodeBody(html);
      // Strip HTML tags for WhatsApp readability
      return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // Recurse into nested multipart
    for (const p of part.parts) {
      const result = decodeBody(p);
      if (result) return result;
    }
  }
  return '';
}

function getHeader(headers, name) {
  const h = headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

export async function gmailSearch({ query, max_results = 10 }) {
  const gmail = getGmail();

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: max_results,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) return 'No messages found.';

  const summaries = [];
  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });

    const headers = detail.data.payload?.headers || [];
    const from = getHeader(headers, 'From');
    const subject = getHeader(headers, 'Subject');
    const date = getHeader(headers, 'Date');
    const snippet = detail.data.snippet || '';
    const unread = (detail.data.labelIds || []).includes('UNREAD') ? '🔵 ' : '';

    summaries.push(`${unread}**${subject || '(no subject)'}**\nFrom: ${from}\nDate: ${date}\nID: ${msg.id}\n${snippet}`);
  }

  return summaries.join('\n\n---\n\n');
}

export async function gmailRead({ message_id }) {
  const gmail = getGmail();

  const res = await gmail.users.messages.get({
    userId: 'me',
    id: message_id,
    format: 'full',
  });

  const headers = res.data.payload?.headers || [];
  const from = getHeader(headers, 'From');
  const to = getHeader(headers, 'To');
  const subject = getHeader(headers, 'Subject');
  const date = getHeader(headers, 'Date');
  const body = decodeBody(res.data.payload);

  // Truncate very long emails for WhatsApp
  const maxLen = 2000;
  const truncatedBody = body.length > maxLen
    ? body.slice(0, maxLen) + '\n\n[... truncated — full email is longer]'
    : body;

  return `**${subject}**\nFrom: ${from}\nTo: ${to}\nDate: ${date}\nThread: ${res.data.threadId}\n\n${truncatedBody}`;
}

export async function gmailDraft({ to, subject, body, thread_id }) {
  const gmail = getGmail();

  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
  ].join('\r\n');

  const raw = Buffer.from(`${headers}\r\n\r\n${body}`).toString('base64url');

  const params = {
    userId: 'me',
    requestBody: { message: { raw } },
  };
  if (thread_id) params.requestBody.message.threadId = thread_id;

  const res = await gmail.users.drafts.create(params);

  const preview = body.length > 300 ? body.slice(0, 300) + '...' : body;
  return `📝 Draft created (NOT sent yet)\n\nTo: ${to}\nSubject: ${subject}\nDraft ID: ${res.data.id}\n\n---\n${preview}\n\n---\n⚠️ To send this, James must confirm. Use gmail_confirm_send with the draft ID above.`;
}

export async function gmailConfirmSend({ draft_id }) {
  const gmail = getGmail();

  const res = await gmail.users.drafts.send({
    userId: 'me',
    requestBody: { id: draft_id },
  });

  const headers = res.data.payload?.headers || [];
  const to = getHeader(headers, 'To');
  const subject = getHeader(headers, 'Subject');

  return `✅ Email sent.\nTo: ${to}\nSubject: ${subject}\nMessage ID: ${res.data.id}`;
}
