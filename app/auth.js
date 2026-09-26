// Drive Notes: Google login and the access token. Extends App (see app/core.js).
//
// The login is the authorization code flow of Google Identity Services. The popup answers a code; the
// Worker at CONFIG.AUTH_URL (worker/index.js), which holds the client secret, trades it for an access
// token (an hour) and a refresh token (until revoked). Renewing is a plain fetch to the Worker, with no
// window and no tap, so the hour passing is never felt. The popup is only for a device with no refresh
// token (the first login, after signing out, after Google revokes), and it only opens from a tap: the
// phone's browser blocks it anywhere else. See design/login-permanente-design.md in the vault.

Object.assign(App, {
  // ── Google Auth ──

  onGisLoaded() {
    // Nothing to set up: the code client is made per request, with the account learned so far
  },

  /** A code client for one popup. Made on the spot because login_hint only goes in at creation, and the
      account is learned after the first login and forgotten on signing out. Throws when the Google
      script has not loaded (an opening without network): the caller fails clean. */
  makeCodeClient() {
    const hint = localStorage.getItem(KEYS.LOGIN_HINT);
    return google.accounts.oauth2.initCodeClient({
      client_id: CONFIG.CLIENT_ID,
      scope: SCOPES,
      ux_mode: 'popup',
      ...(hint ? { login_hint: hint } : {}),
      callback: (response) => { if (this._codeCallback) this._codeCallback(response); },
      // Popup blocked or closed: fail the pending request instead of leaving it hanging
      error_callback: (err) => { if (this._authReject) this._authReject(err); },
    });
  },

  /** Save token + expiry to localStorage (persists across PWA restarts) */
  saveToken(accessToken, expiresIn) {
    this.accessToken = accessToken;
    const expiresAt = Date.now() + (expiresIn || 3600) * 1000;
    localStorage.setItem(KEYS.TOKEN, accessToken);
    localStorage.setItem(KEYS.TOKEN_EXPIRES, expiresAt.toString());

    this.scheduleTokenRefresh(expiresAt);
    this.rememberLoginHint();
    this.renderAccount();
  },

  /** Learn the account email once, so later logins skip the account chooser.
      Kept in localStorage only: the repo is public, so it must not live in CONFIG. */
  async rememberLoginHint() {
    if (localStorage.getItem(KEYS.LOGIN_HINT)) return;
    try {
      const response = await fetch(
        'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
        { headers: { 'Authorization': `Bearer ${this.accessToken}` } }
      );
      if (!response.ok) return;
      const email = (await response.json()).user?.emailAddress;
      if (email) {
        localStorage.setItem(KEYS.LOGIN_HINT, email);
        this.renderAccount();
      }
    } catch {
      // ignore: the hint is a convenience
    }
  },

  /** Restore token from localStorage if still valid. Falls back to legacy sessionStorage. */
  restoreToken() {
    const token = localStorage.getItem(KEYS.TOKEN)
      || sessionStorage.getItem(KEYS.TOKEN);
    const expiresAt = parseInt(
      localStorage.getItem(KEYS.TOKEN_EXPIRES)
      || sessionStorage.getItem(KEYS.TOKEN_EXPIRES)
      || '0'
    );

    if (token && expiresAt > Date.now() + 60000) {
      // Token exists and has more than 1 minute left
      this.accessToken = token;
      this.scheduleTokenRefresh(expiresAt);
      console.log('Drive Notes: token restored, expires in', Math.round((expiresAt - Date.now()) / 60000), 'min');
    }
    this.renderAccount();
  },

  /** Renew 5 minutes before expiry, while the app is in the foreground. Best effort: a failure here is
      nothing, the next trip to the Drive renews on its own (driveFetch). */
  scheduleTokenRefresh(expiresAt) {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);

    const refreshIn = expiresAt - Date.now() - 5 * 60 * 1000;
    if (refreshIn <= 0) return;

    this._refreshTimer = setTimeout(() => {
      if (localStorage.getItem(KEYS.REFRESH_TOKEN)) this.refreshQuietly().catch(() => {});
    }, refreshIn);
  },

  /** True while the token in hand has more than a minute left */
  hasValidToken() {
    const expiresAt = parseInt(
      localStorage.getItem(KEYS.TOKEN_EXPIRES)
      || sessionStorage.getItem(KEYS.TOKEN_EXPIRES)
      || '0'
    );
    return !!this.accessToken && expiresAt > Date.now() + 60000;
  },

  /** A token can be had without a window: one in hand, or a refresh token to get one with.
      The question every screen asks before touching the Drive outside a tap. */
  canRenewQuietly() {
    return this.hasValidToken() || !!localStorage.getItem(KEYS.REFRESH_TOKEN);
  },

  /** POST to the Worker. Answers Google's JSON; throws with `code` = Google's error name (invalid_grant
      when the refresh token is dead), or without one for anything else (no network, Worker down, a 5xx page). */
  async askWorker(body) {
    const response = await fetch(CONFIG.AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(answer.error || `auth ${response.status}`);
      if (answer.error) err.code = answer.error;
      throw err;
    }
    return answer;
  },

  /** Renew the access token with the refresh token, no window. Callers at the same time share one request.
      Google saying the refresh token is dead (invalid_grant) forgets it; any other failure is thrown as is. */
  refreshQuietly() {
    if (this._refreshing) return this._refreshing;
    const refreshToken = localStorage.getItem(KEYS.REFRESH_TOKEN);
    if (!refreshToken) return Promise.reject(loginNeeded());
    this._refreshing = this.askWorker({ grant_type: 'refresh_token', refresh_token: refreshToken })
      .then((answer) => {
        this.saveToken(answer.access_token, answer.expires_in);
        return this.accessToken;
      }, (e) => {
        if (e.code === 'invalid_grant') {
          localStorage.removeItem(KEYS.REFRESH_TOKEN);
          this.log('refresh token revoked');
          this.renderAccount();
        }
        throw e;
      })
      .finally(() => { this._refreshing = null; });
    return this._refreshing;
  },

  /** A valid token, in three steps: the one in hand; a renewal with the refresh token, silently; the popup.
      With `quiet` the popup step rejects instead (err.code 'login_needed'): that is what runs outside a tap. */
  async ensureAuth({ quiet = false } = {}) {
    if (this.hasValidToken()) {
      return this.accessToken;
    }

    this.accessToken = null;
    if (localStorage.getItem(KEYS.REFRESH_TOKEN)) {
      try {
        return await this.refreshQuietly();
      } catch (e) {
        // A dead refresh token falls through to the popup; anything else (no network, Worker down) is the caller's
        if (e.code !== 'invalid_grant') throw e;
      }
    }
    if (quiet) throw loginNeeded();
    return this.requestToken();
  },

  /** Ask Google for a code through the popup and trade it at the Worker. Always settles: a blocked popup,
      an error or 3 minutes of silence reject, so a save waiting on it falls back to the local draft. */
  requestToken() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('auth timeout')), 180000);
      const finish = () => {
        clearTimeout(timer);
        this._authReject = null;
        this._codeCallback = null;
      };
      const fail = (err) => { finish(); reject(err); };
      this._authReject = fail;
      this._codeCallback = (response) => {
        finish();
        if (!response || response.error || !response.code) {
          reject(response || new Error('no code'));
          return;
        }
        this.exchangeCode(response.code).then(resolve, reject);
      };
      let client;
      try {
        client = this.makeCodeClient();
      } catch (e) {
        fail(e); // the Google script has not loaded (an opening without network)
        return;
      }
      client.requestCode();
    });
  },

  /** Trade the popup's code for the tokens. The refresh token is what makes the login permanent; the
      exchange should always bring one (the code flow asks for offline access), and if it does not, the
      hour's token is kept and the panel says so. */
  async exchangeCode(code) {
    const answer = await this.askWorker({ grant_type: 'authorization_code', code });
    if (answer.refresh_token) {
      localStorage.setItem(KEYS.REFRESH_TOKEN, answer.refresh_token);
    } else {
      this.log('login without refresh token');
    }
    this.saveToken(answer.access_token, answer.expires_in);
    return this.accessToken;
  },

  /** Re-authenticate after a 401: the token in hand is dropped, then the same three steps as ensureAuth */
  async reAuth({ quiet = false } = {}) {
    this.accessToken = null;
    localStorage.removeItem(KEYS.TOKEN);
    localStorage.removeItem(KEYS.TOKEN_EXPIRES);
    sessionStorage.removeItem(KEYS.TOKEN);
    sessionStorage.removeItem(KEYS.TOKEN_EXPIRES);
    return this.ensureAuth({ quiet });
  },

  /** The foot of the home screen: the account signed in, and the way out. Shown while the device keeps
      anything of a login (a refresh token, a token, the email); the email once it has been learned. */
  renderAccount() {
    const box = document.getElementById('welcome-account');
    if (!box) return;
    const signedIn = !!(localStorage.getItem(KEYS.REFRESH_TOKEN) || localStorage.getItem(KEYS.TOKEN) || localStorage.getItem(KEYS.LOGIN_HINT));
    box.classList.toggle('hidden', !signedIn);
    document.getElementById('welcome-email').textContent = localStorage.getItem(KEYS.LOGIN_HINT) || 'Conta Google';
  },

  /** Sign out: revoke at Google, wipe everything the app keeps on this device, start over. Needs the network
      (the revoke is the point) and waits for whatever is still on its way to the Drive, so that no text is
      lost to the wipe. Answers true when it went through. */
  async signOut() {
    if (navigator.onLine === false) {
      this.setSaveStatus('error', 'Sem rede: sair da conta precisa de conexão');
      return false;
    }
    await this._saveChain; // a save queued before the tap lands first
    const drafts = this.listDrafts();
    let text = 'O app esquece o login e apaga o que guardou neste aparelho: notas vistas, recentes e rascunhos.';
    if (drafts.length) {
      const names = drafts.map((d) => d.name || 'sem-titulo.md').join(', ');
      text += drafts.length === 1
        ? ` 1 rascunho ainda não está no Drive: ${names}. Sair apaga ele.`
        : ` ${drafts.length} rascunhos ainda não estão no Drive: ${names}. Sair apaga eles.`;
    }
    if (!(await this.confirmDialog('Sair da conta', text, 'Sair'))) return false;

    // The refresh token is what to revoke: it takes the grant with it. The endpoint takes a browser call.
    const token = localStorage.getItem(KEYS.REFRESH_TOKEN) || this.accessToken || localStorage.getItem(KEYS.TOKEN);
    if (token) {
      try {
        // A 400 (token already dead) counts as revoked; only no answer at all stops the sign-out
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      } catch (e) {
        console.warn('Revoke failed:', e);
        this.setSaveStatus('error', 'Não deu pra sair: tente de novo');
        return false;
      }
    }
    await this.wipeDevice();
    this.renderAccount();
    this.reloadPage();
    return true;
  },

  /** Forget everything the app keeps on this device: the login, the recents, the drafts, the notes seen,
      the shares waiting. The service worker's cache stays: it is the app, not data. */
  async wipeDevice() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this.accessToken = null;
    this._refreshing = null;
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key && key.startsWith('drivenotes_')) storage.removeItem(key);
      }
    }
    await Promise.all([this.NoteStore.wipe(), this.ArrivalBox.wipe()]);
  },
});

/** The error of a token that cannot be had without a window */
function loginNeeded() {
  const err = new Error('login needed');
  err.code = 'login_needed';
  return err;
}

// ── Google Identity callback (called from script onload in index.html) ──
function onGisLoaded() {
  App.onGisLoaded();
}
