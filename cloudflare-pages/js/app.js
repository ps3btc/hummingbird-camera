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
let images = [];          // all fetched objects (normalized) — gallery view
let cursor = null;
let truncated = false;
let loading = false;

// OpenAI audit log (Other tab) — separate list fetched with ?prefix=openai-log/
let currentView = 'gallery';  // 'gallery' | 'openai-log'
let openaiLogImages = [];
let openaiLogCursor = null;
let openaiLogTruncated = false;
let openaiLogLoading = false;

let lightboxIndex = -1;
let slideshowTimer = null;
let slideshowSpeed = 0.25;  // 250ms = 4 fps, like a video
let homeSlideshowTimer = null;
let homeSlideshowIndex = 0;
let homeSlideshowPaused = false;

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
const homePlayBtn = document.getElementById('homePlayBtn');
const homeSlideshow = document.getElementById('homeSlideshow');
const homeSlideshowImg = document.getElementById('homeSlideshowImg');
const homeSlideshowClose = document.getElementById('homeSlideshowClose');
const homeSlideshowPause = document.getElementById('homeSlideshowPause');
const homeSlideshowInfo = document.getElementById('homeSlideshowInfo');
const dashboardPanel = document.getElementById('dashboardPanel');
const homePlayBtnContainer = homePlayBtn && homePlayBtn.parentElement;

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setupFilterButtons();
    setupLightbox();
    setupHomeSlideshow();
    setupRefresh();
    loadImages();
    loadStorageCount();
    loadStats();
    loadStatus();
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

// ── OpenAI audit log (Other tab) ────────────────────────────

async function loadOpenAILog(append = false) {
    if (openaiLogLoading) return;
    openaiLogLoading = true;

    if (!append) {
        openaiLogImages = [];
        openaiLogCursor = null;
        gallery.innerHTML = '';
        loadingEl.style.display = 'block';
        gallery.appendChild(loadingEl);
        emptyState.style.display = 'none';
        loadMoreEl.style.display = 'none';
    }

    try {
        const params = new URLSearchParams({
            prefix: 'openai-log/',
            limit: String(ITEMS_PER_PAGE),
        });
        if (append && openaiLogCursor) params.set('cursor', openaiLogCursor);

        const res = await fetch(`${WORKER_URL}/list?${params}`);
        if (!res.ok) throw new Error(`Worker returned ${res.status}`);
        const data = await res.json();

        loadingEl.style.display = 'none';
        openaiLogCursor = data.cursor || null;
        openaiLogTruncated = !!data.truncated;

        const normalized = (data.objects || []).map(normalizeOpenAILogObject);
        openaiLogImages = openaiLogImages.concat(normalized);

        normalized.forEach((img, i) => {
            gallery.appendChild(buildOpenAILogCard(img, openaiLogImages.length - normalized.length + i));
        });
        loadMoreEl.style.display = openaiLogTruncated ? 'block' : 'none';
        applyVisibility();
    } catch (err) {
        console.error('Failed to load OpenAI log:', err);
        loadingEl.innerHTML = `<p>⚠️ Could not reach the Worker API for the OpenAI log.<br>
            <small>Set WORKER_URL in js/app.js to your deployed Worker URL.</small></p>`;
    } finally {
        openaiLogLoading = false;
    }
}

function normalizeOpenAILogObject(obj) {
    const md = obj.customMetadata || {};
    let openai = {};
    let truncated = false;
    try {
        let raw = md.openai_response || '';
        if (raw.endsWith('... (truncated)')) {
            raw = raw.slice(0, -'... (truncated)'.length);
            truncated = true;
        }
        openai = raw ? JSON.parse(raw) : {};
        if (truncated) openai._truncated = true;
    } catch (e) { /* ignore */ }

    let localDetections = [];
    try {
        localDetections = openai.local_detections
            ? (Array.isArray(openai.local_detections) ? openai.local_detections : [openai.local_detections])
            : [];
    } catch (e) { /* ignore */ }

    return {
        key: obj.key,
        url: `${WORKER_URL}/image/${encodeURIComponent(obj.key)}`,
        openai,
        sceneDescription: openai.scene_description || md.scene_description || '',
        interesting: openai.interesting || md.interesting || '',
        hasBird: !!(openai.has_bird ?? (md.has_bird === 'true')),
        hasAnimal: !!(openai.has_animal ?? (md.has_animal === 'true')),
        hasHuman: !!(openai.has_human ?? (md.has_human === 'true')),
        mode: md.capture_mode || 'unknown',
        callNumber: openai.call_number || null,
        timestamp: md.timestamp || obj.uploaded,
        uploaded: obj.uploaded,
        localDetections,
    };
}

