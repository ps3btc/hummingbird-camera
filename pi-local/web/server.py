"""Lightweight Flask web dashboard for local monitoring."""
import json
import logging
from datetime import datetime
from pathlib import Path
from flask import Flask, render_template, jsonify, send_from_directory, Response
from app.config import Config

logger = logging.getLogger(__name__)

app = Flask(__name__,
            template_folder=str(Path(__file__).parent / 'templates'),
            static_folder=str(Path(__file__).parent / 'static'))

# Path to status file written by main camera service
STATUS_FILE = Config.BASE_DIR / 'status.json'

# Shared state (updated by main system)
system_state = {
    'running': False,
    'start_time': None,
    'stats': {
        'captures': 0,
        'uploads': 0,
        'alerts': 0,
        'detections': 0,
    },
    'last_detection': None,
    'last_capture': None,
    'model_type': 'unknown',
    'inference_ms': 0.0,
    'r2_file_count': -1,
    'logs': [],
}


def update_state(key, value):
    """Update system state from main thread."""
    system_state[key] = value


def add_log(level, message):
    """Add a log entry to the shared state."""
    entry = {
        'time': datetime.now().strftime('%H:%M:%S'),
        'level': level,
        'message': message
    }
    system_state['logs'].append(entry)
    # Keep only last 100 log entries
    if len(system_state['logs']) > 100:
        system_state['logs'] = system_state['logs'][-100:]


@app.route('/')
def index():
    """Serve the dashboard."""
    return render_template('index.html')


@app.route('/api/status')
def api_status():
    """Return current system status from main camera service."""
    # Read status from file written by main.py
    status_data = {
        'running': False,
        'uptime': '',
        'stats': {'captures': 0, 'uploads': 0, 'alerts': 0, 'detections': 0},
        'last_detection': None,
        'last_capture': None,
        'model_type': 'unknown',
        'inference_ms': 0.0,
        'r2_file_count': -1,
    }
    
    try:
        if STATUS_FILE.exists():
            with open(STATUS_FILE, 'r') as f:
                file_status = json.load(f)
                status_data.update(file_status)
    except Exception as e:
        logger.error(f"Error reading status file: {e}")
    
    return jsonify(status_data)


@app.route('/api/logs')
def api_logs():
    """Return recent log entries."""
    return jsonify(system_state['logs'][-50:])


@app.route('/api/captures')
def api_captures():
    """Return list of local captures."""
    captures = []
    captures_dir = Config.CAPTURES_DIR

    if captures_dir.exists():
        files = sorted(captures_dir.glob('*.jpg'), key=lambda f: f.stat().st_mtime, reverse=True)
        for f in files[:50]:
            captures.append({
                'filename': f.name,
                'size': f.stat().st_size,
                'modified': datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            })

    return jsonify(captures)


@app.route('/captures/<path:filename>')
def serve_capture(filename):
    """Serve a local capture image."""
    return send_from_directory(str(Config.CAPTURES_DIR), filename)


@app.route('/api/logs/stream')
def api_log_stream():
    """SSE endpoint for real-time log streaming."""
    def stream():
        import time
        last_idx = 0
        while True:
            logs = system_state['logs']
            if len(logs) > last_idx:
                for entry in logs[last_idx:]:
                    yield f"data: {json.dumps(entry)}\n\n"
                last_idx = len(logs)
            time.sleep(1)

    return Response(stream(), mimetype='text/event-stream')
