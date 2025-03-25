import { pool } from '../db/init.js';
import { DnsVerifier } from './dnsVerifier.js';

export class DomainMonitor {
  constructor() {
    this.dnsVerifier = new DnsVerifier();
  }

  async monitorDomains() {
    const connection = await pool.getConnection();
    try {
      // Get all verified custom domains
      const [domains] = await connection.query(
        'SELECT * FROM user_domains WHERE is_verified = 1'
      );

      for (const domain of domains) {
        try {
          // Check DNS records
          const verificationResult = await this.dnsVerifier.verifyAll(domain.domain);
          
          if (!verificationResult.success) {
            // Domain verification failed - update status
            await connection.query(
              'UPDATE user_domains SET status = ? WHERE id = ?',
              ['inactive', domain.id]
            );

            // Log the issue
            await connection.query(
              `INSERT INTO domain_issues (
                id, domain_id, issue_type, details, created_at
              ) VALUES (UUID(), ?, ?, ?, NOW())`,
              [
                domain.id,
                'DNS_VERIFICATION_FAILED',
                JSON.stringify(verificationResult.results)
              ]
            );
          } else if (domain.status === 'inactive') {
            // Domain is now valid - reactivate
            await connection.query(
              'UPDATE user_domains SET status = ? WHERE id = ?',
              ['active', domain.id]
            );
          }
        } catch (error) {
          console.error(`Failed to monitor domain ${domain.domain}:`, error);
        }
      }
    } finally {
      connection.release();
    }
  }

  async checkDomainHealth(domainId) {
    const connection = await pool.getConnection();
    try {
      // Get domain details
      const [domain] = await connection.query(
        'SELECT * FROM user_domains WHERE id = ?',
        [domainId]
      );

      if (domain.length === 0) {
        throw new Error('Domain not found');
      }

      // Check DNS records
      const verificationResult = await this.dnsVerifier.verifyAll(domain[0].domain);

      // Get recent issues
      const [issues] = await connection.query(
        `SELECT * FROM domain_issues 
         WHERE domain_id = ? 
         ORDER BY created_at DESC 
         LIMIT 10`,
        [domainId]
      );

      // Get email statistics
      const [stats] = await connection.query(
        `SELECT 
           COUNT(*) as total_emails,
           COUNT(CASE WHEN received_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 END) as last_24h
         FROM received_emails 
         WHERE domain_id = ?`,
        [domainId]
      );

      return {
        domain: domain[0],
        dnsStatus: verificationResult,
        recentIssues: issues,
        statistics: stats[0]
      };
    } finally {
      connection.release();
    }
  }

  startMonitoring(interval = 1800000) { // Default 30 minutes
    setInterval(() => this.monitorDomains(), interval);
  }
}