function buildOpenAILogCard(img, index) {
    const card = document.createElement('div');
    card.className = 'card card-openai-log';
    card.dataset.index = index;
    card.dataset.view = 'openai-log';

    const matched = img.hasBird || img.hasAnimal || img.hasHuman;
    const verdictBadge = matched
        ? `<span class="verdict-badge match">✅ MATCH</span>`
        : `<span class="verdict-badge clear">❌ CLEAR</span>`;

    const categoryBadges = [
        img.hasBird   && `<span class="verdict-badge bird">🐦 bird</span>`,
        img.hasAnimal && `<span class="verdict-badge animal">🦊 animal</span>`,
        img.hasHuman  && `<span class="verdict-badge human">👤 human</span>`,
    ].filter(Boolean).join('');

    const callNumber = img.callNumber != null ? ` · call #${img.callNumber}` : '';
    const modeLine = `<div class="card-mode-line">${escapeHtml(img.mode)}${escapeHtml(callNumber)}</div>`;
    const sceneBlock = img.sceneDescription
        ? `<div class="card-scene-full">${escapeHtml(img.sceneDescription)}</div>` : '';
    const interestingBlock = img.interesting
        ? `<div class="card-interesting">✨ ${escapeHtml(img.interesting)}</div>` : '';
    const localDetBlock = img.localDetections && img.localDetections.length
        ? `<div class="card-mode-line">local: ${escapeHtml(img.localDetections.join(', '))}</div>` : '';

    card.innerHTML = `
        <div class="card-media">
            <img loading="lazy" src="${img.url}" alt="OpenAI log capture">
            <span class="type-badge openai-log">🔍 OpenAI</span>
        </div>
        <div class="card-info">
            <div class="card-label">OpenAI audit log</div>
            <div class="card-time">${formatTimestamp(img.timestamp)}</div>
            <div class="card-verdict-row">${verdictBadge}${categoryBadges}</div>
            ${sceneBlock}
            ${interestingBlock}
            ${modeLine}
            ${localDetBlock}
        </div>`;

    card.addEventListener('click', () => openOpenAILogLightbox(index));
    return card;
}

function openOpenAILogLightbox(index) {
    const img = openaiLogImages[index];
    if (!img) return;
    lightboxIndex = index;
    lightboxImage.src = img.url;
    lightboxBoxes.innerHTML = '';
    lightboxTimestamp.textContent = formatTimestamp(img.timestamp, true);

    const matched = img.hasBird || img.hasAnimal || img.hasHuman;
    const verdictChips = [
        matched
            ? `<span class="verdict-badge match">✅ MATCH</span>`
            : `<span class="verdict-badge clear">❌ CLEAR</span>`,
        img.hasBird   && `<span class="verdict-badge bird">🐦 bird</span>`,
        img.hasAnimal && `<span class="verdict-badge animal">🦊 animal</span>`,
        img.hasHuman  && `<span class="verdict-badge human">👤 human</span>`,
    ].filter(Boolean).join(' ');

    const sceneBlock = img.sceneDescription
        ? `<div class="lightbox-scene">${escapeHtml(img.sceneDescription)}</div>` : '';
    const interestingBlock = img.interesting
        ? `<div class="lightbox-interesting">✨ ${escapeHtml(img.interesting)}</div>` : '';
    const modelLine = img.openai && img.openai.model
        ? `<div class="lightbox-ai">Verified by ${escapeHtml(img.openai.model)}</div>` : '';

    const callNumber = img.callNumber != null ? ` · call #${img.callNumber}` : '';
    const modeLine = `<div class="card-mode-line" style="margin-top:6px;">${escapeHtml(img.mode)}${escapeHtml(callNumber)}</div>`;
    const localDetLine = img.localDetections && img.localDetections.length
        ? `<div class="card-mode-line">local model: ${escapeHtml(img.localDetections.join(', '))}</div>` : '';

    const responseJson = `<details style="margin-top:10px;">
        <summary style="cursor:pointer;font-size:12px;color:var(--text-dim);">OpenAI raw response</summary>
        ${img.openai && img.openai._truncated
            ? '<div style="margin-top:4px;font-size:11px;color:var(--text-faint);font-style:italic;">(response was truncated to fit R2 metadata limits)</div>'
            : ''}
        <pre style="margin-top:6px;padding:8px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--text);">${escapeHtml(JSON.stringify(img.openai, null, 2))}</pre>
    </details>`;

    lightboxDetections.innerHTML = `<div class="card-verdict-row" style="margin-bottom:8px;">${verdictChips}</div>${sceneBlock}${interestingBlock}${modelLine}${modeLine}${localDetLine}${responseJson}`;

    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
    // No slideshow for the audit log — the user is here to read responses.
    stopSlideshow();
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

        analyticsNote.textContent = `${data.total} captures analyzed`;

        // Only draw charts when the dashboard is visible — otherwise the
        // canvas dimensions are 0x0 (parent display:none) and the chart
        // either renders nothing or Chart.js throws "Canvas is already in use".
        if (dashboardPanel && dashboardPanel.style.display !== 'none') {
            drawMonthlyChart(data.monthly || {});
            drawHourlyChart(data.hourly || []);
        }
    } catch (err) {
        console.error('Failed to load stats:', err);
        analyticsNote.textContent = 'analytics unavailable';
    }
}

