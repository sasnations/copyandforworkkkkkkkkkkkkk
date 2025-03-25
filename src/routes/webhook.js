import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import { simpleParser } from 'mailparser';
import iconv from 'iconv-lite';
import { EmailRouter } from '../services/emailRouter.js';

// Email parsing helper functions
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
  if (emailFrom.includes('bounce') || emailFrom.includes('mailer-daemon')) return 'System Notification';
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
    .replace(/"/g, '"')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
  cleanedSubject = cleanedSubject.replace(/\s+/g, ' ').trim();
  if (cleanedSubject.length > 100) cleanedSubject = cleanedSubject.substring(0, 97) + '...';
  return cleanedSubject || 'No Subject';
}

async function parseEmailContent(rawContent) {
  try {
    let decodedContent = rawContent;
    if (typeof rawContent === 'string') {
      try {
        decodedContent = iconv.decode(Buffer.from(rawContent), 'utf8');
      } catch (err) {
        decodedContent = iconv.decode(Buffer.from(rawContent), 'latin1');
      }
    }
    const parsed = await simpleParser(decodedContent);
    return {
      headers: parsed.headers,
      subject: parsed.subject,
      from: parsed.from?.text || '',
      to: parsed.to?.text || '',
      text: parsed.text,
      html: parsed.html,
      attachments: parsed.attachments.map(attachment => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        content: attachment.content.toString('base64')
      }))
    };
  } catch (error) {
    console.error('Error parsing email:', error);
    return {
      headers: {},
      subject: 'Unable to parse subject',
      from: '',
      to: '',
      text: rawContent,
      html: '',
      attachments: []
    };
  }
}

const router = express.Router();
const emailRouter = new EmailRouter();

// Note: Ensure the following middleware is applied at the app level:
// app.use(express.urlencoded({ extended: true }));
// app.use(express.json());

router.post('/email/incoming', async (req, res) => {
  try {
    const contentType = req.headers['content-type'];

    if (contentType && contentType.includes('application/x-www-form-urlencoded')) {
      // Existing logic for urlencoded requests
      console.log('Received webhook request (urlencoded)');
      console.log('Content-Type:', contentType);

      const rawContent = req.body.body;
      const parsedEmail = await parseEmailContent(rawContent);

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

      const cleanRecipient = emailData.recipient.includes('<') ?
        emailData.recipient.match(/<(.+)>/)[1] :
        emailData.recipient.trim();

      const [tempEmails] = await pool.query(
        'SELECT id FROM temp_emails WHERE email = ? AND expires_at > NOW()',
        [cleanRecipient]
      );

      if (tempEmails.length === 0) {
        console.error('No active temporary email found for recipient:', cleanRecipient);
        return res.status(404).json({
          error: 'Recipient not found',
          message: 'No active temporary email found for the specified recipient'
        });
      }

      const tempEmailId = tempEmails[0].id;
      const emailId = uuidv4();

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
            attachment.content
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
    } else if (contentType && contentType.includes('application/json')) {
      // New logic for JSON requests
      console.log('Received webhook request (JSON)');
      console.log('Content-Type:', contentType);

      const emailData = req.body;
      const recipient = emailData.recipient || emailData.to;
      if (!recipient) {
        throw new Error('No recipient specified');
      }

      await emailRouter.handleIncomingEmail(recipient, emailData);
      res.json({ status: 'success', message: 'Email processed successfully' });
    } else {
      res.status(400).json({ error: 'Unsupported content type' });
    }
  } catch (error) {
    console.error('Failed to process incoming email:', error);
    res.status(500).json({ error: 'Failed to process email' });
  }
});

export default router;
