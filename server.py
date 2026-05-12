import io
import json
import math
import os
import zipfile
from flask import Flask, request, jsonify, send_from_directory, send_file
from PIL import Image, ImageDraw, ImageOps
import numpy as np
import cv2

# HEIC / HEIF support (iPhone photos)
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF_OK = True
except Exception:
    HEIF_OK = False

app = Flask(__name__, static_folder='static', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB upload cap

_rembg_session = None
_face_cascade = None


def get_rembg_session():
    global _rembg_session
    if _rembg_session is None:
        from rembg import new_session
        _rembg_session = new_session('u2net')
    return _rembg_session


def get_face_cascade():
    global _face_cascade
    if _face_cascade is None:
        path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        _face_cascade = cv2.CascadeClassifier(path)
    return _face_cascade


def open_normalized(stream_or_path):
    """Open image, apply EXIF rotation, return RGB Pillow image. Handles HEIC."""
    img = Image.open(stream_or_path)
    img = ImageOps.exif_transpose(img)
    return img.convert('RGB')


def detect_face_bbox(img):
    """Return (x, y, w, h) of largest face or None."""
    gray = np.array(img.convert('L'))
    faces = get_face_cascade().detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60)
    )
    if len(faces) == 0:
        return None
    return tuple(int(v) for v in max(faces, key=lambda f: f[2] * f[3]))


def smart_crop(img, target_w, target_h, face_ratio=0.55):
    """Crop+resize so the detected face is anchored at passport-spec position.
    face fills ~face_ratio of output height; small upward bias for forehead room.
    Falls back to centered aspect-preserving crop if no face."""
    src_w, src_h = img.size
    target_aspect = target_w / target_h
    bbox = detect_face_bbox(img)

    if bbox is not None:
        fx, fy, fw_face, fh_face = bbox
        crop_h = fh_face / face_ratio
        crop_w = crop_h * target_aspect
        cx = fx + fw_face / 2
        cy = fy + fh_face / 2 - crop_h * 0.05  # tiny upward bias

        # if requested crop bigger than source, scale to fit
        if crop_w > src_w or crop_h > src_h:
            scale = min(src_w / crop_w, src_h / crop_h)
            crop_w *= scale
            crop_h *= scale

        x1 = max(0, min(src_w - crop_w, cx - crop_w / 2))
        y1 = max(0, min(src_h - crop_h, cy - crop_h / 2))
        cropped = img.crop((int(x1), int(y1),
                            int(x1 + crop_w), int(y1 + crop_h)))
    else:
        # no face: center crop preserving target aspect
        src_aspect = src_w / src_h
        if src_aspect > target_aspect:
            new_w = src_h * target_aspect
            x1 = (src_w - new_w) / 2
            cropped = img.crop((int(x1), 0, int(x1 + new_w), src_h))
        else:
            new_h = src_w / target_aspect
            y1 = (src_h - new_h) / 2
            cropped = img.crop((0, int(y1), src_w, int(y1 + new_h)))

    return cropped.resize((target_w, target_h), Image.LANCZOS)


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/api/health')
def health():
    return jsonify({'ok': True, 'heic': HEIF_OK})


@app.route('/api/preview', methods=['POST'])
def preview():
    """Normalize an upload (HEIC -> JPEG, EXIF-rotate). Frontend uses the
    returned blob for display and sends it back for downstream processing."""
    f = request.files.get('image')
    if not f:
        return jsonify({'error': 'no image'}), 400
    img = open_normalized(f.stream)
    # downscale very large originals so the browser canvas is happy and
    # round-trips are faster (keeps full-res for sheet generation? NO — we
    # treat the normalized blob as canonical. So keep good quality.)
    max_dim = 2400
    if max(img.size) > max_dim:
        img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=92)
    buf.seek(0)
    return send_file(buf, mimetype='image/jpeg')


@app.route('/api/detect', methods=['POST'])
def detect():
    f = request.files.get('image')
    if not f:
        return jsonify({'error': 'no image'}), 400
    img = open_normalized(f.stream)
    bbox = detect_face_bbox(img)
    if bbox is None:
        return jsonify({'face': False})
    x, y, w, h = bbox
    return jsonify({
        'face': True,
        'score': 1.0,
        'bbox': {
            'x': x / img.width, 'y': y / img.height,
            'w': w / img.width, 'h': h / img.height,
        },
        'image_size': {'w': img.width, 'h': img.height},
    })