async function loadStatus() {
    const piStatusDot = document.getElementById('piStatusDotTop');
    const piStatusText = document.getElementById('piStatusTextTop');
    const piStatusCard = document.getElementById('piStatusTopCard');
    const appStatusDot = document.getElementById('appStatusDotTop');
    const appStatusText = document.getElementById('appStatusTextTop');
    const appStatusCard = document.getElementById('appStatusTopCard');
    const lastSeen = document.getElementById('lastSeen');
    const piUptime = document.getElementById('piUptime');
    const appUptime = document.getElementById('appUptime');
    const overallUptime = document.getElementById('overallUptime');

    // Null checks to prevent errors if elements don't exist
    if (!piStatusDot || !appStatusDot) {
        console.warn('Status elements not found');
        return;
    }

    function setPi(state, label) {
        piStatusDot.classList.toggle('online', state === 'online');
        piStatusDot.classList.toggle('offline', state === 'offline');
        if (piStatusCard) {
            piStatusCard.classList.toggle('online', state === 'online');
            piStatusCard.classList.toggle('offline', state === 'offline');
        }
        if (piStatusText) piStatusText.textContent = label;
    }

    function setApp(state, label) {
        appStatusDot.classList.toggle('online', state === 'online');
        appStatusDot.classList.toggle('offline', state === 'offline');
        if (appStatusCard) {
            appStatusCard.classList.toggle('online', state === 'online');
            appStatusCard.classList.toggle('offline', state === 'offline');
        }
        if (appStatusText) appStatusText.textContent = label;
    }

    try {
        const res = await fetch(`${WORKER_URL}/status?_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        console.log('Status response:', data);

        // App status: based on heartbeat (app sends heartbeats)
        if (data.status === 'online') {
            setApp('online', 'Running');
        } else {
            setApp('offline', 'Stopped');
        }

        // Pi status: if we have system uptime, Pi is online
        // (even if app stopped, Pi hardware is still up)
        if (data.systemUptimeSeconds > 0) {
            setPi('online', 'Online');
        } else if (data.status === 'online') {
            // App is sending heartbeats, so Pi must be online
            setPi('online', 'Online');
        } else {
            // No heartbeats, no system uptime info - Pi might be offline
            setPi('offline', 'Offline');
        }

        // Update details
        if (data.lastSeen && lastSeen) {
            lastSeen.textContent = formatTimestamp(data.lastSeen, true);
        }

        // Format uptimes
        if (data.systemUptimeSeconds > 0 && piUptime) {
            piUptime.textContent = formatUptime(data.systemUptimeSeconds);
        }
        if (data.appUptimeSeconds > 0 && appUptime) {
            appUptime.textContent = formatUptime(data.appUptimeSeconds);
        }

        if (overallUptime) overallUptime.textContent = `${data.overallUptime}%`;

        // Update detection mode
        const detectionMode = document.getElementById('detectionMode');
        if (detectionMode) {
            if (data.motionOnly) {
                detectionMode.textContent = 'Motion-only (no local AI)';
                detectionMode.style.color = '#fbbf24'; // yellow warning
            } else {
                detectionMode.textContent = 'Local AI + OpenAI';
                detectionMode.style.color = '#34d399'; // green
            }
        }

        // Draw uptime chart (only when dashboard visible — canvas must be laid out)
        if (dashboardPanel && dashboardPanel.style.display !== 'none') {
            drawUptimeChart(data.dailyUptime || {});
        }
    } catch (err) {
        console.error('Failed to load status:', err);
        setPi('offline', 'Unknown');
        setApp('offline', 'Unknown');
    }
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
        return `${days}d ${hours}h ${mins}m`;
    } else if (hours > 0) {
        return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
}

let uptimeChartInstance = null;

function drawUptimeChart(dailyUptime) {
    const ctx = document.getElementById('uptimeChart');
    if (!ctx) return;

    // Sort dates and get last 21 days
    const dates = Object.keys(dailyUptime).sort();
    const labels = dates.map(d => {
        const dt = new Date(d);
        return `${dt.getMonth() + 1}/${dt.getDate()}`;
    });
    const values = dates.map(d => dailyUptime[d]);

    // Color bars by uptime percentage
    const colors = values.map(v => {
        if (v >= 95) return '#34d399'; // green
        if (v >= 80) return '#fbbf24'; // yellow
        return '#f87171'; // red
    });

    if (uptimeChartInstance) {
        uptimeChartInstance.destroy();
        uptimeChartInstance = null;
    }

    uptimeChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Uptime %',
                data: values,
                backgroundColor: colors,
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y}% uptime`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: { callback: v => v + '%', color: '#8b94a7' },
                    grid: { color: '#232a3a' },
                },
                x: {
                    ticks: { color: '#8b94a7', maxRotation: 45 },
                    grid: { display: false },
                }
            }
        }
    });
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
    if (currentView === 'openai-log') {
        let shown = 0;
        gallery.querySelectorAll('.card').forEach(card => {
            const isOpenAILog = card.classList.contains('card-openai-log');
            card.style.display = isOpenAILog ? '' : 'none';
            if (isOpenAILog) shown++;
        });
        if (openaiLogImages.length > 0 && shown === 0) {
            emptyState.style.display = 'block';
            emptyState.querySelector('h2').textContent = 'No OpenAI calls yet';
            emptyState.querySelector('p').textContent =
                "The camera hasn't sent any captures to OpenAI yet (motion or detection events).";
        } else if (openaiLogImages.length === 0) {
            emptyState.style.display = 'none';
        } else {
            emptyState.style.display = 'none';
        }
        return;
    }

    let shown = 0;
    gallery.querySelectorAll('.card').forEach(card => {
        // Hide any openai-log cards in the gallery view (shouldn't be there,
        // but be defensive if the user switched views mid-fetch).
        if (card.classList.contains('card-openai-log')) {
            card.style.display = 'none';
            return;
        }
        const cats = card.dataset.categories.split(',');
        const isVisible = cats.some(c => visible[c]);
        card.style.display = isVisible ? '' : 'none';
        if (isVisible) shown++;
    });
    emptyState.style.display = (images.length > 0 && shown === 0) ? 'block' : 'none';
}

