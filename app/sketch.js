// Drive Notes: the drawing screen. Extends App (see app/core.js).

Object.assign(App, {
  // ── Sketch (the drawing screen) ──

  // The palette lives here, not in the CSS, because the strokes are painted from it. The CSS only
  // needs the purple, for the selected ring and the active button. See desenho-na-nota-design.
  SKETCH_COLORS: ['#9b94a6', '#8b6cef', '#e0645c', '#c47f2e', '#369680', '#4b8fe3'],

  SKETCH_WIDTHS: [3, 6, 12],

  SKETCH_MARGIN: 16,

  /** The box the exported PNG is cropped to: everything the ink touches, plus each stroke's half
      width (its round cap sticks out that far) and a margin. Eraser strokes lay down no ink, so
      they never grow the box. Null when nothing was drawn. Coordinates are screen points and may
      go negative, for a stroke against the edge. */
  sketchBounds(strokes) {
    let box = null;
    for (const stroke of strokes) {
      if (stroke.erase) continue;
      const pad = stroke.width / 2;
      for (const p of stroke.points) {
        if (!box) box = { left: p.x - pad, top: p.y - pad, right: p.x + pad, bottom: p.y + pad };
        else {
          box.left = Math.min(box.left, p.x - pad);
          box.top = Math.min(box.top, p.y - pad);
          box.right = Math.max(box.right, p.x + pad);
          box.bottom = Math.max(box.bottom, p.y + pad);
        }
      }
    }
    if (!box) return null;
    const m = this.SKETCH_MARGIN;
    return { x: box.left - m, y: box.top - m, width: (box.right - box.left) + m * 2, height: (box.bottom - box.top) + m * 2 };
  },

  /** Open the drawing screen over the editor. Only from the edit view, with a note open. */
  sketchOpen() {
    if (this.mode !== 'edit' || !this.currentFile || this.sketch) return;
    // The caret is read before the blur: it is the place where the drawing was asked for, and that
    // is what the mark has to keep. The mark itself survives the blur and the edits that come after
    const at = this.Editor.markCaret();
    // Without the blur the keyboard sits over half the canvas
    document.activeElement?.blur?.();

    this.sketch = {
      canvas: this.els.sketchCanvas, ctx: null, dpr: 1,
      strokes: [], stroke: null,
      color: this.SKETCH_COLORS[0], width: 6, erase: false, at,
    };
    this.els.sketchScreen.classList.add('visible');
    this.sketchResize();
    this.sketchRenderTools();
    this.armWatcher();
    this.log('sketch: open');
  },

  /** Leave the screen. Nothing here touches the note: that is sketchFinish's job. */
  sketchClose() {
    this.els.sketchScreen.classList.remove('visible');
    this.sketch = null;
    this.armWatcher();
    this.log('sketch: close');
  },

  /** This screen covers the app header, which is where setSaveStatus writes, so it has to carry its
      own "sending" state: without it a tap on ✓ looks like nothing happened, and the next tap starts
      a second upload. Everything on the screen stops taking taps, including the canvas, so a
      frustrated tap does not turn into a stroke. */
  sketchBusy(on) {
    this.els.sketchScreen.classList.toggle('sketch-sending', on);
    this.els.sketchDone.disabled = on;
    this.els.sketchCancel.disabled = on;
    document.querySelector('.sketch-title').textContent = on ? 'Enviando...' : 'Desenho';
  },

  /** ✕ and the system back button. A drawing with ink in it is never thrown away without asking;
      an untouched screen just closes. */
  async sketchCancel() {
    // The back button reaches this without going through the (disabled) ✕
    if (!this.sketch || this.sketch.busy) return;
    if (this.sketchBounds(this.sketch.strokes)) {
      const discard = await this.confirmDialog('Descartar o desenho?', 'O desenho não vai pra nota.', 'Descartar');
      // Back may have been pressed again while the dialog was up
      if (!discard || !this.sketch) return;
    }
    this.sketchClose();
  },

  /** Size the backing store in device pixels and repaint. Without the dpr the stroke comes out
      jagged on a phone and the 3px one nearly disappears. Setting canvas.width wipes the context
      state, so the scale and the round caps are set again every time. Also the rotation handler:
      the strokes are repainted at the new size, with their coordinates untouched. */
  sketchResize() {
    const s = this.sketch;
    if (!s) return;
    s.dpr = window.devicePixelRatio || 1;
    const width = s.canvas.clientWidth || window.innerWidth;
    const height = s.canvas.clientHeight || window.innerHeight;
    s.canvas.width = Math.round(width * s.dpr);
    s.canvas.height = Math.round(height * s.dpr);
    s.ctx = s.canvas.getContext('2d');
    if (s.ctx) {
      s.ctx.scale(s.dpr, s.dpr);
      s.ctx.lineCap = 'round';
      s.ctx.lineJoin = 'round';
    }
    this.sketchRepaint();
  },

  /** The colour row is built from SKETCH_COLORS, so the palette is written down in one place only */
  sketchRenderTools() {
    const s = this.sketch;
    if (!s) return;
    const row = this.els.sketchColors;
    if (!row.children.length) {
      for (const color of this.SKETCH_COLORS) {
        const btn = document.createElement('button');
        btn.className = 'sketch-swatch';
        btn.style.background = color;
        btn.dataset.sketchColor = color;
        btn.setAttribute('aria-label', `Cor ${color}`);
        row.appendChild(btn);
      }
    }
    for (const btn of row.children) btn.classList.toggle('sketch-active', !s.erase && btn.dataset.sketchColor === s.color);
    for (const btn of document.querySelectorAll('[data-sketch-width]')) btn.classList.toggle('sketch-active', Number(btn.dataset.sketchWidth) === s.width);
    this.els.sketchErase.classList.toggle('sketch-active', s.erase);
  },

  /** Where a pointer event lands on the canvas, in screen points (the context is already dpr-scaled) */
  sketchPoint(e) {
    const rect = this.sketch.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  },

  sketchDown(e) {
    const s = this.sketch;
    if (!s) return;
    e.preventDefault();
    // Keep the stroke fed even if the finger wanders off the canvas
    s.canvas.setPointerCapture?.(e.pointerId);
    s.stroke = { color: s.color, width: s.width, erase: s.erase, points: [this.sketchPoint(e)] };
    s.strokes.push(s.stroke);
    this.sketchPaintStroke(s.stroke);
  },

  sketchMove(e) {
    const s = this.sketch;
    if (!s || !s.stroke) return;
    e.preventDefault();
    const from = s.stroke.points.length;
    // Android delivers the finger's points in batches and only the last of each frame reaches
    // pointermove: without the swallowed ones a quick stroke comes out as a chain of straight lines.
    // The list is empty in browsers that do not have it (and in jsdom), so the event itself is the fallback.
    const batch = e.getCoalescedEvents?.() ?? [];
    for (const point of (batch.length ? batch : [e])) s.stroke.points.push(this.sketchPoint(point));
    this.sketchPaintStroke(s.stroke, from);
  },

  sketchUp(e) {
    const s = this.sketch;
    if (!s || !s.stroke) return;
    s.canvas.releasePointerCapture?.(e.pointerId);
    s.stroke = null;
  },

  /** Undo drops the last stroke and repaints the list. Painting from the list, and never from the
      pixels already on screen, is what keeps undo right when an eraser stroke came before it. */
  sketchUndo() {
    const s = this.sketch;
    if (!s || !s.strokes.length) return;
    s.strokes.pop();
    s.stroke = null;
    this.sketchRepaint();
  },

  /** Paint one stroke from point `from` onwards. from = 0 paints it whole (a repaint); while a
      stroke is being drawn only its new segment is painted, so a long drawing does not repaint
      the whole list on every move. */
  sketchPaintStroke(stroke, from = 0) {
    const ctx = this.sketch?.ctx;
    if (!ctx || !stroke.points.length) return;
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.beginPath();
    const start = stroke.points[Math.max(0, from - 1)];
    ctx.moveTo(start.x, start.y);
    const rest = stroke.points.slice(Math.max(1, from));
    // A single tap still has to leave a dot
    if (!rest.length) ctx.lineTo(start.x, start.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  },

  sketchRepaint() {
    const s = this.sketch;
    if (!s?.ctx) return;
    s.ctx.clearRect(0, 0, s.canvas.width / s.dpr, s.canvas.height / s.dpr);
    for (const stroke of s.strokes) this.sketchPaintStroke(stroke);
  },

  /** The PNG that goes to the vault: only the part with ink on it, at the screen's pixel density.
      Null when nothing was drawn. */
  sketchExport() {
    const s = this.sketch;
    const box = s && this.sketchBounds(s.strokes);
    if (!box) return null;
    const out = document.createElement('canvas');
    out.width = Math.round(box.width * s.dpr);
    out.height = Math.round(box.height * s.dpr);
    // The source canvas holds its backing store in device pixels, so the shift is in device pixels
    // too. Drawing the whole source at an offset (rather than cropping with the nine-argument
    // drawImage) is what lets the box hang off the edge into the negative.
    out.getContext('2d')?.drawImage(s.canvas, Math.round(-box.x * s.dpr), Math.round(-box.y * s.dpr));
    return out;
  },

  /** ✓: crop, upload to the vault's attachment folder, and only then write ![[name]] into the note,
      the same order as a photo. What differs: a failed upload leaves the screen open with the
      drawing still on it, because a drawing cannot be picked again. */
  async sketchFinish() {
    const s = this.sketch;
    // Upload takes seconds on a phone. Without this guard every extra tap in that window starts
    // another upload, and the note ends up with the same drawing embedded several times over.
    if (!s || s.busy) return;
    const out = this.sketchExport();
    if (!out) { this.sketchClose(); return; }

    const file = this.currentFile;
    const at = s.at;
    s.busy = true;
    this.sketchBusy(true);
    this.setSaveStatus('saving', 'Enviando desenho...');

    let name;
    try {
      await this.ensureAuth();
      const folderId = await this.getMediaFolderId();
      if (!folderId) {
        this.setSaveStatus('error', `Pasta ${CONFIG.MEDIA_FOLDER} não encontrada no vault`);
        return;
      }
      const blob = await new Promise(resolve => out.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('canvas produced no blob');
      name = await this.freeMediaName(this.mediaName(blob, null, 'desenho'), folderId);
      await this.driveUploadBlob(name, blob, folderId);
      // The reading view shows it straight from here, without asking Drive for it back
      this._embedUrls.set(name, Promise.resolve(URL.createObjectURL(blob)));
    } catch (e) {
      console.error('Sketch upload failed:', e);
      // In case it was the remembered folder that went away: look it up again next time
      localStorage.removeItem('drivenotes_media_folder');
      this.setSaveStatus('error', 'Erro ao enviar o desenho');
      return;
    } finally {
      // Every failure leaves the screen open, so it has to be usable again: locked for good would
      // mean not even being able to leave
      s.busy = false;
      this.sketchBusy(false);
    }

    this.sketchClose();
    if (this.currentFile !== file) {
      this.setSaveStatus('error', `Desenho salvo, mas a nota mudou: ${name}`);
      return;
    }
    this.insertOnOwnLine(`![[${name}]]`, at);
    this.markDirty();
    this.setSaveStatus('saved', 'Desenho inserido');
  },
});
