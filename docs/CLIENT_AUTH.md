# Client guide: sessions, app lock and tokens

How the mobile app should handle sign-in. The backend side is done (see the README, "Sessions"); everything below
is behaviour the **app** must implement. Two separate things are involved:

| | Proves | Where it lives | Lifetime |
|---|---|---|---|
| **Local unlock** (password/PIN/biometrics) | The person holding the phone is the owner | On the device only. The server never sees it. | Until the app is backgrounded or closed |
| **Server session** (access + refresh token) | The device may talk to the server as this user | Secure storage | Access 1 hour, refresh 7 days (renewed on every refresh) |

Local unlock never replaces the server session, and the server session never replaces local unlock.

## Storage

- Keep `refreshToken` in the platform's secure storage: iOS Keychain (accessible `WhenUnlockedThisDeviceOnly`),
  Android Keystore-backed storage (e.g. EncryptedSharedPreferences). Never in plain preferences, files, logs or a database.
- Keep the access token **in memory only**. It is short-lived and cheap to get again with the refresh token.
- **Never store the user's password**, in any form, anywhere on the device. The password is sent once, at login, and dropped.
  Don't put it in tokens, secure storage, or crash/analytics payloads. A PIN or biometric is a local gate, not a server credential.
- Exclude the secure-storage entry from device backups / cloud sync, so the token stays on this device.

## Lifecycle

1. **Full login** (`POST /api/auth/login` or `/register`): send the password, receive `token`, `expiresIn`, `refreshToken`.
   Save the refresh token to secure storage, keep the access token in memory, discard the password.
2. **Launch** (cold start): the app starts **locked**. Show only the unlock screen; load no user data and make no API calls yet.
3. **Unlock**: ask for the device password/PIN or biometrics (Face ID / Touch ID / Android BiometricPrompt, with the
   device-credential fallback). Do this on **every launch**, with no "remember me" skip.
4. **After a successful unlock**: read the refresh token from secure storage and call `POST /api/auth/refresh`.
   Store the returned `refreshToken` **before** using the new access token (see rotation below), then open the app.
   Prefer to make the biometric prompt the thing that gates the secure-storage read, so the token cannot be read without it.
5. **Background / close**: lock again immediately when the app goes to the background (or after a short grace period
   you choose, e.g. 0 to 30 seconds), and clear the in-memory access token and any cached user data. On return, go back to step 3.
6. **Normal use**: send `Authorization: Bearer <token>`. When a request returns `401`, or `expiresIn` is nearly up, refresh once
   (step 4), then retry the request once. Allow only one refresh at a time; make other waiting requests share its result.
7. **Logout**: call `POST /api/auth/logout` with the refresh token, then delete it from secure storage and clear memory.

## Reacting to the server

| Response | Meaning | App should |
|---|---|---|
| `/refresh` → `200` | New access + refresh token | Save the new refresh token, continue |
| `/refresh` → `401` | Refresh token expired (7 days idle), already used, revoked, or password was reset | Delete stored tokens and show the **full login** screen |
| Any API call → `401` after a successful refresh | Account deleted or password reset since | Same: full login |
| `429`, `503`, no network | Temporary | Keep the tokens, show "try again". **Do not** log the user out |

Only a `401` from `/refresh` ends the session. A network failure must never wipe the stored refresh token.

## Refresh-token rotation: avoid locking yourself out

Each refresh token works **once**. The server replaces it with a new one, and reusing an old one revokes the whole login.

- Write the new `refreshToken` to secure storage as soon as the response arrives, before anything else.
- Never run two refreshes at the same time with the same token (a second tab/process/background task would trigger the reuse protection).
- If the response is lost in transit (the app was killed mid-refresh), the stored token is now spent and the next
  attempt returns `401`. Accept the rare full login that results. Don't send an `Idempotency-Key` on `/refresh` to work around it:
  the server would cache the response, new refresh token included, for 5 minutes.

## Password reset

`POST /api/auth/forgot-password`, then `POST /api/auth/reset-password`. A successful reset signs the account out everywhere, so
after it the app must clear its stored tokens and go to the full login screen. Any local PIN stays valid (it is not the account password).