// ── Controls ────────────────────────────────────────────────

function setupFilterButtons() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const filter = btn.dataset.filter;
            if (filter === 'other') {
                showView('openai-log');
                if (currentView === 'openai-log' && openaiLogImages.length === 0) {
                    loadOpenAILog();
                }
            } else if (filter === 'dashboard') {
                showView('dashboard');
                requestAnimationFrame(() => {
                    loadStats();
                    loadStatus();
                });
            } else {
                showView('gallery');
                if (filter === 'all') {
                    visible.bird = true;
                    visible.animal = true;
                    visible.human = false;
                } else {
                    visible.bird = filter === 'bird';
                    visible.animal = filter === 'animal';
                    visible.human = filter === 'human';
                }
                if (images.length === 0) {
                    loadImages();
                } else {
                    applyVisibility();
                }
            }
            syncFilterButtons();
        });
    });
}

function showView(view) {
    currentView = view;
    if (dashboardPanel) {
        dashboardPanel.style.display = view === 'dashboard' ? '' : 'none';
    }
    const showGallery = view === 'gallery' || view === 'openai-log';
    if (gallery) gallery.style.display = showGallery ? '' : 'none';
    if (loadMoreEl) loadMoreEl.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    if (homePlayBtn) homePlayBtn.style.display = view === 'gallery' ? '' : 'none';
}

