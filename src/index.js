import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';
import { initializeDatabase, checkDatabaseConnection, pool } from './db/init.js';
import { cleanupOldEmails } from './utils/cleanup.js';
import { requestTrackerMiddleware } from './middleware/requestTracker.js';
import { checkBlockedIp } from './middleware/ipBlocker.js'; // Added import
import authRoutes from './routes/auth.js';
import emailRoutes from './routes/emails.js';
import domainRoutes from './routes/domains.js';
import webhookRoutes from './routes/webhook.js';
import messageRoutes from './routes/messages.js';
import blogRoutes from './routes/blog.js';
import monitorRoutes from './routes/monitor.js';
import nodemailer from 'nodemailer';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Create mail transporter
export const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false, // Use TLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false // Only use this in development!
  }
});

// Verify mail configuration on startup
mailTransporter.verify((error, success) => {
  if (error) {
    console.error('Mail server verification failed:', error);
  } else {
    console.log('Mail server is ready to send emails');
  }
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://boomlify.com", "https://www.google.com/recaptcha/"],
      frameSrc: ["https://www.google.com/recaptcha/"]
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Add compression middleware
app.use(compression());

// Add request tracking middleware
app.use(requestTrackerMiddleware);

// Apply IP blocker to all routes except monitor routes
app.use(/^(?!\/monitor).*$/, checkBlockedIp); // Added IP blocker middleware

// Security headers
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Updated CORS configuration with timeouts
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [process.env.FRONTEND_URL, 'https://boomlify.com'] 
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400 // Cache preflight request results for 24 hours
}));

app.use(express.json());

// Health check endpoint
app.get('/health', async (req, res) => {
  const dbHealthy = await checkDatabaseConnection();
  if (dbHealthy) {
    res.status(200).json({ 
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(503).json({ 
      status: 'unhealthy',
      database: 'disconnected',
      timestamp: new Date().toISOString()
    });
  }
});

// Routes
app.use('/auth', authRoutes);
app.use('/emails', emailRoutes);
app.use('/domains', domainRoutes);
app.use('/webhook', webhookRoutes);
app.use('/messages', messageRoutes);
app.use('/blog', blogRoutes);
app.use('/monitor', monitorRoutes);

// Handle preflight requests for /admin/all
app.options('/emails/admin/all', cors());

// Schedule cleanup
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

function scheduleCleanup() {
  setInterval(async () => {
    try {
      const deletedCount = await cleanupOldEmails();
      console.log(`Scheduled cleanup completed. Deleted ${deletedCount} old emails.`);
    } catch (error) {
      console.error('Scheduled cleanup failed:', error);
    }
  }, CLEANUP_INTERVAL);
}

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
    scheduleCleanup();
    console.log('Email cleanup scheduler started');
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});

// Improved rate limiting configuration
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests, please try again later.',
  skip: (req) => {
    // Don't rate limit health check endpoint
    return req.path === '/health';
  }
});

// More restrictive rate limiting for email creation
const emailCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 email creations per hour
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many email creation requests, please try again later.',
  keyGenerator: (req) => {
    // Use user ID if available, otherwise IP
    return req.user?.id || req.ip;
  }
});

// Apply rate limiting to all requests
app.use(apiLimiter);

// Apply more restrictive rate limiting to email creation
app.use('/api/emails/create', emailCreationLimiter);

// Request timeout middleware
app.use((req, res, next) => {
  // Set a 30-second timeout for all requests
  req.setTimeout(30000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

export default app;
