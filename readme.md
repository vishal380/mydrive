# MyDrive

## Start the backend

Install the backend dependencies, configure the environment variables required by `backend/server.js` (`SESSION_SECRET`, database settings, and email settings), then run:

```powershell
cd backend
npm install
npm start
```

The frontend is served by the backend at `http://localhost:3000` by default.

## Try the authentication API

Use your own test account values; do not commit real passwords, email addresses, OTPs, or session cookies.

```powershell
$body = @{
    username = "test-user"
    email = "you@example.com"
    password = "use-a-local-test-password"
} | ConvertTo-Json

Invoke-RestMethod `
    -Uri "http://localhost:3000/api/auth/register" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body
```

Password reset endpoints are `/api/auth/forgot-password`, `/api/auth/verify-otp`, and `/api/auth/reset-password`.
