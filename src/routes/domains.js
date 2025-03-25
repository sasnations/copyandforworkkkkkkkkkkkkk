import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { pool } from '../db/init.js';

const router = express.Router();

// Get public domains (no auth required)
router.get('/public', async (req, res) => {
  try {
    const [domains] = await pool.query(
      'SELECT * FROM domains ORDER BY created_at DESC'
    );
    res.json(domains);
  } catch (error) {
    console.error('Failed to fetch public domains:', error);
    res.status(500).json({ error: 'Failed to fetch domains' });
  }
});

// Get all domains (protected route)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const [domains] = await pool.query('SELECT * FROM domains ORDER BY created_at DESC');
    res.json(domains);
  } catch (error) {
    console.error('Failed to fetch domains:', error);
    res.status(500).json({ error: 'Failed to fetch domains' });
  }
});

// Get user's custom domains
router.get('/custom', authenticateToken, async (req, res) => {
  try {
    const [domains] = await pool.query(
      `SELECT ud.*, dv.is_verified as dns_verified, df.forward_to 
       FROM user_domains ud 
       LEFT JOIN domain_verifications dv ON ud.id = dv.domain_id
       LEFT JOIN domain_forwards df ON ud.id = df.domain_id
       WHERE ud.user_id = ?
       ORDER BY ud.created_at DESC`,
      [req.user.id]
    );
    res.json(domains);
  } catch (error) {
    console.error('Failed to fetch custom domains:', error);
    res.status(500).json({ error: 'Failed to fetch custom domains' });
  }
});

// Add custom domain
router.post('/custom', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { domain } = req.body;
    
    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    // Validate domain format
    const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
    if (!domainRegex.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    await connection.beginTransaction();

    // Check if domain already exists
    const [existingDomains] = await connection.query(
      'SELECT * FROM user_domains WHERE domain = ?',
      [domain]
    );

    if (existingDomains.length > 0) {
      await connection.rollback();
      return res.status(409).json({ error: 'Domain already exists' });
    }

    // Create domain record
    const domainId = uuidv4();
    await connection.query(
      'INSERT INTO user_domains (id, user_id, domain, status) VALUES (?, ?, ?, ?)',
      [domainId, req.user.id, domain, 'trial']
    );

    // Create verification records
    const verifications = [
      { type: 'MX', value: `10 mail.${domain}` },
      { type: 'TXT', value: `v=spf1 include:${domain} -all` },
      { type: 'DKIM', value: `k=rsa; p=MIGfMA0...` } // You'll need to generate actual DKIM keys
    ];

    for (const verification of verifications) {
      await connection.query(
        'INSERT INTO domain_verifications (id, domain_id, type, value) VALUES (?, ?, ?, ?)',
        [uuidv4(), domainId, verification.type, verification.value]
      );
    }

    await connection.commit();

    const [newDomain] = await connection.query(
      'SELECT * FROM user_domains WHERE id = ?',
      [domainId]
    );

    res.json(newDomain[0]);
  } catch (error) {
    await connection.rollback();
    console.error('Failed to add custom domain:', error);
    res.status(500).json({ error: 'Failed to add custom domain' });
  } finally {
    connection.release();
  }
});

// Add domain (admin only)
router.post('/add', authenticateToken, async (req, res) => {
  try {
    // Check admin access
    const adminAccess = req.headers['admin-access'];
    if (adminAccess !== process.env.ADMIN_PASSPHRASE && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { domain } = req.body;
    const id = uuidv4();

    await pool.query(
      'INSERT INTO domains (id, domain) VALUES (?, ?)',
      [id, domain]
    );

    res.json({ id, domain });
  } catch (error) {
    console.error('Failed to add domain:', error);
    res.status(500).json({ error: 'Failed to add domain' });
  }
});

// Verify domain DNS records
router.post('/verify/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;

    // Check domain ownership
    const [domain] = await connection.query(
      'SELECT * FROM user_domains WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (domain.length === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    // Get verification records
    const [verifications] = await connection.query(
      'SELECT * FROM domain_verifications WHERE domain_id = ?',
      [id]
    );

    // Here you would implement actual DNS verification logic
    // For now, we'll simulate successful verification
    await connection.beginTransaction();

    for (const verification of verifications) {
      await connection.query(
        'UPDATE domain_verifications SET is_verified = 1, verified_at = NOW() WHERE id = ?',
        [verification.id]
      );
    }

    await connection.query(
      'UPDATE user_domains SET is_verified = 1 WHERE id = ?',
      [id]
    );

    await connection.commit();

    res.json({ message: 'Domain verified successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Failed to verify domain:', error);
    res.status(500).json({ error: 'Failed to verify domain' });
  } finally {
    connection.release();
  }
});

// Set up email forwarding
router.post('/forward/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { forward_to } = req.body;

    if (!forward_to) {
      return res.status(400).json({ error: 'Forward email is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(forward_to)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check domain ownership
    const [domain] = await connection.query(
      'SELECT * FROM user_domains WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (domain.length === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    await connection.beginTransaction();

    // Update or create forwarding record
    await connection.query(
      `INSERT INTO domain_forwards (id, domain_id, forward_to) 
       VALUES (?, ?, ?) 
       ON DUPLICATE KEY UPDATE forward_to = ?`,
      [uuidv4(), id, forward_to, forward_to]
    );

    await connection.commit();

    res.json({ message: 'Email forwarding set up successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Failed to set up email forwarding:', error);
    res.status(500).json({ error: 'Failed to set up email forwarding' });
  } finally {
    connection.release();
  }
});

// Delete custom domain
router.delete('/custom/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;

    // Check domain ownership
    const [domain] = await connection.query(
      'SELECT * FROM user_domains WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (domain.length === 0) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    await connection.beginTransaction();

    // Delete domain and related records (cascade will handle related records)
    await connection.query(
      'DELETE FROM user_domains WHERE id = ?',
      [id]
    );

    await connection.commit();

    res.json({ message: 'Domain deleted successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Failed to delete domain:', error);
    res.status(500).json({ error: 'Failed to delete domain' });
  } finally {
    connection.release();
  }
});

export default router;
