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
      
      if (path === '/image/' && request.method === 'GET') {
        return handleGetImage(request, env, corsHeaders);
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
