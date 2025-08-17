// example.js
require('dotenv').config();
const { getXeroAccessToken } = require('./xeroToken');

(async () => {
  const token = await getXeroAccessToken({
    email: process.env.XERO_EMAIL,
    password: process.env.XERO_PASSWORD,
    totpSecret: process.env.XERO_TOTP_SECRET,
    userDataDir: './xero-profile', // persists your login
    headful: true,                // set true once to trust device
    timeoutMs: 60000
  });

  console.log('Token:', token.access_token);
  console.log('Expires in:', token.expires_in, 'seconds');
})();
