import { pool } from '../db/init.js';
import nodemailer from 'nodemailer';
import { mailTransporter } from '../index.js';

export class EmailRouter {
  async getRoutingInfo(recipientEmail) {
    const connection = await pool.getConnection();
    try {
      // Extract domain from email
      const domain = recipientEmail.split('@')[1];

      // Check if this is a custom domain
      const [customDomain] = await connection.query(
        `SELECT ud.*, df.forward_to 
         FROM user_domains ud 
         LEFT JOIN domain_forwards df ON ud.id = df.domain_id
         WHERE ud.domain = ? AND ud.is_verified = 1`,
        [domain]
      );

      if (customDomain.length > 0) {
        return {
          type: 'custom',
          forwardTo: customDomain[0].forward_to,
          userId: customDomain[0].user_id
        };
      }

      // Check if this is a system domain
      const [systemDomain] = await connection.query(
        'SELECT * FROM domains WHERE domain = ?',
        [domain]
      );

      if (systemDomain.length > 0) {
        // Check if there's a forwarding rule for this email
        const [forwardRule] = await connection.query(
          'SELECT forward_to FROM email_forwards WHERE email = ?',
          [recipientEmail]
        );

        return {
          type: 'system',
          domain: systemDomain[0],
          forwardTo: forwardRule.length > 0 ? forwardRule[0].forward_to : null
        };
      }

      return null;
    } finally {
      connection.release();
    }
  }

  async handleIncomingEmail(recipientEmail, emailData) {
    const routing = await this.getRoutingInfo(recipientEmail);
    
    if (!routing) {
      throw new Error('Invalid recipient domain');
    }

    const connection = await pool.getConnection();
    try {
      // Get the temp email details
      const [tempEmail] = await connection.query(
        'SELECT * FROM temp_emails WHERE email = ?',
        [recipientEmail]
      );

      // Forward email if there's a forwarding rule (for both custom and system domains)
      if (routing.forwardTo) {
        await this.forwardEmail(
          recipientEmail,
          routing.forwardTo,
          emailData.from,
          emailData.subject,
          emailData.html || emailData.text,
          emailData.attachments
        );
      }

      // Store the email in received_emails table
      await this.storeEmail(emailData, routing.userId || tempEmail[0]?.user_id);

    } catch (error) {
      console.error('Error handling incoming email:', error);
      throw error;
    } finally {
      connection.release();
    }
  }

  async forwardEmail(fromEmail, toEmail, originalSender, subject, content, attachments = []) {
    try {
      // Create email options
      const mailOptions = {
        from: fromEmail,
        to: toEmail,
        subject: subject,
        html: content,
        attachments: attachments.map(attachment => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType
        })),
        headers: {
          'X-Original-From': originalSender,
          'X-Forwarded-By': 'Boomlify Mail Service'
        },
        replyTo: originalSender
      };

      // Send the email using the configured transporter
      await mailTransporter.sendMail(mailOptions);

    } catch (error) {
      console.error('Failed to forward email:', error);
      throw error;
    }
  }

  async storeEmail(emailData, userId = null) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Store email in received_emails table
      const [result] = await connection.query(
        `INSERT INTO received_emails (
          id, temp_email_id, from_email, from_name, subject, 
          body_html, body_text, received_at, user_id
        ) VALUES (UUID(), ?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [
          emailData.tempEmailId,
          emailData.from,
          emailData.fromName,
          emailData.subject,
          emailData.html,
          emailData.text,
          userId
        ]
      );

      // Store attachments if any
      if (emailData.attachments?.length) {
        for (const attachment of emailData.attachments) {
          await connection.query(
            `INSERT INTO email_attachments (
              id, email_id, filename, content_type, size, content
            ) VALUES (UUID(), ?, ?, ?, ?, ?)`,
            [
              result.insertId,
              attachment.filename,
              attachment.contentType,
              attachment.size,
              attachment.content
            ]
          );
        }
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
