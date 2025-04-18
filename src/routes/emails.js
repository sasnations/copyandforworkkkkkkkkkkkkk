import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticateToken } from '../middleware/auth.js';
import { pool } from '../db/init.js';
import compression from 'compression';
import { rateLimitMiddleware, verifyCaptcha, checkCaptchaRequired, rateLimitStore } from '../middleware/rateLimit.js';

const router = express.Router();

// Get a specific temporary email
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const [emails] = await pool.query(
      'SELECT * FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (emails.length === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    res.json(emails[0]);
  } catch (error) {
    res.status(400).json({ error: 'Failed to fetch email' });
  }
});

// Get received emails for a specific temporary email with pagination
router.get('/:id/received', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const [countResult] = await pool.query(`
      SELECT COUNT(*) as total
      FROM received_emails re
      JOIN temp_emails te ON re.temp_email_id = te.id
      WHERE te.id = ? AND te.user_id = ?
    `, [req.params.id, req.user.id]);

    const totalCount = countResult[0].total;

    const [emails] = await pool.query(`
      SELECT re.*, te.email as temp_email
      FROM received_emails re
      JOIN temp_emails te ON re.temp_email_id = te.id
      WHERE te.id = ? AND te.user_id = ?
      ORDER BY re.received_at DESC
      LIMIT ? OFFSET ?
    `, [req.params.id, req.user.id, limit, offset]);

    res.json({
      data: emails,
      metadata: {
        total: totalCount,
        page: page,
        limit: limit,
        pages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    console.error('Failed to fetch received emails:', error);
    res.status(400).json({ error: 'Failed to fetch received emails' });
  }
});

// Create email with rate limit and optional CAPTCHA verification
router.post('/create', authenticateToken, rateLimitMiddleware, checkCaptchaRequired, verifyCaptcha, async (req, res) => {
  try {
    const { email, domainId } = req.body;
    const id = uuidv4();
    
    // Set expiry date to 2 months from now
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 2);
    
    // If CAPTCHA was provided and successfully verified, reset rate limit counter
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (req.body.captchaResponse) {
      if (req.user) {
        const userId = req.user.id;
        if (rateLimitStore.userLimits[userId]) {
          rateLimitStore.userLimits[userId].count = 0;
          rateLimitStore.userLimits[userId].captchaRequired = false;
        }
      } else {
        if (rateLimitStore.limits[clientIp]) {
          rateLimitStore.limits[clientIp].count = 0;
          rateLimitStore.limits[clientIp].captchaRequired = false;
        }
      }
    }

    // Check if this is a custom domain
    const [customDomain] = await pool.query(
      'SELECT * FROM user_domains WHERE id = ? AND user_id = ?',
      [domainId, req.user.id]
    );

    if (customDomain.length > 0) {
      // Create email with custom domain
      await pool.query(
        'INSERT INTO temp_emails (id, user_id, email, domain_id, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 2 MONTH))',
        [id, req.user.id, email, domainId]
      );

      const [createdEmail] = await pool.query(
        'SELECT * FROM temp_emails WHERE id = ?',
        [id]
      );

      res.json(createdEmail[0]);
    } else {
      // Check system domains
      const [systemDomain] = await pool.query(
        'SELECT * FROM domains WHERE id = ?',
        [domainId]
      );

      if (systemDomain.length === 0) {
        return res.status(400).json({ error: 'Invalid domain' });
      }

      // Create email with system domain
      const [result] = await pool.query(
        'INSERT INTO temp_emails (id, user_id, email, domain_id, expires_at) VALUES (?, ?, ?, ?, ?)',
        [id, req.user.id, email, domainId, expiresAt]
      );

      const [createdEmail] = await pool.query(
        'SELECT * FROM temp_emails WHERE id = ?',
        [id]
      );

      res.json(createdEmail[0]);
    }
  } catch (error) {
    console.error('Create email error:', error);
    res.status(400).json({ error: 'Failed to create temporary email' });
  }
});

router.delete('/delete/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const [deleteReceivedResult] = await connection.query(
      'DELETE FROM received_emails WHERE temp_email_id = ?',
      [req.params.id]
    );

    const [deleteTempResult] = await connection.query(
      'DELETE FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (deleteTempResult.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Email not found' });
    }

    await connection.commit();
    res.json({ message: 'Email deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Delete email error:', error);
    res.status(400).json({ error: 'Failed to delete email' });
  } finally {
    connection.release();
  }
});

