import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { neon } from '@neondatabase/serverless';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);

if (!process.env.CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY || !process.env.DATABASE_URL) {
  throw new Error('CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, and DATABASE_URL are required.');
}

const sql = neon(process.env.DATABASE_URL);
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const analystUserIds = new Set((process.env.ANALYST_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const analystRoleCache = new Set();
const emailConfig = {
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.EMAIL_FROM,
  analyst: process.env.ANALYST_NOTIFICATION_EMAIL,
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.(presentationml\.presentation|wordprocessingml\.document))$/.test(file.mimetype)),
});

app.use(express.json({ limit: '32kb' }));
app.get('/', async (_request, response, next) => {
  try {
    const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
    response.type('html').send(html.replaceAll('__CLERK_PUBLISHABLE_KEY__', process.env.CLERK_PUBLISHABLE_KEY));
  } catch (error) {
    next(error);
  }
});
app.use(express.static(__dirname));

async function requireAuth(request, response, next) {
  const authorization = request.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return response.status(401).json({ error: 'Sign in to submit your discovery brief.' });
  }

  try {
    request.auth = await verifyToken(authorization.slice(7), {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    return next();
  } catch {
    return response.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
}

async function isAnalyst(auth) {
  const metadata = auth.public_metadata || auth.publicMetadata || auth.metadata || auth.sessionClaims?.metadata || {};
  if (analystUserIds.has(auth.sub) || metadata.role === 'analyst') {
    analystRoleCache.add(auth.sub);
    return true;
  }
  if (analystRoleCache.has(auth.sub)) return true;

  try {
    const user = await clerkClient.users.getUser(auth.sub);
    const hasAnalystRole = user.publicMetadata?.role === 'analyst' || user.privateMetadata?.role === 'analyst';
    if (hasAnalystRole) analystRoleCache.add(auth.sub);
    return hasAnalystRole;
  } catch (error) {
    if (analystRoleCache.has(auth.sub)) return true;
    console.warn('Analyst role lookup failed', error?.message || error);
    return false;
  }
}

async function sendEmail(to, subject, html) {
  if (!emailConfig.apiKey || !emailConfig.from || !to) {
    console.warn('Email notification skipped: configure RESEND_API_KEY, EMAIL_FROM, and recipient settings.');
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${emailConfig.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: emailConfig.from, to: [to], subject, html }),
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

app.get('/api/me', requireAuth, async (request, response) => {
  response.json({ isAnalyst: await isAnalyst(request.auth) });
});

app.get('/api/discovery-status', requireAuth, async (request, response) => {
  try {
    const [status] = await sql`
      SELECT b.id, b.review_status, q.id AS questionnaire_id, q.status AS questionnaire_status
      FROM discovery_briefs b
      LEFT JOIN LATERAL (
        SELECT id, status
        FROM questionnaires
        WHERE brief_id = b.id
        ORDER BY prepared_at DESC
        LIMIT 1
      ) q ON true
      WHERE b.clerk_user_id = ${request.auth.sub}
      ORDER BY b.created_at DESC
      LIMIT 1
    `;
    response.json({ status: status || null });
  } catch (error) {
    console.error('Failed to load discovery status', error);
    response.status(500).json({ error: 'We could not load your discovery status.' });
  }
});

app.get('/api/analyst/briefs', requireAuth, async (request, response) => {
  if (!(await isAnalyst(request.auth))) {
    return response.status(403).json({ error: 'Analyst access required.' });
  }

  try {
    const briefs = await sql`
      SELECT b.id, b.clerk_user_id, b.user_name, b.user_email, b.company_name, b.context, b.stage, b.file_name, b.file_size, b.file_mime_type, b.review_status, b.created_at,
        q.id AS questionnaire_id, q.title AS questionnaire_title, q.status AS questionnaire_status, q.questions AS questionnaire_questions, q.answers AS questionnaire_answers
      FROM discovery_briefs b
      LEFT JOIN LATERAL (
        SELECT id, title, status, questions, answers
        FROM questionnaires
        WHERE brief_id = b.id
        ORDER BY CASE status WHEN 'submitted' THEN 1 WHEN 'prepared' THEN 2 ELSE 3 END, prepared_at DESC
        LIMIT 1
      ) q ON true
      ORDER BY b.created_at DESC
    `;
    return response.json({ briefs });
  } catch (error) {
    console.error('Failed to load analyst briefs', error);
    return response.status(500).json({ error: 'We could not load discovery briefs.' });
  }
});

app.get('/api/analyst/briefs/:id/file', requireAuth, async (request, response) => {
  if (!(await isAnalyst(request.auth))) return response.status(403).json({ error: 'Analyst access required.' });
  const [file] = await sql`
    SELECT file_name, file_mime_type, file_data
    FROM discovery_briefs
    WHERE id = ${request.params.id} AND file_data IS NOT NULL
  `;
  if (!file) return response.status(404).json({ error: 'File not found.' });
  response.type(file.file_mime_type).set('Content-Disposition', `inline; filename="${file.file_name.replaceAll('"', '')}"`).send(file.file_data);
});

app.post('/api/analyst/questionnaires', requireAuth, async (request, response) => {
  if (!(await isAnalyst(request.auth))) return response.status(403).json({ error: 'Analyst access required.' });
  const { briefId, title, questions, status = 'prepared' } = request.body;
  if (!Number.isInteger(Number(briefId)) || typeof title !== 'string' || !title.trim() || !Array.isArray(questions) || questions.length === 0 || questions.length > 30) {
    return response.status(400).json({ error: 'Add a title and at least one question.' });
  }
  if (!['draft', 'prepared'].includes(status)) return response.status(400).json({ error: 'Invalid questionnaire status.' });
  const cleanQuestions = questions.map((question) => ({
    id: String(question.id || crypto.randomUUID()),
    prompt: String(question.prompt || '').trim(),
    type: ['textarea', 'multiple-choice', 'multi-select'].includes(question.type) ? question.type : 'text',
    options: Array.isArray(question.options) ? question.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 20) : [],
    required: question.required !== false,
  }));
  if (cleanQuestions.some((question) => !question.prompt || question.prompt.length > 500 || (['multiple-choice', 'multi-select'].includes(question.type) && question.options.length < 2))) {
    return response.status(400).json({ error: 'Each question must contain up to 500 characters.' });
  }

  try {
    const [brief] = await sql`SELECT clerk_user_id, user_email, user_name FROM discovery_briefs WHERE id = ${briefId}`;
    if (!brief) return response.status(404).json({ error: 'Discovery brief not found.' });
    const [questionnaire] = await sql`
      INSERT INTO questionnaires (brief_id, clerk_user_id, title, questions, status)
      VALUES (${briefId}, ${brief.clerk_user_id}, ${title.trim()}, ${JSON.stringify(cleanQuestions)}::jsonb, ${status})
      RETURNING id, title, status, prepared_at
    `;
    if (status === 'prepared') {
      await sendEmail(brief.user_email, 'Your JCiTL follow-up questionnaire is ready', `<p>Hello ${brief.user_name || 'there'},</p><p>Your follow-up questionnaire is ready. Sign in to JCiTL Discovery Studio to complete it.</p>`);
    }
    return response.status(201).json({ questionnaire });
  } catch (error) {
    console.error('Failed to prepare questionnaire', error);
    return response.status(500).json({ error: 'Questionnaire saved, but the notification could not be sent.' });
  }
});

app.get('/api/questionnaires/current', requireAuth, async (request, response) => {
  const questionnaires = await sql`
    SELECT id, brief_id, title, questions, answers, status, prepared_at, submitted_at
    FROM questionnaires
    WHERE clerk_user_id = ${request.auth.sub}
    ORDER BY prepared_at DESC
  `;
  response.json({ questionnaires });
});

app.post('/api/questionnaires/:id/submit', requireAuth, async (request, response) => {
  const { answers } = request.body;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return response.status(400).json({ error: 'Provide questionnaire answers.' });
  try {
    const [questionnaire] = await sql`
      SELECT id, brief_id, questions FROM questionnaires
      WHERE id = ${request.params.id} AND clerk_user_id = ${request.auth.sub}
    `;
    if (!questionnaire) return response.status(404).json({ error: 'Questionnaire not found.' });
    for (const question of questionnaire.questions) {
      const answer = answers[question.id];
      if (question.required && (!answer || (Array.isArray(answer) && answer.length === 0))) return response.status(400).json({ error: 'Please answer all required questions.' });
      if (['multiple-choice', 'multi-select'].includes(question.type)) {
        const values = Array.isArray(answer) ? answer : [answer];
        if (values.some((value) => !question.options.includes(value))) return response.status(400).json({ error: 'One or more selected options are invalid.' });
      }
    }
    const [submitted] = await sql`
      UPDATE questionnaires SET answers = ${JSON.stringify(answers)}::jsonb, status = 'submitted', submitted_at = now()
      WHERE id = ${request.params.id} RETURNING id, brief_id
    `;
    await sendEmail(emailConfig.analyst, 'A JCiTL questionnaire has been submitted', `<p>A follow-up questionnaire for discovery brief #${submitted.brief_id} has been submitted and is ready for review.</p>`);
    response.json({ message: 'Your answers have been submitted. We will be in touch in due course.' });
  } catch (error) {
    console.error('Failed to submit questionnaire', error);
    response.status(500).json({ error: 'We could not submit your answers.' });
  }
});

app.post('/api/discovery-briefs', requireAuth, upload.single('file'), async (request, response) => {
  const { companyName, context, stage } = request.body;
  const allowedStages = new Set([
    'Idea / pre-revenue',
    'Early traction',
    'Scaling',
    'Exploring next move',
  ]);

  if (typeof companyName !== 'string' || !companyName.trim() || companyName.length > 200 || typeof context !== 'string' || !context.trim() || context.length > 600 || !allowedStages.has(stage)) {
    return response.status(400).json({ error: 'Please complete the required fields.' });
  }

  if (request.file && request.file.originalname.length > 255) {
    return response.status(400).json({ error: 'The selected file must be 20MB or smaller.' });
  }

  try {
    const user = await clerkClient.users.getUser(request.auth.sub);
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
    const userEmail = user.primaryEmailAddress?.emailAddress || null;
    await sql`
      INSERT INTO discovery_briefs (clerk_user_id, user_name, user_email, company_name, context, stage, file_name, file_size, file_mime_type, file_data)
      VALUES (${request.auth.sub}, ${userName}, ${userEmail}, ${companyName.trim()}, ${context.trim()}, ${stage}, ${request.file?.originalname || null}, ${request.file?.size || null}, ${request.file?.mimetype || null}, ${request.file?.buffer || null})
    `;
    return response.status(201).json({ message: 'Your discovery brief has been received and will be evaluated. We will be in touch in due course.' });
  } catch (error) {
    console.error('Failed to save discovery brief', error);
    return response.status(500).json({ error: 'We could not save your brief. Please try again.' });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`JCiTL discovery app listening on http://localhost:${port}`);
  });
}

export default app;
