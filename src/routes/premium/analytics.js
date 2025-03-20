import express from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { pool } from '../../db/init.js';

const router = express.Router();

// Get premium analytics
router.get('/analytics', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [analytics] = await connection.query(
      `SELECT 
        DATE(created_at) as date,
        event_type,
        COUNT(*) as count
       FROM premium_analytics
       WHERE user_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at), event_type
       ORDER BY date DESC`,
      [req.user.id]
    );

    res.json(analytics);
  } catch (error) {
    console.error('Failed to fetch analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  } finally {
    connection.release();
  }
});

// Track premium event
router.post('/analytics/track', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { eventType, eventData } = req.body;
    
    const id = uuidv4();
    await connection.query(
      `INSERT INTO premium_analytics (
        id, user_id, event_type, event_data
      ) VALUES (?, ?, ?, ?)`,
      [id, req.user.id, eventType, JSON.stringify(eventData)]
    );

    res.json({ message: 'Event tracked successfully' });
  } catch (error) {
    console.error('Failed to track event:', error);
    res.status(500).json({ error: 'Failed to track event' });
  } finally {
    connection.release();
  }
});

export default router;
