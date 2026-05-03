/**
 * WhatsApp Configuration Module
 * 
 * This module manages WhatsApp delivery settings for the Dhanam Chits application.
 * It supports both Meta (WhatsApp Business API) and Twilio as delivery providers,
 * with automatic fallback between providers if needed.
 * 
 * Configuration is loaded from environment variables at runtime.
 */

require('dotenv').config();

module.exports = {
  /**
   * Provider Configuration
   * 
   * WHATSAPP_PROVIDER: Choose which provider to use
   *   - 'meta': Use Meta WhatsApp Business API
   *   - 'twilio': Use Twilio WhatsApp API
   *   - 'auto': Automatically detect the best provider based on available credentials
   * 
   * WHATSAPP_PROVIDER_ORDER: Fallback order when auto-detecting
   *   Example: 'meta,twilio' - try Meta first, fallback to Twilio if Meta fails
   */
  provider: {
    mode: process.env.WHATSAPP_PROVIDER || 'meta', // Default to Meta
    fallbackOrder: (process.env.WHATSAPP_PROVIDER_ORDER || 'meta,twilio')
      .split(',')
      .map(p => p.trim().toLowerCase())
      .filter(p => ['meta', 'twilio'].includes(p))
  },

  /**
   * Meta WhatsApp Business API Configuration
   * 
   * Get credentials from: https://developers.facebook.com/
   * 1. Create a WhatsApp Business Account
   * 2. Go to your app's WhatsApp section
   * 3. Navigate to "API Setup" under Configuration
   * 4. Find "Phone number ID" and "Access Token"
   * 
   * The Phone number ID is the unique identifier for your WhatsApp sender number.
   * The Access Token is used to authenticate API requests.
   */
  meta: {
    phoneNumberId: process.env.WHATSAPP_META_PHONE_NUMBER_ID || '',
    accessToken: process.env.WHATSAPP_META_ACCESS_TOKEN || '',
    apiVersion: '18.0', // Latest stable version
    apiBaseUrl: 'https://graph.instagram.com',
    
    /**
     * Validates Meta configuration
     * @returns {Object} { isValid: boolean, errors: string[] }
     */
    validate: function() {
      const errors = [];
      if (!this.phoneNumberId) {
        errors.push('WHATSAPP_META_PHONE_NUMBER_ID is not set');
      }
      if (!this.accessToken) {
        errors.push('WHATSAPP_META_ACCESS_TOKEN is not set');
      }
      return {
        isValid: errors.length === 0,
        errors
      };
    },

    /**
     * Gets the API endpoint URL for sending messages
     * @returns {string} The full API endpoint URL
     */
    getMessageEndpoint: function() {
      return `${this.apiBaseUrl}/v${this.apiVersion}/${this.phoneNumberId}/messages`;
    },

    /**
     * Gets authorization headers for API requests
     * @returns {Object} Headers object with authorization
     */
    getHeaders: function() {
      return {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      };
    }
  },

  /**
   * Twilio Configuration
   * 
   * Get credentials from: https://console.twilio.com/
   * 1. Sign up or log in to Twilio Console
   * 2. Find your Account SID and Auth Token on the home page
   * 3. Navigate to Messaging > Send WhatsApp messages
   * 4. Use an approved WhatsApp sender number (e.g., +1234567890)
   * 
   * For template-based messages, set the Content Template SIDs:
   * - TWILIO_CONTENT_SID_STANDARD: For standard reminder messages
   * - TWILIO_CONTENT_SID_URGENT: For urgent/escalation messages
   * - TWILIO_CONTENT_SID_APPOINTMENT: For appointment reminders
   * - etc.
   */
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || '',
    apiBaseUrl: 'https://api.twilio.com/2010-04-01',
    
    /**
     * Content Template SIDs for pre-approved message templates
     * When using templates, messages are sent faster and have higher delivery rates
     */
    contentSids: {
      standard: process.env.TWILIO_CONTENT_SID_STANDARD || '',
      urgent: process.env.TWILIO_CONTENT_SID_URGENT || '',
      appointment: process.env.TWILIO_CONTENT_SID_APPOINTMENT || '',
      order: process.env.TWILIO_CONTENT_SID_ORDER || '',
      verification: process.env.TWILIO_CONTENT_SID_VERIFICATION || '',
      default: process.env.TWILIO_CONTENT_SID_DEFAULT || ''
    },

    /**
     * Validates Twilio configuration
     * @returns {Object} { isValid: boolean, errors: string[] }
     */
    validate: function() {
      const errors = [];
      if (!this.accountSid) {
        errors.push('TWILIO_ACCOUNT_SID is not set');
      }
      if (!this.authToken) {
        errors.push('TWILIO_AUTH_TOKEN is not set');
      }
      if (!this.whatsappFrom) {
        errors.push('TWILIO_WHATSAPP_FROM is not set');
      }
      return {
        isValid: errors.length === 0,
        errors
      };
    },

    /**
     * Gets the API endpoint URL for sending messages
     * @returns {string} The full API endpoint URL
     */
    getMessageEndpoint: function() {
      return `${this.apiBaseUrl}/Accounts/${this.accountSid}/Messages.json`;
    },

    /**
     * Gets Basic Auth token for Twilio API
     * @returns {string} Base64 encoded credentials
     */
    getAuthToken: function() {
      const credentials = `${this.accountSid}:${this.authToken}`;
      return Buffer.from(credentials).toString('base64');
    }
  },

  /**
   * General WhatsApp configuration
   */
  general: {
    /**
     * Maximum characters for a single WhatsApp message
     * Meta limit is 4096 characters
     */
    maxMessageLength: 4096,

    /**
     * Retry configuration
     */
    retry: {
      maxAttempts: 3,
      delayMs: 1000 // Delay between retry attempts in milliseconds
    },

    /**
     * Message timeout in milliseconds
     */
    timeoutMs: 30000
  },

  /**
   * Validates the complete WhatsApp configuration
   * @returns {Object} { isValid: boolean, errors: string[], warnings: string[] }
   */
  validate: function() {
    const errors = [];
    const warnings = [];

    const metaValidation = this.meta.validate();
    const twilioValidation = this.twilio.validate();

    if (!metaValidation.isValid && !twilioValidation.isValid) {
      errors.push('No WhatsApp provider is properly configured');
      errors.push(...metaValidation.errors);
      errors.push(...twilioValidation.errors);
    }

    // Warnings for optional providers
    if (!metaValidation.isValid && this.provider.fallbackOrder.includes('meta')) {
      warnings.push('Meta is in fallback order but not configured');
    }
    if (!twilioValidation.isValid && this.provider.fallbackOrder.includes('twilio')) {
      warnings.push('Twilio is in fallback order but not configured');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      providers: {
        meta: metaValidation.isValid,
        twilio: twilioValidation.isValid
      }
    };
  },

  /**
   * Gets summary of current configuration
   * @returns {Object} Configuration summary
   */
  getSummary: function() {
    const validation = this.validate();
    return {
      provider: this.provider.mode,
      fallbackOrder: this.provider.fallbackOrder.join(' → '),
      metaConfigured: validation.providers.meta,
      twilioConfigured: validation.providers.twilio,
      isValid: validation.isValid,
      errors: validation.errors,
      warnings: validation.warnings
    };
  }
};

// Export validation function for use in server startup
if (require.main === module) {
  const config = module.exports;
  const validation = config.validate();
  
  console.log('WhatsApp Configuration Status:');
  console.log(JSON.stringify(config.getSummary(), null, 2));
  
  if (!validation.isValid) {
    console.error('Configuration Errors:');
    validation.errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }
}
