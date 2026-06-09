const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

/**
 * Standardized alert publisher using AWS SNS.
 * Constructs a structured notification with metadata (service, event type, resource, timestamp, severity, correlation ID).
 * 
 * @param {string} topicArn - The target SNS topic ARN
 * @param {object} alertDetails
 * @param {string} alertDetails.service - The service reporting the alert (e.g. fanvault-commerce-service)
 * @param {string} alertDetails.eventType - The type of event/alert (e.g. OrderProcessingFailure, LowInventoryWarning)
 * @param {string} alertDetails.resource - The affected resource identifier (e.g. Order:12345, Product:abc)
 * @param {string} alertDetails.severity - Severity level (INFO, WARNING, ERROR, CRITICAL)
 * @param {string} alertDetails.correlationId - Correlation/Request ID for tracing
 * @param {object} alertDetails.details - Structured key-value details of the alert
 */
async function publishAlert(topicArn, { service, eventType, resource, severity, correlationId, details }) {
  if (!topicArn) {
    console.warn(`[SNS] Skip publishing alert: topicArn is not configured/empty.`);
    return null;
  }

  const timestamp = new Date().toISOString();
  const severityVal = severity || 'INFO';
  const serviceVal = service || 'fanvault-commerce-service';
  const eventTypeVal = eventType || 'GenericOperationalAlert';
  const resourceVal = resource || 'system';
  const correlationIdVal = correlationId || 'system';
  const detailsVal = details || {};

  const titleEmoji = severityVal === 'ERROR' || severityVal === 'CRITICAL' ? '🚨' : '⚠️';
  const border = '--------------------------------------------------';
  
  let detailsSection = '';
  if (detailsVal && Object.keys(detailsVal).length > 0) {
    detailsSection = `\nAlert Details:\n${border}\n`;
    for (const [key, value] of Object.entries(detailsVal)) {
      const formattedKey = key
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, str => str.toUpperCase());
      
      if (value !== null && typeof value === 'object') {
        detailsSection += `• ${formattedKey}:\n${JSON.stringify(value, null, 2)}\n`;
      } else {
        detailsSection += `• ${formattedKey}: ${value}\n`;
      }
    }
    detailsSection += border;
  }

  const formattedMessage = `${titleEmoji} [${severityVal}] ${eventTypeVal}
${border}
An operational incident was reported.

• Service:        ${serviceVal}
• Event Type:     ${eventTypeVal}
• Resource:       ${resourceVal}
• Severity:       ${severityVal}
• Timestamp:      ${timestamp}
• Correlation ID: ${correlationIdVal}
${detailsSection}
`;

  const subject = `[${severityVal}] ${eventTypeVal} - ${resourceVal}`;

  try {
    const params = {
      TopicArn: topicArn,
      Message: formattedMessage,
      Subject: subject.substring(0, 100) // Subject limit is 100 chars
    };

    const response = await sns.send(new PublishCommand(params));
    console.log(`[SNS] Successfully published alert to ${topicArn}. MessageId: ${response.MessageId}`);
    return response;
  } catch (err) {
    console.error(`[SNS] Failed to publish alert to topic ${topicArn}:`, err.message);
  }
}

module.exports = { publishAlert };
