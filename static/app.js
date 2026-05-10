const $ = (id) => document.getElementById(id);
const DEFAULT_TOTAL = 20;            // default copies per sheet across all photos
let PAPER = {}, PHOTO = {};
let nextId = 1;
const photos = [];                   // see schema below

/*
photo = {
  id: 'p1',
  origBlob,
  cutoutBlob,        // PNG with transparent bg, or null
  finalBlob,         // image actually placed on sheet
  finalDataURL,      // for SVG preview
  bgRemoved: false,
  bgColor: '#ffffff',
  count: 10,
  el,                // DOM card
}
*/

const PHOTO_LABELS = {
  passport_us_2x2: 'US Passport (2×2 in)',
  passport_intl_35x45: 'International (35×45 mm)',
  visa_uk_35x45: 'UK Visa (35×45 mm)',
  visa_schengen_35x45: 'Schengen Visa (35×45 mm)',
  india_35x35: 'India (35×35 mm)',
  china_33x48: 'China (33×48 mm)',
};

const PALETTE = [
  { c: '#ffffff', n: 'White' },
  { c: '#f5f5f0', n: 'Off-white' },
  { c: '#e8eef7', n: 'Pale blue' },
  { c: '#c8d8f0', n: 'Light blue' },
  { c: '#7fb3e8', n: 'Sky blue' },
  { c: '#1f4e8c', n: 'Navy' },
  { c: '#dcdcdc', n: 'Light gray' },
  { c: '#a0a0a0', n: 'Mid gray' },
  { c: '#fff8dc', n: 'Cream' },
  { c: '#f8d7d7', n: 'Soft pink' },
  { c: '#ff3030', n: 'Red' },
  { c: '#0a0a0a', n: 'Black' },
];

/* ============== INIT ============== */
async function init() {
  const r = await fetch('/api/paper-options');
  const d = await r.json();
  PAPER = d.paper; PHOTO = d.photo;

  const paperSel = $('paper');
  for (const k of Object.keys(PAPER)) paperSel.add(new Option(k, k));
  const photoSel = $('photo-size');
  for (const k of Object.keys(PHOTO)) photoSel.add(new Option(PHOTO_LABELS[k] || k, k));
  photoSel.value = 'passport_intl_35x45';

  ['paper', 'photo-size', 'margin', 'gap'].forEach(id =>
    $(id).addEventListener('input', () => { redistributeCounts(); renderSheetPreview(); }));
  $('cut').addEventListener('change', renderSheetPreview);

  // Format auto-default based on paper. Stops auto-defaulting once user picks
  // an option themselves.
  $('paper').addEventListener('change', () => {
    if (!$('format').dataset.touched) autoFormat();
    updateBtnLabel();
  });
  $('format').addEventListener('change', () => {
    $('format').dataset.touched = '1';
    updateBtnLabel();
  });
  autoFormat();
  updateBtnLabel();

  setupDropzone();
  $('btn-add-more').addEventListener('click', () => $('file').click());
  $('btn-sheet').addEventListener('click', generateSheet);
  $('btn-refresh').addEventListener('click', startFresh);
}

const PDF_FRIENDLY_PAPERS = new Set(['A4', 'A3', 'Letter']);
function autoFormat() {
  const paper = $('paper').value;
  $('format').value = PDF_FRIENDLY_PAPERS.has(paper) ? 'pdf' : 'image';
}
function updateBtnLabel() {
  const fmt = $('format').value;
  const totalCopies = photos.reduce((s, p) => s + p.count, 0);
  const cap = capacity();
  const pages = totalCopies ? Math.ceil(totalCopies / cap) : 1;
  let label;
  if (fmt === 'pdf') {
    label = pages > 1 ? `Generate & download PDF (${pages} pages)` : 'Generate & download PDF';
  } else {
    label = pages > 1 ? `Generate & download ZIP (${pages} images)` : 'Generate & download PNG';
  }
  $('btn-sheet').querySelector('.btn-label').textContent = label;
}

function startFresh() {
  location.reload();
}
init();

