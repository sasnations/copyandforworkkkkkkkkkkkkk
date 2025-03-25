import dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);
const resolveTxt = promisify(dns.resolveTxt);

export class DnsVerifier {
  async verifyMxRecord(domain, expectedValue) {
    try {
      const records = await resolveMx(domain);
      return records.some(record => 
        record.exchange === expectedValue.split(' ')[1] && 
        record.priority === parseInt(expectedValue.split(' ')[0])
      );
    } catch (error) {
      console.error(`MX verification failed for ${domain}:`, error);
      return false;
    }
  }

  async verifySpfRecord(domain, expectedValue) {
    try {
      const records = await resolveTxt(domain);
      return records.some(record => 
        record.some(txt => txt.includes('v=spf1'))
      );
    } catch (error) {
      console.error(`SPF verification failed for ${domain}:`, error);
      return false;
    }
  }

  async verifyDkimRecord(domain, selector = 'default') {
    try {
      const records = await resolveTxt(`${selector}._domainkey.${domain}`);
      return records.some(record => 
        record.some(txt => txt.includes('v=DKIM1'))
      );
    } catch (error) {
      console.error(`DKIM verification failed for ${domain}:`, error);
      return false;
    }
  }

  async verifyAll(domain) {
    const results = {
      mx: await this.verifyMxRecord(domain, `10 mail.${domain}`),
      spf: await this.verifySpfRecord(domain),
      dkim: await this.verifyDkimRecord(domain)
    };

    return {
      success: Object.values(results).every(result => result),
      results
    };
  }
}
