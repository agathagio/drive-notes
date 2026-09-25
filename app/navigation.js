// Drive Notes: history, back, edge swipe, diagnostics and the new version. Extends App (see app/core.js).

Object.assign(App, {
  // ── Navigation (back button, Android back gesture) ──

  // A view is described by { view: 'welcome' }, { view: 'file', id, name } or { view: 'browse', id, name, path }.
  //
  // Two ways to make the system back button walk through views instead of closing the app:
  // - CloseWatcher (useWatcher): the API Chrome gives apps for the Android back button. While one is
  //   active, "back" fires its close event and never touches the session history. The views left
  //   behind live in navStack. This is the one used wherever it exists.
  // - History API: one history entry per view, carrying its description; "back" lands on an entry
  //   and onPopState shows what it says.

  viewState() {
    // Read while a note is still loading, the screen would describe the view before it: two quick steps
    // (forward twice, two taps on the list) then left the same folder on the back stack more than once
    if (this._opening) return this._opening;
    const file = this.currentFile;
    if (file) return { view: 'file', id: file.id, name: file.name };
    if (this.folder) return { view: 'browse', ...this.folder };
    return { view: 'welcome' };
  },

  /** Show the view a description stands for; nothing to do if it is already on screen */
  show(state) {
    this.log(`show ${state?.view || 'welcome'} ${state?.name || ''}`);
    if (state?.view === 'file' && state.id) {
      if (state.id !== this.currentFile?.id) return this.openFile(state.id, state.name);
      if (this._opening) {
        // Back to the note on screen while another was on its way: give up on that one
        this._loadSeq++;
        this._opening = null;
        this.setSaveStatus('', '');
      }
    } else if (state?.view === 'browse') {
      if (this._opening || this.currentFile || this.folder?.id !== state.id) {
        return this.openFolder({ id: state.id, name: state.name, path: state.path || [], query: state.query || '' });
      }
    } else if (this.currentFile || this.folder || document.body.dataset.view !== 'welcome') {
      // (already there when a failed navigation is being undone: its error message stays on screen)
      this.goHome();
    }
  },

  /** Call synchronously from the tap that starts a navigation. In History mode Chrome's back button
      skips entries that were not created during a user gesture, so this cannot wait for the Drive. */
  beginNav() {
    if (this.useWatcher) {
      // A navigation still under way (looking a link up, a note loading) never reached the screen:
      // its entry already stands for the view being left
      const pushed = this._pending ? this._pending.pushed : true;
      if (!this._pending) this.navStack.push(this.viewState());
      this._pending = { pushed };
      this.fwdStack = []; // going somewhere new: nothing is "ahead" any more, as in a browser
      this.armWatcher();
    } else {
      history.pushState(this.viewState(), '');
    }
    this.log('beginNav');
  },

  /** The navigation begun never changed the view: forget it */
  cancelNav() {
    if (this.useWatcher) {
      if (this._pending?.pushed) this.navStack.pop();
      this._pending = null;
      this._opening = null;
      this.armWatcher();
    } else {
      history.back();
    }
    this.log('cancelNav');
  },

  /** History mode: make the current entry describe what is on screen */
  syncHistory() {
    if (!this.useWatcher) history.replaceState(this.viewState(), '');
  },

  /** Keep a CloseWatcher alive exactly while "back" has something to do inside the app.
      With none active, the system back button leaves the app, which is what the welcome screen wants. */
  armWatcher() {
    if (!this.useWatcher) return;
    const needed = this.navStack.length > 0 || !!this.sketch || !!document.querySelector('.modal-overlay.visible');
    if (needed && !this._watcher) {
      try {
        const watcher = new CloseWatcher();
        watcher.onclose = () => {
          this._watcher = null;
          this.log('watcher: close');
          this.handleBack();
        };
        this._watcher = watcher;
      } catch (e) {
        this.log(`watcher failed: ${e.message}`);
      }
    } else if (!needed && this._watcher) {
      this._watcher.destroy();
      this._watcher = null;
    }
  },

  /** One step back: close the dialog on top, or leave the drawing screen, or else return to the previous view */
  handleBack() {
    // The system back button is no touch on the page: a lift click still owed to a long press will not
    // come now, and left armed it would swallow the dismiss click below (a first "back" doing nothing)
    this._longPressed = null;
    const dismiss = document.querySelector('.modal-overlay.visible [data-dismiss]');
    if (this.Editor.closeLinkList()) {
      // The link list is the topmost thing on screen: "back" closes it and stops there
    } else if (dismiss) {
      dismiss.click();
    } else if (this.sketch) {
      this.sketchCancel();
    } else if (this._pending) {
      // Something tapped is still on its way (a link being looked up, a note loading): "back" gives up
      // on it and stays on the view that is on screen, instead of leaving it for the note to land later.
      // (A note that an earlier "back" is still loading is different: see viewState, back goes on from it.)
      this._loadSeq++;
      this.cancelNav();
      this.setSaveStatus('', '');
    } else {
      // The view being left is where a swipe from the right edge returns to. A note not yet on the Drive has no way back.
      const leaving = this.viewState();
      if (leaving.view === 'browse' || (leaving.view === 'file' && leaving.id)) this.fwdStack.push(leaving);
      // An entry for the view already on screen would make this "back" do nothing: skip it
      const same = (a, b) => a.view === b.view && (a.id || null) === (b.id || null);
      let target = this.navStack.pop();
      while (target && same(target, leaving)) target = this.navStack.pop();
      this.show(target || null);
    }
    this.armWatcher();
  },

  /** Swipe from the right edge: back into the view that "back" last left */
  async goForward() {
    if (!this.useWatcher) {
      history.forward();
      return;
    }
    const next = this.fwdStack.pop();
    if (!next) return;
    // Forward again while the last step is still loading: what is left behind is that step, not the screen
    this.navStack.push(this.viewState());
    this._pending = { pushed: true };
    this.armWatcher();
    if ((await this.show(next)) === false) {
      // Did not open (no network): the screen stayed where it was, and so do the two stacks
      this.cancelNav();
      this.fwdStack.push(next);
    }
  },

  // ── Edge swipe ──
  //
  // With the three-button bar Android has no back gesture, and the swipe Chrome offers in a tab does not
  // exist in an installed app. So the app has its own, with Chrome's meaning: a drag inwards from the left
  // edge is "back" (the same as the system button), from the right edge is "forward".

  swipeAllowed(side) {
    if (this.sketch) return false; // a stroke that starts at the edge is a stroke
    const dialog = !!document.querySelector('.modal-overlay.visible');
    if (side === 'left') return dialog || document.body.dataset.view !== 'welcome';
    return !dialog && (!this.useWatcher || this.fwdStack.length > 0);
  },

  onSwipeStart(e) {
    this._swipe = null;
    if (e.touches.length !== 1) return;
    const { clientX: x, clientY: y } = e.touches[0];
    const fromEdge = Math.min(x, window.innerWidth - x);
    const side = x < window.innerWidth / 2 ? 'left' : 'right';
    if (fromEdge > SWIPE_EDGE * 2 || !this.swipeAllowed(side)) return;
    // Dragging near the edge with text selected is moving a selection handle; and these scroll sideways themselves
    const selection = window.getSelection();
    const blocked = selection && !selection.isCollapsed ? 'selection' : e.target.closest?.('input, .toolbar, .table-wrap, pre') ? 'target' : '';
    // A start just outside the strip (or a blocked one) does nothing, but is followed so the diagnostics panel can tell
    const skip = blocked || (fromEdge > SWIPE_EDGE ? 'outside' : '');
    this._swipe = { side, x, y, pull: 0, armed: false, skip };
    if (!skip) this.log(`swipe ${side} x=${Math.round(x)}`);
  },

  onSwipeMove(e) {
    const swipe = this._swipe;
    if (!swipe) return;
    const { clientX, clientY } = e.touches[0];
    const pull = (clientX - swipe.x) * (swipe.side === 'left' ? 1 : -1);
    const drift = Math.abs(clientY - swipe.y);
    swipe.pull = Math.max(swipe.pull, pull);
    if (swipe.skip) return;
    // Clearly more down than across: that is the page scrolling. The first few px decide nothing:
    // a thumb starts its swipe in an arc, and dropping the gesture there made it hard to catch.
    if (drift > SWIPE_SCROLL && drift > pull) {
      this.log(`swipe drop: vertical pull=${Math.round(pull)} drift=${Math.round(drift)}`);
      this.endSwipe();
      return;
    }
    swipe.armed = pull >= SWIPE_TRIGGER;
    const hint = this.els.swipeHint;
    hint.textContent = swipe.side === 'left' ? '‹' : '›';
    hint.dataset.side = swipe.side;
    hint.style.top = `${swipe.y}px`;
    hint.style.setProperty('--pull', `${Math.max(0, Math.min(pull, SWIPE_TRIGGER + 20))}px`);
    hint.classList.toggle('visible', pull > 10);
    hint.classList.toggle('armed', swipe.armed);
  },

  /** Finger up (act = true) or gesture abandoned */
  endSwipe(act = false) {
    const swipe = this._swipe;
    this._swipe = null;
    this.els.swipeHint.classList.remove('visible', 'armed');
    if (!act || !swipe) return;
    const pull = Math.round(swipe.pull);
    if (swipe.skip) {
      // Only what looked like an attempt at the gesture is worth a line
      if (pull >= SWIPE_TRIGGER) this.log(`swipe miss (${swipe.skip}) ${swipe.side} x=${Math.round(swipe.x)} pull=${pull}`);
      return;
    }
    if (!swipe.armed || !this.swipeAllowed(swipe.side)) {
      if (pull > 10) this.log(`swipe end: short pull=${pull}`);
      return;
    }
    if (swipe.side === 'left') {
      this.log(`swipe: back pull=${pull}`);
      // History mode has no step for "close the dialog": goBack would leave the note behind it
      const dismiss = !this.useWatcher && document.querySelector('.modal-overlay.visible [data-dismiss]');
      if (dismiss) dismiss.click();
      else this.goBack('swipe');
    } else {
      this.log(`swipe: forward pull=${pull}`);
      this.goForward();
    }
  },

  /** Header back button */
  goBack(from = 'button') {
    this.log(`goBack (${from})`);
    if (this.useWatcher) {
      this.handleBack();
      return;
    }
    this._popped = false;
    history.back();
    // No entry of ours behind this one (should not happen): still leave the note
    setTimeout(() => {
      if (!this._popped) this.goHome();
    }, 500);
  },

  onPopState(state) {
    this._popped = true;
    this.log('popstate');
    if (!this.useWatcher) this.show(state);
  },

  /** Line for the hidden diagnostics panel (five taps on the welcome title) */
  log(message) {
    const time = new Date().toTimeString().slice(0, 8);
    this._log.push(`${time} ${message} | hist=${history.length} stack=${this.navStack.length} watcher=${this._watcher ? 1 : 0}`);
    if (this._log.length > 60) this._log.shift();
  },

  /** The cache serving the app, for the panel. Best effort: it answers long before five taps land
      on the title, and where there is no cache at all the panel says so instead of lying. */
  async readVersion() {
    try {
      const keys = await caches.keys();
      this._version = keys.filter((k) => k.startsWith('drivenotes-')).join(', ') || 'sem cache';
    } catch (e) {
      this._version = 'indisponível';
    }
  },

  showDiagnostics() {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? '?';
    document.getElementById('debug-text').textContent = [
      `versão: ${this._version}`,
      `editor: ${this.Editor.kind()}`,
      `modo de voltar: ${this.useWatcher ? 'CloseWatcher' : 'History API'}`,
      `instalado (standalone): ${standalone}`,
      `view: ${document.body.dataset.view}`,
      navigator.userAgent,
      '',
      ...this._log,
    ].join('\n');
    document.getElementById('debug-overlay').classList.add('visible');
    this.armWatcher();
  },

  // ── New version ──
  //
  // The service worker is cache-first, so the opening that finds a new version is already running the
  // old one. The new one downloads behind it and takes over (skipWaiting, clients.claim), and the page
  // hears `controllerchange`; before this, nothing listened, and a deploy took two or three openings to
  // show. Now: on the home screen, with nothing that could be lost, the page reloads on its own; anywhere
  // else a bar offers the update, and tapping it saves, reloads and comes back to the same view. Text not
  // yet on the Drive never reloads.

  /** Called by index.html with navigator.serviceWorker, as the page loads */
  watchVersions(container) {
    // The very first opening (or one after the site data was cleared) has no service worker behind it,
    // and hears controllerchange too, when the first one takes over: that one is not a new version.
    // Any change after it is.
    let controlled = !!container.controller;
    container.register('./sw.js')
      .then((registration) => { this._swRegistration = registration; })
      .catch((err) => console.warn('SW registration failed:', err));
    container.addEventListener('controllerchange', () => {
      if (!controlled) {
        controlled = true;
        this.log('service worker: first install');
        return;
      }
      this.log('new version');
      if (this._updateReady) return;
      this._updateReady = true;
      this.offerUpdate();
    });
    // Android often brings the app back from the background instead of loading it again, and only a
    // load looks for a new version by itself
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._swRegistration?.update().catch(() => {});
    });
  },

  /** With a new version in charge: reload where nothing can be lost, offer it anywhere else */
  offerUpdate() {
    if (!this._updateReady || this._reloading) return;
    if (this.safeToReload()) {
      this.reloadForUpdate();
    } else {
      this.els.updateBar?.classList.remove('hidden');
    }
  },

  /** The home screen with nothing on it: no note, no folder, nothing on its way, no dialog, no drawing */
  safeToReload() {
    return document.body.dataset.view === 'welcome' && !this.currentFile && !this.folder && !this.isDirty
      && !this._opening && !this._pending && !this.sketch && !document.querySelector('.modal-overlay.visible');
  },

  /** The reload on its own, from the home screen: after whatever is still on its way to the Drive */
  async reloadForUpdate() {
    this._reloading = true;
    await this._saveChain;
    // A tap during the wait may have left the home screen
    if (!this.safeToReload()) {
      this._reloading = false;
      this.offerUpdate();
      return;
    }
    this.log('reload: new version');
    this.reloadPage();
  },

  /** The bar: the open note goes to the Drive first, then the reload, coming back to the same view. In
      edit mode the package also carries the editor's top line (editorLine): the editor may have been
      scrolled far from where the reading was when Editar was tapped. */
  async applyUpdate() {
    if (this._reloading) return;
    this._reloading = true;
    if (this.isDirty) await this.save({ manual: true });
    await this._saveChain;
    // Not on the Drive (no network, a conflict, the login): the save status already says why, and the
    // bar stays for another try. Reloading would leave the text behind as a draft, at best.
    if (this.isDirty) {
      this._reloading = false;
      return;
    }
    try {
      const view = this.viewState();
      const kept = { view, mode: this.mode, navStack: this.navStack, fwdStack: this.fwdStack };
      // Read only with the editor on screen and showing that note: hidden, CodeMirror's geometry means nothing
      if (this.mode === 'edit' && view.view === 'file' && view.id === this.currentFile?.id && document.body.dataset.view === 'edit') {
        kept.editorLine = this.Editor.topLine();
      }
      sessionStorage.setItem(KEYS.REOPEN, JSON.stringify(kept));
    } catch (e) {
      console.warn('View not kept for the reload:', e);
    }
    // Where the reading was comes back with the note's own opening (landInNote). In edit mode it keeps
    // nothing, on purpose: the reading's place stays the one kept when Editar was tapped.
    this.rememberPlace();
    this.log('reload: new version, from the bar');
    this.reloadPage();
  },

  // The package is kept in sessionStorage (KEYS.REOPEN): it survives a reload, and dies with the app, where a reopening has no business

  /** Right after the reload from the bar: back to the view it was tapped on, in the same mode, and with
      "back" going where it went before. The reading view comes back where it was, as in any opening
      (landInNote). The editor comes back on the line it had (the package's editorLine), also for a note
      that reopens straight into the editor with its draft. A package without editorLine was written by
      a version before it (the page that taps the bar is the old one): the editor then opens on the
      stretch the reading view is on (editAtReading). */
  async reopenAfterUpdate() {
    let kept = null;
    try {
      kept = JSON.parse(sessionStorage.getItem(KEYS.REOPEN));
      sessionStorage.removeItem(KEYS.REOPEN);
    } catch { /* nothing to reopen */ }
    if (!kept?.view || kept.view.view === 'welcome') return;
    this.log(`reopen ${kept.view.view} ${kept.view.name || ''}`);
    // History mode needs nothing: the reload keeps the session history, entries and all
    if (this.useWatcher) {
      this.navStack = kept.navStack || [];
      this.fwdStack = kept.fwdStack || [];
      this.armWatcher();
    }
    const landed = await this.show(kept.view);
    if (landed === false) {
      // Did not open (no network, no login): home, where "back" leaves the app
      this.navStack = [];
      this.fwdStack = [];
      this.armWatcher();
      return;
    }
    if (kept.mode === 'edit' && kept.view.view === 'file' && this.currentFile?.id === kept.view.id) {
      if (typeof kept.editorLine === 'number') {
        // On screen first: CodeMirror scrolls in its measuring pass, and hidden it can only guess line heights
        if (this.mode !== 'edit') this.setMode('edit');
        this.Editor.showLine(kept.editorLine);
      } else if (this.mode === 'preview') {
        this.editAtReading();
      }
    }
  },

  reloadPage() {
    location.reload();
  },
});
