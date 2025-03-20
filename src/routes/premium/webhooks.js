import express from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { pool } from '../../db/init.js';
import crypto from 'crypto';

const router = express.Router();

// Get webhook configurations
router.get('/webhooks', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [webhooks] = await connection.query(
      'SELECT * FROM premium_webhooks WHERE user_id = ?',
      [req.user.id]
    );
    res.json(webhooks);
  } catch (error) {
    console.error('Failed to fetch webhooks:', error);
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  } finally {
    connection.release();
  }
});

// Create webhook
router.post('/webhooks', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { url, events } = req.body;
    
    // Generate webhook secret
    const secret = crypto.randomBytes(32).toString('hex');
    
    const id = uuidv4();
    await connection.query(
      `INSERT INTO premium_webhooks (
        id, user_id, url, secret, events
      ) VALUES (?, ?, ?, ?, ?)`,
      [id, req.user.id, url, secret, JSON.stringify(events)]
    );

    const [webhook] = await connection.query(
      'SELECT * FROM premium_webhooks WHERE id = ?',
      [id]
    );

    res.json(webhook[0]);
  } catch (error) {
    console.error('Failed to create webhook:', error);
    res.status(500).json({ error: 'Failed to create webhook' });
  } finally {
    connection.release();
  }
});

// Update webhook
router.put('/webhooks/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { url, events, is_active } = req.body;
    
    await connection.query(
      `UPDATE premium_webhooks 
       SET url = ?, events = ?, is_active = ?
       WHERE id = ? AND user_id = ?`,
      [url, JSON.stringify(events), is_active, req.params.id, req.user.id]
    );

    const [webhook] = await connection.query(
      'SELECT * FROM premium_webhooks WHERE id = ?',
      [req.params.id]
    );

    res.json(webhook[0]);
  } catch (error) {
    console.error('Failed to update webhook:', error);
    res.status(500).json({ error: 'Failed to update webhook' });
  } finally {
    connection.release();
  }
});

// Delete webhook
router.delete('/webhooks/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      'DELETE FROM premium_webhooks WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    res.json({ message: 'Webhook deleted successfully' });
  } catch (error) {
    console.error('Failed to delete webhook:', error);
    res.status(500).json({ error: 'Failed to delete webhook' });
  } finally {
    connection.release();
  }
});

export default router;
