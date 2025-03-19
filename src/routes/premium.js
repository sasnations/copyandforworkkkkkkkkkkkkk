import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticateToken } from '../middleware/auth.js';
import { pool } from '../db/init.js';
import dns from 'dns';
import { promisify } from 'util';

const router = express.Router();
const resolveMx = promisify(dns.resolveMx);
const resolveTxt = promisify(dns.resolveTxt);

// Verify DNS settings for a domain
async function verifyDNSSettings(domain) {
  try {
    // Check MX records
    const mxRecords = await resolveMx(domain);
    const hasMxRecords = mxRecords.some(record => 
      record.exchange.includes('mx1.boomlify.com') || 
      record.exchange.includes('mx2.boomlify.com')
    );

    // Check SPF record
    const txtRecords = await resolveTxt(domain);
    const hasSpf = txtRecords.some(records => 
      records.some(record => 
        record.includes('v=spf1') && 
        record.includes('include:_spf.boomlify.com')
      )
    );

    // Check CNAME record
    const hasCname = await new Promise((resolve) => {
      dns.resolveCname(`mail.${domain}`, (err, addresses) => {
        resolve(!err && addresses?.some(addr => addr.includes('mail.boomlify.com')));
      });
    });

    return {
      isValid: hasMxRecords && hasSpf && hasCname,
      checks: {
        mx: hasMxRecords,
        spf: hasSpf,
        cname: hasCname
      }
    };
  } catch (error) {
    console.error('DNS verification error:', error);
    return {
      isValid: false,
      checks: {
        mx: false,
        spf: false,
        cname: false
      }
    };
  }
}

// Get all custom domains for a user
router.get('/domains', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [domains] = await connection.query(
      'SELECT * FROM custom_domains WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(domains);
  } catch (error) {
    console.error('Failed to fetch domains:', error);
    res.status(500).json({ error: 'Failed to fetch domains' });
  } finally {
    connection.release();
  }
});

// Add a new custom domain
router.post('/domains', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { domain } = req.body;
    
    // Basic validation
    if (!domain || !/^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    // Check if domain already exists
    const [existing] = await connection.query(
      'SELECT id FROM custom_domains WHERE domain = ?',
      [domain]
    );

    if (existing.length > 0) {
      return res.status(409).json({ error: 'Domain already exists' });
    }

    // Add domain with pending status
    const id = uuidv4();
    await connection.query(
      `INSERT INTO custom_domains (
        id, user_id, domain, status, created_at
      ) VALUES (?, ?, ?, 'pending', NOW())`,
      [id, req.user.id, domain]
    );

    // Return the new domain
    const [newDomain] = await connection.query(
      'SELECT * FROM custom_domains WHERE id = ?',
      [id]
    );

    res.json(newDomain[0]);
  } catch (error) {
    console.error('Failed to add domain:', error);
    res.status(500).json({ error: 'Failed to add domain' });
  } finally {
    connection.release();
  }
});

// Verify domain DNS settings
router.post('/domains/:id/verify', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [domain] = await connection.query(
      'SELECT * FROM custom_domains WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!domain.length) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const verification = await verifyDNSSettings(domain[0].domain);
    
    await connection.query(
      `UPDATE custom_domains 
       SET status = ?, 
           verified_at = ?,
           last_check_at = NOW(),
           dns_check_results = ?
       WHERE id = ?`,
      [
        verification.isValid ? 'verified' : 'failed',
        verification.isValid ? new Date() : null,
        JSON.stringify(verification.checks),
        req.params.id
      ]
    );

    res.json({
      status: verification.isValid ? 'verified' : 'failed',
      checks: verification.checks
    });
  } catch (error) {
    console.error('Failed to verify domain:', error);
    res.status(500).json({ error: 'Failed to verify domain' });
  } finally {
    connection.release();
  }
});

// Get premium emails
router.get('/emails', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    // Get total count
    const [countResult] = await connection.query(
      `SELECT COUNT(*) as total 
       FROM premium_emails 
       WHERE user_id = ?
       ${search ? 'AND email LIKE ?' : ''}`,
      search ? [req.user.id, `%${search}%`] : [req.user.id]
    );

    // Get paginated emails
    const [emails] = await connection.query(
      `SELECT * FROM premium_emails 
       WHERE user_id = ?
       ${search ? 'AND email LIKE ?' : ''}
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      search ? [req.user.id, `%${search}%`, limit, offset] : [req.user.id, limit, offset]
    );

    res.json({
      data: emails,
      metadata: {
        total: countResult[0].total,
        page,
        limit,
        pages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Failed to fetch emails:', error);
    res.status(500).json({ error: 'Failed to fetch emails' });
  } finally {
    connection.release();
  }
});

// Create premium email
router.post('/emails', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { email, domainId } = req.body;

    // Validate domain ownership
    const [domain] = await connection.query(
      'SELECT * FROM custom_domains WHERE id = ? AND user_id = ? AND status = ?',
      [domainId, req.user.id, 'verified']
    );

    if (!domain.length) {
      return res.status(403).json({ error: 'Invalid or unverified domain' });
    }

    // Create premium email
    const id = uuidv4();
    await connection.query(
      `INSERT INTO premium_emails (
        id, user_id, email, domain_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 3 MONTH), NOW())`,
      [id, req.user.id, email, domainId]
    );

    const [newEmail] = await connection.query(
      'SELECT * FROM premium_emails WHERE id = ?',
      [id]
    );

    res.json(newEmail[0]);
  } catch (error) {
    console.error('Failed to create email:', error);
    res.status(500).json({ error: 'Failed to create email' });
  } finally {
    connection.release();
  }
});

// Extend email validity
router.post('/emails/:id/extend', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { days } = req.body;
    
    if (!days || days < 1 || days > 365) {
      return res.status(400).json({ error: 'Invalid extension period' });
    }

    // Verify ownership and update expiry
    const result = await connection.query(
      `UPDATE premium_emails 
       SET expires_at = DATE_ADD(expires_at, INTERVAL ? DAY)
       WHERE id = ? AND user_id = ?`,
      [days, req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const [updatedEmail] = await connection.query(
      'SELECT * FROM premium_emails WHERE id = ?',
      [req.params.id]
    );

    res.json(updatedEmail[0]);
  } catch (error) {
    console.error('Failed to extend email validity:', error);
    res.status(500).json({ error: 'Failed to extend email validity' });
  } finally {
    connection.release();
  }
});

// Set email forwarding
router.post('/emails/:id/forward', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { forwardTo } = req.body;

    if (!forwardTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forwardTo)) {
      return res.status(400).json({ error: 'Invalid forwarding email' });
    }

    // Update forwarding address
    const result = await connection.query(
      `UPDATE premium_emails 
       SET forward_to = ?
       WHERE id = ? AND user_id = ?`,
      [forwardTo, req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const [updatedEmail] = await connection.query(
      'SELECT * FROM premium_emails WHERE id = ?',
      [req.params.id]
    );

    res.json(updatedEmail[0]);
  } catch (error) {
    console.error('Failed to set email forwarding:', error);
    res.status(500).json({ error: 'Failed to set email forwarding' });
  } finally {
    connection.release();
  }
});

// Delete premium email
router.delete('/emails/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    // Delete email and all associated data
    const result = await connection.query(
      'DELETE FROM premium_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    res.json({ message: 'Email deleted successfully' });
  } catch (error) {
    console.error('Failed to delete email:', error);
    res.status(500).json({ error: 'Failed to delete email' });
  } finally {
    connection.release();
  }
});

export default router;
