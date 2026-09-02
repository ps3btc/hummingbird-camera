/**
 * Cloudflare Worker for Hummingbird Camera API
 * Handles image uploads to R2, listing, and FIFO management
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    try {
      // Auth check - mutating endpoints require the API_TOKEN secret
      // (set via `wrangler secret put API_TOKEN`). Read endpoints (GET) are
      // public so the Pages gallery can fetch without embedding secrets.
      const requiresAuth = (request.method === 'POST' || request.method === 'DELETE')
        && path !== '/config';
      if (requiresAuth) {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader && authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : null;
        if (!token || !env.API_TOKEN || token !== env.API_TOKEN) {
          return Response.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
        }
      }
      
      // Routes
      if (path === '/upload' && request.method === 'POST') {
        return handleUpload(request, env, ctx, corsHeaders);
      }
      
      if (path === '/list' && request.method === 'GET') {
        return handleList(request, env, corsHeaders);
      }
      
      if (path === '/stats' && request.method === 'GET') {
        return handleStats(env, corsHeaders);
      }
      
      if (path === '/count' && request.method === 'GET') {
        return handleCount(env, corsHeaders);
      }
      
      if (path === '/oldest' && request.method === 'DELETE') {
        return handleDeleteOldest(env, corsHeaders);
      }
      
      if (path.startsWith('/image/') && request.method === 'GET') {
        return handleGetImage(request, env, corsHeaders);
      }
      
      if (path === '/heartbeat' && request.method === 'POST') {
        return handleHeartbeat(request, env, corsHeaders);
      }
      
      if (path === '/status' && request.method === 'GET') {
        return handleStatus(env, corsHeaders);
      }
      
      if (path === '/clear' && request.method === 'DELETE') {
        return handleClearAll(env, corsHeaders);
      }

      if (path === '/config' && request.method === 'GET') {
        return handleGetConfig(env, corsHeaders);
      }

      if (path === '/config' && request.method === 'POST') {
        return handleSetConfig(request, env, corsHeaders);
      }

      if (path === '/cleanup' && request.method === 'GET') {
        return handleGetCleanup(env, corsHeaders);
      }

      if (path === '/cleanup' && request.method === 'POST') {
        ctx.waitUntil(runCleanup(env));
        return Response.json({ success: true, message: 'Cleanup started' }, { headers: corsHeaders });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
      
    } catch (error) {
      return Response.json(
        { error: 'Internal server error', message: error.message },
        { status: 500, headers: corsHeaders }
      );
    }
  }
};

/**
 * Cron trigger: runs every 15 minutes to clean up images where no bird
 * or animal was detected and the image is older than 15 minutes.
 */
export const scheduled = {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  }
};

async function runCleanup(env) {
  const now = new Date();
  const nowISO = now.toISOString();
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  let deleted = 0;
  let scanned = 0;
  let cursor = null;

  do {
    const options = {
      limit: 1000,
      include: ['customMetadata'],
    };
    if (cursor) options.cursor = cursor;

    const listed = await env.BUCKET.list(options);

    for (const obj of listed.objects) {
      scanned++;
      const md = obj.customMetadata || {};

      // Keep images where a bird or animal was detected
      if (md.has_bird === 'true' || md.has_animal === 'true') continue;

      // Only delete if older than 15 minutes
      const uploaded = obj.uploaded;
      if (uploaded && uploaded >= fifteenMinutesAgo) continue;

      await env.BUCKET.delete(obj.key);
      deleted++;
    }

    cursor = listed.cursor;
  } while (cursor);

  // Store cleanup results in D1
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS cleanup_log (id INTEGER PRIMARY KEY, timestamp TEXT, deleted_count INTEGER, scanned_count INTEGER)'
  ).run();
  await env.DB.prepare(
    'INSERT INTO cleanup_log (timestamp, deleted_count, scanned_count) VALUES (?, ?, ?)'
  ).bind(nowISO, deleted, scanned).run();

  // Keep only last 10 cleanup records
  await env.DB.prepare(
    'DELETE FROM cleanup_log WHERE id NOT IN (SELECT id FROM cleanup_log ORDER BY id DESC LIMIT 10)'
  ).run();

  // Check if camera app is offline (no heartbeat in last 15 minutes)
  try {
    const latest = await env.DB.prepare(
      'SELECT timestamp FROM heartbeats ORDER BY id DESC LIMIT 1'
    ).first();

    if (latest) {
      const lastTime = new Date(latest.timestamp).getTime();
      const nowMs = Date.now();
      const minutesAgo = (nowMs - lastTime) / 60000;

      if (minutesAgo > 15) {
        const subject = '⚠️ Hummingbird Camera App Offline';
        const htmlBody = `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #d32f2f;">Camera App Offline</h2>
            <p>The hummingbird camera app has not sent a heartbeat for ${Math.round(minutesAgo)} minutes.</p>
            <div style="background: #ffebee; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #d32f2f;">
              <p style="margin: 5px 0;"><strong>Last Heartbeat:</strong> ${latest.timestamp}</p>
              <p style="margin: 5px 0;"><strong>Time Offline:</strong> ${Math.round(minutesAgo)} minutes</p>
            </div>
            <p>Please check the Raspberry Pi and restart the camera app if needed.</p>
            <p style="margin-top: 20px;">
              <a href="https://hummingbird-gallery.pages.dev" style="display: inline-block; background: #d32f2f; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Dashboard</a>
            </p>
          </div>
        `;
        await sendEmail(env, subject, htmlBody);
      }
    }
  } catch (e) {
    console.error('Failed to check camera status:', e);
  }
}

