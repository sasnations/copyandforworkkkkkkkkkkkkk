import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import { simpleParser } from 'mailparser';
import { mailTransporter } from '../index.js';
import iconv from 'iconv-lite';

const router = express.Router();

router.post('/email/incoming', express.urlencoded({ extended: true }), async (req, res) => {
  console.log('Received webhook request');
  console.log('Content-Type:', req.headers['content-type']);
  
  try {
    const rawContent = req.body.body;
    const parsedEmail = await simpleParser(rawContent);
    
    // Extract and clean email data
    const senderEmail = extractSenderEmail(req.body.sender || parsedEmail.from);
    const senderName = extractSenderName(req.body.sender || parsedEmail.from);
    const cleanedSubject = cleanSubject(parsedEmail.subject);
    
    const emailData = {
      recipient: req.body.recipient || parsedEmail.to,
      sender: senderEmail,
      senderName: senderName,
      subject: cleanedSubject,
      body_html: parsedEmail.html || '',
      body_text: parsedEmail.text || '',
      attachments: parsedEmail.attachments || []
    };

    // Clean the recipient email address
    const cleanRecipient = emailData.recipient.includes('<') ? 
      emailData.recipient.match(/<(.+)>/)[1] : 
      emailData.recipient.trim();

    // Check if this is a premium email
    const [premiumEmails] = await pool.query(
      'SELECT id, forward_to FROM premium_emails WHERE email = ? AND expires_at > NOW()',
      [cleanRecipient]
    );

    if (premiumEmails.length > 0) {
      const premiumEmail = premiumEmails[0];
      const emailId = uuidv4();

      // Start a transaction
      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        // Store the email
        await connection.query(`
          INSERT INTO premium_received_emails (
            id, 
            premium_email_id,
            from_email,
            from_name,
            subject, 
            body_html,
            body_text,
            received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          emailId,
          premiumEmail.id,
          emailData.sender,
          emailData.senderName,
          emailData.subject,
          emailData.body_html,
          emailData.body_text
        ]);

        // Store attachments if any
        for (const attachment of emailData.attachments) {
          const attachmentId = uuidv4();
          await connection.query(`
            INSERT INTO premium_email_attachments (
              id,
              email_id,
              filename,
              content_type,
              size,
              content,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, NOW())
          `, [
            attachmentId,
            emailId,
            attachment.filename,
            attachment.contentType,
            attachment.size,
            attachment.content.toString('base64')
          ]);
        }

        // Forward email if forwarding is enabled
        if (premiumEmail.forward_to) {
          try {
            await mailTransporter.sendMail({
              from: `"${emailData.senderName}" <${cleanRecipient}>`,
              to: premiumEmail.forward_to,
              subject: `[Forwarded] ${emailData.subject}`,
              html: `
                <div style="border-left: 2px solid #4A90E2; padding-left: 10px; margin: 10px 0;">
                  <p><strong>Original From:</strong> ${emailData.sender}</p>
                  <p><strong>Original To:</strong> ${cleanRecipient}</p>
                  <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
                </div>
                <div style="margin-top: 20px;">
                  ${emailData.body_html || emailData.body_text}
                </div>
              `,
              attachments: emailData.attachments.map(att => ({
                filename: att.filename,
                content: att.content
              }))
            });

            // Log successful forward
            await connection.query(`
              INSERT INTO premium_analytics (
                id, user_id, event_type, event_data
              ) VALUES (?, ?, 'email_forwarded', ?)`,
              [
                uuidv4(),
                premiumEmail.user_id,
                JSON.stringify({
                  from: emailData.sender,
                  to: premiumEmail.forward_to,
                  subject: emailData.subject
                })
              ]
            );
          } catch (error) {
            console.error('Failed to forward email:', error);
            // Continue processing even if forwarding fails
          }
        }

        await connection.commit();
        console.log('Email and attachments stored successfully');

        res.status(200).json({
          message: 'Email received and stored successfully',
          emailId,
          recipient: cleanRecipient
        });
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    } else {
      // Check regular temporary emails
      const [tempEmails] = await pool.query(
        'SELECT id FROM temp_emails WHERE email = ? AND expires_at > NOW()',
        [cleanRecipient]
      );

      if (tempEmails.length === 0) {
        console.error('No active email found for recipient:', cleanRecipient);
        return res.status(404).json({ 
          error: 'Recipient not found',
          message: 'No active email found for the specified recipient'
        });
      }

      const tempEmailId = tempEmails[0].id;
      const emailId = uuidv4();

      // Store the regular email
      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        await connection.query(`
          INSERT INTO received_emails (
            id, 
            temp_email_id, 
            from_email,
            from_name,
            subject, 
            body_html,
            body_text,
            received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          emailId,
          tempEmailId,
          emailData.sender,
          emailData.senderName,
          emailData.subject,
          emailData.body_html,
          emailData.body_text
        ]);

        // Store attachments
        for (const attachment of emailData.attachments) {
          const attachmentId = uuidv4();
          await connection.query(`
            INSERT INTO email_attachments (
              id,
              email_id,
              filename,
              content_type,
              size,
              content,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, NOW())
          `, [
            attachmentId,
            emailId,
            attachment.filename,
            attachment.contentType,
            attachment.size,
            attachment.content.toString('base64')
          ]);
        }

        await connection.commit();
        console.log('Email and attachments stored successfully');

        res.status(200).json({
          message: 'Email received and stored successfully',
          emailId,
          recipient: cleanRecipient
        });
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to process the incoming email'
    });
  }
});

// Helper functions
function extractSenderEmail(emailFrom) {
  if (!emailFrom) return '';
  const angleEmailMatch = emailFrom.match(/<(.+?)>/);
  if (angleEmailMatch) return angleEmailMatch[1];
  const simpleEmailMatch = emailFrom.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/);
  if (simpleEmailMatch) return simpleEmailMatch[1];
  if (emailFrom.includes('bounce') || emailFrom.includes('mailer-daemon')) {
    const bounceMatch = emailFrom.match(/original-sender:\s*([^\s]+@[^\s]+)/i);
    if (bounceMatch) return bounceMatch[1];
    return 'system@bounced.mail';
  }
  return emailFrom;
}

function extractSenderName(emailFrom) {
  if (!emailFrom) return 'Unknown Sender';
  const nameMatch = emailFrom.match(/^"?([^"<]+)"?\s*</);
  if (nameMatch) return nameMatch[1].trim();
  if (emailFrom.includes('bounce') || emailFrom.includes('mailer-daemon')) {
    return 'System Notification';
  }
  const email = extractSenderEmail(emailFrom);
  return email.split('@')[0] || 'Unknown Sender';
}

function cleanSubject(subject) {
  if (!subject) return 'No Subject';
  const prefixesToRemove = [
    /^re:\s*/i,
    /^fwd:\s*/i,
    /^fw:\s*/i,
    /^\[SPAM\]\s*/i,
    /^bounce:/i,
    /^auto.*reply:\s*/i,
    /^automatic\s+reply:\s*/i
  ];
  let cleanedSubject = subject;
  prefixesToRemove.forEach(prefix => {
    cleanedSubject = cleanedSubject.replace(prefix, '');
  });
  cleanedSubject = cleanedSubject
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
  cleanedSubject = cleanedSubject.replace(/\s+/g, ' ').trim();
  if (cleanedSubject.length > 100) {
    cleanedSubject = cleanedSubject.substring(0, 97) + '...';
  }
  return cleanedSubject || 'No Subject';
}

export default router;
