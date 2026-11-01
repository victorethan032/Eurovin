'use strict';
/** Mini-moteur de mise en page PDF (pdf-lib, polices standard). Aucune dépendance native. */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const A4 = [595.28, 841.89];
const M = 50;
const COL = { ink: rgb(0.1, 0.12, 0.16), mut: rgb(0.4, 0.44, 0.5), line: rgb(0.85, 0.87, 0.9), ac: rgb(0.04, 0.34, 0.82), warn: rgb(0.7, 0.35, 0.0), ok: rgb(0.1, 0.5, 0.25), bg: rgb(0.95, 0.96, 0.98) };

class Doc {
  static async create(title, footerText) {
    const d = new Doc();
    d.pdf = await PDFDocument.create();
    d.pdf.setTitle(title); d.pdf.setProducer('EuroVin'); d.pdf.setCreator('EuroVin');
    d.f = await d.pdf.embedFont(StandardFonts.Helvetica);
    d.b = await d.pdf.embedFont(StandardFonts.HelveticaBold);
    d.chars = new Set(d.f.getCharacterSet());
    d.footerText = footerText || '';
    d.page = null; d.y = 0;
    d.newPage();
    return d;
  }
  /** Ne laisse passer que les caractères encodables ; remplace les espaces fines et indices usuels. */
  clean(s) {
    return Array.from(String(s == null ? '' : s).replace(/[   ]/g, ' ').replace(/₂/g, '2').replace(/[\r\n\t]+/g, ' '))
      .map((c) => (this.chars.has(c.codePointAt(0)) ? c : '?')).join('');
  }
  newPage() { this.page = this.pdf.addPage(A4); this.y = A4[1] - M; }
  need(h) { if (this.y - h < M + 24) this.newPage(); }
  width(t, size, bold) { return (bold ? this.b : this.f).widthOfTextAtSize(t, size); }
  wrap(text, size, bold, maxW) {
    const out = [];
    for (const para of this.clean(text).split(/\s{0}\n/)) {
      let line = '';
      for (const w of para.split(' ')) {
        let word = w;
        while (this.width(word, size, bold) > maxW) {                  // mot trop long (VIN, code) : coupé
          let n = word.length; while (n > 1 && this.width(word.slice(0, n), size, bold) > maxW) n--;
          if (line) { out.push(line); line = ''; }
          out.push(word.slice(0, n)); word = word.slice(n);
        }
        const t = line ? line + ' ' + word : word;
        if (this.width(t, size, bold) <= maxW) line = t; else { out.push(line); line = word; }
      }
      out.push(line);
    }
    return out;
  }
  text(t, o = {}) {
    const size = o.size || 10, lh = size * 1.35, x = M + (o.indent || 0), maxW = (o.width || A4[0] - 2 * M) - (o.indent || 0);
    for (const l of this.wrap(t, size, o.bold, maxW)) {
      this.need(lh);
      const xx = o.align === 'right' ? x + maxW - this.width(l, size, o.bold) : x;
      this.page.drawText(l, { x: xx, y: this.y - size, size, font: o.bold ? this.b : this.f, color: o.color || COL.ink });
      this.y -= lh;
    }
    this.y -= o.gap == null ? 2 : o.gap;
  }
  gap(n) { this.y -= n; }
  hr() { this.need(10); this.page.drawLine({ start: { x: M, y: this.y - 4 }, end: { x: A4[0] - M, y: this.y - 4 }, thickness: 0.6, color: COL.line }); this.y -= 10; }
  h1(t) { this.text(t, { size: 20, bold: true, gap: 4 }); }
  h2(t) { this.gap(8); this.need(30); this.text(t, { size: 13, bold: true, color: COL.ac, gap: 4 }); }
  /** ligne « libellé … valeur » : la valeur est alignée à droite, le libellé passe à la ligne si besoin. */
  row(left, right, o = {}) {
    const size = o.size || 10, lh = size * 1.35, rw = right ? this.width(this.clean(right), size, o.bold) + 8 : 0;
    const lines = this.wrap(left, size, o.bold, A4[0] - 2 * M - rw - (o.indent || 0));
    this.need(lh * lines.length);
    const top = this.y;
    lines.forEach((l, i) => this.page.drawText(l, { x: M + (o.indent || 0), y: top - size - i * lh, size, font: o.bold ? this.b : this.f, color: o.color || COL.ink }));
    if (right) { const r = this.clean(right); this.page.drawText(r, { x: A4[0] - M - this.width(r, size, o.bold), y: top - size, size, font: o.bold ? this.b : this.f, color: o.rcolor || o.color || COL.ink }); }
    this.y -= lh * lines.length + 3;
    if (o.rule) { this.page.drawLine({ start: { x: M, y: this.y + 1 }, end: { x: A4[0] - M, y: this.y + 1 }, thickness: 0.4, color: COL.line }); this.y -= 3; }
  }
  /** Ligne de tableau : colonnes de largeurs fixes (points), alignement 'l' ou 'r', texte qui passe à la ligne. */
  trow(cells, widths, aligns, o = {}) {
    const size = o.size || 9, lh = size * 1.35, pad = 4;
    const wrapped = cells.map((c, i) => this.wrap(c, size, o.bold, widths[i] - pad));
    const n = Math.max(...wrapped.map((w) => w.length));
    this.need(lh * n + 4);
    const top = this.y; let x = M;
    wrapped.forEach((ls, i) => {
      ls.forEach((l, j) => {
        const w = this.width(l, size, o.bold), xx = aligns[i] === 'r' ? x + widths[i] - pad - w : x;
        this.page.drawText(l, { x: xx, y: top - size - j * lh, size, font: o.bold ? this.b : this.f, color: o.color || COL.ink });
      });
      x += widths[i];
    });
    this.y -= lh * n + 3;
    if (o.rule !== false) { this.page.drawLine({ start: { x: M, y: this.y + 1 }, end: { x: A4[0] - M, y: this.y + 1 }, thickness: 0.4, color: COL.line }); this.y -= 3; }
  }
  /** Deux blocs côte à côte (vendeur / acheteur). */
  twoCols(left, right, size = 9) {
    const lh = size * 1.35, w = (A4[0] - 2 * M) / 2 - 10;
    const L = left.flatMap((t) => this.wrap(t.text, size, t.bold, w).map((l) => ({ l, bold: t.bold }))), R = right.flatMap((t) => this.wrap(t.text, size, t.bold, w).map((l) => ({ l, bold: t.bold })));
    const n = Math.max(L.length, R.length); this.need(lh * n + 6); const top = this.y;
    L.forEach((t, i) => this.page.drawText(t.l, { x: M, y: top - size - i * lh, size, font: t.bold ? this.b : this.f, color: COL.ink }));
    R.forEach((t, i) => this.page.drawText(t.l, { x: M + w + 20, y: top - size - i * lh, size, font: t.bold ? this.b : this.f, color: COL.ink }));
    this.y -= lh * n + 8;
  }
  box(lines, o = {}) {
    const size = o.size || 10, lh = size * 1.35, pad = 8;
    const wrapped = lines.flatMap((l) => this.wrap(l, size, false, A4[0] - 2 * M - 2 * pad));
    const h = wrapped.length * lh + 2 * pad;
    this.need(h);
    this.page.drawRectangle({ x: M, y: this.y - h, width: A4[0] - 2 * M, height: h, color: o.bg || COL.bg });
    wrapped.forEach((l, i) => this.page.drawText(l, { x: M + pad, y: this.y - pad - size - i * lh, size, font: this.f, color: o.color || COL.ink }));
    this.y -= h + 6;
  }
  async save() {
    const pages = this.pdf.getPages();
    pages.forEach((p, i) => {
      const t = this.clean(`${this.footerText}${this.footerText ? '  ·  ' : ''}Page ${i + 1} / ${pages.length}`);
      p.drawText(t, { x: A4[0] - M - this.width(t, 8), y: 28, size: 8, font: this.f, color: COL.mut });
    });
    return Buffer.from(await this.pdf.save());
  }
}
module.exports = { Doc, COL, A4, M };
