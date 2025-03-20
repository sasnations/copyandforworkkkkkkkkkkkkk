import express from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { pool } from '../../db/init.js';

const router = express.Router();

// Get email templates
router.get('/templates', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [templates] = await connection.query(
      'SELECT * FROM premium_email_templates WHERE user_id = ?',
      [req.user.id]
    );
    res.json(templates);
  } catch (error) {
    console.error('Failed to fetch templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  } finally {
    connection.release();
  }
});

// Create email template
router.post('/templates', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { name, subject, content, variables } = req.body;
    
    const id = uuidv4();
    await connection.query(
      `INSERT INTO premium_email_templates (
        id, user_id, name, subject, content, variables
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, name, subject, content, JSON.stringify(variables)]
    );

    const [template] = await connection.query(
      'SELECT * FROM premium_email_templates WHERE id = ?',
      [id]
    );

    res.json(template[0]);
  } catch (error) {
    console.error('Failed to create template:', error);
    res.status(500).json({ error: 'Failed to create template' });
  } finally {
    connection.release();
  }
});

// Update email template
router.put('/templates/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { name, subject, content, variables } = req.body;
    
    await connection.query(
      `UPDATE premium_email_templates 
       SET name = ?, subject = ?, content = ?, variables = ?
       WHERE id = ? AND user_id = ?`,
      [name, subject, content, JSON.stringify(variables), req.params.id, req.user.id]
    );

    const [template] = await connection.query(
      'SELECT * FROM premium_email_templates WHERE id = ?',
      [req.params.id]
    );

    res.json(template[0]);
  } catch (error) {
    console.error('Failed to update template:', error);
    res.status(500).json({ error: 'Failed to update template' });
  } finally {
    connection.release();
  }
});

// Delete email template
router.delete('/templates/:id', authenticateToken, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      'DELETE FROM premium_email_templates WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    console.error('Failed to delete template:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  } finally {
    connection.release();
  }
});

export default router;
