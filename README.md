# xero-token-extraction
Extract Xero Token with Playwright automation

Create a .env file and populate these values:

PORT=8080
API_KEY=Geveo123
XERO_EMAIL=email
XERO_PASSWORD=password
XERO_TOTP_SECRET=OTP value you received while setting up authenticator app
XERO_ORG_NAME=Default ORG name
USER_DATA_DIR=./xero-profile
EXPIRY_BUFFER_SEC=30
DEBUG=true
DEBUG_SHOTS=true 

Run funaction app as node server.js  
Call the API url curl -H "x-api-key: Geveo123" http://localhost:8080/token