@app.route('/api/remove-bg', methods=['POST'])
def remove_bg():
    f = request.files.get('image')
    if not f:
        return jsonify({'error': 'no image'}), 400
    from rembg import remove
    img = open_normalized(f.stream)
    buf_in = io.BytesIO()
    img.save(buf_in, 'PNG')
    buf_in.seek(0)
    out = remove(buf_in.read(), session=get_rembg_session())
    return send_file(io.BytesIO(out), mimetype='image/png')


@app.route('/api/apply-bg', methods=['POST'])
def apply_bg():
    f = request.files.get('image')
    if not f:
        return jsonify({'error': 'no image'}), 400
    color = request.form.get('color', '#ffffff').lstrip('#')
    if len(color) != 6:
        return jsonify({'error': 'bad color'}), 400
    rgb = tuple(int(color[i:i+2], 16) for i in (0, 2, 4))
    fg = Image.open(f.stream).convert('RGBA')
    bg = Image.new('RGBA', fg.size, rgb + (255,))
    out = Image.alpha_composite(bg, fg).convert('RGB')
    buf = io.BytesIO()
    out.save(buf, 'PNG')
    buf.seek(0)
    return send_file(buf, mimetype='image/png')


PAPER_SIZES_MM = {
    'A4': (210.0, 297.0),
    'A3': (297.0, 420.0),
    'Letter': (215.9, 279.4),
    '4x6': (101.6, 152.4),
    '5x7': (127.0, 177.8),
    '4x5': (101.6, 127.0),
}

PHOTO_SIZES_MM = {
    'passport_us_2x2': (51.0, 51.0),
    'passport_intl_35x45': (35.0, 45.0),
    'visa_uk_35x45': (35.0, 45.0),
    'visa_schengen_35x45': (35.0, 45.0),
    'india_35x35': (35.0, 35.0),
    'china_33x48': (33.0, 48.0),
}


@app.route('/api/paper-options')
def paper_options():
    return jsonify({
        'paper': {k: {'w': v[0], 'h': v[1]} for k, v in PAPER_SIZES_MM.items()},
        'photo': {k: {'w': v[0], 'h': v[1]} for k, v in PHOTO_SIZES_MM.items()},
    })


