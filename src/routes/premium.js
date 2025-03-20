import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { pool } from '../db/init.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

// Get all emails (both premium and regular)
router.get('/emails', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    // Get premium emails
    const [premiumEmails] = await connection.query(
      `SELECT pe.*, cd.domain 
       FROM premium_emails pe
       JOIN custom_domains cd ON pe.domain_id = cd.id
       WHERE pe.user_id = ? AND pe.email LIKE ?
       ORDER BY pe.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, `%${search}%`, limit, offset]
    );

    // Get total count
    const [totalCount] = await connection.query(
      `SELECT COUNT(*) as total 
       FROM premium_emails 
       WHERE user_id = ? AND email LIKE ?`,
      [req.user.id, `%${search}%`]
    );

    // Get regular emails
    const [regularEmails] = await connection.query(
      `SELECT * FROM temp_emails 
       WHERE user_id = ? AND email LIKE ?
       ORDER BY created_at DESC`,
      [req.user.id, `%${search}%`]
    );

    // Combine and format response
    const allEmails = [
      ...premiumEmails.map(email => ({
        ...email,
        type: 'premium'
      })),
      ...regularEmails.map(email => ({
        ...email,
        type: 'regular'
      }))
    ];

    res.json({
      data: allEmails,
      metadata: {
        total: totalCount[0].total,
        page,
        limit,
        pages: Math.ceil(totalCount[0].total / limit)
      }
    });

  } catch (error) {
    console.error('Failed to fetch emails:', error);
    res.status(500).json({ error: 'Failed to fetch emails' });
  } finally {
    connection.release();
  }
});

// Get custom domains
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

// Add custom domain
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

    // Verify DNS settings
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

// Upgrade regular email to premium
router.post('/emails/upgrade/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { domainId } = req.body;

    // Verify domain ownership and status
    const [domain] = await connection.query(
      'SELECT * FROM custom_domains WHERE id = ? AND user_id = ? AND status = ?',
      [domainId, req.user.id, 'verified']
    );

    if (!domain.length) {
      return res.status(403).json({ error: 'Invalid or unverified domain' });
    }

    // Get regular email
    const [regularEmail] = await connection.query(
      'SELECT * FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!regularEmail.length) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Create premium email
    const id = uuidv4();
    const newEmail = `${regularEmail[0].email.split('@')[0]}@${domain[0].domain}`;

    await connection.beginTransaction();

    // Insert premium email
    await connection.query(
      `INSERT INTO premium_emails (
        id, user_id, email, domain_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 3 MONTH), NOW())`,
      [id, req.user.id, newEmail, domainId]
    );

    // Delete regular email
    await connection.query(
      'DELETE FROM temp_emails WHERE id = ?',
      [req.params.id]
    );

    await connection.commit();

    const [upgradedEmail] = await connection.query(
      'SELECT * FROM premium_emails WHERE id = ?',
      [id]
    );

    res.json(upgradedEmail[0]);
  } catch (error) {
    await connection.rollback();
    console.error('Failed to upgrade email:', error);
    res.status(500).json({ error: 'Failed to upgrade email' });
  } finally {
    connection.release();
  }
});

export default router;
