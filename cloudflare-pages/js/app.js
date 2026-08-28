/**
 * Hummingbird Camera — Detection Gallery
 * Fetches detections from the Cloudflare Worker API (/list, /stats, /image/:key)
 * and renders a filterable gallery with analytics charts.
 */

// ── Configuration ───────────────────────────────────────────
// Update this URL after deploying the worker (output of `wrangler deploy`)
const WORKER_URL = 'https://hummingbird-camera.flyingokapi.workers.dev';

const ITEMS_PER_PAGE = 30;
const FRAME_WIDTH = 640;   // Pi camera resolution (bbox coordinate space)
const FRAME_HEIGHT = 480;

const TYPE_META = {
    bird:   { label: 'Bird',   emoji: '🐦', cls: 'bird' },
    animal: { label: 'Animal', emoji: '🦊', cls: 'animal' },
    human:  { label: 'Human',  emoji: '👤', cls: 'human' },
    motion: { label: 'Motion', emoji: '📷', cls: 'motion' },
};

// ── State ───────────────────────────────────────────────────
let images = [];          // all fetched objects (normalized)
let cursor = null;
let truncated = false;
let loading = false;
let lightboxIndex = -1;
let slideshowTimer = null;
let slideshowSpeed = 3;  // seconds between frames

// Category visibility toggles (default: birds + animals on, humans hidden, motion shown)
const visible = { bird: true, animal: true, human: false, motion: true };

// ── DOM ─────────────────────────────────────────────────────
const gallery = document.getElementById('gallery');
const loadingEl = document.getElementById('loading');
const loadMoreEl = document.getElementById('loadMore');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const emptyState = document.getElementById('emptyState');
const refreshBtn = document.getElementById('refreshBtn');
const storageCount = document.getElementById('storageCount');
const analyticsNote = document.getElementById('analyticsNote');
const lightbox = document.getElementById('lightbox');
const lightboxImage = document.getElementById('lightboxImage');
const lightboxBoxes = document.getElementById('lightboxBoxes');
const lightboxTimestamp = document.getElementById('lightboxTimestamp');
const lightboxDetections = document.getElementById('lightboxDetections');
const slideshowPlay = document.getElementById('slideshowPlay');
const slideshowSpeedEl = document.getElementById('slideshowSpeed');
const toggles = {
    bird: document.getElementById('toggleBird'),
    animal: document.getElementById('toggleAnimal'),
    human: document.getElementById('toggleHuman'),
};

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setupToggles();
    setupFilterButtons();
    setupLightbox();
    setupRefresh();
    loadImages();
    loadStorageCount();
    loadStats();
});

// ── Data loading ────────────────────────────────────────────

async function loadImages(append = false) {
    if (loading) return;
    loading = true;

    if (!append) {
        images = [];
        cursor = null;
        gallery.innerHTML = '';
        loadingEl.style.display = 'block';
        gallery.appendChild(loadingEl);
        emptyState.style.display = 'none';
        loadMoreEl.style.display = 'none';
    }

    try {
        const params = new URLSearchParams({ limit: String(ITEMS_PER_PAGE) });
        if (append && cursor) params.set('cursor', cursor);

        const res = await fetch(`${WORKER_URL}/list?${params}`);
        if (!res.ok) throw new Error(`Worker returned ${res.status}`);
        const data = await res.json();

        loadingEl.style.display = 'none';
        cursor = data.cursor || null;
        truncated = !!data.truncated;

        const normalized = (data.objects || []).map(normalizeObject);
        images = images.concat(normalized);

        normalized.forEach((img, i) => gallery.appendChild(buildCard(img, images.length - normalized.length + i)));
        loadMoreEl.style.display = truncated ? 'block' : 'none';
        applyVisibility();
    } catch (err) {
        console.error('Failed to load images:', err);
        loadingEl.innerHTML = `<p>⚠️ Could not reach the Worker API.<br>
            <small>Set WORKER_URL in js/app.js to your deployed Worker URL.</small></p>`;
    } finally {
        loading = false;
    }
}