@app.route('/api/generate-sheet', methods=['POST'])
def generate_sheet():
    files = request.files.getlist('images')
    if not files:
        return jsonify({'error': 'no images'}), 400

    counts_raw = request.form.get('counts', '')
    try:
        counts = json.loads(counts_raw) if counts_raw else [1] * len(files)
    except Exception:
        counts = [1] * len(files)
    counts = [max(0, int(c)) for c in counts]
    if len(counts) < len(files):
        counts += [1] * (len(files) - len(counts))

    # Optional per-photo manual crop rect, normalized to source (0..1).
    # Shape: [{"x":..,"y":..,"w":..,"h":..} | null, ...] parallel to images.
    crops_raw = request.form.get('crops', '')
    try:
        crops = json.loads(crops_raw) if crops_raw else [None] * len(files)
    except Exception:
        crops = [None] * len(files)
    if len(crops) < len(files):
        crops += [None] * (len(files) - len(crops))

    paper = request.form.get('paper', 'A4')
    photo_key = request.form.get('photo_size', 'passport_intl_35x45')
    dpi = int(request.form.get('dpi', '300'))
    margin_mm = float(request.form.get('margin', '5'))
    gap_mm = float(request.form.get('gap', '3'))
    cut_lines = request.form.get('cut_lines', '1') == '1'
    smart = request.form.get('smart_crop', '1') == '1'

    if paper not in PAPER_SIZES_MM or photo_key not in PHOTO_SIZES_MM:
        return jsonify({'error': 'bad size key'}), 400

    pw_mm, ph_mm = PAPER_SIZES_MM[paper]
    fw_mm, fh_mm = PHOTO_SIZES_MM[photo_key]

    def mm_px(mm):
        return int(round(mm * dpi / 25.4))

    pw, ph = mm_px(pw_mm), mm_px(ph_mm)
    fw, fh = mm_px(fw_mm), mm_px(fh_mm)
    margin = mm_px(margin_mm)
    gap = mm_px(gap_mm)

    cols = max(1, (pw - 2*margin + gap) // (fw + gap))
    rows = max(1, (ph - 2*margin + gap) // (fh + gap))
    capacity = cols * rows

    # process each unique upload once: manual crop → smart crop → naive resize
    queue = []
    for f, n, crop_spec in zip(files, counts, crops):
        if n <= 0:
            continue
        src = open_normalized(f.stream)
        sw, sh = src.size
        if crop_spec and all(k in crop_spec for k in ('x', 'y', 'w', 'h')):
            cx = max(0.0, min(1.0, float(crop_spec['x'])))
            cy = max(0.0, min(1.0, float(crop_spec['y'])))
            cw = max(0.001, min(1.0 - cx, float(crop_spec['w'])))
            ch = max(0.001, min(1.0 - cy, float(crop_spec['h'])))
            x1 = int(cx * sw)
            y1 = int(cy * sh)
            x2 = int((cx + cw) * sw)
            y2 = int((cy + ch) * sh)
            photo = src.crop((x1, y1, x2, y2)).resize((fw, fh), Image.LANCZOS)
        elif smart:
            photo = smart_crop(src, fw, fh)
        else:
            photo = src.resize((fw, fh), Image.LANCZOS)
        queue.extend([photo] * n)

    if not queue:
        return jsonify({'error': 'nothing to print (counts all 0)'}), 400

    # split queue across pages
    grid_w = cols*fw + (cols-1)*gap
    grid_h = rows*fh + (rows-1)*gap
    x0 = (pw - grid_w) // 2
    y0 = (ph - grid_h) // 2

    pages = []
    n_pages = math.ceil(len(queue) / capacity)
    for p in range(n_pages):
        page_imgs = queue[p*capacity : (p+1)*capacity]
        sheet = Image.new('RGB', (pw, ph), (255, 255, 255))
        draw = ImageDraw.Draw(sheet)
        i = 0
        for r in range(rows):
            for c in range(cols):
                if i >= len(page_imgs):
                    break
                x = x0 + c*(fw+gap)
                y = y0 + r*(fh+gap)
                sheet.paste(page_imgs[i], (x, y))
                if cut_lines:
                    draw.rectangle([x, y, x+fw-1, y+fh-1],
                                   outline=(180, 180, 180), width=1)
                i += 1
            if i >= len(page_imgs):
                break
        pages.append(sheet)

    fmt = request.form.get('format', 'pdf').lower()
    base = f'passport_sheet_{paper}_{photo_key}'

    if fmt in ('png', 'image', 'jpg', 'jpeg'):
        is_jpg = fmt in ('jpg', 'jpeg')
        ext = 'jpg' if is_jpg else 'png'
        save_kwargs = (dict(format='JPEG', quality=92)
                       if is_jpg else dict(format='PNG', optimize=True))

        def render(img):
            b = io.BytesIO()
            img_to_save = img.convert('RGB') if is_jpg else img
            img_to_save.save(b, **save_kwargs)
            return b.getvalue()

        if len(pages) == 1:
            buf = io.BytesIO(render(pages[0]))
            return send_file(buf, mimetype=f'image/{"jpeg" if is_jpg else "png"}',
                             as_attachment=True,
                             download_name=f'{base}.{ext}')

        # multi-page → ZIP
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for i, page in enumerate(pages, 1):
                zf.writestr(f'{base}_page{i}.{ext}', render(page))
        buf.seek(0)
        return send_file(buf, mimetype='application/zip',
                         as_attachment=True,
                         download_name=f'{base}.zip')

    # default: PDF
    buf = io.BytesIO()
    pages[0].save(buf, 'PDF', resolution=dpi,
                  save_all=True, append_images=pages[1:])
    buf.seek(0)
    return send_file(buf, mimetype='application/pdf',
                     as_attachment=True,
                     download_name=f'{base}.pdf')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '5005'))
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
