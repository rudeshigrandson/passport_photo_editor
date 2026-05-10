const $ = (id) => document.getElementById(id);
let originalBlob = null;   // raw uploaded
let cutoutBlob = null;     // bg-removed PNG (transparent)
let finalBlob = null;      // bg-color applied PNG

const fileInput = $('file');
const stepDetect = $('step-detect');
const stepBg = $('step-bg');
const stepSheet = $('step-sheet');
const detectStatus = $('detect-status');
const origCanvas = $('orig-canvas');
const finalCanvas = $('final-canvas');
const bgControls = $('bg-controls');
const bgColor = $('bg-color');
const sheetStatus = $('sheet-status');

async function loadPaperOptions() {
  const r = await fetch('/api/paper-options');
  const d = await r.json();
  for (const p of d.paper) $('paper').add(new Option(p, p));
  for (const p of d.photo) $('photo-size').add(new Option(p.replace(/_/g, ' '), p));
  $('photo-size').value = 'passport_intl_35x45';
}
loadPaperOptions();

fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  if (!f) return;
  originalBlob = f;
  await drawToCanvas(f, origCanvas);
  stepDetect.hidden = false;
  detectStatus.textContent = 'Checking…';
  detectStatus.className = 'status';

  const fd = new FormData();
  fd.append('image', f);
  const r = await fetch('/api/detect', { method: 'POST', body: fd });
  const d = await r.json();
  if (d.face) {
    detectStatus.textContent = `Face detected (score ${d.score.toFixed(2)})`;
    detectStatus.className = 'status ok';
    drawBox(origCanvas, d.bbox, d.image_size);
    stepBg.hidden = false;
  } else {
    detectStatus.textContent = 'No face detected. Try another photo.';
    detectStatus.className = 'status err';
    stepBg.hidden = true;
  }
});

$('btn-remove').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Removing…';
  const fd = new FormData();
  fd.append('image', originalBlob);
  const r = await fetch('/api/remove-bg', { method: 'POST', body: fd });
  cutoutBlob = await r.blob();
  await applyColor(bgColor.value);
  bgControls.hidden = false;
  stepSheet.hidden = false;
  e.target.disabled = false;
  e.target.textContent = 'Remove background';
});

bgColor.addEventListener('input', () => applyColor(bgColor.value));
document.querySelectorAll('.presets button').forEach(b =>
  b.addEventListener('click', () => { bgColor.value = b.dataset.c; applyColor(b.dataset.c); }));

async function applyColor(color) {
  if (!cutoutBlob) return;
  const fd = new FormData();
  fd.append('image', cutoutBlob, 'cut.png');
  fd.append('color', color);
  const r = await fetch('/api/apply-bg', { method: 'POST', body: fd });
  finalBlob = await r.blob();
  await drawToCanvas(finalBlob, finalCanvas);
}

$('btn-sheet').addEventListener('click', async (e) => {
  if (!finalBlob) { sheetStatus.textContent = 'Apply background first.'; sheetStatus.className='status err'; return; }
  e.target.disabled = true;
  sheetStatus.textContent = 'Generating PDF…'; sheetStatus.className = 'status';
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
    sheetStatus.textContent = 'Failed.'; sheetStatus.className = 'status err';
    e.target.disabled = false; return;
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `passport_sheet.pdf`; a.click();
  URL.revokeObjectURL(url);
  sheetStatus.textContent = 'Downloaded.'; sheetStatus.className = 'status ok';
  e.target.disabled = false;
});

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

function drawBox(canvas, bb, imgSize) {
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#00c853'; ctx.lineWidth = 3;
  ctx.strokeRect(bb.x * canvas.width, bb.y * canvas.height,
                 bb.w * canvas.width, bb.h * canvas.height);
}
