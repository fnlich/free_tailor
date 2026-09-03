const nodemailer = require('nodemailer');
const { getGeneratedFilePath } = require('../utils/generatedPath');

const ALLOWED_FROM_EMAILS = [
  'dominic.moorman98@gmail.com',
  'xihua.yang.dev@gmail.com',
  'william.zhuang795@gmail.com',
  'dkimura216@gmail.com',
];

const EMAIL_SEND_INTERVAL_MS = 5 * 60 * 1000;

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function parseRecipientEmails(values) {
  const uniqueRecipients = new Set();
  const invalidRecipients = new Set();

  for (const value of values) {
    const normalizedValue = value.trim().toLowerCase();
    if (!normalizedValue) continue;

    if (!isValidEmailAddress(normalizedValue)) {
      invalidRecipients.add(normalizedValue);
      continue;
    }

    uniqueRecipients.add(normalizedValue);
  }

  if (invalidRecipients.size > 0) {
    throw new Error(`Invalid recipient email(s): ${Array.from(invalidRecipients).join(', ')}`);
  }

  const recipients = Array.from(uniqueRecipients);
  if (recipients.length === 0) {
    throw new Error('At least one valid recipient email is required.');
  }

  return recipients;
}

function assertAllowedFromEmail(value) {
  const normalizedValue = value.trim().toLowerCase();
  const matched = ALLOWED_FROM_EMAILS.find((email) => email === normalizedValue);

  if (!matched) {
    throw new Error('From Email must be one of the allowed sender accounts.');
  }

  return matched;
}

function getSenderPasswordEnvName(fromEmail) {
  const normalizedSegment = fromEmail
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `EMAIL_APP_PASSWORD_${normalizedSegment}`;
}

function resolveEmailSenderConfig(fromEmail) {
  const user = assertAllowedFromEmail(fromEmail);
  const passwordEnvName = getSenderPasswordEnvName(user);
  const pass = process.env[passwordEnvName]?.trim();

  if (!pass) {
    throw new Error(`Missing email credential for ${user}. Set ${passwordEnvName} in the backend environment.`);
  }

  return { user, pass };
}

async function resolveEmailAttachments(attachmentFilenames) {
  const uniqueFilenames = [
    ...new Set((attachmentFilenames ?? []).map((value) => value.trim()).filter(Boolean)),
  ];
  const attachments = [];

  for (const filename of uniqueFilenames) {
    const resolvedPath = await getGeneratedFilePath(filename);
    if (!resolvedPath) {
      throw new Error(`Attachment not found: ${filename}`);
    }

    attachments.push({ filename, path: resolvedPath });
  }

  return attachments;
}

function getSmtpConfig() {
  const host = process.env.EMAIL_SMTP_HOST?.trim() || 'smtp.gmail.com';
  const port = Number.parseInt(process.env.EMAIL_SMTP_PORT?.trim() || '465', 10);
  const secureValue = process.env.EMAIL_SMTP_SECURE?.trim();
  const secure = typeof secureValue === 'string' && secureValue.length > 0
    ? secureValue.toLowerCase() === 'true'
    : port === 465;

  if (!Number.isFinite(port)) {
    throw new Error('EMAIL_SMTP_PORT must be a valid number when configured.');
  }

  return { host, port, secure };
}

async function sendProjectEmail(input) {
  const { fromEmail, toEmail, subject, content, attachmentFilenames } = input;
  const recipient = toEmail.trim();
  const body = content.trim();

  if (!isValidEmailAddress(recipient)) {
    throw new Error('A valid recipient email is required.');
  }

  if (!body) {
    throw new Error('Email content is required.');
  }

  const auth = resolveEmailSenderConfig(fromEmail);
  const smtpConfig = getSmtpConfig();
  const attachments = await resolveEmailAttachments(attachmentFilenames);
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth,
  });

  const info = await transporter.sendMail({
    from: auth.user,
    to: recipient,
    replyTo: auth.user,
    subject: subject?.trim() || 'Tailored Resume Builder Message',
    text: body,
    attachments,
  });

  return {
    messageId: info.messageId,
    attachments: attachments.length,
  };
}

const queuedEmailJobs = new Map();

async function processQueuedEmailJob(jobId) {
  const job = queuedEmailJobs.get(jobId);
  if (!job) return;

  const nextRecipient = job.recipients[job.sentCount];
  if (!nextRecipient) {
    queuedEmailJobs.delete(jobId);
    return;
  }

  try {
    await sendProjectEmail({
      fromEmail: job.fromEmail,
      toEmail: nextRecipient,
      subject: job.subject,
      content: job.content,
      attachmentFilenames: job.attachmentFilenames,
    });
    job.sentCount += 1;
  } catch (error) {
    job.sentCount += 1;
    console.error(`Failed to send queued email to ${nextRecipient}:`, error);
  }

  if (job.sentCount >= job.recipients.length) {
    queuedEmailJobs.delete(jobId);
    return;
  }

  setTimeout(() => {
    void processQueuedEmailJob(jobId);
  }, EMAIL_SEND_INTERVAL_MS);
}

async function queueProjectEmails(input) {
  const body = input.content.trim();
  if (!body) {
    throw new Error('Email content is required.');
  }

  resolveEmailSenderConfig(input.fromEmail);
  const recipients = parseRecipientEmails(input.toEmails);
  await resolveEmailAttachments(input.attachmentFilenames);

  const jobId = `email-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const job = {
    id: jobId,
    fromEmail: input.fromEmail,
    recipients,
    subject: input.subject,
    content: body,
    attachmentFilenames: input.attachmentFilenames,
    sentCount: 0,
  };

  queuedEmailJobs.set(jobId, job);
  void processQueuedEmailJob(jobId);

  return {
    jobId,
    queuedRecipients: recipients.length,
    intervalMinutes: EMAIL_SEND_INTERVAL_MS / (60 * 1000),
  };
}

module.exports = {
  ALLOWED_FROM_EMAILS,
  EMAIL_SEND_INTERVAL_MS,
  isValidEmailAddress,
  parseRecipientEmails,
  assertAllowedFromEmail,
  getSenderPasswordEnvName,
  resolveEmailSenderConfig,
  sendProjectEmail,
  queueProjectEmails,
};