function normalizeObject(obj) {
    const md = obj.customMetadata || {};
    let detections = [];
    try {
        detections = md.detections ? JSON.parse(md.detections) : [];
    } catch (e) { /* ignore malformed metadata */ }

    // Which categories does this image belong to?
    const categories = new Set();
    if (md.has_bird === 'true' || md.detection_type === 'bird') categories.add('bird');
    if (md.has_animal === 'true' || md.detection_type === 'animal') categories.add('animal');
    if (md.has_human === 'true' || md.detection_type === 'human') categories.add('human');
    if (categories.size === 0) categories.add('motion');

    const primary = md.detection_type || 'motion';
    const maxConf = detections.reduce((m, d) => Math.max(m, d.confidence || 0), 0);

    return {
        key: obj.key,
        url: `${WORKER_URL}/image/${encodeURIComponent(obj.key)}`,
        categories,
        primary,
        detections,
        maxConf,
        species: md.species || '',
        timestamp: md.timestamp || obj.uploaded,
        uploaded: obj.uploaded,
        // OpenAI metadata
        sceneDescription: md.scene_description || '',
        interesting: md.interesting || '',
        aiModel: md.ai_model || 'local',
    };
}

async function loadStorageCount() {
    try {
        const res = await fetch(`${WORKER_URL}/count`);
        if (!res.ok) return;
        const data = await res.json();
        storageCount.textContent = `${data.count} / ${(data.limit / 1000).toFixed(0)}k`;
        storageCount.title = `${data.percentage}% of R2 file limit`;
    } catch (e) { /* non-fatal */ }
}

async function loadStats() {
    try {
        const res = await fetch(`${WORKER_URL}/stats`);
        if (!res.ok) throw new Error(`stats ${res.status}`);
        const data = await res.json();

        document.getElementById('totalVisits').textContent = data.total;
        document.getElementById('birdVisits').textContent = data.byType.bird || 0;
        document.getElementById('animalVisits').textContent = data.byType.animal || 0;
        document.getElementById('humanVisits').textContent = data.byType.human || 0;
        analyticsNote.textContent = `${data.total} captures analyzed`;

        drawMonthlyChart(data.monthly || {});
        drawHourlyChart(data.hourly || []);
    } catch (err) {
        console.error('Failed to load stats:', err);
        analyticsNote.textContent = 'analytics unavailable';
    }
}

// ── Cards & visibility ──────────────────────────────────────

function buildCard(img, index) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.index = index;
    card.dataset.categories = [...img.categories].join(',');

    const meta = TYPE_META[img.primary] || TYPE_META.motion;
    const conf = img.maxConf > 0 ? `<span class="confidence">${Math.round(img.maxConf * 100)}%</span>` : '';
    const species = img.species
        ? `<div class="card-species">${escapeHtml(img.species)}</div>` : '';
    const scene = img.sceneDescription
        ? `<div class="card-scene" title="${escapeHtml(img.sceneDescription)}">${escapeHtml(img.sceneDescription.substring(0, 60))}${img.sceneDescription.length > 60 ? '...' : ''}</div>` : '';
    const aiBadge = img.aiModel !== 'local'
        ? `<span class="ai-badge" title="Verified by ${escapeHtml(img.aiModel)}">AI</span>` : '';

    card.innerHTML = `
        <div class="card-media">
            <img loading="lazy" src="${img.url}" alt="${meta.label} capture">
            <div class="bbox-layer">${renderBoxes(img.detections)}</div>
            <span class="type-badge ${meta.cls}">${meta.emoji} ${meta.label}</span>
            ${aiBadge}
        </div>
        <div class="card-info">
            <div class="card-label">${meta.label} ${conf}</div>
            <div class="card-time">${formatTimestamp(img.timestamp)}</div>
            ${species}
            ${scene}
        </div>`;

    card.addEventListener('click', () => openLightbox(index));
    return card;
}

function renderBoxes(detections) {
    return detections.map(d => {
        if (!Array.isArray(d.bbox) || d.bbox.length !== 4) return '';
        const [x1, y1, x2, y2] = d.bbox;
        const left = (x1 / FRAME_WIDTH) * 100;
        const top = (y1 / FRAME_HEIGHT) * 100;
        const width = ((x2 - x1) / FRAME_WIDTH) * 100;
        const height = ((y2 - y1) / FRAME_HEIGHT) * 100;

        let cls = '';
        const name = (d.class_name || '').toLowerCase();
        if (name === 'person') cls = 'b-human';
        else if (name !== 'bird') cls = 'b-animal';

        return `<div class="bbox ${cls}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%">
            <span class="bbox-label">${escapeHtml(d.class_name || 'object')} ${Math.round((d.confidence || 0) * 100)}%</span>
        </div>`;
    }).join('');
}

