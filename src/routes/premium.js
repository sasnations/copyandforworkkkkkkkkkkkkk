import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { pool } from '../db/init.js';
import { v4 as uuidv4 } from 'uuid';
import { mailTransporter } from '../index.js';
import analyticsRoutes from './premium/analytics.js';
import webhooksRoutes from './premium/webhooks.js';
import templatesRoutes from './premium/templates.js';
import backupsRoutes from './premium/backups.js';

const router = express.Router();

// Use premium sub-routes
router.use('/analytics', analyticsRoutes);
router.use('/webhooks', webhooksRoutes);
router.use('/templates', templatesRoutes);
router.use('/backups', backupsRoutes);

// Set up email forwarding
router.post('/emails/:id/forward', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { forwardTo } = req.body;
    
    // Validate email format
    if (!forwardTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forwardTo)) {
      return res.status(400).json({ error: 'Invalid forwarding email address' });
    }

    // Verify email ownership
    const [email] = await connection.query(
      'SELECT * FROM premium_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!email.length) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Update forwarding address
    await connection.query(
      'UPDATE premium_emails SET forward_to = ? WHERE id = ?',
      [forwardTo, req.params.id]
    );

    // Test forwarding setup
    try {
      await mailTransporter.sendMail({
        from: `"Boomlify Forward Test" <${email[0].email}>`,
        to: forwardTo,
        subject: 'Email Forwarding Test',
        html: `
          <h1>Email Forwarding Test</h1>
          <p>This is a test email to confirm your forwarding setup is working correctly.</p>
          <p>You will now receive all emails sent to ${email[0].email} at this address.</p>
        `
      });
    } catch (error) {
      console.error('Forward test failed:', error);
      // Continue even if test fails - don't block setup
    }

    res.json({ message: 'Email forwarding set up successfully' });
  } catch (error) {
    console.error('Failed to set up forwarding:', error);
    res.status(500).json({ error: 'Failed to set up email forwarding' });
  } finally {
    connection.release();
  }
});

// Remove email forwarding
router.delete('/emails/:id/forward', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [result] = await connection.query(
      'UPDATE premium_emails SET forward_to = NULL WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Email not found' });
    }

    res.json({ message: 'Email forwarding removed successfully' });
  } catch (error) {
    console.error('Failed to remove forwarding:', error);
    res.status(500).json({ error: 'Failed to remove email forwarding' });
  } finally {
    connection.release();
  }
});

// Get forwarding status
router.get('/emails/:id/forward', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [email] = await connection.query(
      'SELECT forward_to FROM premium_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!email.length) {
      return res.status(404).json({ error: 'Email not found' });
    }

    res.json({
      forwardingEnabled: !!email[0].forward_to,
      forwardTo: email[0].forward_to
    });
  } catch (error) {
    console.error('Failed to get forwarding status:', error);
    res.status(500).json({ error: 'Failed to get forwarding status' });
  } finally {
    connection.release();
  }
});

// Get premium status
router.get('/status', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [user] = await connection.query(
      'SELECT premium_tier, premium_features, premium_limits FROM users WHERE id = ?',
      [req.user.id]
    );

    if (!user.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user[0]);
  } catch (error) {
    console.error('Failed to fetch premium status:', error);
    res.status(500).json({ error: 'Failed to fetch premium status' });
  } finally {
    connection.release();
  }
});

// Get premium usage stats
router.get('/usage', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    // Get email counts
    const [emailCounts] = await connection.query(
      `SELECT 
        COUNT(DISTINCT pe.id) as total_emails,
        COUNT(DISTINCT cd.id) as total_domains,
        COUNT(DISTINCT pre.id) as total_received,
        COUNT(DISTINCT CASE WHEN pe.forward_to IS NOT NULL THEN pe.id END) as forwarded_emails
       FROM premium_emails pe
       LEFT JOIN custom_domains cd ON pe.domain_id = cd.id
       LEFT JOIN premium_received_emails pre ON pe.id = pre.premium_email_id
       WHERE pe.user_id = ?`,
      [req.user.id]
    );

    // Get storage usage
    const [storageUsage] = await connection.query(
      `SELECT 
        SUM(CHAR_LENGTH(pre.body_html) + CHAR_LENGTH(pre.body_text)) as email_size,
        COUNT(pea.id) as attachment_count,
        SUM(pea.size) as attachment_size
       FROM premium_received_emails pre
       LEFT JOIN premium_email_attachments pea ON pre.id = pea.email_id
       WHERE pre.premium_email_id IN (
         SELECT id FROM premium_emails WHERE user_id = ?
       )`,
      [req.user.id]
    );

    res.json({
      emails: {
        ...emailCounts[0],
        forwarded: emailCounts[0].forwarded_emails || 0
      },
      storage: {
        emailSize: storageUsage[0].email_size || 0,
        attachmentCount: storageUsage[0].attachment_count || 0,
        attachmentSize: storageUsage[0].attachment_size || 0,
        totalSize: (storageUsage[0].email_size || 0) + (storageUsage[0].attachment_size || 0)
      }
    });
  } catch (error) {
    console.error('Failed to fetch usage stats:', error);
    res.status(500).json({ error: 'Failed to fetch usage stats' });
  } finally {
    connection.release();
  }
});

// Update premium settings
router.put('/settings', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { features } = req.body;
    
    await connection.query(
      'UPDATE users SET premium_features = ? WHERE id = ?',
      [JSON.stringify(features), req.user.id]
    );

    res.json({ message: 'Settings updated successfully' });
  } catch (error) {
    console.error('Failed to update settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  } finally {
    connection.release();
  }
});

// Get premium limits
router.get('/limits', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [user] = await connection.query(
      'SELECT premium_limits FROM users WHERE id = ?',
      [req.user.id]
    );

    if (!user.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const limits = JSON.parse(user[0].premium_limits || '{}');
    
    // Get current usage
    const [usage] = await connection.query(
      `SELECT 
        COUNT(DISTINCT pe.id) as email_count,
        COUNT(DISTINCT cd.id) as domain_count,
        SUM(CHAR_LENGTH(pre.body_html) + CHAR_LENGTH(pre.body_text)) as storage_used,
        COUNT(DISTINCT CASE WHEN pe.forward_to IS NOT NULL THEN pe.id END) as forwarding_count
       FROM premium_emails pe
       LEFT JOIN custom_domains cd ON pe.domain_id = cd.id
       LEFT JOIN premium_received_emails pre ON pe.id = pre.premium_email_id
       WHERE pe.user_id = ?`,
      [req.user.id]
    );

    res.json({
      limits,
      usage: {
        emails: usage[0].email_count || 0,
        domains: usage[0].domain_count || 0,
        storage: usage[0].storage_used || 0,
        forwarding: usage[0].forwarding_count || 0
      }
    });
  } catch (error) {
    console.error('Failed to fetch limits:', error);
    res.status(500).json({ error: 'Failed to fetch limits' });
  } finally {
    connection.release();
  }
});

export default router;
