import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import axios from 'axios';

// Store recent requests in memory for quick access
const recentRequests = {
  // Structure: { [requestId]: requestData }
  byId: new Map(),
  // Structure: { [ip]: [requestIds] }
  byIp: new Map(),
  // Maximum number of requests to keep in memory per IP
  maxPerIp: 100,
  // Maximum total entries in the byId map
  maxTotal: 10000,
  // Time-to-live for cached entries (1 hour)
  ttl: 60 * 60 * 1000,
};

// Function to periodically clean up old entries
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  let count = 0;
  
  // Clean up old entries
  for (const [requestId, data] of recentRequests.byId.entries()) {
    if (now - data.timestamp > recentRequests.ttl) {
      recentRequests.byId.delete(requestId);
      count++;
    }
  }
  
  // Clean up IP references to non-existent requests
  for (const [ip, requestIds] of recentRequests.byIp.entries()) {
    recentRequests.byIp.set(ip, requestIds.filter(id => recentRequests.byId.has(id)));
    if (recentRequests.byIp.get(ip).length === 0) {
      recentRequests.byIp.delete(ip);
    }
  }
  
  if (count > 0) {
    console.log(`Cleaned up ${count} expired request entries from memory cache`);
  }
}, 15 * 60 * 1000); // Run every 15 minutes

// Ensure cleanup on process exit
process.on('exit', () => {
  clearInterval(cleanupInterval);
});

