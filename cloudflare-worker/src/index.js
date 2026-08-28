/**
 * Cloudflare Worker for Hummingbird Camera API
 * Handles image uploads to R2, listing, and FIFO management
 */

export default {
  async fetch(request, env) {
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
      const requiresAuth = request.method === 'POST' || request.method === 'DELETE';
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
        return handleUpload(request, env, corsHeaders);
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
 * Upload image to R2 with metadata
 */
async function handleUpload(request, env, corsHeaders) {
  const formData = await request.formData();
  const file = formData.get('file');
  const metadataStr = formData.get('metadata');
  
  if (!file) {
    return Response.json({ error: 'No file provided' }, { status: 400, headers: corsHeaders });
  }
  
  // Generate unique key with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `${timestamp}_${file.name}`;
  
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
  let detectionType = 'motion';
  if (metadata.has_bird) detectionType = 'bird';
  else if (metadata.has_human) detectionType = 'human';
  else if (metadata.has_animal) detectionType = 'animal';
  
  // OpenAI vision metadata (if available)
  const openai = metadata.openai || {};
  
  const customMetadata = {
    detection_type: detectionType,
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
  };
  
  // Upload to R2
  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type || 'image/jpeg',
    },
    customMetadata: customMetadata,
  });
  
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
  const cursor = url.searchParams.get('cursor');
  
  const options = {
    limit: Math.min(limit, 100),
    prefix: '',
  };
  
  if (cursor) {
    options.cursor = cursor;
  }
  
  const listed = await env.BUCKET.list(options);
  
  // Format objects with metadata
  const objects = listed.objects.map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
    httpMetadata: obj.httpMetadata,
    customMetadata: obj.customMetadata || {},
  }));
  
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
  const key = url.pathname.replace('/image/', '');
  
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
  
  return Response.json({
    success: true,
    timestamp: now,
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
  
  // Calculate uptime: expected ~144 heartbeats/day (every 10 min)
  // Uptime % = (actual / expected) * 100, capped at 100
  const expectedPerDay = 144;
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
    overallUptime: overallUptime,
    dailyUptime: dailyUptime,
    heartbeatCount: results.length,
  }, { headers: corsHeaders });
}
