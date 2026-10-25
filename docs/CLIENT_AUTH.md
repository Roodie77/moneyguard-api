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

## Web apps: staying signed in when the page is refreshed

**Symptom:** the user presses F5 (or reloads the tab) and lands on the login page instead of their dashboard.

**Cause:** the app kept the tokens only in memory (a variable or component state). A page reload wipes all memory, so the app thinks nobody is signed in. The server did nothing wrong: logging in again shows all the data, because it is stored on the server.

**Fix:** keep the **refresh token** somewhere that survives a reload, and use it when the app starts.

1. After login, register or refresh, save the **new** `refreshToken` in `localStorage` (or `sessionStorage` if it should end when the tab closes). Keep the access token in memory.
2. When the app starts, **before** showing any page: if there is a refresh token in storage, call `POST /api/auth/refresh`, save the new pair, then load the dashboard. While that runs, show a loading screen, **not** the login page.
3. Only a `401` from `/api/auth/refresh` means "log in again": delete the stored token and show the login page. A network error, `429` or `503` must keep the token and show "try again".

```js
let inFlight = null; // one refresh at a time, shared by everyone who asks

export function restoreSession() {
  inFlight ??= (async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) throw new Error('signed-out');
    const res = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (res.status === 401) { localStorage.removeItem('refreshToken'); throw new Error('signed-out'); }
    if (!res.ok) throw new Error('try-again'); // keep the token
    const data = await res.json();
    localStorage.setItem('refreshToken', data.refreshToken); // save the NEW one first
    accessToken = data.token;
    return data;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
```

**The trap that logs people out even when this is done:** each refresh token works **once**. If the same token is sent twice, the second call gets `401` and the server cancels the whole login (that is its theft protection). Two things cause a double send:

- **React 18 StrictMode** runs effects twice in development, so the start-up refresh fires twice. The shared `inFlight` promise above prevents it. (Do not "fix" it by turning StrictMode off.)
- **Several requests failing with 401 at the same moment** (for example when the access token expires). They must all wait for **one** refresh, not each start their own. The same `inFlight` promise handles it.

Two browser tabs refreshing at the same moment can also collide. If that matters, use `navigator.locks.request('refresh', ...)` around the refresh call.

**After changing the password** (`PUT /api/me/password`) the answer is a **new session** for this device, and every other login is ended. Replace the stored refresh token and the in-memory access token with it right away. Skipping this logs the user out on the next request, which looks like "it logged me out when I changed my password".

**Account deletion (24-hour grace period).** `DELETE /api/me` does not log the user out and does not delete anything yet: the session keeps working so the user can see the pending notice and cancel. Show a banner from `accountStatus` / `accountDeletion` (on `GET /api/me`, the dashboard and the login answer). When the deadline passes, the account is deleted: the next request gets `401 Account not found`, the refresh call also gets 401, and the helper reports `SessionError('signed-out')`, which sends the user to the login screen (where the old email now answers 401, or can be registered again as a new account).

**Trade-off to know:** anything in `localStorage` can be read by a script injected into the page (XSS), so keep the app free of untrusted HTML. A mobile app should use the Keychain or Keystore instead, as described above.
