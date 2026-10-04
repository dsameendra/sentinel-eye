// Reusable styled date + time picker: a month calendar (optionally shaded with DVR recording coverage)
// plus HH:MM:SS number fields, matching the app's dark theme. Used by playback's "jump to date & time"
// panel, the export dialog's start/end fields, and the Events page's custom date range — one component
// instead of native <input type=date>/datetime-local, which look and behave differently per browser and
// don't have anywhere to show which days actually have recordings.
import { icon } from './ui.js';
import { partsFromEpoch, epochFromParts } from './dvrtime.js';
import { getJSON } from './api.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const pad2 = (n) => String(n).padStart(2, '0');
const clampInt = (v, lo, hi, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };

export class DateTimePicker {
  /**
   * @param host element to render into (its innerHTML is fully owned by this component)
   * @param opts {
   *   epoch: initial value (unix seconds),
   *   tzOffsetMin: DVR UTC offset in minutes,
   *   onChange(epoch): fired when the user picks a day or commits a time field,
   *   coverageChannel: optional DVR channel number — shades days with recordings, disables days without,
   *   showTime: include the HH:MM:SS row (default true),
   *   label: optional heading text,
   *   timeHost: optional element to render the HH:MM:SS row into instead (Playback's calendar popover puts
   *     it in its own card beside the month, per the Calendar board),
   * }
   */
  constructor(host, opts) {
    this.host = host;
    this.opts = opts;
    this.epoch = opts.epoch;
    this.tzOffsetMin = opts.tzOffsetMin;
    const p = partsFromEpoch(this.epoch, this.tzOffsetMin);
    this.view = { y: p.y, mo: p.mo };
    this.coverageDays = new Map();
    this._build();
    if (opts.coverageChannel != null) this._loadCoverage();
  }

  /** Explicit jump (calendar click, external caller) — full re-render, fires onChange unless silent. */
  setEpoch(epoch, { silent = false } = {}) {
    this.epoch = epoch;
    const p = partsFromEpoch(epoch, this.tzOffsetMin);
    const monthChanged = p.y !== this.view.y || p.mo !== this.view.mo;
    this.view = { y: p.y, mo: p.mo };
    if (monthChanged && this.opts.coverageChannel != null) this._loadCoverage();
    else this._renderCalendar();
    this._renderTimeFields();
    if (!silent) this.opts.onChange?.(epoch);
  }

  setTzOffset(min) {
    this.tzOffsetMin = min;
    this.setEpoch(this.epoch, { silent: true });
  }

  _q(sel) { return this.host.querySelector(sel) || this.opts.timeHost?.querySelector(sel); }