function applyVisibility() {
    let shown = 0;
    gallery.querySelectorAll('.card').forEach(card => {
        const cats = card.dataset.categories.split(',');
        const isVisible = cats.some(c => visible[c]);
        card.style.display = isVisible ? '' : 'none';
        if (isVisible) shown++;
    });
    emptyState.style.display = (images.length > 0 && shown === 0) ? 'block' : 'none';
}

// ── Controls ────────────────────────────────────────────────

function setupToggles() {
    Object.entries(toggles).forEach(([category, input]) => {
        input.addEventListener('change', () => {
            visible[category] = input.checked;
            applyVisibility();
            syncFilterButtons();
        });
    });
}

function setupFilterButtons() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const filter = btn.dataset.filter;
            if (filter === 'all') {
                // All = birds + animals by default; humans only if already toggled on
                visible.bird = true;
                visible.animal = true;
            } else {
                visible.bird = filter === 'bird';
                visible.animal = filter === 'animal';
                visible.human = filter === 'human';
            }
            Object.entries(toggles).forEach(([cat, input]) => { input.checked = visible[cat]; });
            applyVisibility();
            syncFilterButtons();
        });
    });
}

function syncFilterButtons() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        const f = btn.dataset.filter;
        let active = false;
        if (f === 'all') active = visible.bird && visible.animal && visible.human;
        else if (f === 'bird') active = visible.bird && !visible.animal && !visible.human;
        else if (f === 'animal') active = visible.animal && !visible.bird && !visible.human;
        else if (f === 'human') active = visible.human && !visible.bird && !visible.animal;
        btn.classList.toggle('active', active);
    });
}

function setupRefresh() {
    refreshBtn.addEventListener('click', () => {
        refreshBtn.classList.add('spinning');
        Promise.all([loadImages(), loadStorageCount(), loadStats()]).finally(() => {
            setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
        });
    });
    loadMoreBtn.addEventListener('click', () => loadImages(true));
}

// ── Charts (pure canvas, no libraries) ──────────────────────

function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w: rect.width, h: rect.height };
}

function drawBarChart(canvas, labels, values, color) {
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    const padL = 8, padR = 8, padT = 14, padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const max = Math.max(1, ...values);
    const n = values.length;
    const slot = plotW / n;
    const barW = Math.max(3, slot * 0.62);

    // Baseline
    ctx.strokeStyle = 'rgba(139, 148, 167, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH + 0.5);
    ctx.lineTo(padL + plotW, padT + plotH + 0.5);
    ctx.stroke();

    values.forEach((v, i) => {
        const barH = (v / max) * plotH;
        const x = padL + i * slot + (slot - barW) / 2;
        const y = padT + plotH - barH;

        const grad = ctx.createLinearGradient(0, y, 0, padT + plotH);
        grad.addColorStop(0, color);
        grad.addColorStop(1, color + '33');
        ctx.fillStyle = v > 0 ? grad : 'rgba(139,148,167,0.12)';

        roundedRect(ctx, x, v > 0 ? y : padT + plotH - 2, barW, v > 0 ? barH : 2, 3);
        ctx.fill();

        // Value label above bar
        if (v > 0) {
            ctx.fillStyle = 'rgba(232, 236, 244, 0.85)';
            ctx.font = '600 10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(String(v), x + barW / 2, y - 4);
        }

        // X-axis label (thin out when crowded)
        if (labels[i] && (n <= 14 || i % 2 === 0)) {
            ctx.fillStyle = 'rgba(139, 148, 167, 0.8)';
            ctx.font = '500 9px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(labels[i], x + barW / 2, h - 6);
        }
    });
}

function roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, 0);
    ctx.arcTo(x, y + h, x, y, 0);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawMonthlyChart(monthly) {
    // Last 12 months, oldest → newest
    const labels = [];
    const values = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        labels.push(d.toLocaleString('en-US', { month: 'short' }));
        values.push(monthly[key] || 0);
    }
    drawBarChart(document.getElementById('monthlyChart'), labels, values, '#34d399');
}

function drawHourlyChart(hourly) {
    const labels = Array.from({ length: 24 }, (_, i) =>
        i % 3 === 0 ? `${i}h` : '');
    drawBarChart(document.getElementById('hourlyChart'), labels, hourly, '#38bdf8');
}

let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(loadStats, 300);
});

// ── Lightbox ────────────────────────────────────────────────

