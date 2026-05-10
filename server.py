import io
import os
from flask import Flask, request, jsonify, send_from_directory, send_file
from PIL import Image, ImageDraw
import numpy as np
import cv2

app = Flask(__name__, static_folder='static', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 30 * 1024 * 1024  # 30MB upload cap

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


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/api/health')
def health():
    return jsonify({'ok': True})


@app.route('/api/detect', methods=['POST'])
def detect():
    f = request.files.get('image')
    if not f:
        return jsonify({'error': 'no image'}), 400
    img = Image.open(f.stream).convert('RGB')
    gray = np.array(img.convert('L'))
    faces = get_face_cascade().detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60)
    )
    if len(faces) == 0:
        return jsonify({'face': False})
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    return jsonify({
        'face': True,
        'score': 1.0,
        'bbox': {
            'x': float(x) / img.width,
            'y': float(y) / img.height,
            'w': float(w) / img.width,
            'h': float(h) / img.height,
        },
        'image_size': {'w': img.width, 'h': img.height},
    })


@app.route('/api/remove-bg', methods=['POST'])
def remove_bg():
    f = request.files.get('image')
    if not f:
        return jsonify({'error': 'no image'}), 400
    from rembg import remove
    out = remove(f.read(), session=get_rembg_session())
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
    return jsonify({'paper': list(PAPER_SIZES_MM.keys()),
                    'photo': list(PHOTO_SIZES_MM.keys())})


@app.route('/api/generate-sheet', methods=['POST'])
def generate_sheet():
    f = request.files.get('image')
    if not f:
        return jsonify({'error': 'no image'}), 400

    paper = request.form.get('paper', 'A4')
    photo_key = request.form.get('photo_size', 'passport_intl_35x45')
    dpi = int(request.form.get('dpi', '300'))
    margin_mm = float(request.form.get('margin', '5'))
    gap_mm = float(request.form.get('gap', '3'))
    cut_lines = request.form.get('cut_lines', '1') == '1'

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

    sheet = Image.new('RGB', (pw, ph), (255, 255, 255))
    photo = Image.open(f.stream).convert('RGB').resize((fw, fh), Image.LANCZOS)

    draw = ImageDraw.Draw(sheet)
    grid_w = cols*fw + (cols-1)*gap
    grid_h = rows*fh + (rows-1)*gap
    x0 = (pw - grid_w) // 2
    y0 = (ph - grid_h) // 2

    for r in range(rows):
        for c in range(cols):
            x = x0 + c*(fw+gap)
            y = y0 + r*(fh+gap)
            sheet.paste(photo, (x, y))
            if cut_lines:
                draw.rectangle([x, y, x+fw-1, y+fh-1],
                               outline=(180, 180, 180), width=1)

    buf = io.BytesIO()
    sheet.save(buf, 'PDF', resolution=dpi)
    buf.seek(0)
    return send_file(buf, mimetype='application/pdf',
                     as_attachment=True,
                     download_name=f'passport_sheet_{paper}_{photo_key}.pdf')


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '5005'))
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
