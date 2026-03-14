// One-time script to get Google OAuth refresh token
// Run: node get-google-token.js <CLIENT_ID> <CLIENT_SECRET>
//
// 1. Opens a browser URL for you to authorize
// 2. Google redirects to localhost with an auth code
// 3. Exchanges the code for a refresh token
// 4. Prints the refresh token to add to .env

import { google } from 'googleapis';
import { createServer } from 'http';

const clientId = process.argv[2];
const clientSecret = process.argv[3];

if (!clientId || !clientSecret) {
  console.error('\nUsage: node get-google-token.js <CLIENT_ID> <CLIENT_SECRET>\n');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:3000';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',  // read + write events only
  'https://www.googleapis.com/auth/gmail.readonly',    // read/search emails
  'https://www.googleapis.com/auth/gmail.compose',     // create drafts + send (guardrailed in code)
];

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n=== Google OAuth Setup ===\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for callback on http://localhost:3000 ...\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><p>Waiting for auth redirect...</p></body></html>');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Success! You can close this tab.</h2><p>Check the terminal for your refresh token.</p></body></html>');

    console.log('\n=== SUCCESS ===\n');
    console.log('Add this to your .env file:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`\nFull token response: ${JSON.stringify(tokens, null, 2)}\n`);

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500);
    res.end('Token exchange failed: ' + err.message);
    console.error('Token exchange failed:', err.message);
  }
});

server.listen(3000);
