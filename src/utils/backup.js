import { pool } from '../db/init.js';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { createGzip } from 'zlib';

const pipelineAsync = promisify(pipeline);
const writeFileAsync = promisify(fs.writeFile);
const readFileAsync = promisify(fs.readFile);

export async function createBackup(backupId, userId, type) {
  const connection = await pool.getConnection();
  try {
    // Get user's data based on backup type
    let data = {};
    
    if (type === 'full' || type === 'emails') {
      const [emails] = await connection.query(
        `SELECT * FROM premium_emails WHERE user_id = ?`,
        [userId]
      );
      data.emails = emails;

      const [receivedEmails] = await connection.query(
        `SELECT * FROM premium_received_emails WHERE premium_email_id IN (
          SELECT id FROM premium_emails WHERE user_id = ?
        )`,
        [userId]
      );
      data.receivedEmails = receivedEmails;
    }

    if (type === 'full' || type === 'templates') {
      const [templates] = await connection.query(
        `SELECT * FROM premium_email_templates WHERE user_id = ?`,
        [userId]
      );
      data.templates = templates;
    }

    if (type === 'full' || type === 'domains') {
      const [domains] = await connection.query(
        `SELECT * FROM custom_domains WHERE user_id = ?`,
        [userId]
      );
      data.domains = domains;
    }

    // Create backup file
    const backupDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const filename = `backup_${backupId}_${Date.now()}.json.gz`;
    const filepath = path.join(backupDir, filename);

    // Compress and save data
    const jsonData = JSON.stringify(data);
    await pipelineAsync(
      Buffer.from(jsonData),
      createGzip(),
      fs.createWriteStream(filepath)
    );

    // Update backup status
    const fileStats = fs.statSync(filepath);
    await connection.query(
      `UPDATE premium_backups 
       SET status = 'completed', 
           file_path = ?,
           size = ?,
           completed_at = NOW()
       WHERE id = ?`,
      [filepath, fileStats.size, backupId]
    );

  } catch (error) {
    console.error('Backup creation failed:', error);
    await connection.query(
      `UPDATE premium_backups 
       SET status = 'failed',
           completed_at = NOW()
       WHERE id = ?`,
      [backupId]
    );
  } finally {
    connection.release();
  }
}

export async function restoreBackup(backup) {
  const connection = await pool.getConnection();
  try {
    // Read and decompress backup file
    const compressedData = await readFileAsync(backup.file_path);
    const jsonData = compressedData.toString();
    const data = JSON.parse(jsonData);

    await connection.beginTransaction();

    // Restore data based on backup type
    if (backup.backup_type === 'full' || backup.backup_type === 'emails') {
      // Delete existing data first
      await connection.query(
        'DELETE FROM premium_emails WHERE user_id = ?',
        [backup.user_id]
      );

      // Restore emails
      for (const email of data.emails) {
        await connection.query(
          `INSERT INTO premium_emails SET ?`,
          email
        );
      }

      // Restore received emails
      for (const email of data.receivedEmails) {
        await connection.query(
          `INSERT INTO premium_received_emails SET ?`,
          email
        );
      }
    }

    if (backup.backup_type === 'full' || backup.backup_type === 'templates') {
      await connection.query(
        'DELETE FROM premium_email_templates WHERE user_id = ?',
        [backup.user_id]
      );

      for (const template of data.templates) {
        await connection.query(
          `INSERT INTO premium_email_templates SET ?`,
          template
        );
      }
    }

    if (backup.backup_type === 'full' || backup.backup_type === 'domains') {
      await connection.query(
        'DELETE FROM custom_domains WHERE user_id = ?',
        [backup.user_id]
      );

      for (const domain of data.domains) {
        await connection.query(
          `INSERT INTO custom_domains SET ?`,
          domain
        );
      }
    }

    await connection.commit();

    // Update backup status
    await connection.query(
      `UPDATE premium_backups 
       SET status = 'restored',
           completed_at = NOW()
       WHERE id = ?`,
      [backup.id]
    );

  } catch (error) {
    await connection.rollback();
    console.error('Restore failed:', error);
    await connection.query(
      `UPDATE premium_backups 
       SET status = 'restore_failed',
           completed_at = NOW()
       WHERE id = ?`,
      [backup.id]
    );
  } finally {
    connection.release();
  }
}