/**
 * Upload image to R2 with metadata
 */
async function handleUpload(request, env, ctx, corsHeaders) {
  const formData = await request.formData();
  const file = formData.get('file');
  const metadataStr = formData.get('metadata');
  const keyPrefix = (formData.get('key_prefix') || '').toString();

  if (!file) {
    return Response.json({ error: 'No file provided' }, { status: 400, headers: corsHeaders });
  }

  // Generate unique key with timestamp. The optional key_prefix lets callers
  // route uploads to a sub-namespace (e.g. "openai-log/" for the audit log).
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${keyPrefix}${timestamp}_${file.name}`;
  
  // Parse metadata
  let metadata = {};
  if (metadataStr) {
    try {
      metadata = JSON.parse(metadataStr);
    } catch (e) {
      console.error('Failed to parse metadata:', e);
    }
  }
  
  // Normalize detection metadata for gallery filtering and analytics.
  // R2 custom metadata values must be strings.
  const detections = Array.isArray(metadata.detections) ? metadata.detections.slice(0, 10) : [];
  const logKind = metadata.log_kind || 'capture';
  let detectionType = 'motion';
  if (logKind === 'openai') {
    // Audit-log entries: don't piggyback on bird/animal/human detection_type,
    // the "Other" tab filters by log_kind === 'openai' instead.
    detectionType = 'openai-log';
  } else if (metadata.has_bird) detectionType = 'bird';
  else if (metadata.has_human) detectionType = 'human';
  else if (metadata.has_animal) detectionType = 'animal';

  // OpenAI vision metadata (if available)
  const openai = metadata.openai || {};

  // R2 customMetadata is capped at 2KB total per object. Serialize the openai
  // response and truncate so it can't blow the limit alongside the other fields.
  let openaiResponseStr = '';
  if (openai && Object.keys(openai).length > 0) {
    const full = JSON.stringify(openai);
    if (full.length <= 1500) {
      openaiResponseStr = full;
    } else {
      openaiResponseStr = full.slice(0, 1500) + '... (truncated)';
    }
  }

  const customMetadata = {
    detection_type: detectionType,
    log_kind: logKind,
    timestamp: metadata.timestamp || new Date().toISOString(),
    has_bird: metadata.has_bird ? 'true' : 'false',
    has_animal: metadata.has_animal ? 'true' : 'false',
    has_human: metadata.has_human ? 'true' : 'false',
    species: detections.map(d => d.class_name).filter(Boolean).join(',') || '',
    inference_ms: String(metadata.inference_ms ?? ''),
    detections: JSON.stringify(detections),
    // OpenAI vision metadata
    scene_description: openai.scene_description || '',
    interesting: openai.interesting || '',
    ai_model: openai.model || 'local',
    openai_response: openaiResponseStr,
    // Capture mode (motion-only vs local+openai) — top-level `mode` from Pi
    capture_mode: metadata.mode || '',
  };
  
  // Upload to R2
  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type || 'image/jpeg',
    },
    customMetadata: customMetadata,
  });

  // Send email alert if bird or animal detected (not for openai-log entries)
  if (logKind !== 'openai' && (metadata.has_bird || metadata.has_animal)) {
    const imageUrl = `https://hummingbird-gallery.pages.dev/image/${encodeURIComponent(key)}`;
    const species = customMetadata.species || 'Unknown';
    const detectionLabel = metadata.has_bird ? 'Bird' : 'Animal';
    const subject = `🐦 ${detectionLabel} detected at hummingbird camera`;
    const htmlBody = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2e7d32;">${detectionLabel} Detected!</h2>
        <p>A ${detectionLabel.toLowerCase()} was detected by your hummingbird camera.</p>
        <div style="margin: 20px 0;">
          <img src="${imageUrl}" alt="Detection" style="max-width: 100%; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
        </div>
        <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Type:</strong> ${detectionLabel}</p>
          <p style="margin: 5px 0;"><strong>Species:</strong> ${species}</p>
          <p style="margin: 5px 0;"><strong>Time:</strong> ${customMetadata.timestamp}</p>
          ${customMetadata.inference_ms ? `<p style="margin: 5px 0;"><strong>Inference:</strong> ${customMetadata.inference_ms}ms</p>` : ''}
        </div>
        <p style="margin-top: 20px;">
          <a href="https://hummingbird-gallery.pages.dev" style="display: inline-block; background: #2e7d32; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View in Gallery</a>
        </p>
      </div>
    `;
    // Send email asynchronously
    ctx.waitUntil(sendEmail(env, subject, htmlBody));
  }

  return Response.json({
    success: true,
    key: key,
    filename: file.name,
    timestamp: metadata.timestamp || new Date().toISOString(),
  }, { headers: corsHeaders });
}

/**
 * List images with pagination
 */
async function handleList(request, env, corsHeaders) {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const prefix = url.searchParams.get('prefix') || '';

  // When filtering by prefix (e.g., openai-log/), fetch all matching objects,
  // sort by timestamp descending, then return the requested page. This ensures
  // the newest images appear first, even if there are 100+ objects.
  if (prefix) {
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const allObjects = [];
    let cursor = null;

    do {
      const options = {
        limit: 1000,
        prefix: prefix,
        include: ['httpMetadata', 'customMetadata'],
      };
      if (cursor) options.cursor = cursor;

      const listed = await env.BUCKET.list(options);
      allObjects.push(...listed.objects);
      cursor = listed.cursor;
    } while (cursor);

    // Sort by timestamp descending (newest first)
    allObjects.sort((a, b) => {
      const tsA = a.customMetadata?.timestamp || a.uploaded.toISOString();
      const tsB = b.customMetadata?.timestamp || b.uploaded.toISOString();
      return new Date(tsB) - new Date(tsA);
    });

    // Paginate
    const page = allObjects.slice(offset, offset + limit);
    const objects = page.map(obj => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata || {},
    }));

    return Response.json({
      objects: objects,
      truncated: offset + limit < allObjects.length,
      nextOffset: offset + limit < allObjects.length ? offset + limit : null,
    }, { headers: corsHeaders });
  }

  // No prefix: use cursor-based pagination (for the main gallery)
  const cursor = url.searchParams.get('cursor');
  const options = {
    limit: Math.min(limit, 100),
    prefix: prefix,
    include: ['httpMetadata', 'customMetadata'],
  };

  if (cursor) {
    options.cursor = cursor;
  }

  const listed = await env.BUCKET.list(options);

  // Format objects with metadata, then reverse to show most recent first
  const objects = listed.objects.map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata || {},
  })).reverse();

  return Response.json({
    objects: objects,
    truncated: listed.truncated,
    cursor: listed.cursor,
  }, { headers: corsHeaders });
}

/**
 * Aggregated analytics: totals by type, monthly and hourly visit counts.
 * Scans the whole bucket server-side so the frontend needs one request.
 */
async function handleStats(env, corsHeaders) {
  const monthly = {};
  const hourly = Array(24).fill(0);
  const byType = { bird: 0, animal: 0, human: 0, motion: 0 };
  let total = 0;
  let cursor = null;
  
  do {
    const options = { limit: 1000 };
    if (cursor) options.cursor = cursor;
    
    const listed = await env.BUCKET.list(options);
    
    for (const obj of listed.objects) {
      total++;
      const md = obj.customMetadata || {};
      const type = md.detection_type || 'motion';
      byType[type] = (byType[type] || 0) + 1;
      
      const ts = md.timestamp || obj.uploaded.toISOString();
      const d = new Date(ts);
      if (!isNaN(d.getTime())) {
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthly[monthKey] = (monthly[monthKey] || 0) + 1;
        hourly[d.getHours()]++;
      }
    }
    
    cursor = listed.cursor;
  } while (cursor && total < 20000);
  
  return Response.json({ total, byType, monthly, hourly }, { headers: corsHeaders });
}

/**
 * Get current file count
 */
async function handleCount(env, corsHeaders) {
  // R2 doesn't have a direct count API, so we list with limit 1000
  let count = 0;
  let cursor = null;
  
  do {
    const options = { limit: 1000 };
    if (cursor) options.cursor = cursor;
    
    const listed = await env.BUCKET.list(options);
    count += listed.objects.length;
    cursor = listed.cursor;
    
    // Safety: don't count beyond what we need to know
    if (count > env.MAX_FILES) break;
    
  } while (cursor);
  
  return Response.json({
    count: count,
    limit: env.MAX_FILES,
    percentage: ((count / env.MAX_FILES) * 100).toFixed(2),
  }, { headers: corsHeaders });
}

/**
 * Delete oldest file (FIFO)
 */
async function handleDeleteOldest(env, corsHeaders) {
  // List oldest first
  const listed = await env.BUCKET.list({
    limit: 1,
  });
  
  if (listed.objects.length === 0) {
    return Response.json({ error: 'No files to delete' }, { status: 404, headers: corsHeaders });
  }
  
  const oldest = listed.objects[0];
  await env.BUCKET.delete(oldest.key);
  
  return Response.json({
    success: true,
    key: oldest.key,
    deleted: new Date().toISOString(),
  }, { headers: corsHeaders });
}

/**
 * Get image by key
 */
async function handleGetImage(request, env, corsHeaders) {
  const url = new URL(request.url);
  // Browser encodes the '/' in prefixed keys (e.g. "openai-log/foo.jpg") as %2F,
  // so decode before using the value as the R2 key. Falling back to the raw
  // pathname keeps the legacy non-prefixed path working.
  let key;
  try {
    key = decodeURIComponent(url.pathname.replace('/image/', ''));
  } catch (e) {
    key = url.pathname.replace('/image/', '');
  }
  
  if (!key) {
    return Response.json({ error: 'No key provided' }, { status: 400, headers: corsHeaders });
  }
  
  const object = await env.BUCKET.get(key);
  
  if (!object) {
    return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
  }
  
  return new Response(object.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000',
    },
  });
}

/**
 * Receive heartbeat from Raspberry Pi
 */
async function handleHeartbeat(request, env, corsHeaders) {
  let details = {};
  try {
    details = await request.json();
  } catch (e) {
    // ignore parse errors, use defaults
  }
  
  const now = new Date().toISOString();
  const status = details.status || 'alive';
  const detailsStr = JSON.stringify(details);
  
  await env.DB.prepare(
    'INSERT INTO heartbeats (timestamp, status, details) VALUES (?, ?, ?)'
  ).bind(now, status, detailsStr).run();
  
  // Clean up old records (keep 3 weeks)
  const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'DELETE FROM heartbeats WHERE timestamp < ?'
  ).bind(threeWeeksAgo).run();

  const openaiEnabled = await getSetting(env, 'openai_enabled', 'true');

  return Response.json({
    success: true,
    timestamp: now,
    openai_enabled: openaiEnabled === 'true',
  }, { headers: corsHeaders });
}

/**
 * Get Pi status and uptime data for last 3 weeks
 */
async function handleStatus(env, corsHeaders) {
  // Get latest heartbeat to determine current status
  const latest = await env.DB.prepare(
    'SELECT timestamp, status, details FROM heartbeats ORDER BY id DESC LIMIT 1'
  ).first();
  
  // Determine if app is running (heartbeat within last 15 minutes)
  let appStatus = 'offline';
  let lastSeen = null;
  let appUptimeSeconds = 0;
  let systemUptimeSeconds = 0;
  let motionOnly = false;
  
  if (latest) {
    lastSeen = latest.timestamp;
    const lastTime = new Date(latest.timestamp).getTime();
    const now = Date.now();
    
    // Parse details to get uptime info
    let details = {};
    try {
      details = JSON.parse(latest.details || '{}');
    } catch (e) { /* ignore */ }
    
    appUptimeSeconds = details.app_uptime_seconds || 0;
    systemUptimeSeconds = details.system_uptime_seconds || 0;
    motionOnly = details.motion_only === true;
    
    if (now - lastTime < 15 * 60 * 1000) {
      appStatus = 'online';
    }
  }
  
  // Get all heartbeats from last 3 weeks for uptime chart
  const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const { results } = await env.DB.prepare(
    'SELECT timestamp, status, details FROM heartbeats WHERE timestamp >= ? ORDER BY timestamp ASC'
  ).bind(threeWeeksAgo).all();
  
  // Calculate daily uptime percentages
  const dailyUptime = {};
  const heartbeatsByDay = {};
  
  for (const row of results) {
    const day = row.timestamp.slice(0, 10); // YYYY-MM-DD
    if (!heartbeatsByDay[day]) heartbeatsByDay[day] = 0;
    heartbeatsByDay[day]++;
  }
  
  // Calculate uptime: expected ~1440 heartbeats/day (every 1 min)
  // Uptime % = (actual / expected) * 100, capped at 100
  const expectedPerDay = 1440;
  for (const [day, count] of Object.entries(heartbeatsByDay)) {
    dailyUptime[day] = Math.min(100, Math.round((count / expectedPerDay) * 100));
  }
  
  // Calculate overall uptime for last 3 weeks
  const totalDays = Object.keys(heartbeatsByDay).length || 1;
  const totalExpected = totalDays * expectedPerDay;
  const totalActual = results.length;
  const overallUptime = Math.min(100, Math.round((totalActual / totalExpected) * 100));
  
  return Response.json({
    status: appStatus,
    lastSeen: lastSeen,
    appUptimeSeconds: appUptimeSeconds,
    systemUptimeSeconds: systemUptimeSeconds,
    motionOnly: motionOnly,
    overallUptime: overallUptime,
    dailyUptime: dailyUptime,
    heartbeatCount: results.length,
  }, { headers: corsHeaders });
}

/**
 * Delete all objects from R2 bucket
 */
async function handleClearAll(env, corsHeaders) {
  try {
    let deleted = 0;
    const batchSize = 50;
    
    // List and delete in batches
    while (true) {
      const listed = await env.BUCKET.list({ limit: batchSize });
      
      if (!listed.objects || listed.objects.length === 0) {
        break;
      }
      
      // Delete this batch sequentially
      for (const obj of listed.objects) {
        await env.BUCKET.delete(obj.key);
        deleted++;
      }
    }
    
    return Response.json({ 
      success: true, 
      deleted: deleted,
      message: `Deleted ${deleted} objects from R2`
    }, { headers: corsHeaders });
  } catch (error) {
    return Response.json({ 
      error: 'Clear failed', 
      message: error.message 
    }, { status: 500, headers: corsHeaders });
  }
}

async function ensureSettingsTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)'
  ).run();
}

async function getSetting(env, key, defaultValue) {
  await ensureSettingsTable(env);
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : defaultValue;
}

async function setSetting(env, key, value) {
  await ensureSettingsTable(env);
  await env.DB.prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
  ).bind(key, value).run();
}

async function handleGetConfig(env, corsHeaders) {
  const openaiEnabled = await getSetting(env, 'openai_enabled', 'true');
  return Response.json({
    openai_enabled: openaiEnabled === 'true',
  }, { headers: corsHeaders });
}

async function handleSetConfig(request, env, corsHeaders) {
  const body = await request.json();
  if (typeof body.openai_enabled !== 'boolean') {
    return Response.json({ error: 'openai_enabled must be a boolean' }, { status: 400, headers: corsHeaders });
  }
  await setSetting(env, 'openai_enabled', body.openai_enabled ? 'true' : 'false');
  return Response.json({
    success: true,
    openai_enabled: body.openai_enabled,
  }, { headers: corsHeaders });
}

async function handleGetCleanup(env, corsHeaders) {
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS cleanup_log (id INTEGER PRIMARY KEY, timestamp TEXT, deleted_count INTEGER, scanned_count INTEGER)'
    ).run();
    const row = await env.DB.prepare(
      'SELECT timestamp, deleted_count, scanned_count FROM cleanup_log ORDER BY id DESC LIMIT 1'
    ).first();

    if (!row) {
      return Response.json({ last_run: null, deleted: 0, scanned: 0 }, { headers: corsHeaders });
    }

    return Response.json({
      last_run: row.timestamp,
      deleted: row.deleted_count,
      scanned: row.scanned_count,
    }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ last_run: null, deleted: 0, scanned: 0 }, { headers: corsHeaders });
  }
}

/**
 * Send email via Mailjet API
 */
async function sendEmail(env, subject, htmlBody) {
  if (!env.MAILJET_API_KEY || !env.MAILJET_SECRET_KEY) {
    console.warn('Mailjet credentials not configured, skipping email');
    return;
  }

  try {
    const auth = btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`);
    const response = await fetch('https://api.mailjet.com/v3.1/send', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Messages: [{
          From: {
            Email: 'alerts@loglinearexplorations.online',
            Name: 'Hummingbird Camera',
          },
          To: [{
            Email: 'hareesh.nagarajan@gmail.com',
            Name: 'Hareesh',
          }],
          Subject: subject,
          HTMLPart: htmlBody,
        }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Mailjet API error:', error);
    }
  } catch (e) {
    console.error('Failed to send email:', e);
  }
}
