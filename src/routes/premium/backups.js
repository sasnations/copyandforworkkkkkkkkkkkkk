import express from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { pool } from '../../db/init.js';
import { createBackup, restoreBackup } from '../../utils/backup.js';

const router = express.Router();

// Get backup history
router.get('/backups', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [backups] = await connection.query(
      'SELECT * FROM premium_backups WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(backups);
  } catch (error) {
    console.error('Failed to fetch backups:', error);
    res.status(500).json({ error: 'Failed to fetch backups' });
  } finally {
    connection.release();
  }
});

// Create new backup
router.post('/backups', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { type } = req.body;
    
    const id = uuidv4();
    await connection.query(
      `INSERT INTO premium_backups (
        id, user_id, backup_type, status
      ) VALUES (?, ?, ?, 'pending')`,
      [id, req.user.id, type]
    );

    // Start backup process
    createBackup(id, req.user.id, type);

    res.json({ message: 'Backup started', id });
  } catch (error) {
    console.error('Failed to create backup:', error);
    res.status(500).json({ error: 'Failed to create backup' });
  } finally {
    connection.release();
  }
});

// Get backup status
router.get('/backups/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [backup] = await connection.query(
      'SELECT * FROM premium_backups WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (!backup.length) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    res.json(backup[0]);
  } catch (error) {
    console.error('Failed to fetch backup:', error);
    res.status(500).json({ error: 'Failed to fetch backup' });
  } finally {
    connection.release();
  }
});

// Restore from backup
router.post('/backups/:id/restore', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [backup] = await connection.query(
      'SELECT * FROM premium_backups WHERE id = ? AND user_id = ? AND status = ?',
      [req.params.id, req.user.id, 'completed']
    );

    if (!backup.length) {
      return res.status(404).json({ error: 'Backup not found or incomplete' });
    }

    // Start restore process
    restoreBackup(backup[0]);

    res.json({ message: 'Restore process started' });
  } catch (error) {
    console.error('Failed to restore backup:', error);
    res.status(500).json({ error: 'Failed to restore backup' });
  } finally {
    connection.release();
  }
});

export default router;