/* ============== DROPZONE ============== */
function setupDropzone() {
  const dz = $('dropzone');
  const file = $('file');
  dz.addEventListener('click', () => file.click());
  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
  file.addEventListener('change', () => { addFiles(file.files); file.value = ''; });
}

async function addFiles(fileList) {
  // accept anything that *looks* like an image OR has a heic/heif extension
  // (Safari/Chrome don't always set type for HEIC).
  const arr = Array.from(fileList).filter(f =>
    /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
  if (!arr.length) return;
  for (const f of arr) await addPhoto(f);
  redistributeCounts();
  renderSheetPreview();
}

/* ============== PHOTO LIFECYCLE ============== */
async function addPhoto(file) {
  const id = 'p' + (nextId++);

  // Normalize through server: HEIC -> JPEG, EXIF rotation applied.
  // Use the normalized blob as the canonical version going forward.
  let normBlob;
  try {
    const fd = new FormData();
    fd.append('image', file);
    const r = await fetch('/api/preview', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('preview failed');
    normBlob = await r.blob();
  } catch (e) {
    console.warn('preview endpoint failed, falling back to raw file', e);
    normBlob = file;
  }

  const photo = {
    id,
    origBlob: normBlob,
    cutoutBlob: null,
    finalBlob: normBlob,
    finalDataURL: await blobToDataURL(normBlob),
    bgRemoved: false,
    bgColor: '#ffffff',
    count: 0,
    el: null,
  };
  photo.el = buildCard(photo);
  photos.push(photo);
  $('photo-list').appendChild(photo.el);
  $('step-photos').hidden = false;
  $('step-sheet').hidden = false;
  $('photos-count').textContent = photos.length;

  await drawToCanvas(normBlob, photo.el.querySelector('.thumb'));
  detectFace(photo);
}

async function detectFace(photo) {
  const fd = new FormData();
  fd.append('image', photo.origBlob);
  const r = await fetch('/api/detect', { method: 'POST', body: fd });
  const d = await r.json();
  const badge = photo.el.querySelector('.face-badge');
  if (d.face) {
    badge.textContent = `✓ face ${d.score.toFixed(2)}`;
    badge.className = 'face-badge ok';
  } else {
    badge.textContent = '✗ no face';
    badge.className = 'face-badge err';
  }
}

function buildCard(photo) {
  const tpl = $('tpl-photo-card');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = photo.id;

  // remove btn
  node.querySelector('.remove-photo').addEventListener('click', () => removePhoto(photo.id));

  // bg toggle
  const toggle = node.querySelector('.bg-toggle');
  const bgSection = node.querySelector('.bg-section');
  toggle.addEventListener('change', async () => {
    if (toggle.checked) {
      bgSection.hidden = false;
      await removeBg(photo);
      await applyColor(photo, photo.bgColor);
    } else {
      bgSection.hidden = true;
      photo.bgRemoved = false;
      photo.cutoutBlob = null;
      photo.finalBlob = photo.origBlob;
      photo.finalDataURL = await blobToDataURL(photo.origBlob);
      await drawToCanvas(photo.finalBlob, node.querySelector('.thumb'));
      renderSheetPreview();
    }
  });

  // mini palette
  const pal = node.querySelector('.mini-palette');
  for (const { c, n } of PALETTE) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.style.background = c;
    sw.dataset.color = c;
    sw.title = n;
    sw.addEventListener('click', () => {
      node.querySelector('.bg-color').value = c;
      node.querySelector('.hex').textContent = c.toLowerCase();
      applyColor(photo, c);
      pal.querySelectorAll('.swatch').forEach(s =>
        s.classList.toggle('active', s.dataset.color === c));
    });
    pal.appendChild(sw);
  }

  // custom color
  const colorInput = node.querySelector('.bg-color');
  colorInput.addEventListener('input', e => {
    node.querySelector('.hex').textContent = e.target.value.toLowerCase();
    applyColor(photo, e.target.value);
  });

  // count
  const countInput = node.querySelector('.count');
  countInput.addEventListener('input', () => {
    photo.count = Math.max(0, parseInt(countInput.value, 10) || 0);
    renderSheetPreview();
  });

  return node;
}

function removePhoto(id) {
  const idx = photos.findIndex(p => p.id === id);
  if (idx < 0) return;
  photos[idx].el.remove();
  photos.splice(idx, 1);
  $('photos-count').textContent = photos.length;
  if (!photos.length) {
    $('step-photos').hidden = true;
    $('step-sheet').hidden = true;
    return;
  }
  redistributeCounts();
  renderSheetPreview();
}

/* ============== BG REMOVAL & COLOR ============== */
async function removeBg(photo) {
  const card = photo.el;
  showCardBusy(card, true, 'Removing background…');
  try {
    const fd = new FormData();
    fd.append('image', photo.origBlob);
    const r = await fetch('/api/remove-bg', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('remove-bg failed');
    photo.cutoutBlob = await r.blob();
    photo.bgRemoved = true;
  } catch (err) {
    console.error(err);
    card.querySelector('.bg-toggle').checked = false;
  } finally {
    showCardBusy(card, false);
  }
}

async function applyColor(photo, hex) {
  if (!photo.cutoutBlob) return;
  photo.bgColor = hex;
  const fd = new FormData();
  fd.append('image', photo.cutoutBlob, 'cut.png');
  fd.append('color', hex);
  const r = await fetch('/api/apply-bg', { method: 'POST', body: fd });
  photo.finalBlob = await r.blob();
  photo.finalDataURL = await blobToDataURL(photo.finalBlob);
  await drawToCanvas(photo.finalBlob, photo.el.querySelector('.thumb'));
  renderSheetPreview();
}

/* ============== COUNT DEFAULTS ============== */
function capacity() {
  const paperKey = $('paper').value;
  const photoKey = $('photo-size').value;
  if (!PAPER[paperKey] || !PHOTO[photoKey]) return DEFAULT_TOTAL;
  const pw = PAPER[paperKey].w, ph = PAPER[paperKey].h;
  const fw = PHOTO[photoKey].w, fh = PHOTO[photoKey].h;
  const m = parseFloat($('margin').value) || 0;
  const g = parseFloat($('gap').value) || 0;
  const c = Math.max(1, Math.floor((pw - 2*m + g) / (fw + g)));
  const r = Math.max(1, Math.floor((ph - 2*m + g) / (fh + g)));
  return c * r;
}

function redistributeCounts() {
  if (!photos.length) return;
  const target = Math.min(DEFAULT_TOTAL, capacity());
  const base = Math.floor(target / photos.length);
  const extra = target - base * photos.length;
  photos.forEach((p, i) => {
    p.count = base + (i < extra ? 1 : 0);
    p.el.querySelector('.count').value = p.count;
  });
}

/* ============== SHEET PREVIEW ============== */
function renderSheetPreview() {
  const wrap = $('sheet-preview');
  const paperKey = $('paper').value;
  const photoKey = $('photo-size').value;
  if (!PAPER[paperKey] || !PHOTO[photoKey]) { wrap.innerHTML = ''; return; }

  const pw = PAPER[paperKey].w, ph = PAPER[paperKey].h;
  const fw = PHOTO[photoKey].w, fh = PHOTO[photoKey].h;
  const margin = parseFloat($('margin').value) || 0;
  const gap = parseFloat($('gap').value) || 0;
  const cols = Math.max(1, Math.floor((pw - 2*margin + gap) / (fw + gap)));
  const rows = Math.max(1, Math.floor((ph - 2*margin + gap) / (fh + gap)));
  const cap = cols * rows;

  // build placement queue from photo counts
  const queue = [];
  for (const p of photos) {
    for (let i = 0; i < p.count && queue.length < cap; i++) {
      queue.push(p.finalDataURL);
    }
    if (queue.length >= cap) break;
  }

  const gridW = cols * fw + (cols - 1) * gap;
  const gridH = rows * fh + (rows - 1) * gap;
  const x0 = (pw - gridW) / 2;
  const y0 = (ph - gridH) / 2;

  let cells = '';
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * (fw + gap);
      const y = y0 + r * (fh + gap);
      if (i < queue.length) {
        cells += `<image x="${x}" y="${y}" width="${fw}" height="${fh}" href="${queue[i]}" preserveAspectRatio="xMidYMid slice"/>`;
        if ($('cut').checked) {
          cells += `<rect x="${x}" y="${y}" width="${fw}" height="${fh}" fill="none" stroke="#bbb" stroke-width="0.2"/>`;
        }
      } else {
        cells += `<rect x="${x}" y="${y}" width="${fw}" height="${fh}" fill="#f0f0f7" stroke="#d0d0e0" stroke-width="0.2" stroke-dasharray="1,1"/>`;
      }
      i++;
    }
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${pw} ${ph}" xmlns="http://www.w3.org/2000/svg" style="background:white;border:1px solid #d4d4e4;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,0.08);">
      <rect x="0" y="0" width="${pw}" height="${ph}" fill="white"/>
      ${cells}
    </svg>`;

  // total copies across all photos (not capped to one page)
  const totalCopies = photos.reduce((s, p) => s + p.count, 0);
  const pages = Math.max(1, Math.ceil(totalCopies / cap));
  const pageNote = pages > 1
    ? ` · <b>${pages} pages</b> (showing page 1)`
    : '';

  $('layout-info').innerHTML =
    `<b>${totalCopies}</b> total copies · grid <b>${cols}×${rows}</b> = ${cap}/page · ` +
    `paper ${pw.toFixed(0)}×${ph.toFixed(0)} mm · photo ${fw}×${fh} mm${pageNote}`;

  updateBtnLabel();
}

/* ============== GENERATE ============== */
async function generateSheet(e) {
  const btn = e.currentTarget;
  if (!photos.length) {
    setStatus('sheet-status', 'Add at least one photo.', 'err'); return;
  }
  const totalCount = photos.reduce((s, p) => s + p.count, 0);
  if (totalCount === 0) {
    setStatus('sheet-status', 'Set copies > 0 on at least one photo.', 'err'); return;
  }
  busy(btn, true);
  setStatus('sheet-status', 'Generating…');

  try {
    const fd = new FormData();
    for (const p of photos) fd.append('images', p.finalBlob, `${p.id}.png`);
    fd.append('counts', JSON.stringify(photos.map(p => p.count)));
    fd.append('paper', $('paper').value);
    fd.append('photo_size', $('photo-size').value);
    fd.append('dpi', $('dpi').value);
    fd.append('margin', $('margin').value);
    fd.append('gap', $('gap').value);
    fd.append('cut_lines', $('cut').checked ? '1' : '0');
    fd.append('smart_crop', $('smart').checked ? '1' : '0');
    fd.append('format', $('format').value);

    const r = await fetch('/api/generate-sheet', { method: 'POST', body: fd });
    if (!r.ok) {
      setStatus('sheet-status', 'Failed to generate.', 'err');
      return;
    }
    const blob = await r.blob();
    // Pick filename + extension from server's content-disposition if possible,
    // otherwise derive from mimetype.
    let filename = 'passport_sheet';
    const cd = r.headers.get('content-disposition') || '';
    const m = /filename="?([^";]+)"?/.exec(cd);
    if (m) filename = m[1];
    else if (blob.type === 'application/pdf') filename += '.pdf';
    else if (blob.type === 'application/zip') filename += '.zip';
    else if (blob.type === 'image/png') filename += '.png';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    setStatus('sheet-status', `✓ Downloaded (${filename}).`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus('sheet-status', 'Failed: ' + (err.message || err), 'err');
  } finally {
    busy(btn, false);
  }
}

/* ============== HELPERS ============== */
function setStatus(id, text, cls) {
  const el = $(id); el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}
function busy(btn, on) {
  btn.disabled = on;
  btn.querySelector('.spinner').hidden = !on;
}
function showCardBusy(card, on, label='') {
  card.classList.toggle('busy', on);
  let bar = card.querySelector('.busy-bar');
  if (on) {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'busy-bar';
      card.appendChild(bar);
    }
    bar.textContent = label;
  } else if (bar) {
    bar.remove();
  }
}
async function drawToCanvas(blob, canvas) {
  const url = URL.createObjectURL(blob);
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i); i.onerror = rej; i.src = url;
  });
  const max = 200;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}