function setupLightbox() {
    document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
    document.getElementById('lightboxOverlay').addEventListener('click', closeLightbox);
    document.getElementById('lightboxPrev').addEventListener('click', () => stepLightbox(-1));
    document.getElementById('lightboxNext').addEventListener('click', () => stepLightbox(1));

    document.addEventListener('keydown', (e) => {
        if (!lightbox.classList.contains('open')) return;
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') stepLightbox(-1);
        if (e.key === 'ArrowRight') stepLightbox(1);
        if (e.key === ' ') { e.preventDefault(); toggleSlideshow(); }
    });
    
    // Slideshow controls
    slideshowPlay.addEventListener('click', toggleSlideshow);
    slideshowSpeedEl.querySelectorAll('.speed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            slideshowSpeed = parseInt(btn.dataset.speed, 10);
            slideshowSpeedEl.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Restart timer with new speed if playing
            if (slideshowTimer) { stopSlideshow(); startSlideshow(); }
        });
    });
}

function visibleIndexes() {
    return [...gallery.querySelectorAll('.card')]
        .filter(c => c.style.display !== 'none')
        .map(c => parseInt(c.dataset.index, 10));
}

function openLightbox(index) {
    lightboxIndex = index;
    renderLightbox();
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
    // Auto-start slideshow if there are multiple images
    const idxs = visibleIndexes();
    if (idxs.length > 2) startSlideshow();
}

function renderLightbox() {
    const img = images[lightboxIndex];
    if (!img) return;

    lightboxImage.src = img.url;
    lightboxBoxes.innerHTML = renderBoxes(img.detections);
    lightboxTimestamp.textContent = formatTimestamp(img.timestamp, true);

    const chips = img.detections.map(d => {
        const name = (d.class_name || 'object').toLowerCase();
        const cls = name === 'person' ? 'human' : (name === 'bird' ? 'bird' : 'animal');
        const notes = d.notes ? ` · ${escapeHtml(d.notes)}` : '';
        return `<span class="det-chip ${cls}">${escapeHtml(d.class_name)} · ${Math.round((d.confidence || 0) * 100)}%${notes}</span>`;
    }).join('');
    lightboxDetections.innerHTML = chips ||
        `<span class="det-chip motion">motion only</span>`;

    // Show OpenAI metadata if available
    let openaiHtml = '';
    if (img.sceneDescription) {
        openaiHtml += `<div class="lightbox-scene">${escapeHtml(img.sceneDescription)}</div>`;
    }
    if (img.interesting) {
        openaiHtml += `<div class="lightbox-interesting">✨ ${escapeHtml(img.interesting)}</div>`;
    }
    if (img.aiModel !== 'local') {
        openaiHtml += `<div class="lightbox-ai">Verified by ${escapeHtml(img.aiModel)}</div>`;
    }
    
    // Insert OpenAI metadata after detections
    const existingContent = lightboxDetections.innerHTML;
    if (openaiHtml) {
        lightboxDetections.innerHTML = existingContent + openaiHtml;
    }
}

function stepLightbox(delta) {
    const idxs = visibleIndexes();
    if (idxs.length === 0) return;
    const pos = idxs.indexOf(lightboxIndex);
    const next = pos === -1 ? 0 : (pos + delta + idxs.length) % idxs.length;
    lightboxIndex = idxs[next];
    renderLightbox();
}

function closeLightbox() {
    stopSlideshow();
    lightbox.classList.remove('open');
    document.body.style.overflow = '';
}

function toggleSlideshow() {
    if (slideshowTimer) {
        stopSlideshow();
    } else {
        startSlideshow();
    }
}

function startSlideshow() {
    stopSlideshow();
    slideshowPlay.textContent = '⏸';
    slideshowPlay.classList.add('playing');
    slideshowSpeedEl.style.display = 'flex';
    slideshowTimer = setInterval(() => stepLightbox(1), slideshowSpeed * 1000);
}

function stopSlideshow() {
    if (slideshowTimer) clearInterval(slideshowTimer);
    slideshowTimer = null;
    slideshowPlay.textContent = '▶';
    slideshowPlay.classList.remove('playing');
    slideshowSpeedEl.style.display = 'none';
}

// ── Helpers ─────────────────────────────────────────────────

function formatTimestamp(ts, long = false) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    if (long) {
        return d.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        });
    }
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) {
        return 'Today, ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
        d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
