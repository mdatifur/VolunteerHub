'use strict';
/* ===== Helpers ===== */
const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const $ = (s, e = document) => e.querySelector(s);
const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const t2m = t => {
  const [a, b] = String(t).split(':');
  return +a * 60 + +b;
};
const fm = m => {
  const h = Math.floor(m / 60),
    n = String(m % 60).padStart(2, '0');
  return (h % 12 || 12) + ':' + n + (h % 24 < 12 ? ' AM' : ' PM');
};
const ft = t => fm(t2m(t));
const uid = p =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/* ===== Data service (Supabase: the only database; no localStorage fallback) ===== */
const BUCKET = 'screenshots';
const errMsg = e => {
  const m = String((e && e.message) || e);
  return e && e.code === '23505'
    ? 'This phone number or ID already exists in the database.'
    : e && e.code === '42501'
      ? 'Permission denied. Sign in with the admin account.'
      : /fetch|network/i.test(m)
        ? 'Cannot reach the database. Check your internet connection.'
        : m || 'Database error';
};
const Store = {
  sb: null,
  ok: false,
  state: 'checking',
  busyN: 0,
  cache: { v: [], e: [] },
  volunteers() {
    return structuredClone(this.cache.v);
  },
  events() {
    return structuredClone(this.cache.e);
  },
  classes(id) {
    return (this.cache.v.find(v => v.id === id) || {}).classes || [];
  },
  async run(q) {
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },
  async load() {
    const S = this.sb,
      g = t => this.run(S.from(t).select('*').range(0, 9999)),
      [v, c, e, a] = await Promise.all(
        ['volunteers', 'class_schedules', 'events', 'event_assignments'].map(g),
      );
    const cl = {},
      as = {};
    c.sort((x, y) => x.id - y.id).forEach(r =>
      (cl[r.volunteer_id] ??= []).push({
        day: r.day,
        course: r.course,
        start: r.start_time.slice(0, 5),
        end: r.end_time.slice(0, 5),
      }),
    );
    a.forEach(r => (as[r.event_id] ??= []).push(r.volunteer_id));
    const vols = v
      .sort((x, y) => x.id.localeCompare(y.id))
      .map(r => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        address: r.address,
        dept: r.dept,
        status: r.status,
        verification: r.verification,
        classes: cl[r.id] || [],
        shotPath: r.screenshot_path || '',
        screenshot: '',
        driveUrl: r.drive_url || '',
      }));
    vols.forEach(x => {
      if (x.shotPath.startsWith('assets/')) x.screenshot = x.shotPath;
    });
    const paths = vols
      .filter(x => x.shotPath && !x.shotPath.startsWith('assets/'))
      .map(x => x.shotPath);
    if (paths.length) {
      const { data } = await S.storage
        .from(BUCKET)
        .createSignedUrls(paths, 3600);
      (data || []).forEach(d => {
        const x = vols.find(y => y.shotPath === d.path);
        if (x && d.signedUrl) x.screenshot = d.signedUrl;
      });
    }
    this.cache.v = vols;
    this.cache.e = e
      .sort((x, y) =>
        (x.date + x.start_time).localeCompare(y.date + y.start_time),
      )
      .map(r => ({
        id: r.id,
        name: r.name,
        date: r.date,
        start: r.start_time.slice(0, 5),
        end: r.end_time.slice(0, 5),
        location: r.location,
        required: r.required,
        assigned: as[r.id] || [],
      }));
  },
  async guard(fn) {
    // every write: connection check, busy state, error toast, resync on failure
    if (!this.ok) {
      toast('Not connected to the database. Nothing was saved.', 'err');
      return false;
    }
    setBusy(1);
    try {
      await fn();
      return true;
    } catch (e) {
      toast(errMsg(e), 'err');
      try {
        await this.load();
        render();
      } catch {}
      return false;
    } finally {
      setBusy(-1);
    }
  },
  saveVolunteers(next) {
    return this.guard(async () => {
      const S = this.sb,
        old = this.cache.v,
        ids = new Set(next.map(x => x.id)),
        gone = old.filter(o => !ids.has(o.id)).map(o => o.id),
        J = JSON.stringify;
      if (gone.length)
        await this.run(S.from('volunteers').delete().in('id', gone));
      for (const n of next) {
        const o = old.find(x => x.id === n.id);
        if (o && J(o) === J(n)) continue;
        const row = {
          id: n.id,
          name: n.name,
          phone: n.phone,
          address: n.address || '',
          dept: n.dept || '',
          status: n.status,
          verification: n.verification,
          screenshot_path: n.shotPath || null,
          drive_url: n.driveUrl || null,
        };
        await this.run(
          o
            ? S.from('volunteers').update(row).eq('id', n.id)
            : S.from('volunteers').insert(row),
        ); // new records use insert, so they never overwrite another admin's record
        if (!o || J(o.classes) !== J(n.classes)) {
          await this.run(
            S.from('class_schedules').delete().eq('volunteer_id', n.id),
          );
          if (n.classes.length)
            await this.run(
              S.from('class_schedules').insert(
                n.classes.map(c => ({
                  volunteer_id: n.id,
                  day: c.day,
                  course: c.course,
                  start_time: c.start,
                  end_time: c.end,
                })),
              ),
            );
        }
      }
      this.cache.v = structuredClone(next);
      this.cache.e.forEach(
        e => (e.assigned = e.assigned.filter(a => !gone.includes(a))),
      );
    });
  },
  addClasses(id, rows) {
    return this.guard(async () => {
      // insert-only: never edits or deletes volunteers or existing classes
      await this.run(
        this.sb.from('class_schedules').insert(
          rows.map(c => ({
            volunteer_id: id,
            day: c.day,
            course: c.course,
            start_time: c.start,
            end_time: c.end,
          })),
        ),
      );
      this.cache.v
        .find(v => v.id === id)
        .classes.push(
          ...rows.map(c => ({
            day: c.day,
            course: c.course,
            start: c.start,
            end: c.end,
          })),
        );
    });
  },
  async updateVolunteer(id, fn) {
    const a = this.volunteers(),
      v = a.find(x => x.id === id);
    if (!v) return false;
    fn(v);
    return this.saveVolunteers(a);
  },
  deleteVolunteer(id) {
    return this.saveVolunteers(this.volunteers().filter(v => v.id !== id));
  },
  saveClasses(id, c) {
    return this.updateVolunteer(id, v => (v.classes = c));
  },
  saveEvents(next) {
    return this.guard(async () => {
      const S = this.sb,
        old = this.cache.e,
        ids = new Set(next.map(x => x.id)),
        gone = old.filter(o => !ids.has(o.id)).map(o => o.id),
        J = JSON.stringify;
      if (gone.length) await this.run(S.from('events').delete().in('id', gone));
      for (const n of next) {
        const o = old.find(x => x.id === n.id);
        if (o && J(o) === J(n)) continue;
        await this.run(
          S.from('events').upsert(
            {
              id: n.id,
              name: n.name,
              date: n.date,
              start_time: n.start,
              end_time: n.end,
              location: n.location,
              required: n.required,
            },
            { onConflict: 'id' },
          ),
        );
        const have = o ? o.assigned : [],
          rm = have.filter(a => !n.assigned.includes(a)),
          ad = n.assigned.filter(a => !have.includes(a));
        if (rm.length)
          await this.run(
            S.from('event_assignments')
              .delete()
              .eq('event_id', n.id)
              .in('volunteer_id', rm),
          );
        if (ad.length)
          await this.run(
            S.from('event_assignments').insert(
              ad.map(v => ({ event_id: n.id, volunteer_id: v })),
            ),
          );
      }
      this.cache.e = structuredClone(next);
    });
  },
  async uploadShot(id, file) {
    const ext = ((file.type || 'image/jpeg').split('/')[1] || 'jpg')
        .replace('jpeg', 'jpg')
        .replace(/[^a-z0-9]/g, ''),
      path = `${id}-${Date.now()}.${ext}`;
    await this.run(
      this.sb.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type || 'image/jpeg' }),
    );
    const u = await this.run(
      this.sb.storage.from(BUCKET).createSignedUrl(path, 3600),
    );
    return { path, url: u.signedUrl };
  },
};