  _build() {
    const timeRow = `<div class="time-inputs dtp-time">
        <div class="time-field"><input type="number" min="0" max="23" class="dtp-hh" aria-label="Hours"><label>hh</label></div>
        <span class="time-sep">:</span>
        <div class="time-field"><input type="number" min="0" max="59" class="dtp-mm" aria-label="Minutes"><label>mm</label></div>
        <span class="time-sep">:</span>
        <div class="time-field"><input type="number" min="0" max="59" class="dtp-ss" aria-label="Seconds"><label>ss</label></div>
      </div>`;
    const inline = this.opts.showTime !== false && !this.opts.timeHost;
    if (this.opts.showTime !== false && this.opts.timeHost) this.opts.timeHost.innerHTML = timeRow;
    this.host.innerHTML = `<div class="dtp">
      ${this.opts.label ? `<h4 class="dtp-label">${this.opts.label}</h4>` : ''}
      <div class="cal-head">
        <button class="btn sm icon ghost" data-a="prevmonth" aria-label="Previous month">${icon('left')}</button>
        <span class="cal-label"></span>
        <button class="btn sm icon ghost" data-a="nextmonth" aria-label="Next month">${icon('right')}</button>
      </div>
      <div class="cal-week">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid"></div>
      ${inline ? timeRow : ''}
    </div>`;
    this.host.querySelector('[data-a=prevmonth]').addEventListener('click', () => this._shiftMonth(-1));
    this.host.querySelector('[data-a=nextmonth]').addEventListener('click', () => this._shiftMonth(1));
    if (this.opts.showTime !== false) {
      const hh = this._q('.dtp-hh'), mm = this._q('.dtp-mm'), ss = this._q('.dtp-ss');
      const commit = () => {
        const p = partsFromEpoch(this.epoch, this.tzOffsetMin);
        const H = clampInt(hh.value, 0, 23, p.hh), M = clampInt(mm.value, 0, 59, p.mi), S = clampInt(ss.value, 0, 59, p.ss);
        this.setEpoch(epochFromParts(p.y, p.mo, p.da, H, M, S, this.tzOffsetMin));
      };
      for (const inp of [hh, mm, ss]) {
        inp.addEventListener('change', commit);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); inp.blur(); } });
      }
    }
    this._renderCalendar();
    this._renderTimeFields();
  }

  async _loadCoverage() {
    const { y, mo } = this.view;
    const first = new Date(Date.UTC(y, mo, 1)), last = new Date(Date.UTC(y, mo + 1, 0));
    const iso = (d) => d.toISOString().slice(0, 10);
    try {
      const cov = await getJSON(`/api/timeline/coverage?channel=${this.opts.coverageChannel}&from_day=${iso(first)}&to_day=${iso(last)}`);
      this.coverageDays = new Map(Object.entries(cov).map(([d, spans]) => [d, spans.length > 0]));
    } catch { this.coverageDays = new Map(); }
    this._renderCalendar();
  }

  _renderCalendar() {
    const { y, mo } = this.view;
    const sel = partsFromEpoch(this.epoch, this.tzOffsetMin);
    const today = partsFromEpoch(Date.now() / 1000, this.tzOffsetMin);
    const firstWeekday = new Date(Date.UTC(y, mo, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const gatedByCoverage = this.opts.coverageChannel != null;
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push('<span class="cal-day empty"></span>');
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${y}-${pad2(mo + 1)}-${pad2(d)}`;
      const isSel = sel.y === y && sel.mo === mo && sel.da === d;
      const isToday = today.y === y && today.mo === mo && today.da === d;
      const future = y > today.y || (y === today.y && (mo > today.mo || (mo === today.mo && d > today.da)));
      // Gated: only days with footage are pickable, and carry the green "has footage" dot. Ungated (Events'
      // range): any day up to today is pickable, with no dot — it would claim footage nobody checked.
      const has = gatedByCoverage ? this.coverageDays.get(key) : false;
      const pickable = gatedByCoverage ? has : !future;
      cells.push(`<button class="cal-day${has ? ' has' : ''}${pickable && !has ? ' avail' : ''}${isSel ? ' sel' : ''}${isToday ? ' today' : ''}" data-day="${d}" ${pickable ? '' : 'disabled'} title="${gatedByCoverage ? (has ? 'Recordings available' : 'No recordings') : ''}">${d}</button>`);
    }
    this.host.querySelector('.cal-label').textContent = `${MONTHS[mo]} ${y}`;
    const grid = this.host.querySelector('.cal-grid');
    grid.innerHTML = cells.join('');
    grid.querySelectorAll('.cal-day:not([disabled])').forEach((b) => {
      if (b.classList.contains('empty')) return;
      b.addEventListener('click', () => {
        const day = +b.dataset.day;
        // A fresh day starts at midnight, not wherever the time fields happened to be left — carrying the
        // old time forward made "pick a day, then a time" feel like it was jumping to a stale, unrelated
        // moment on the new day instead of a clean starting point to then set a time from.
        this.setEpoch(epochFromParts(y, mo, day, 0, 0, 0, this.tzOffsetMin));
      });
    });
  }

  _renderTimeFields() {
    if (this.opts.showTime === false) return;
    const p = partsFromEpoch(this.epoch, this.tzOffsetMin);
    this._q('.dtp-hh').value = pad2(p.hh);
    this._q('.dtp-mm').value = pad2(p.mi);
    this._q('.dtp-ss').value = pad2(p.ss);
  }

  _shiftMonth(delta) {
    let { y, mo } = this.view;
    mo += delta;
    if (mo < 0) { mo = 11; y--; } else if (mo > 11) { mo = 0; y++; }
    this.view = { y, mo };
    if (this.opts.coverageChannel != null) this._loadCoverage();
    else this._renderCalendar();
  }

  destroy() {
    this.host.innerHTML = '';
    if (this.opts.timeHost) this.opts.timeHost.innerHTML = '';
  }
}