function syncFilterButtons() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        const f = btn.dataset.filter;
        let active = false;
        if (f === 'dashboard') {
            active = currentView === 'dashboard';
        } else if (f === 'other') {
            active = currentView === 'openai-log';
        } else if (currentView === 'gallery') {
            if (f === 'all') active = visible.bird && visible.animal && !visible.human;
            else if (f === 'bird') active = visible.bird && !visible.animal && !visible.human;
            else if (f === 'animal') active = visible.animal && !visible.bird && !visible.human;
            else if (f === 'human') active = visible.human && !visible.bird && !visible.animal;
        }
        btn.classList.toggle('active', active);
    });
}

function setupRefresh() {
    refreshBtn.addEventListener('click', () => {
        refreshBtn.classList.add('spinning');
        const promises = [loadStorageCount(), loadStats(), loadStatus()];
        if (currentView === 'openai-log') {
            promises.push(loadOpenAILog());
        } else if (currentView === 'gallery') {
            promises.push(loadImages());
        }
        Promise.all(promises).finally(() => {
            setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
        });
    });
    loadMoreBtn.addEventListener('click', () => {
        if (currentView === 'openai-log') {
            loadOpenAILog(true);
        } else {
            loadImages(true);
        }
    });
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
}

function setupHomeSlideshow() {
    homePlayBtn.addEventListener('click', openHomeSlideshow);
    homeSlideshowClose.addEventListener('click', closeHomeSlideshow);
    homeSlideshowPause.addEventListener('click', toggleHomeSlideshow);
    
    // Keyboard controls for home slideshow
    document.addEventListener('keydown', (e) => {
        if (!homeSlideshow.classList.contains('open')) return;
        if (e.key === 'Escape') closeHomeSlideshow();
        if (e.key === ' ') { e.preventDefault(); toggleHomeSlideshow(); }
    });
}

function openHomeSlideshow() {
    const idxs = visibleIndexes();
    if (idxs.length === 0) return;
    homeSlideshowIndex = 0;
    homeSlideshowPaused = false;
    homeSlideshow.classList.add('open');
    document.body.style.overflow = 'hidden';
    renderHomeSlideshowFrame();
    startHomeSlideshow();
}

function renderHomeSlideshowFrame() {
    const idxs = visibleIndexes();
    if (idxs.length === 0) return;
    const img = currentView === 'openai-log'
        ? openaiLogImages[idxs[homeSlideshowIndex % idxs.length]]
        : images[idxs[homeSlideshowIndex % idxs.length]];
    if (!img) return;
    homeSlideshowImg.src = img.url;
    const ts = formatTimestamp(img.timestamp, true);
    if (currentView === 'openai-log') {
        const matched = img.hasBird || img.hasAnimal || img.hasHuman;
        const verdict = matched ? 'MATCH' : 'CLEAR';
        const det = img.sceneDescription
            ? img.sceneDescription.substring(0, 60)
            : 'no scene description';
        homeSlideshowInfo.textContent = `${ts} · ${verdict} · ${det}`;
    } else {
        const det = img.detections.map(d => d.class_name).join(', ') || 'motion';
        homeSlideshowInfo.textContent = `${ts} · ${det}`;
    }
}

function startHomeSlideshow() {
    if (homeSlideshowTimer) clearInterval(homeSlideshowTimer);
    homeSlideshowTimer = setInterval(() => {
        if (!homeSlideshowPaused) {
            homeSlideshowIndex++;
            renderHomeSlideshowFrame();
        }
    }, slideshowSpeed * 1000);
}

function toggleHomeSlideshow() {
    homeSlideshowPaused = !homeSlideshowPaused;
    homeSlideshowPause.textContent = homeSlideshowPaused ? '▶' : '⏸';
}

function closeHomeSlideshow() {
    if (homeSlideshowTimer) clearInterval(homeSlideshowTimer);
    homeSlideshowTimer = null;
    homeSlideshow.classList.remove('open');
    document.body.style.overflow = '';
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
    if (currentView === 'openai-log') {
        const idxs = visibleIndexes();
        if (idxs.length === 0) return;
        const pos = idxs.indexOf(lightboxIndex);
        const next = pos === -1 ? 0 : (pos + delta + idxs.length) % idxs.length;
        lightboxIndex = idxs[next];
        openOpenAILogLightbox(lightboxIndex);
        return;
    }
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
    slideshowTimer = setInterval(() => stepLightbox(1), slideshowSpeed * 1000);
}

function stopSlideshow() {
    if (slideshowTimer) clearInterval(slideshowTimer);
    slideshowTimer = null;
    slideshowPlay.textContent = '▶';
    slideshowPlay.classList.remove('playing');
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