/* ===== Availability calculation (pure) ===== */
const overlaps = (s, e, cs, ce) => s < ce && e > cs; // half-open [start,end)
function classConflicts(v, date, s, e, buf = 0) {
  const day = DAYS[new Date(date + 'T00:00:00').getDay()];
  return (v.classes || []).filter(
    c => c.day === day && overlaps(s - buf, e + buf, t2m(c.start), t2m(c.end)),
  );
}
function freeIntervals(conf, s, e, buf) {
  let free = [[s, e]];
  conf.forEach(c => {
    const bs = t2m(c.start) - buf,
      be = t2m(c.end) + buf;
    free = free.flatMap(([a, b]) => {
      const r = [];
      if (a < bs) r.push([a, Math.min(b, bs)]);
      if (b > be) r.push([Math.max(a, be), b]);
      return a < b && bs < b && be > a ? r : [[a, b]];
    });
  });
  return free.filter(([a, b]) => b > a);
}
function checkAvail(v, date, s, e, buf) {
  if (v.verification !== 'Verified' || !(v.classes || []).length)
    return { cat: 'pending', conf: [], free: [] };
  const conf = classConflicts(v, date, s, e, buf);
  if (!conf.length) return { cat: 'full', conf, free: [[s, e]] };
  const free = freeIntervals(conf, s, e, buf);
  return { cat: free.length ? 'partial' : 'none', conf, free };
}
function runTests() {
  // console: runTests()
  const v = {
      verification: 'Verified',
      classes: [{ day: 'Monday', start: '10:00', end: '11:00' }],
    },
    d = '2026-10-19'; // a Monday
  const T = [
    [checkAvail(v, d, 540, 600, 0).cat, 'full'],
    [checkAvail(v, d, 600, 660, 0).cat, 'none'],
    [checkAvail(v, d, 660, 720, 0).cat, 'full'],
    [checkAvail(v, d, 660, 720, 15).cat, 'partial'],
    [checkAvail(v, d, 540, 720, 0).cat, 'partial'],
    [checkAvail(v, '2026-10-20', 600, 660, 0).cat, 'full'],
    [
      checkAvail({ ...v, verification: 'Pending' }, d, 540, 600, 0).cat,
      'pending',
    ],
    [
      checkAvail({ verification: 'Verified', classes: [] }, d, 540, 600, 0).cat,
      'pending',
    ],
  ];
  return T.map(([a, b], i) => `#${i + 1} ${a === b ? 'PASS' : 'FAIL'} (${a})`);
}

/* ===== UI helpers ===== */
function toast(m, t = '') {
  const d = document.createElement('div');
  d.className = 'toast ' + t;
  d.textContent = m;
  $('#toasts').append(d);
  setTimeout(() => d.remove(), 3200);
}
function confirmDlg(msg, btn = 'Confirm') {
  return new Promise(r => {
    $('#cfm').textContent = msg;
    $('#cfy').textContent = btn;
    const d = $('#cf');
    d.onclose = () => r(d.returnValue === 'y');
    d.returnValue = 'n';
    d.showModal();
  });
}
const dlg = html => {
  const d = $('#dlg');
  d.oncancel = null;
  d.onchange = null;
  d.onclick = null;
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
};
const closeDlg = () => $('#dlg').close();
const badge = s =>
  `<span class="badge b-${esc(s)}">${esc(s[0].toUpperCase() + s.slice(1))}</span>`;
const empty = m => `<div class="empty">${m}</div>`;
async function copy(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('Copied ' + t);
  } catch {
    toast('Copy failed. Select the number manually.', 'err');
  }
}
const nameOf = id =>
  (Store.volunteers().find(v => v.id === id) || { name: '(removed)' }).name;
const cleanPhone = p => String(p).replace(/[\s-]/g, '');
const validPhone = p => /^\+?\d{8,15}$/.test(cleanPhone(p));
const actions = v =>
  `<button class="sm" data-a="view" data-id="${v.id}">View</button> <button class="sm" data-a="edit" data-id="${v.id}">Edit</button> <button class="sm" data-a="copy" data-id="${esc(v.phone)}">Copy</button> <a href="tel:${esc(cleanPhone(v.phone))}"><button class="sm">Call</button></a> <button class="sm danger" data-a="del" data-id="${v.id}">Delete</button>`;

/* ===== Navigation ===== */
const TITLES = {
  dashboard: 'Dashboard',
  volunteers: 'All Volunteers',
  routines: 'Class Routines',
  finder: 'Availability Finder',
  events: 'Events',
  settings: 'Settings',
};
function go(p) {
  document
    .querySelectorAll('section')
    .forEach(s => s.classList.toggle('on', s.dataset.page === p));
  document
    .querySelectorAll('#nav button')
    .forEach(b => b.classList.toggle('on', b.dataset.p === p));
  $('#title').textContent = TITLES[p];
  $('#side').classList.remove('open');
  location.hash = p;
}

/* ===== Dashboard ===== */
function renderDashboard() {
  const v = Store.volunteers(),
    ev = upcoming();
  const S = [
    ['Total Volunteers', v.length],
    ['Active Volunteers', v.filter(x => x.status === 'active').length],
    ['Verified Routines', v.filter(x => x.verification === 'Verified').length],
    ['Upcoming Events', ev.length],
  ];
  $('#stats').innerHTML = S.map(
    ([l, n]) => `<div class="stat"><b>${n}</b>${l}</div>`,
  ).join('');
  $('#upcoming').innerHTML = ev.length
    ? ev
        .slice(0, 5)
        .map(
          e =>
            `<div class="ev" style="padding:8px 0;border-bottom:1px solid var(--line)"><span><b>${esc(e.name)}</b><br><span class="muted">${esc(e.date)}, ${ft(e.start)}–${ft(e.end)}, ${esc(e.location)}</span></span><span>${e.assigned.length}/${e.required} assigned</span></div>`,
        )
        .join('')
    : empty('No upcoming events. Add one on the Events page.');
}
const upcoming = () => {
  const t = new Date().toISOString().slice(0, 10);
  return Store.events()
    .filter(e => e.date >= t)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
};

/* ===== Volunteers ===== */
function renderVolunteers() {
  const q = $('#q').value.trim().toLowerCase(),
    f = $('#fs').value;
  const all = Store.volunteers(),
    list = all.filter(
      v =>
        (!f || v.status === f) &&
        (!q || v.name.toLowerCase().includes(q) || String(v.phone).includes(q)),
    );
  $('#vtable').innerHTML = !all.length
    ? empty('No volunteers yet. Add one or import a CSV.')
    : !list.length
      ? empty('No volunteers match your search.')
      : `<table><thead><tr><th>ID</th><th>Name</th><th>Phone</th><th>Address</th><th>Routine</th><th>Status</th><th>Actions</th></tr></thead><tbody>${list.map(v => `<tr><td>${esc(v.id)}</td><td>${esc(v.name)}</td><td>${esc(v.phone)}</td><td>${esc(v.address)}</td><td>${badge(v.verification)}</td><td>${badge(v.status)}</td><td>${actions(v)}</td></tr>`).join('')}</tbody></table>`;
}
function volForm(id) {
  const v = Store.volunteers().find(x => x.id === id) || {
    status: 'active',
    verification: 'Pending',
  };
  dlg(`<h2>${id ? 'Edit' : 'Add'} volunteer</h2><form id="vf" class="f"><label>Full name<input name="name" required value="${esc(v.name)}"></label><label>Phone<input name="phone" required inputmode="tel" value="${esc(v.phone)}"></label><label>Address<input name="address" value="${esc(v.address)}"></label><label>Department (optional)<input name="dept" value="${esc(v.dept)}"></label>
  <label>Status<select name="status"><option value="active"${v.status === 'active' ? ' selected' : ''}>Active</option><option value="inactive"${v.status === 'inactive' ? ' selected' : ''}>Inactive</option></select></label><p class="err" id="ve"></p><div class="row end"><button type="button" onclick="closeDlg()">Cancel</button><button class="pri">Save</button></div></form>`);
  $('#vf').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target)),
      all = Store.volunteers();
    d.name = d.name.trim();
    d.phone = cleanPhone(d.phone);
    if (!d.name)
      return ($('#ve').textContent = "Enter the volunteer's full name.");
    if (!validPhone(d.phone))
      return ($('#ve').textContent =
        'Enter a valid phone number (8–15 digits).');
    if (all.some(x => x.phone === d.phone && x.id !== id))
      return ($('#ve').textContent =
        'Another volunteer already uses this phone number.');
    if (id)
      Object.assign(
        all.find(x => x.id === id),
        d,
      );
    else {
      const n = Math.max(0, ...all.map(x => +x.id.slice(1) || 0)) + 1;
      all.push({
        ...d,
        id: 'V' + String(n).padStart(3, '0'),
        verification: 'Pending',
        classes: [],
        screenshot: '',
      });
    }
    if (await Store.saveVolunteers(all)) {
      closeDlg();
      toast('Volunteer saved');
      render();
    }
  };
}
async function delVol(id) {
  if (
    await confirmDlg(
      `Delete ${nameOf(id)}? They will also be removed from events.`,
      'Delete',
    )
  ) {
    if (await Store.deleteVolunteer(id)) {
      toast('Volunteer deleted');
      render();
    }
  }
}

