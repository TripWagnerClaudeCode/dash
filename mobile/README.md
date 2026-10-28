# Dash for iPhone

The phone side of Dash: an [Expo](https://expo.dev) app that runs inside **Expo Go**, so there's no Xcode build and no
7-day free-provisioning expiry. Everything it shows comes from the [Dash hub](../hub/README.md) on the always-on PC. So
it works with the Mac closed, and the phone and Mac Dash always show the same to-do list, chats, portfolio and memory.

```
iPhone (Expo Go) ──Tailscale──► tailscale serve on dash-hub (https, your devices only) ──► the hub
```

| Tab / screen | What it does |
|---|---|
| **Today** | The brief, to-do, deadlines (confirm or check off), the next 7 days, the inbox |
| **Chats** | Hub chats with Approve/Deny cards, off-the-record and check-in chats |
| **Portfolio** | Live holdings and the advisor |
| **Lecture** | Starts and stops recording on the Mac |
| **Study** | Skill launchers |
| **Memory**, **Settings** | What Dash remembers; pairing and notification setup |

## One-time setup

1. Install [Tailscale](https://tailscale.com) on the Mac and the iPhone, and sign in to the same account on both.
2. Publish the hub to your tailnet. The hub keeps this setting across restarts.
   ```sh
   tailscale serve --bg http://127.0.0.1:47900
   ```
3. Install **Expo Go** from the App Store.
4. For notifications, install the **ntfy** app and subscribe to the server and topic shown in Dash › Settings.

## Running it

There's nothing to start: the hub serves the app all the time from Metro (`dash-metro.service`).
- In Expo Go, open `exp://<hub's Tailscale IP>:8081` once (`tailscale ip -4` on the hub). After that it's in Expo
  Go's recent list.
- `hub/deploy/deploy.sh` restarts Metro with each change.

**To pair:**
1. On the Mac, open Dash › Settings › Dash hub › Pair a Phone….
2. Scan that code from the app's Pair screen.

The token is kept in the iPhone's Keychain. To sign the phone out, remove it from the device list in the same Settings
section. Lecture recording is the one thing that needs the Mac open.

`./start-phone.sh` is only for working on the app from the Mac: it serves your local copy to Expo Go over Tailscale
instead of the hub's.

## Developing on the Mac

```sh
(cd ../hub && npm run dev)       # a throwaway hub on ws://127.0.0.1:47910
                                 # pairing code: DASH_DATA=./.dev-data npm run pair -- phone
npx expo start --web             # the app in a browser; pair with ws://127.0.0.1:47910
npx tsc --noEmit                 # type-check before deploying (deploy.sh runs it too)
```

`cd ../hub && npm run selftest` checks pairing, sign-in, to-do sync and the lecture relay without the app.
[`AGENTS.md`](AGENTS.md) has Expo conventions for coding agents.

## Code map

| File | Role |
|---|---|
| `src/lib/hub.ts` | The WebSocket client (sign-in, reconnect with backoff, heartbeat, requests, events) and the message types |
| `src/lib/hub-context.tsx` | Holds the connection and the latest data for every screen, with an offline cache |
| `src/lib/chats.ts`, `src/lib/storage.ts` | Chat helpers; secure storage for the pairing token |
| `src/app/(tabs)/` | Today (`index.tsx`), Chats, Portfolio, Lecture, Study |
| `src/app/chat/[id].tsx`, `memory.tsx`, `settings.tsx`, `pair.tsx` | One chat; Memory; Settings; QR scan or typed address and code |
| `src/components/ui.tsx` | Cards, buttons, the connection line, a small markdown renderer |
