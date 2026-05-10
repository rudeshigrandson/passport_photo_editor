const $ = (id) => document.getElementById(id);

let originalBlob = null;
let cutoutBlob = null;
let finalBlob = null;
let finalDataURL = null;       // for SVG preview
let PAPER = {};                // {key: {w,h}} mm
let PHOTO = {};                // same

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

/* ---------- INIT ---------- */
async function init() {
  const r = await fetch('/api/paper-options');
  const d = await r.json();
  PAPER = d.paper; PHOTO = d.photo;

  const paperSel = $('paper');
  for (const k of Object.keys(PAPER)) paperSel.add(new Option(k, k));

  const photoSel = $('photo-size');
  for (const k of Object.keys(PHOTO)) photoSel.add(new Option(PHOTO_LABELS[k] || k, k));
  photoSel.value = 'passport_intl_35x45';

  buildPalette();
  ['paper', 'photo-size', 'margin', 'gap'].forEach(id =>
    $(id).addEventListener('input', renderSheetPreview));

  setupDropzone();
}
init();

/* ---------- PALETTE ---------- */
function buildPalette() {
  const wrap = $('palette');
  wrap.innerHTML = '';
  for (const { c, n } of PALETTE) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.style.background = c;
    sw.dataset.color = c;
    sw.dataset.name = n;
    sw.title = n;
    sw.addEventListener('click', () => selectColor(c));
    wrap.appendChild(sw);
  }
  // mark default
  markActiveSwatch('#ffffff');
}
function markActiveSwatch(hex) {
  document.querySelectorAll('.swatch').forEach(el =>
    el.classList.toggle('active', el.dataset.color.toLowerCase() === hex.toLowerCase()));
}
async function selectColor(hex) {
  $('bg-color').value = hex;
  $('hex-display').textContent = hex.toLowerCase();
  markActiveSwatch(hex);
  await applyColor(hex);
}
$('bg-color').addEventListener('input', (e) => selectColor(e.target.value));

/* ---------- DROPZONE ---------- */
function setupDropzone() {
  const dz = $('dropzone');
  const file = $('file');
  dz.addEventListener('click', () => file.click());
  ['dragenter', 'dragover'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  file.addEventListener('change', () => {
    if (file.files[0]) handleFile(file.files[0]);
  });
}

/* ---------- PIPELINE ---------- */
async function handleFile(f) {
  if (!/^image\//.test(f.type)) {
    setStatus('detect-status', 'Not an image file.', 'err');
    return;
  }
  originalBlob = f;
  cutoutBlob = null; finalBlob = null; finalDataURL = null;
  $('step-detect').hidden = false;
  $('step-bg').hidden = true;
  $('step-sheet').hidden = true;
  await drawToCanvas(f, $('orig-canvas'));

  setStatus('detect-status', 'Detecting face…');
  const fd = new FormData();
  fd.append('image', f);
  const r = await fetch('/api/detect', { method: 'POST', body: fd });
  const d = await r.json();
  if (d.face) {
    setStatus('detect-status', `✓ Face detected (confidence ${d.score.toFixed(2)})`, 'ok');
    drawBox($('orig-canvas'), d.bbox);
    $('step-bg').hidden = false;
  } else {
    setStatus('detect-status', '✗ No face detected. Try another photo.', 'err');
  }
}

$('btn-remove').addEventListener('click', async (e) => {
  busy(e.currentTarget, true);
  const fd = new FormData();
  fd.append('image', originalBlob);
  const r = await fetch('/api/remove-bg', { method: 'POST', body: fd });
  cutoutBlob = await r.blob();
  await applyColor($('bg-color').value);
  $('bg-controls').hidden = false;
  $('step-sheet').hidden = false;
  renderSheetPreview();
  busy(e.currentTarget, false);
});

async function applyColor(color) {
  if (!cutoutBlob) return;
  const fd = new FormData();
  fd.append('image', cutoutBlob, 'cut.png');
  fd.append('color', color);
  const r = await fetch('/api/apply-bg', { method: 'POST', body: fd });
  finalBlob = await r.blob();
  finalDataURL = await blobToDataURL(finalBlob);
  await drawToCanvas(finalBlob, $('final-canvas'));
  renderSheetPreview();
  $('hex-display').textContent = color.toLowerCase();
}

$('btn-sheet').addEventListener('click', async (e) => {
  if (!finalBlob) {
    setStatus('sheet-status', 'Apply a background color first.', 'err');
    return;
  }
  busy(e.currentTarget, true);
  setStatus('sheet-status', 'Generating PDF…');
  const fd = new FormData();
  fd.append('image', finalBlob, 'photo.png');
  fd.append('paper', $('paper').value);
  fd.append('photo_size', $('photo-size').value);
  fd.append('dpi', $('dpi').value);
  fd.append('margin', $('margin').value);
  fd.append('gap', $('gap').value);
  fd.append('cut_lines', $('cut').checked ? '1' : '0');
  const r = await fetch('/api/generate-sheet', { method: 'POST', body: fd });
  if (!r.ok) {
    setStatus('sheet-status', 'Failed to generate.', 'err');
    busy(e.currentTarget, false);
    return;
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `passport_sheet.pdf`; a.click();
  URL.revokeObjectURL(url);
  setStatus('sheet-status', '✓ Downloaded.', 'ok');
  busy(e.currentTarget, false);
});

/* ---------- SHEET PREVIEW (SVG) ---------- */
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
  const gridW = cols * fw + (cols - 1) * gap;
  const gridH = rows * fh + (rows - 1) * gap;
  const x0 = (pw - gridW) / 2;
  const y0 = (ph - gridH) / 2;

  // photos as image fill (or color rect if none yet)
  let cells = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * (fw + gap);
      const y = y0 + r * (fh + gap);
      if (finalDataURL) {
        cells += `<image x="${x}" y="${y}" width="${fw}" height="${fh}" href="${finalDataURL}" preserveAspectRatio="xMidYMid slice"/>`;
        if ($('cut').checked) {
          cells += `<rect x="${x}" y="${y}" width="${fw}" height="${fh}" fill="none" stroke="#bbb" stroke-width="0.2"/>`;
        }
      } else {
        cells += `<rect x="${x}" y="${y}" width="${fw}" height="${fh}" fill="#dbe5ff" stroke="#7fa0d8" stroke-width="0.3"/>`;
      }
    }
  }

  wrap.innerHTML = `
    <svg viewBox="0 0 ${pw} ${ph}" xmlns="http://www.w3.org/2000/svg" style="background:white;border:1px solid #d4d4e4;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,0.08);">
      <rect x="0" y="0" width="${pw}" height="${ph}" fill="white"/>
      ${cells}
    </svg>`;

  $('layout-info').innerHTML =
    `<b>${cols} × ${rows} = ${cols*rows}</b> photos · ` +
    `paper ${pw.toFixed(0)}×${ph.toFixed(0)} mm · ` +
    `photo ${fw}×${fh} mm`;
}
$('cut').addEventListener('change', renderSheetPreview);

/* ---------- HELPERS ---------- */
function setStatus(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}
function busy(btn, on) {
  btn.disabled = on;
  btn.querySelector('.spinner').hidden = !on;
}
async function drawToCanvas(blob, canvas) {
  const url = URL.createObjectURL(blob);
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i); i.onerror = rej; i.src = url;
  });
  const max = 480;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
}
function drawBox(canvas, bb) {
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#00d4a3'; ctx.lineWidth = 3;
  ctx.strokeRect(bb.x * canvas.width, bb.y * canvas.height,
                 bb.w * canvas.width, bb.h * canvas.height);
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}