/* ===== Routines ===== */
function renderRoutines() {
  const all = Store.volunteers();
  $('#rtable').innerHTML = !all.length
    ? empty('Add volunteers first to manage routines.')
    : `<table><thead><tr><th>Name</th><th>Classes</th><th>Screenshot</th><th>Verification</th><th></th></tr></thead><tbody>${all.map(v => `<tr><td>${esc(v.name)}</td><td>${(v.classes || []).length}</td><td>${v.screenshot ? 'Attached' : 'None'}</td><td>${badge(v.verification)}</td><td><button class="sm" data-a="view" data-id="${v.id}">Manage routine</button></td></tr>`).join('')}</tbody></table>`;
}
function detail(id, editIdx = -1) {
  const v = Store.volunteers().find(x => x.id === id);
  if (!v) return;
  const cl = v.classes || [],
    c = cl[editIdx] || { day: 'Monday' };
  const sorted = cl
    .map((x, i) => ({ ...x, i }))
    .sort(
      (a, b) =>
        DAYS.indexOf(a.day) - DAYS.indexOf(b.day) ||
        a.start.localeCompare(b.start),
    );
  dlg(`<h2>${esc(v.name)}</h2><p class="muted">${esc(v.id)} · ${esc(v.phone)} · ${esc(v.address)}${v.dept ? ' · ' + esc(v.dept) : ''}</p><p>${badge(v.status)} ${badge(v.verification)}</p>
  <label>Routine verification<select id="vs">${['Verified', 'Pending', 'Rejected'].map(s => `<option${v.verification === s ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
  <h2 style="margin-top:16px">Classes</h2>${sorted.length ? `<table><tbody>${sorted.map(x => `<tr><td>${x.day}</td><td>${esc(x.course)}</td><td>${ft(x.start)}–${ft(x.end)}</td><td><button class="sm" data-ce="${x.i}">Edit</button> <button class="sm danger" data-cd="${x.i}">Delete</button></td></tr>`).join('')}</tbody></table>` : empty('No classes entered yet.')}
  <form id="cfm2" class="grid" style="margin-top:10px"><label>Day<select name="day">${DAYS.map(d => `<option${c.day === d ? ' selected' : ''}>${d}</option>`).join('')}</select></label><label>Course<input name="course" required value="${esc(c.course)}"></label><label>Start<input type="time" name="start" required value="${c.start || ''}"></label><label>End<input type="time" name="end" required value="${c.end || ''}"></label><button class="pri">${editIdx >= 0 ? 'Update' : 'Add'} class</button></form><p class="err" id="ce"></p>
  <h2 style="margin-top:16px">Routine screenshot</h2><input type="file" id="shotf" accept="image/*" aria-label="Upload screenshot">
  ${v.screenshot ? `<img class="shot" src="${esc(v.screenshot)}" alt="Class routine screenshot" onerror="this.outerHTML='<p class=muted>Image could not be loaded.</p>'">` : '<p class="muted">No screenshot attached.</p>'}
  ${v.driveUrl ? `<p class="muted">Form link: <a href="${esc(v.driveUrl)}" target="_blank" rel="noopener">Open in Google Drive</a> (needs access to the Drive file)</p>` : ''}
  <div class="row end"><button onclick="closeDlg()">Close</button></div>`);
  $('#vs').onchange = async e => {
    if (
      await Store.updateVolunteer(id, x => (x.verification = e.target.value))
    ) {
      toast('Verification set to ' + e.target.value);
      render();
    }
  };
  $('#cfm2').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    if (t2m(d.end) <= t2m(d.start))
      return ($('#ce').textContent = 'End time must be after start time.');
    const n = [...cl];
    editIdx >= 0 ? (n[editIdx] = d) : n.push(d);
    if (await Store.saveClasses(id, n)) {
      toast('Class saved');
      render();
      detail(id);
    }
  };
  $('#dlg')
    .querySelectorAll('[data-ce]')
    .forEach(b => (b.onclick = () => detail(id, +b.dataset.ce)));
  $('#dlg')
    .querySelectorAll('[data-cd]')
    .forEach(
      b =>
        (b.onclick = async () => {
          if (await confirmDlg('Delete this class?', 'Delete')) {
            if (
              await Store.saveClasses(
                id,
                cl.filter((_, i) => i !== +b.dataset.cd),
              )
            ) {
              render();
              detail(id);
            }
          }
        }),
    );
  $('#shotf').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('Choose an image file.', 'err');
    if (f.size > 2 * 1024 * 1024)
      return toast('Image is over 2 MB. Compress it first.', 'err');
    let up;
    if (
      !(await Store.guard(async () => {
        up = await Store.uploadShot(id, f);
      }))
    )
      return;
    if (
      await Store.updateVolunteer(id, x => {
        x.shotPath = up.path;
        x.screenshot = up.url;
      })
    ) {
      toast('Screenshot saved');
      render();
      detail(id);
    }
  };
}

/* ===== Availability finder ===== */
const rowV = (v, r, chk) =>
  `<tr><td>${chk ? `<input type="checkbox" class="pick" value="${v.id}" aria-label="Select ${esc(v.name)}"> ` : ''}${esc(v.name)}</td><td>${esc(v.phone)}</td><td>${esc(v.address)}</td><td>${r.conf.length ? r.conf.map(c => `${esc(c.course)} ${ft(c.start)}–${ft(c.end)}`).join('<br>') : 'None'}</td><td>${r.cat === 'pending' ? 'Unknown' : r.free.map(([a, b]) => fm(a) + '–' + fm(b)).join(', ') || 'None'}</td><td>${badge({ full: 'active', partial: 'Partial', none: 'Unavailable', pending: 'Pending' }[r.cat]).replace('>Active<', '>Available<')}<br>${actions(
    v,
  )
    .replace(/<button class="sm" data-a="(view|edit)".*?<\/button> /g, '')
    .replace(/<button class="sm danger".*$/, '')}</td></tr>`;
function find(e) {
  e.preventDefault();
  const date = $('#fd').value,
    s = t2m($('#fst').value || 'x:0'),
    en = t2m($('#fet').value || 'x:0'),
    buf = Math.max(0, +$('#fb').value || 0),
    need = Math.max(1, +$('#fn').value || 1);
  const err = $('#ferr');
  err.textContent = '';
  if (!date || !$('#fst').value || !$('#fet').value)
    return (err.textContent = 'Pick a date, start time and end time.');
  if (en <= s)
    return (err.textContent = 'End time must be later than start time.');
  const act = Store.volunteers().filter(v => v.status === 'active');
  if (!act.length)
    return ($('#fres').innerHTML =
      '<div class="card">' +
      empty('No active volunteers to check.') +
      '</div>');
  const R = { full: [], partial: [], none: [], pending: [] };
  act.forEach(v => {
    const r = checkAvail(v, date, s, en, buf);
    R[r.cat].push([v, r]);
  });
  const sec = (k, t, chk) =>
    `<div class="card tw"><h2 style="padding:18px 18px 0">${t} (${R[k].length})</h2>${R[k].length ? `<table><thead><tr><th>Volunteer</th><th>Phone</th><th>Address</th><th>Class conflict</th><th>Available time</th><th>Status</th></tr></thead><tbody>${R[k].map(([v, r]) => rowV(v, r, chk)).join('')}</tbody></table>` : empty('Nobody in this group.')}</div>`;
  $('#fres').innerHTML =
    `<p class="muted">${DAYS[new Date(date + 'T00:00:00').getDay()]}, ${fm(s)}–${fm(en)}${buf ? `, ${buf} min buffer` : ''}. Only volunteers with a verified routine can be confirmed available.</p><div class="sum" id="sel"></div>` +
    sec('full', 'Fully available', 1) +
    sec('partial', 'Partially available') +
    sec('none', 'Unavailable') +
    sec('pending', 'Routine pending or missing');
  const upd = () => {
    const n = document.querySelectorAll('.pick:checked').length,
      el = $('#sel');
    el.className = 'sum' + (n < need ? ' bad' : '');
    el.innerHTML = `<span>Selected: <b>${n}</b> of <b>${need}</b> needed</span><span>${n >= need ? 'Enough volunteers selected' : `${need - n} more needed`}</span>`;
  };
  document.querySelectorAll('.pick').forEach(c => (c.onchange = upd));
  upd();
}

/* ===== Events ===== */
function renderEvents() {
  const ev = Store.events().sort((a, b) =>
    (a.date + a.start).localeCompare(b.date + b.start),
  );
  $('#elist').innerHTML = ev.length
    ? ev
        .map(
          e =>
            `<div class="card ev"><div><b>${esc(e.name)}</b><br><span class="muted">${esc(e.date)}, ${ft(e.start)}–${ft(e.end)}, ${esc(e.location)}</span><br>${e.assigned.length}/${e.required} volunteers assigned</div><div class="row"><button class="sm" data-e="view" data-id="${e.id}">Details</button><button class="sm" data-e="assign" data-id="${e.id}">Assign</button><button class="sm" data-e="edit" data-id="${e.id}">Edit</button><button class="sm danger" data-e="del" data-id="${e.id}">Delete</button></div></div>`,
        )
        .join('')
    : `<div class="card">${empty('No events yet. Add your first event.')}</div>`;
}
function evForm(id) {
  const e = Store.events().find(x => x.id === id) || { required: 3 };
  dlg(
    `<h2>${id ? 'Edit' : 'Add'} event</h2><form id="ef" class="f"><label>Event name<input name="name" required value="${esc(e.name)}"></label><label>Date<input type="date" name="date" required value="${e.date || ''}"></label><div class="grid"><label>Start<input type="time" name="start" required value="${e.start || ''}"></label><label>End<input type="time" name="end" required value="${e.end || ''}"></label></div><label>Location<input name="location" required value="${esc(e.location)}"></label><label>Volunteers required<input type="number" name="required" min="1" required value="${e.required}"></label><p class="err" id="ee"></p><div class="row end"><button type="button" onclick="closeDlg()">Cancel</button><button class="pri">Save</button></div></form>`,
  );
  $('#ef').onsubmit = async ev => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target));
    d.required = +d.required;
    if (t2m(d.end) <= t2m(d.start))
      return ($('#ee').textContent = 'End time must be after start time.');
    const all = Store.events();
    if (id)
      Object.assign(
        all.find(x => x.id === id),
        d,
      );
    else all.push({ ...d, id: uid('E'), assigned: [] });
    if (await Store.saveEvents(all)) {
      closeDlg();
      toast('Event saved');
      render();
    }
  };
}
function evView(id) {
  const e = Store.events().find(x => x.id === id);
  if (!e) return;
  dlg(
    `<h2>${esc(e.name)}</h2><p class="muted">${esc(e.date)}, ${ft(e.start)}–${ft(e.end)}, ${esc(e.location)}</p><p>${e.assigned.length} of ${e.required} volunteers assigned</p>${
      e.assigned.length
        ? `<table><tbody>${e.assigned
            .map(a => {
              const v = Store.volunteers().find(x => x.id === a);
              return `<tr><td>${esc(nameOf(a))}</td><td>${esc(v ? v.phone : '')}</td><td><button class="sm danger" data-rm="${a}">Remove</button></td></tr>`;
            })
            .join('')}</tbody></table>`
        : empty('Nobody assigned yet.')
    }<div class="row end"><button onclick="closeDlg()">Close</button></div>`,
  );
  $('#dlg')
    .querySelectorAll('[data-rm]')
    .forEach(
      b =>
        (b.onclick = async () => {
          const all = Store.events(),
            x = all.find(y => y.id === id);
          x.assigned = x.assigned.filter(a => a !== b.dataset.rm);
          if (await Store.saveEvents(all)) {
            render();
            evView(id);
          }
        }),
    );
}
function warnings(v, e, events) {
  const w = [],
    s = t2m(e.start),
    en = t2m(e.end);
  classConflicts(v, e.date, s, en, 0).forEach(c =>
    w.push(`class ${c.course} ${ft(c.start)}–${ft(c.end)}`),
  );
  events
    .filter(
      o =>
        o.id !== e.id &&
        o.date === e.date &&
        o.assigned.includes(v.id) &&
        overlaps(s, en, t2m(o.start), t2m(o.end)),
    )
    .forEach(o => w.push(`event "${o.name}" ${ft(o.start)}–${ft(o.end)}`));
  return w;
}
function assign(id) {
  const events = Store.events(),
    e = events.find(x => x.id === id),
    act = Store.volunteers().filter(v => v.status === 'active');
  if (!e) return;
  dlg(
    `<h2>Assign volunteers: ${esc(e.name)}</h2>${
      act.length
        ? `<table><tbody>${act
            .map(v => {
              const w = warnings(v, e, events);
              return `<tr><td><label><input type="checkbox" class="ap" value="${v.id}" style="width:auto"${e.assigned.includes(v.id) ? ' checked' : ''}> ${esc(v.name)}</label></td><td>${w.length ? badge('Pending').replace('Pending', 'Conflict') + ' <span class="muted">' + esc(w.join('; ')) + '</span>' : v.verification === 'Verified' ? '' : '<span class="muted">Routine ' + esc(v.verification.toLowerCase()) + '</span>'}</td></tr>`;
            })
            .join('')}</tbody></table>`
        : empty('No active volunteers.')
    }<div class="row end" style="margin-top:12px"><button onclick="closeDlg()">Cancel</button><button class="pri" id="as">Save assignments</button></div>`,
  );
  $('#as').onclick = async () => {
    const sel = [
        ...new Set(
          [...document.querySelectorAll('.ap:checked')].map(c => c.value),
        ),
      ],
      added = sel.filter(a => !e.assigned.includes(a));
    const bad = added
      .map(a => [
        act.find(v => v.id === a),
        warnings(
          act.find(v => v.id === a),
          e,
          events,
        ),
      ])
      .filter(([, w]) => w.length);
    if (
      bad.length &&
      !(await confirmDlg(
        'Assign anyway? ' +
          bad.map(([v, w]) => `${v.name} has ${w.join(' and ')}.`).join(' '),
        'Assign anyway',
      ))
    )
      return;
    e.assigned = [
      ...e.assigned.filter(a => sel.includes(a) || !act.some(v => v.id === a)),
      ...added,
    ];
    if (await Store.saveEvents(events)) {
      closeDlg();
      toast('Assignments saved');
      render();
    }
  };
}

/* ===== CSV / JSON import & export ===== */
function parseCSV(t) {
  const rows = [];
  let r = [],
    c = '',
    q = false;
  t = t.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        c += '"';
        i++;
      } else if (ch === '"') q = false;
      else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      r.push(c);
      c = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      r.push(c);
      c = '';
      if (r.some(x => x.trim())) rows.push(r);
      r = [];
    } else c += ch;
  }
  if (c || r.length) {
    r.push(c);
    if (r.some(x => x.trim())) rows.push(r);
  }
  return rows;
}
const csvCell = x => '"' + String(x ?? '').replace(/"/g, '""') + '"';
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}
function exportCSV() {
  const v = Store.volunteers();
  if (!v.length) return toast('No volunteers to export', 'err');
  download(
    'volunteers.csv',
    '\uFEFF' +
      ['ID,Name,Phone,Address,Department,Status,Verification']
        .concat(
          v.map(x =>
            [x.id, x.name, x.phone, x.address, x.dept, x.status, x.verification]
              .map(csvCell)
              .join(','),
          ),
        )
        .join('\r\n'),
    'text/csv',
  );
}
function previewCSV(text) {
  const rows = parseCSV(text),
    h = (rows.shift() || []).map(x => x.trim().toLowerCase()),
    ix = k => h.findIndex(x => x.includes(k));
  const [iN, iP, iA, iU] = [
    ix('full name'),
    ix('phone'),
    ix('address'),
    ix('screenshot'),
  ];
  if (iN < 0 || iP < 0 || iA < 0)
    return toast('CSV needs Full Name, Phone and Address columns', 'err');
  const have = new Set(Store.volunteers().map(v => v.phone)),
    seen = new Set(),
    items = rows.map(r => {
      const name = (r[iN] || '').replace(/\s+/g, ' ').trim(),
        phone = cleanPhone(r[iP] || ''),
        address = (r[iA] || '').trim(),
        url = (r[iU] || '').trim();
      let st = 'ok';
      if (!name || !phone) st = 'Missing required field';
      else if (!validPhone(phone)) st = 'Invalid phone';
      else if (have.has(phone)) st = 'Duplicate (already saved)';
      else if (seen.has(phone)) st = 'Duplicate (in file)';
      seen.add(phone);
      return { name, phone, address, url, st };
    });
  const good = items.filter(i => i.st === 'ok');
  dlg(
    `<h2>Import preview</h2><p>${good.length} of ${items.length} rows can be imported. Rows with problems are skipped. Imported volunteers start with a Pending routine.</p><div class="tw" style="max-height:320px;overflow:auto"><table><thead><tr><th>Name</th><th>Phone</th><th>Result</th></tr></thead><tbody>${items.map(i => `<tr><td>${esc(i.name)}</td><td>${esc(i.phone)}</td><td>${i.st === 'ok' ? badge('active').replace('Active', 'Ready') : badge('Rejected').replace('Rejected', esc(i.st))}</td></tr>`).join('')}</tbody></table></div><div class="row end" style="margin-top:12px"><button onclick="closeDlg()">Cancel</button><button class="pri" id="go"${good.length ? '' : ' disabled'}>Import ${good.length} volunteers</button></div>`,
  );
  $('#go').onclick = async () => {
    const all = Store.volunteers();
    let n = Math.max(0, ...all.map(x => +x.id.slice(1) || 0));
    good.forEach(i =>
      all.push({
        id: 'V' + String(++n).padStart(3, '0'),
        name: i.name,
        phone: i.phone,
        address: i.address,
        dept: '',
        status: 'active',
        verification: 'Pending',
        classes: [],
        screenshot: '',
        driveUrl: i.url,
      }),
    );
    if (await Store.saveVolunteers(all)) {
      dlg(
        `<h2>Import summary</h2><p>Imported: <b>${good.length}</b><br>Skipped: <b>${items.length - good.length}</b> (${items.filter(i => i.st.startsWith('Dup')).length} duplicates, ${items.filter(i => i.st !== 'ok' && !i.st.startsWith('Dup')).length} invalid)</p><div class="row end"><button class="pri" onclick="closeDlg()">Done</button></div>`,
      );
      render();
    }
  };
}
async function importJSON(text) {
  try {
    const d = JSON.parse(text);
    if (!Array.isArray(d.volunteers) || !Array.isArray(d.events)) throw 0;
    if (d.volunteers.some(v => !v || !v.id || !v.name || !v.phone)) throw 0;
    d.volunteers.forEach(v => {
      v.phone = String(v.phone);
      v.classes = Array.isArray(v.classes) ? v.classes : [];
    });
    d.events.forEach(
      e => (e.assigned = Array.isArray(e.assigned) ? e.assigned : []),
    );
    if (
      !(await confirmDlg(
        'Replace ALL online data with this file? Records not in the file will be deleted from the shared database.',
        'Replace',
      ))
    )
      return;
    if (
      (await Store.saveVolunteers(d.volunteers)) &&
      (await Store.saveEvents(d.events))
    ) {
      toast('Data imported');
      render();
    }
  } catch {
    toast('Invalid backup file. Expected volunteers and events lists.', 'err');
  }
}
const readFile = (inp, fn) =>
  (inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => fn(r.result);
    r.readAsText(f);
    inp.value = '';
  });

/* ===== Bulk routine import from screenshots (OCR runs in the browser; images are not uploaded anywhere) ===== */
const TESS_URL =
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const ABBR = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};
const D3 = '(?:sun|mon|tue|wed|thu|fri|sat)',
  TIME_RE = new RegExp(
    '\\b(' +
      D3 +
      ')[a-z]*\\.?\\s*(\\d{1,2})\\s*[:.]\\s*(\\d{1,2})\\s*([AP]M)?\\s*[-–—~]+\\s*(?:' +
      D3 +
      '[a-z]*\\.?\\s*)?(\\d{1,2})\\s*[:.]\\s*(\\d{1,2})\\s*([AP]M)?',
    'i',
  );
const m2t = m =>
  String(Math.floor(m / 60)).padStart(2, '0') +
  ':' +
  String(m % 60).padStart(2, '0');
function resolveTimes(a, b) {
  // a,b = [hour,minute,AM/PM or undefined]; returns [startMin,endMin,guessed] or null
  if (+a[0] > 23 || +b[0] > 23 || +a[1] > 59 || +b[1] > 59) return null;
  const f = (x, ap) =>
    +x[0] > 12 || +x[0] === 0 || !ap
      ? +x[0] * 60 + +x[1]
      : ((+x[0] % 12) + (/p/i.test(ap) ? 12 : 0)) * 60 + +x[1];
  if (a[2] && b[2]) return [f(a, a[2]), f(b, b[2]), false];
  if (a[2] || b[2]) {
    const ap = a[2] || b[2],
      o = /a/i.test(ap) ? 'PM' : 'AM';
    let s = f(a, a[2] || ap),
      e = f(b, b[2] || ap);
    if (!(s < e)) {
      s = f(a, a[2] || o);
      e = f(b, b[2] || o);
    }
    return [s, e, false];
  }
  const g = x =>
    +x[0] > 12 || +x[0] === 0 ? '' : +x[0] >= 7 && +x[0] <= 11 ? 'AM' : 'PM'; // no AM/PM at all: 7-11 = morning, otherwise afternoon (flagged for review)
  return [f(a, g(a)), f(b, g(b)), true];
}
function parseRoutineText(text) {
  // portal format: "01524-COURSE NAME [O]" then "(Theory) Time: Sun 1:0 PM - Sun 2:30 PM Room: 3117"
  const lines = String(text)
      .split(/\r?\n/)
      .map(l => l.replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean),
    rows = [],
    unparsed = [];
  let course = '',
    open = false;
  const clean = x => x.replace(/(\s*\[[^\]]*\])+\s*$/, '').trim();
  let once = false; // once: course line without a code applies to the next Time line only
  for (const l of lines) {
    const c = l.match(/^\W*\d{3,5}\s*[-–—]\s*(.+)$/),
      c2 = l.match(/^([A-Z][A-Z0-9 &.,'()\/-]{4,}?)\s*(\[[^\]]*\]\s*)+$/);
    if (c && !/\btime\b/i.test(l)) {
      course = clean(c[1]);
      open = !/\]\s*$/.test(c[1]);
      once = false;
      continue;
    }
    if (c2) {
      course = clean(l);
      open = false;
      once = true;
      continue;
    }
    if (/\btime\b/i.test(l) && new RegExp(D3, 'i').test(l)) {
      open = false;
      const m = l.match(TIME_RE);
      if (!m) {
        unparsed.push(l);
        continue;
      }
      const t = resolveTimes([m[2], m[3], m[4]], [m[5], m[6], m[7]]);
      if (!t) {
        unparsed.push(l);
        continue;
      }
      const lab = /lab/i.test(l.split(/time/i)[0]);
      rows.push({
        day: ABBR[m[1].toLowerCase()],
        course: course ? course + (lab ? ' (Lab)' : '') : '',
        start: m2t(t[0]),
        end: m2t(t[1]),
        guess: t[2],
      });
      if (once) {
        course = '';
        once = false;
      }
      continue;
    }
    if (open && course && !/room|theory|lab|registered/i.test(l)) {
      course += ' ' + clean(l);
      open = !/\]\s*$/.test(l);
    }
  }
  return { rows, unparsed };
}
const STOP = new Set(
  'class time routine screenshot img image file png jpg jpeg upload your copy final photo whatsapp'.split(
    ' ',
  ),
);
function matchVolunteer(fname, text, vols) {
  // returns {id,how} only when confident; {suggest} when only a weak hint; null otherwise
  const pm = (String(text) + ' ' + fname)
    .replace(/[\s-]/g, '')
    .match(/(?:\+?88)?(01\d{9})/);
  if (pm) {
    const v = vols.find(x => cleanPhone(x.phone).endsWith(pm[1]));
    if (v) return { id: v.id, how: 'phone number found' };
  }
  const toks = s =>
      String(s)
        .toLowerCase()
        .replace(/\.[a-z]+$/, '')
        .split(/[^a-z]+/)
        .filter(t => t.length > 2 && !STOP.has(t)),
    ft = new Set(toks(fname));
  const sc = vols
    .map(v => {
      const t = toks(v.name);
      return { v, hit: t.filter(x => ft.has(x)).length, n: t.length };
    })
    .filter(x => x.hit)
    .sort((a, b) => b.hit / b.n - a.hit / a.n || b.hit - a.hit);
  if (!sc.length) return null;
  const [b, s2] = sc;
  return b.hit >= 2 && b.hit / b.n >= 0.6 && (!s2 || s2.hit < b.hit)
    ? { id: b.v.id, how: 'name matches file name' }
    : { suggest: b.v.id };
}
const IMP = { groups: [], cancel: false };
const loadScript = u =>
  new Promise((ok, no) => {
    if (window.Tesseract) return ok();
    const s = document.createElement('script');
    s.src = u;
    s.onload = ok;
    s.onerror = () =>
      no(
        new Error(
          'Could not load the OCR library. Check your internet connection.',
        ),
      );
    document.head.append(s);
  });
async function prep(blob) {
  const bm = await createImageBitmap(blob),
    k = bm.width < 1000 ? 2 : 1,
    c = document.createElement('canvas');
  c.width = bm.width * k;
  c.height = bm.height * k;
  const x = c.getContext('2d');
  x.drawImage(bm, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height),
    p = d.data;
  let sum = 0,
    n = 0;
  for (let i = 0; i < p.length; i += 16, n++)
    sum += (p[i] + p[i + 1] + p[i + 2]) / 3;
  if (sum / n < 110) {
    for (let i = 0; i < p.length; i += 4) {
      p[i] = 255 - p[i];
      p[i + 1] = 255 - p[i + 1];
      p[i + 2] = 255 - p[i + 2];
    }
    x.putImageData(d, 0, 0);
  } // dark mode screenshots
  return c;
}
function impStart(attached) {
  if (!Store.ok) return toast('Connect to the database first.', 'err');
  if (!attached) return $('#fimp').click();
  const vs = Store.cache.v.filter(
    v => v.screenshot && v.verification !== 'Verified',
  );
  if (!vs.length)
    return toast('No attached screenshots on non-Verified volunteers.', 'err');
  runOCR(
    vs.map(v => ({
      name: v.name + ' (attached)',
      vid: v.id,
      get: async () => {
        const r = await fetch(v.screenshot);
        if (!r.ok) throw new Error('image not reachable');
        return r.blob();
      },
    })),
  );
}
async function runOCR(items) {
  IMP.cancel = false;
  IMP.groups = [];
  let w;
  lock(
    `<h2>Reading screenshots</h2><p id="ip">Loading OCR engine (first time downloads about 10 MB)…</p><progress id="ib" max="100" value="0" style="width:100%"></progress><p class="muted">Everything runs in this browser. Nothing is sent to an OCR service.</p><div class="row end"><button id="ic2">Stop</button></div>`,
  );
  $('#ic2').onclick = () => {
    IMP.cancel = true;
  };
  try {
    await loadScript(TESS_URL);
    w = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text' && $('#ib'))
          $('#ib').value = Math.round(m.progress * 100);
      },
    });
    await w.setParameters({ tessedit_pageseg_mode: '6' });
    for (let i = 0; i < items.length && !IMP.cancel; i++) {
      const it = items[i];
      $('#ip').textContent = `Image ${i + 1} of ${items.length}: ${it.name}`;
      $('#ib').value = 0;
      try {
        const r = await w.recognize(await prep(await it.get())),
          p = parseRoutineText(r.data.text),
          m = it.vid
            ? { id: it.vid, how: 'attached screenshot' }
            : matchVolunteer(it.name, r.data.text, Store.cache.v);
        IMP.groups.push({
          name: it.name,
          vid: (m && m.id) || '',
          how: (m && m.how) || '',
          suggest: (m && m.suggest) || '',
          rows: p.rows.map(x => ({ ...x, inc: true })),
          unparsed: p.unparsed,
          noTime: !/time/i.test(r.data.text) && !p.rows.length,
        });
      } catch (e) {
        IMP.groups.push({
          name: it.name,
          vid: it.vid || '',
          how: '',
          suggest: '',
          rows: [],
          unparsed: [],
          error: 'Could not read this image: ' + errMsg(e),
        });
      }
    }
  } catch (e) {
    toast(errMsg(e), 'err');
  } finally {
    if (w) w.terminate();
  }
  IMP.groups.length ? impRender() : closeDlg();
}
function rowStat(g, r, seen) {
  const v = Store.cache.v.find(x => x.id === g.vid);
  if (!v) return ['bad', 'No volunteer selected'];
  if (v.verification === 'Verified')
    return ['bad', 'Routine is Verified. Set it to Pending first'];
  if (!DAYS.includes(r.day)) return ['bad', 'Invalid day'];
  if (!String(r.course).trim()) return ['bad', 'Course name missing'];
  if (
    !/^\d\d:\d\d$/.test(r.start) ||
    !/^\d\d:\d\d$/.test(r.end) ||
    t2m(r.end) <= t2m(r.start)
  )
    return ['bad', 'Invalid time'];
  const k = [v.id, r.day, r.start, r.end].join('|');
  if (
    v.classes.some(
      c => c.day === r.day && c.start === r.start && c.end === r.end,
    ) ||
    seen.has(k)
  )
    return ['dup', 'Duplicate (will be skipped)'];
  seen.add(k);
  return r.guess ? ['chk', 'AM/PM guessed. Check'] : ['ok', 'OK'];
}
function impRender() {
  const seen = new Set(),
    st = $('#dlg').scrollTop,
    B = { ok: 'active', chk: 'Pending', dup: 'Pending', bad: 'Rejected' };
  let will = 0;
  const opts = g =>
    '<option value="">Choose volunteer…</option>' +
    Store.cache.v
      .map(
        v =>
          `<option value="${v.id}"${v.id === g.vid ? ' selected' : ''}>${esc(v.name)} (${esc(v.phone)})</option>`,
      )
      .join('');
  const html = IMP.groups
    .map(
      (
        g,
        gi,
      ) => `<div class="card"><b>${esc(g.name)}</b><label>Volunteer<select data-g="${gi}" data-f="vid">${opts(g)}</select></label>
   <p class="muted">${g.vid ? 'Matched: ' + esc(g.how || 'chosen manually') : g.suggest ? 'Not sure. Possible match: ' + esc(nameOf(g.suggest)) + '. Please choose.' : 'No confident match. Please choose.'}</p>
   ${g.error ? `<p class="err">${esc(g.error)}</p>` : ''}${g.noTime ? '<p class="err">No class times found (maybe a table layout). Enter classes manually in the volunteer\'s routine.</p>' : ''}
   ${
     g.rows.length
       ? `<div class="tw"><table><thead><tr><th></th><th>Day</th><th>Course</th><th>Start</th><th>End</th><th>Status</th><th></th></tr></thead><tbody>${g.rows
           .map((r, ri) => {
             const [s, m] = rowStat(g, r, seen),
               on = r.inc && (s === 'ok' || s === 'chk');
             if (on) will++;
             return `<tr><td><input type="checkbox" data-g="${gi}" data-r="${ri}" data-f="inc" style="width:auto" aria-label="Include"${r.inc ? ' checked' : ''}${s === 'bad' || s === 'dup' ? ' disabled' : ''}></td><td><select data-g="${gi}" data-r="${ri}" data-f="day">${DAYS.map(d => `<option${r.day === d ? ' selected' : ''}>${d}</option>`).join('')}</select></td><td><input data-g="${gi}" data-r="${ri}" data-f="course" value="${esc(r.course)}"></td><td><input type="time" data-g="${gi}" data-r="${ri}" data-f="start" value="${r.start}"></td><td><input type="time" data-g="${gi}" data-r="${ri}" data-f="end" value="${r.end}"></td><td><span class="badge b-${B[s]}">${m}</span></td><td><button class="sm danger" data-act="del" data-g="${gi}" data-r="${ri}">✕</button></td></tr>`;
           })
           .join('')}</tbody></table></div>`
       : ''
   }
   ${g.unparsed.length ? `<p class="err">Unparsed lines (not imported, add them manually):</p><ul class="muted">${g.unparsed.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
   <button class="sm" data-act="add" data-g="${gi}">+ Add row</button></div>`,
    )
    .join('');
  dlg(
    `<h2>Review extracted classes</h2><p class="muted">Nothing is saved yet. Fix anything wrong, then import. Imported routines keep their current verification status (Pending); verify them yourself after checking.</p>${html}<div class="row end"><button id="ix">Cancel</button><button class="pri" id="is"${will ? '' : ' disabled'}>Import ${will} classes</button></div>`,
  );
  const d = $('#dlg');
  d.scrollTop = st;
  d.oncancel = e => e.preventDefault();
  d.onchange = e => {
    const t = e.target.dataset,
      g = IMP.groups[t.g];
    if (!g || !t.f) return;
    if (t.f === 'vid') {
      g.vid = e.target.value;
      g.how = '';
    } else {
      const r = g.rows[t.r];
      r[t.f] = t.f === 'inc' ? e.target.checked : e.target.value;
      if (t.f !== 'inc' && t.f !== 'day' && t.f !== 'course') r.guess = false;
    }
    impRender();
  };
  d.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    const t = b.dataset,
      g = IMP.groups[t.g];
    if (b.id === 'ix') closeDlg();
    else if (b.id === 'is') impSave();
    else if (t.act === 'add') {
      g.rows.push({
        day: 'Sunday',
        course: '',
        start: '',
        end: '',
        inc: true,
        guess: false,
      });
      impRender();
    } else if (t.act === 'del') {
      g.rows.splice(t.r, 1);
      impRender();
    }
  };
}
async function impSave() {
  const seen = new Set(),
    per = {},
    S = { imp: 0, dup: 0, bad: 0, off: 0, unm: 0, unp: 0, fail: 0 };
  IMP.groups.forEach(g => {
    S.unp += g.unparsed.length;
    if (!g.vid) S.unm++;
    g.rows.forEach(r => {
      const [s] = rowStat(g, r, seen);
      if (s === 'dup') S.dup++;
      else if (s === 'bad') S.bad++;
      else if (!r.inc) S.off++;
      else
        (per[g.vid] ??= []).push({
          day: r.day,
          course: r.course.trim(),
          start: r.start,
          end: r.end,
        });
    });
  });
  lock('<h2>Importing…</h2><progress style="width:100%"></progress>');
  for (const id of Object.keys(per)) {
    if (await Store.addClasses(id, per[id])) S.imp += per[id].length;
    else S.fail += per[id].length;
  }
  dlg(
    `<h2>Import summary</h2><ul><li>Imported: <b>${S.imp}</b></li><li>Skipped duplicates: <b>${S.dup}</b></li><li>Skipped invalid: <b>${S.bad}</b></li><li>Unchecked by you: <b>${S.off}</b></li><li>Screenshots with no volunteer chosen: <b>${S.unm}</b></li><li>Unparsed lines (add manually): <b>${S.unp}</b></li>${S.fail ? `<li class="err">Failed to save: <b>${S.fail}</b> (see error message)</li>` : ''}</ul><p class="muted">Routine verification was not changed. Open each volunteer, check the classes, then set Verified.</p><div class="row end"><button class="pri" onclick="closeDlg()">Done</button></div>`,
  );
  render();
}

/* ===== Connection, login, migration ===== */
const STATUS = {
  checking: ['Checking connection…', 'Pending'],
  noconfig: ['Not configured', 'Rejected'],
  login: ['Sign in required', 'Pending'],
  connected: ['Connected to database', 'active'],
  error: ['Database unavailable', 'Rejected'],
};
function setStatus(k, tip) {
  Store.state = k;
  const el = $('#conn');
  el.textContent = STATUS[k][0];
  el.className = 'badge b-' + STATUS[k][1];
  el.title = tip || '';
  $('#so').hidden = k !== 'connected';
}
function setBusy(d) {
  Store.busyN += d;
  if (Store.state === 'connected')
    $('#conn').textContent = Store.busyN > 0 ? 'Saving…' : STATUS.connected[0];
}
const cfgOk = () => {
  const c = window.VH_CONFIG || {};
  return (
    /^https:\/\/\S+$/.test(c.SUPABASE_URL || '') &&
    (c.SUPABASE_ANON_KEY || '').length > 30
  );
};
function lock(html) {
  dlg(html);
  $('#dlg').oncancel = e => e.preventDefault();
}
async function boot() {
  Store.ok = false;
  setStatus('checking');
  if (!cfgOk() || !window.supabase) {
    setStatus('noconfig');
    return lock(
      `<h2>Database not configured</h2><p>${window.supabase ? 'Open <b>config.js</b> and paste your Supabase Project URL and anon key.' : 'The Supabase library could not load. Check your internet connection.'} Steps are in SETUP.md. No data is shown or saved until the database is connected.</p>`,
    );
  }
  if (!Store.sb) {
    Store.sb = window.supabase.createClient(
      VH_CONFIG.SUPABASE_URL,
      VH_CONFIG.SUPABASE_ANON_KEY,
    );
    Store.sb.auth.onAuthStateChange(ev => {
      if (ev === 'SIGNED_OUT') {
        Store.cache = { v: [], e: [] };
        render();
        boot();
      }
    });
  }
  try {
    const { data, error } = await Store.sb.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      setStatus('login');
      return loginDlg();
    }
    if ((await Store.run(Store.sb.rpc('is_admin'))) !== true)
      throw new Error(
        'This account is not on the admin list (SETUP.md, step 4).',
      );
    await Store.load();
    Store.ok = true;
    setStatus('connected');
    closeDlg();
    render();
  } catch (e) {
    setStatus('error', errMsg(e));
    lock(
      `<h2>Database unavailable</h2><p class="err">${esc(errMsg(e))}</p><div class="row end"><button id="rt">Retry</button><button id="lo">Sign out</button></div>`,
    );
    $('#rt').onclick = boot;
    $('#lo').onclick = () => Store.sb.auth.signOut();
  }
}
function loginDlg() {
  lock(
    `<h2>Admin sign in</h2><form id="lf" class="f"><label>Email<input type="email" name="email" required autocomplete="username"></label><label>Password<input type="password" name="password" required autocomplete="current-password"></label><p class="err" id="le"></p><button class="pri">Sign in</button></form>`,
  );
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const { error } = await Store.sb.auth.signInWithPassword(
      Object.fromEntries(new FormData(e.target)),
    );
    if (error)
      return ($('#le').textContent = /fetch|network/i.test(error.message)
        ? 'Cannot reach Supabase. Check your internet and config.js.'
        : 'Sign in failed: ' + error.message);
    boot();
  };
}
function localData() {
  const r = k => {
    try {
      const x = JSON.parse(localStorage.getItem(k));
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  };
  return { v: r('vh.volunteers'), e: r('vh.events') };
}
async function migrate() {
  // copies old browser data into Supabase; never deletes anything
  if (!Store.ok) return toast('Connect and sign in first.', 'err');
  const L = localData();
  if (!L.v.length && !L.e.length)
    return toast(
      'No old data in this browser. Open the site at the same address you used before.',
      'err',
    );
  const byPhone = new Map(Store.volunteers().map(v => [v.phone, v])),
    newV = L.v.filter(
      v => v && v.id && v.phone && v.name && !byPhone.has(cleanPhone(v.phone)),
    );
  const key = e => [e.name, e.date, e.start].join('|'),
    haveE = new Set(Store.events().map(key)),
    newE = L.e.filter(
      e =>
        e &&
        e.name &&
        e.date &&
        e.start &&
        e.end &&
        t2m(e.end) > t2m(e.start) &&
        !haveE.has(key(e)),
    );
  dlg(
    `<h2>Migrate browser data</h2><p>Found ${L.v.length} volunteers and ${L.e.length} events in this browser.</p><ul><li>${newV.length} new volunteers will be added</li><li>${L.v.length - newV.length} skipped (already in the database or duplicate phone)</li><li>${newE.length} new events will be added</li></ul><p class="muted">Nothing is deleted. The copy in this browser stays untouched.</p><div class="row end"><button onclick="closeDlg()">Cancel</button><button class="pri" id="mg"${newV.length || newE.length ? '' : ' disabled'}>Migrate now</button></div>`,
  );
  $('#mg').onclick = async () => {
    const all = Store.volunteers(),
      used = new Set(all.map(v => v.id)),
      map = {},
      seen = new Map();
    let n = Math.max(0, ...all.map(x => +x.id.slice(1) || 0));
    L.v.forEach(o => {
      const ex = o && byPhone.get(cleanPhone(o.phone));
      if (ex) map[o.id] = ex.id;
    });
    for (const o of newV) {
      const p = cleanPhone(o.phone);
      if (seen.has(p)) {
        map[o.id] = seen.get(p);
        continue;
      }
      let id = used.has(o.id) ? 'V' + String(++n).padStart(3, '0') : o.id;
      used.add(id);
      map[o.id] = id;
      seen.set(p, id);
      let path = '';
      const sh = o.screenshot || '';
      if (sh.startsWith('assets/')) path = sh;
      else if (sh.startsWith('data:'))
        try {
          path = (await Store.uploadShot(id, await (await fetch(sh)).blob()))
            .path;
        } catch {
          toast(
            'Screenshot of ' +
              o.name +
              ' was not uploaded; the rest is migrated.',
            'err',
          );
        }
      all.push({
        id,
        name: String(o.name).trim(),
        phone: p,
        address: o.address || '',
        dept: o.dept || '',
        status: o.status === 'inactive' ? 'inactive' : 'active',
        verification: ['Verified', 'Pending', 'Rejected'].includes(
          o.verification,
        )
          ? o.verification
          : 'Pending',
        classes: (Array.isArray(o.classes) ? o.classes : [])
          .filter(
            c =>
              c &&
              DAYS.includes(c.day) &&
              c.start &&
              c.end &&
              t2m(c.end) > t2m(c.start),
          )
          .map(c => ({
            day: c.day,
            course: String(c.course || ''),
            start: c.start,
            end: c.end,
          })),
        shotPath: path,
        screenshot: '',
        driveUrl: o.driveUrl || '',
      });
    }
    const evs = Store.events();
    newE.forEach(e =>
      evs.push({
        id: uid('E'),
        name: String(e.name),
        date: e.date,
        start: e.start,
        end: e.end,
        location: e.location || '',
        required: +e.required || 1,
        assigned: [
          ...new Set((e.assigned || []).map(a => map[a]).filter(Boolean)),
        ],
      }),
    );
    if ((await Store.saveVolunteers(all)) && (await Store.saveEvents(evs))) {
      await Store.load();
      closeDlg();
      render();
      toast(
        `Migrated ${newV.length} volunteers and ${newE.length} events. Your browser copy was kept.`,
      );
    }
  };
}

/* ===== Init ===== */
function render() {
  renderDashboard();
  renderVolunteers();
  renderRoutines();
  renderEvents();
}
function init() {
  $('#nav').onclick = e => {
    const b = e.target.closest('button');
    if (b) go(b.dataset.p);
  };
  $('#menu').onclick = () => $('#side').classList.toggle('open');
  $('#q').oninput = renderVolunteers;
  $('#fs').onchange = renderVolunteers;
  $('#addV').onclick = () => volForm();
  $('#addE').onclick = () => evForm();
  $('#ff').onsubmit = find;
  $('#fd').value = new Date().toISOString().slice(0, 10);
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-a],[data-e]');
    if (!b) return;
    const id = b.dataset.id,
      a = b.dataset.a;
    if (a === 'view') detail(id);
    else if (a === 'edit') volForm(id);
    else if (a === 'copy') copy(id);
    else if (a === 'del') delVol(id);
    const x = b.dataset.e;
    if (x === 'view') evView(id);
    else if (x === 'edit') evForm(id);
    else if (x === 'assign') assign(id);
    else if (x === 'del')
      confirmDlg('Delete this event?', 'Delete').then(async y => {
        if (
          y &&
          (await Store.saveEvents(Store.events().filter(v => v.id !== id)))
        ) {
          toast('Event deleted');
          render();
        }
      });
  });
  $('#xj').onclick = () =>
    download(
      'volunteerhub-backup.json',
      JSON.stringify(
        { volunteers: Store.volunteers(), events: Store.events() },
        null,
        2,
      ),
      'application/json',
    );
  $('#ij').onclick = () => $('#fj').click();
  readFile($('#fj'), importJSON);
  $('#ic').onclick = () => $('#fc').click();
  readFile($('#fc'), previewCSV);
  $('#xc').onclick = exportCSV;
  $('#rs').onclick = async () => {
    if (
      await confirmDlg(
        'This DELETES everything in the shared online database and loads the sample volunteers. Continue?',
        'Delete and reset',
      )
    ) {
      const sv = SEED_VOLUNTEERS.map(v => ({
        ...v,
        shotPath: v.screenshot,
        screenshot: v.screenshot,
      }));
      if ((await Store.saveVolunteers(sv)) && (await Store.saveEvents([]))) {
        toast('Sample data restored');
        render();
      }
    }
  };
  $('#imp').onclick = () => impStart(false);
  $('#impA').onclick = () => impStart(true);
  $('#fimp').onchange = e => {
    const fs = [...e.target.files];
    e.target.value = '';
    if (fs.length) runOCR(fs.map(f => ({ name: f.name, get: async () => f })));
  };
  $('#mig').onclick = migrate;
  $('#so').onclick = () => Store.sb && Store.sb.auth.signOut();
  render();
  boot();
  go(TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');
}
if (typeof document !== 'undefined') init();
else
  module.exports = {
    checkAvail,
    runTests,
    Store,
    parseRoutineText,
    matchVolunteer,
  };