// Get geo information for an IP address
async function getGeoInfo(ip) {
  try {
    // Skip for localhost and private IPs
    if (ip === '127.0.0.1' || ip === 'localhost' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return { country: 'Local', city: 'Development', region: 'Internal' };
    }
    
    const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`, {
      timeout: 3000 // 3 second timeout
    });
    
    if (response.data && response.data.status === 'success') {
      return {
        country: response.data.country || '',
        city: response.data.city || '',
        region: response.data.regionName || ''
      };
    }
    
    return { country: '', city: '', region: '' };
  } catch (error) {
    console.error('Error fetching geo info:', error.message);
    return { country: '', city: '', region: '' };
  }
}

// Detect if request is from a bot
function detectBot(userAgent = '') {
  if (!userAgent) return false;
  
  const userAgentLower = userAgent.toLowerCase();
  const botPatterns = [
    'bot', 'spider', 'crawler', 'googlebot', 'bingbot', 'yandex', 'baidu', 
    'semrush', 'ahrefs', 'screaming frog', 'httrack', 'wget', 'curl', 'puppeteer',
    'headless', 'scraper', 'lighthouse', 'pagespeed', 'google-structured-data'
  ];
  
  return botPatterns.some(pattern => userAgentLower.includes(pattern));
}

// Request tracking middleware
export async function requestTrackerMiddleware(req, res, next) {
  // Start timer for response time
  const start = Date.now();
  
  // Generate unique request ID if not already present
  const requestId = req.headers['x-request-id'] || uuidv4();
  req.requestId = requestId;
  
  // Set request ID header for response
  res.setHeader('X-Request-ID', requestId);
  
  // Get client IP
  const clientIp = 
    req.headers['x-forwarded-for']?.split(',')[0].trim() || 
    req.headers['x-real-ip'] || 
    req.connection.remoteAddress || 
    req.socket.remoteAddress || 
    'unknown';
  
  // Extract user ID if authenticated
  const userId = req.user?.id || null;

  // Store basic request data for immediate access
  const requestData = {
    requestId,
    clientIp,
    userId,
    requestPath: req.originalUrl || req.url,
    requestMethod: req.method,
    userAgent: req.headers['user-agent'] || '',
    referer: req.headers['referer'] || '',
    timestamp: Date.now(),
    isBot: detectBot(req.headers['user-agent'])
  };
  
  // Cache request data in memory
  recentRequests.byId.set(requestId, requestData);
  
  // Add to IP-indexed map
  if (!recentRequests.byIp.has(clientIp)) {
    recentRequests.byIp.set(clientIp, []);
  }
  const ipRequests = recentRequests.byIp.get(clientIp);
  ipRequests.push(requestId);
  
  // Limit requests stored per IP
  if (ipRequests.length > recentRequests.maxPerIp) {
    const removed = ipRequests.shift();
    recentRequests.byId.delete(removed);
  }
  
  // Limit total cached requests
  if (recentRequests.byId.size > recentRequests.maxTotal) {
    // Remove oldest entries
    const entries = Array.from(recentRequests.byId.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    
    const toRemove = entries.slice(0, Math.floor(recentRequests.maxTotal * 0.2)); // Remove oldest 20%
    for (const [id, _] of toRemove) {
      recentRequests.byId.delete(id);
    }
  }

  // Add suspicious behavior checking
  const checkSuspiciousBehavior = async (req, clientIp) => {
    try {
      // Check for rapid requests
      const [recentRequests] = await pool.query(
        `SELECT COUNT(*) as count 
         FROM request_logs 
         WHERE client_ip = ? 
         AND created_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)`,
        [clientIp]
      );

      if (recentRequests[0].count > 100) {
        await pool.query(
          `INSERT INTO ip_behaviors (ip_address, behavior_type, severity, details) 
           VALUES (?, 'rate_limit_exceeded', 2, ?)`,
          [clientIp, JSON.stringify({ requests_per_minute: recentRequests[0].count })]
        );
      }

      // Check for suspicious patterns
      const [suspiciousPatterns] = await pool.query(
        `SELECT 
           COUNT(DISTINCT request_path) as unique_paths,
           COUNT(DISTINCT user_id) as unique_users,
           AVG(response_time) as avg_response_time
         FROM request_logs 
         WHERE client_ip = ? 
         AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
        [clientIp]
      );

      // Log suspicious behavior if detected
      if (suspiciousPatterns[0].unique_paths > 50 || 
          suspiciousPatterns[0].unique_users > 10) {
        await pool.query(
          `INSERT INTO ip_behaviors (ip_address, behavior_type, severity, details) 
           VALUES (?, 'suspicious_activity', 3, ?)`,
          [clientIp, JSON.stringify(suspiciousPatterns[0])]
        );
      }
    } catch (error) {
      console.error('Error checking suspicious behavior:', error);
    }
  };

  // Call suspicious behavior check (runs async, doesn't block)
  checkSuspiciousBehavior(req, clientIp);

  // Capture response data on finish
  res.on('finish', async () => {
    try {
      const responseTime = Date.now() - start;
      const statusCode = res.statusCode;
      
      // Update cached data with response info
      if (recentRequests.byId.has(requestId)) {
        const data = recentRequests.byId.get(requestId);
        data.statusCode = statusCode;
        data.responseTime = responseTime;
      }
      
      // Get geo information (async, don't block response)
      getGeoInfo(clientIp).then(async (geoInfo) => {
        // Store in database
        const id = uuidv4();
        await pool.query(
          `INSERT INTO request_logs 
           (id, request_id, client_ip, user_id, user_agent, request_path, request_method, 
            status_code, response_time, geo_country, geo_city, geo_region, referer, is_bot) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, requestId, clientIp, userId, req.headers['user-agent'] || '', 
            req.originalUrl || req.url, req.method, statusCode, responseTime,
            geoInfo.country, geoInfo.city, geoInfo.region, 
            req.headers['referer'] || '', detectBot(req.headers['user-agent'])
          ]
        );
        
        // Update cached data with geo info
        if (recentRequests.byId.has(requestId)) {
          const data = recentRequests.byId.get(requestId);
          data.geoCountry = geoInfo.country;
          data.geoCity = geoInfo.city;
          data.geoRegion = geoInfo.region;
        }
      }).catch(err => {
        console.error('Error logging request:', err);
      });
    } catch (error) {
      console.error('Error in request tracking:', error);
    }
  });
  
  next();
}

// Function to lookup requests by ID
export async function lookupRequestById(requestId) {
  // Check in-memory cache first
  if (recentRequests.byId.has(requestId)) {
    return recentRequests.byId.get(requestId);
  }
  
  // If not in cache, look up in database
  try {
    const [rows] = await pool.query(
      `SELECT * FROM request_logs WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`,
      [requestId]
    );
    
    if (rows.length > 0) {
      return rows[0];
    }
    
    return null;
  } catch (error) {
    console.error('Error looking up request by ID:', error);
    throw error;
  }
}

// Function to lookup requests by IP
export async function lookupRequestsByIp(ip, limit = 50) {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM request_logs WHERE client_ip = ? ORDER BY created_at DESC LIMIT ?`,
      [ip, limit]
    );
    
    return rows;
  } catch (error) {
    console.error('Error looking up requests by IP:', error);
    throw error;
  }
}

// Get stats for an IP
export async function getIpStats(ip) {
  try {
    // Get request count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM request_logs WHERE client_ip = ?`,
      [ip]
    );
    
    // Get unique paths
    const [pathsResult] = await pool.query(
      `SELECT request_path, COUNT(*) as count FROM request_logs 
       WHERE client_ip = ? GROUP BY request_path 
       ORDER BY count DESC LIMIT 10`,
      [ip]
    );
    
    // Get first seen date
    const [firstSeenResult] = await pool.query(
      `SELECT MIN(created_at) as first_seen FROM request_logs WHERE client_ip = ?`,
      [ip]
    );
    
    // Get last seen date
    const [lastSeenResult] = await pool.query(
      `SELECT MAX(created_at) as last_seen FROM request_logs WHERE client_ip = ?`,
      [ip]
    );
    
    // Get average response time
    const [avgTimeResult] = await pool.query(
      `SELECT AVG(response_time) as avg_time FROM request_logs WHERE client_ip = ?`,
      [ip]
    );
    
    // Get user IDs if any
    const [userIdsResult] = await pool.query(
      `SELECT DISTINCT user_id FROM request_logs WHERE client_ip = ? AND user_id IS NOT NULL`,
      [ip]
    );
    
    // Get error rate
    const [errorRateResult] = await pool.query(
      `SELECT 
        COUNT(*) as total_requests,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
       FROM request_logs WHERE client_ip = ?`,
      [ip]
    );
    
    // Get geo information (last known)
    const [geoResult] = await pool.query(
      `SELECT geo_country, geo_city, geo_region FROM request_logs 
       WHERE client_ip = ? AND geo_country != '' 
       ORDER BY created_at DESC LIMIT 1`,
      [ip]
    );
    
    // Calculate error rate
    const errorRate = errorRateResult[0].total_requests > 0 
      ? (errorRateResult[0].error_count / errorRateResult[0].total_requests) * 100 
      : 0;
    
    return {
      totalRequests: countResult[0].total,
      topPaths: pathsResult,
      firstSeen: firstSeenResult[0].first_seen,
      lastSeen: lastSeenResult[0].last_seen,
      avgResponseTime: avgTimeResult[0].avg_time,
      associatedUsers: userIdsResult.map(row => row.user_id),
      errorRate: errorRate.toFixed(2) + '%',
      geoInfo: geoResult.length > 0 ? {
        country: geoResult[0].geo_country,
        city: geoResult[0].geo_city,
        region: geoResult[0].geo_region
      } : null
    };
  } catch (error) {
    console.error('Error getting IP stats:', error);
    throw error;
  }
}

// Get recent unique IPs
export async function getRecentIps(limit = 30) {
  try {
    const [rows] = await pool.query(
      `SELECT client_ip, MAX(created_at) as last_seen, 
       COUNT(*) as request_count, geo_country, geo_city
       FROM request_logs
       GROUP BY client_ip
       ORDER BY last_seen DESC
       LIMIT ?`,
      [limit]
    );
    
    return rows;
  } catch (error) {
    console.error('Error getting recent IPs:', error);
    throw error;
  }
}
