# Order Up Mobile (React Native)

This folder contains a React Native / Expo app for running Order Up from a phone.

## What it does

- Connects to your existing Order Up backend (`app/server.ts`)
- Shows initiative and PR status from `/api/status`
- Lets you switch tool profile via `/api/settings`
- Triggers fix actions:
  - `POST /api/fix-all-issues`
  - `POST /api/finish-pr`
  - `POST /api/fix-check`

The Electron app remains unchanged and can run alongside this app.

## Run locally

```bash
cd mobile
npm install
npm run start
```

Then open the Expo QR code in Expo Go.

## Pointing your phone to the server

Your phone cannot use `localhost` for your laptop's server.

1. Start Order Up backend:
   ```bash
   cd app
   npm run dev
   ```
2. Find your computer LAN IP (example: `192.168.1.25`).
3. In the mobile app, set server URL to:
   `http://192.168.1.25:3333`
4. Tap **Save URL**.

You can also preconfigure at startup:

```bash
cd mobile
EXPO_PUBLIC_ORDER_UP_API_URL="http://192.168.1.25:3333" npm run start
```

## Simulator notes

- iOS Simulator can usually use `http://localhost:3333`
- Android Emulator should use `http://10.0.2.2:3333`