// Get user emails with pagination
router.get('/', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let countQuery = 'SELECT COUNT(*) as total FROM temp_emails WHERE user_id = ?';
    let countParams = [req.user.id];
    
    if (search) {
      countQuery += ' AND email LIKE ?';
      countParams.push(`%${search}%`);
    }
    
    const [countResult] = await pool.query(countQuery, countParams);
    const totalCount = countResult[0].total;

    let dataQuery = 'SELECT * FROM temp_emails WHERE user_id = ?';
    let dataParams = [req.user.id];
    
    if (search) {
      dataQuery += ' AND email LIKE ?';
      dataParams.push(`%${search}%`);
    }
    
    dataQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    dataParams.push(limit, offset);
    
    const [emails] = await pool.query(dataQuery, dataParams);

    res.json({
      data: emails,
      metadata: {
        total: totalCount,
        page: page,
        limit: limit,
        pages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    console.error('Failed to fetch emails:', error);
    res.status(400).json({ error: 'Failed to fetch emails' });
  }
});

// Delete a received email
router.delete('/:tempEmailId/received/:emailId', authenticateToken, async (req, res) => {
  try {
    const [tempEmails] = await pool.query(
      'SELECT id FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.tempEmailId, req.user.id]
    );

    if (tempEmails.length === 0) {
      return res.status(404).json({ error: 'Temporary email not found' });
    }

    const [result] = await pool.query(
      'DELETE FROM received_emails WHERE id = ? AND temp_email_id = ?',
      [req.params.emailId, req.params.tempEmailId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Received email not found' });
    }

    res.json({ message: 'Email deleted successfully' });
  } catch (error) {
    console.error('Failed to delete received email:', error);
    res.status(400).json({ error: 'Failed to delete received email' });
  }
});

// Bulk delete received emails
router.post('/:tempEmailId/received/bulk/delete', authenticateToken, async (req, res) => {
  const { emailIds } = req.body;
  
  if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
    return res.status(400).json({ error: 'Invalid email IDs' });
  }

  try {
    const [tempEmails] = await pool.query(
      'SELECT id FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.tempEmailId, req.user.id]
    );

    if (tempEmails.length === 0) {
      return res.status(404).json({ error: 'Temporary email not found' });
    }

    const [result] = await pool.query(
      'DELETE FROM received_emails WHERE id IN (?) AND temp_email_id = ?',
      [emailIds, req.params.tempEmailId]
    );

    res.json({ 
      message: 'Emails deleted successfully',
      count: result.affectedRows
    });
  } catch (error) {
    console.error('Failed to delete received emails:', error);
    res.status(400).json({ error: 'Failed to delete received emails' });
  }
});

// Get public emails (no auth required)
router.get('/public/:email', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=5');
    const [emails] = await pool.query(`
      SELECT re.*, te.email as temp_email
      FROM received_emails re
      JOIN temp_emails te ON re.temp_email_id = te.id
      WHERE te.email = ?
      ORDER BY re.received_at DESC
    `, [req.params.email]);

    res.json(emails);
  } catch (error) {
    console.error('Failed to fetch public emails:', error);
    res.status(400).json({ error: 'Failed to fetch emails' });
  }
});

// Create public temporary email (no auth required) with rate limiting and CAPTCHA
router.post('/public/create', rateLimitMiddleware, checkCaptchaRequired, verifyCaptcha, async (req, res) => {
  try {
    const { email, domainId } = req.body;
    const id = uuidv4();
    
    if (res.locals.captchaRequired && !req.body.captchaResponse) {
      return res.status(400).json({
        error: 'CAPTCHA_REQUIRED',
        captchaRequired: true,
        captchaSiteKey: res.locals.captchaSiteKey,
        message: 'You have exceeded the rate limit. Please complete the CAPTCHA.'
      });
    }
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 48);
    
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (req.body.captchaResponse) {
      if (rateLimitStore.limits[clientIp]) {
        rateLimitStore.limits[clientIp].count = 0;
        rateLimitStore.limits[clientIp].captchaRequired = false;
      }
    }

    const [result] = await pool.query(
      'INSERT INTO temp_emails (id, email, domain_id, expires_at) VALUES (?, ?, ?, ?)',
      [id, email, domainId, expiresAt]
    );

    const [createdEmail] = await pool.query(
      'SELECT * FROM temp_emails WHERE id = ?',
      [id]
    );

    res.json(createdEmail[0]);
  } catch (error) {
    console.error('Create public email error:', error);
    res.status(400).json({ error: 'Failed to create temporary email' });
  }
});

// Admin route to fetch all emails (admin-only)
router.get('/admin/all', async (req, res) => {
  try {
    const adminAccess = req.headers['admin-access'];
    if (adminAccess !== process.env.ADMIN_PASSPHRASE) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const offset = (page - 1) * limit;

    const [countResult] = await pool.query(`
      SELECT COUNT(*) as total
      FROM received_emails
    `);

    const totalCount = countResult[0].total;

    const [emails] = await pool.query(`
      SELECT re.*, te.email as temp_email
      FROM received_emails re
      JOIN temp_emails te ON re.temp_email_id = te.id
      ORDER BY re.received_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    res.json({
      data: emails,
      metadata: {
        total: totalCount,
        page: page,
        limit: limit,
        pages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    console.error('Failed to fetch admin emails:', error);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

// Compress responses
router.use(compression());

export default router;
