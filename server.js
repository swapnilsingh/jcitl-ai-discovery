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
const analystRoleCache = new Set();
const LOCK_MINUTES = 10;
const emailConfig = {
  apiKey: process.env.RESEND_API_KEY,
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
  if (analystRoleCache.has(auth.sub)) return true;

  try {
    const [assignedAnalyst] = await sql`
      SELECT clerk_user_id
      FROM analyst_users
      WHERE clerk_user_id = ${auth.sub} AND is_active = true
      LIMIT 1
    `;
    if (assignedAnalyst) {
      analystRoleCache.add(auth.sub);
      return true;
    }
  } catch (error) {
    console.warn('Analyst role database lookup failed', error?.message || error);
  }

  try {
    const metadata = auth.public_metadata || auth.publicMetadata || auth.metadata || auth.sessionClaims?.metadata || {};
    const user = await clerkClient.users.getUser(auth.sub);
    const hasAnalystRole = metadata.role === 'analyst' || user.publicMetadata?.role === 'analyst' || user.privateMetadata?.role === 'analyst';
    if (hasAnalystRole) {
      analystRoleCache.add(auth.sub);
      const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
      const userEmail = user.primaryEmailAddress?.emailAddress || null;
      await sql`
        INSERT INTO analyst_users (clerk_user_id, user_name, user_email, is_active)
        VALUES (${auth.sub}, ${userName}, ${userEmail}, true)
        ON CONFLICT (clerk_user_id)
        DO UPDATE SET user_name = EXCLUDED.user_name, user_email = EXCLUDED.user_email, is_active = true
      `;
    }
    return hasAnalystRole;
  } catch (error) {
    if (analystRoleCache.has(auth.sub)) return true;
    console.warn('Analyst role lookup failed', error?.message || error);
    return false;
  }
}

async function requireAnalyst(request, response, next) {
  if (!(await isAnalyst(request.auth))) return response.status(403).json({ error: 'Analyst access required.' });
  return next();
}

async function sendEmail({ to, from, fallbackFrom, subject, html }) {
  const recipients = Array.isArray(to)
    ? [...new Set(to.map((item) => String(item || '').trim()).filter(Boolean))]
    : [String(to || '').trim()].filter(Boolean);
  const sender = String(from || '').trim();
  const fallbackSender = String(fallbackFrom || '').trim();
  const initialSender = sender || fallbackSender;

  if (!emailConfig.apiKey || !initialSender || recipients.length === 0) {
    console.warn('Email notification skipped: configure RESEND_API_KEY and sender/recipient settings in database records.');
    return;
  }
  const payload = { from: initialSender, to: recipients, subject, html };

  let response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${emailConfig.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok && sender && fallbackSender && fallbackSender !== sender) {
    const fallbackPayload = { ...payload, from: fallbackSender };
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${emailConfig.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fallbackPayload),
    });
  }
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}

app.get('/api/me', requireAuth, async (request, response) => {
  response.json({ isAnalyst: await isAnalyst(request.auth), userId: request.auth.sub });
});

app.get('/api/analyst/users', requireAuth, requireAnalyst, async (_request, response) => {
  try {
    const analysts = await sql`
      SELECT clerk_user_id, user_name, user_email, is_active, assigned_at, assigned_by_clerk_user_id
      FROM analyst_users
      WHERE is_active = true
      ORDER BY assigned_at DESC
    `;
    response.json({ analysts });
  } catch (error) {
    console.error('Failed to load analyst users', error);
    response.status(500).json({ error: 'We could not load analyst users.' });
  }
});

app.post('/api/analyst/users', requireAuth, requireAnalyst, async (request, response) => {
  const { clerkUserId } = request.body;
  if (typeof clerkUserId !== 'string' || !clerkUserId.trim()) return response.status(400).json({ error: 'Provide a valid Clerk user ID.' });

  try {
    const user = await clerkClient.users.getUser(clerkUserId.trim());
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
    const userEmail = user.primaryEmailAddress?.emailAddress || null;
    const [analyst] = await sql`
      INSERT INTO analyst_users (clerk_user_id, user_name, user_email, is_active, assigned_by_clerk_user_id)
      VALUES (${user.id}, ${userName}, ${userEmail}, true, ${request.auth.sub})
      ON CONFLICT (clerk_user_id)
      DO UPDATE SET user_name = EXCLUDED.user_name, user_email = EXCLUDED.user_email, is_active = true, assigned_by_clerk_user_id = EXCLUDED.assigned_by_clerk_user_id
      RETURNING clerk_user_id, user_name, user_email, is_active, assigned_at, assigned_by_clerk_user_id
    `;
    analystRoleCache.add(user.id);
    response.status(201).json({ analyst });
  } catch (error) {
    console.error('Failed to assign analyst user', error);
    response.status(500).json({ error: 'We could not assign this analyst user.' });
  }
});

app.delete('/api/analyst/users/:clerkUserId', requireAuth, requireAnalyst, async (request, response) => {
  const { clerkUserId } = request.params;
  if (!clerkUserId) return response.status(400).json({ error: 'Provide a valid Clerk user ID.' });

  try {
    const [updated] = await sql`
      UPDATE analyst_users
      SET is_active = false
      WHERE clerk_user_id = ${clerkUserId}
      RETURNING clerk_user_id
    `;
    if (!updated) return response.status(404).json({ error: 'Analyst user not found.' });
    analystRoleCache.delete(clerkUserId);
    response.json({ message: 'Analyst access removed.' });
  } catch (error) {
    console.error('Failed to remove analyst user', error);
    response.status(500).json({ error: 'We could not remove this analyst user.' });
  }
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

app.get('/api/analyst/briefs', requireAuth, requireAnalyst, async (_request, response) => {

  try {
    const briefs = await sql`
      SELECT b.id, b.clerk_user_id, b.user_name, b.user_email, b.company_name, b.context, b.stage, b.file_name, b.file_size, b.file_mime_type, b.review_status, b.created_at,
        bl.analyst_clerk_user_id AS lock_owner_user_id, bl.locked_at, bl.expires_at,
        au.user_name AS lock_owner_name, au.user_email AS lock_owner_email,
        q.id AS questionnaire_id, q.title AS questionnaire_title, q.status AS questionnaire_status, q.questions AS questionnaire_questions, q.answers AS questionnaire_answers
      FROM discovery_briefs b
      LEFT JOIN LATERAL (
        SELECT brief_id, analyst_clerk_user_id, locked_at, expires_at
        FROM brief_locks
        WHERE brief_id = b.id AND expires_at > now()
        LIMIT 1
      ) bl ON true
      LEFT JOIN analyst_users au
        ON au.clerk_user_id = bl.analyst_clerk_user_id
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

app.post('/api/analyst/briefs/:id/lock', requireAuth, requireAnalyst, async (request, response) => {
  const briefId = Number(request.params.id);
  if (!Number.isInteger(briefId)) return response.status(400).json({ error: 'Invalid brief ID.' });

  try {
    const [brief] = await sql`SELECT id FROM discovery_briefs WHERE id = ${briefId}`;
    if (!brief) return response.status(404).json({ error: 'Discovery brief not found.' });

    const [lock] = await sql`
      INSERT INTO brief_locks (brief_id, analyst_clerk_user_id, locked_at, expires_at, updated_at)
      VALUES (${briefId}, ${request.auth.sub}, now(), now() + (${LOCK_MINUTES} * interval '1 minute'), now())
      ON CONFLICT (brief_id)
      DO UPDATE SET
        analyst_clerk_user_id = EXCLUDED.analyst_clerk_user_id,
        locked_at = now(),
        expires_at = now() + (${LOCK_MINUTES} * interval '1 minute'),
        updated_at = now()
      WHERE brief_locks.expires_at <= now() OR brief_locks.analyst_clerk_user_id = ${request.auth.sub}
      RETURNING brief_id, analyst_clerk_user_id, locked_at, expires_at
    `;

    if (!lock) {
      const [activeLock] = await sql`
        SELECT bl.analyst_clerk_user_id, au.user_name, au.user_email, bl.expires_at
        FROM brief_locks bl
        LEFT JOIN analyst_users au ON au.clerk_user_id = bl.analyst_clerk_user_id
        WHERE bl.brief_id = ${briefId} AND bl.expires_at > now()
        LIMIT 1
      `;
      return response.status(409).json({
        error: 'This brief is currently locked by another analyst.',
        lock: activeLock || null,
      });
    }

    return response.json({
      lock: {
        briefId: lock.brief_id,
        analystUserId: lock.analyst_clerk_user_id,
        lockedAt: lock.locked_at,
        expiresAt: lock.expires_at,
      },
    });
  } catch (error) {
    console.error('Failed to lock discovery brief', error);
    return response.status(500).json({ error: 'We could not lock this discovery brief.' });
  }
});

app.post('/api/analyst/briefs/:id/lock/heartbeat', requireAuth, requireAnalyst, async (request, response) => {
  const briefId = Number(request.params.id);
  if (!Number.isInteger(briefId)) return response.status(400).json({ error: 'Invalid brief ID.' });

  try {
    const [lock] = await sql`
      UPDATE brief_locks
      SET expires_at = now() + (${LOCK_MINUTES} * interval '1 minute'), updated_at = now()
      WHERE brief_id = ${briefId} AND analyst_clerk_user_id = ${request.auth.sub}
      RETURNING brief_id, expires_at
    `;
    if (!lock) return response.status(409).json({ error: 'Your brief lock is no longer active.' });
    return response.json({ lock: { briefId: lock.brief_id, expiresAt: lock.expires_at } });
  } catch (error) {
    console.error('Failed to refresh discovery brief lock', error);
    return response.status(500).json({ error: 'We could not refresh this brief lock.' });
  }
});

app.delete('/api/analyst/briefs/:id/lock', requireAuth, requireAnalyst, async (request, response) => {
  const briefId = Number(request.params.id);
  if (!Number.isInteger(briefId)) return response.status(400).json({ error: 'Invalid brief ID.' });

  try {
    const [unlocked] = await sql`
      DELETE FROM brief_locks
      WHERE brief_id = ${briefId} AND analyst_clerk_user_id = ${request.auth.sub}
      RETURNING brief_id
    `;
    if (!unlocked) return response.status(404).json({ error: 'No active lock found for this brief.' });
    return response.json({ message: 'Brief unlocked.' });
  } catch (error) {
    console.error('Failed to unlock discovery brief', error);
    return response.status(500).json({ error: 'We could not unlock this discovery brief.' });
  }
});

app.post('/api/analyst/locks/release-all', requireAuth, requireAnalyst, async (request, response) => {
  try {
    const deleted = await sql`
      DELETE FROM brief_locks
      WHERE analyst_clerk_user_id = ${request.auth.sub}
      RETURNING brief_id
    `;
    return response.json({ releasedLocks: deleted.length });
  } catch (error) {
    console.error('Failed to release analyst locks', error);
    return response.status(500).json({ error: 'We could not release analyst locks.' });
  }
});

app.get('/api/analyst/briefs/:id/file', requireAuth, requireAnalyst, async (request, response) => {
  const [file] = await sql`
    SELECT file_name, file_mime_type, file_data
    FROM discovery_briefs
    WHERE id = ${request.params.id} AND file_data IS NOT NULL
  `;
  if (!file) return response.status(404).json({ error: 'File not found.' });
  response.type(file.file_mime_type).set('Content-Disposition', `inline; filename="${file.file_name.replaceAll('"', '')}"`).send(file.file_data);
});

app.post('/api/analyst/questionnaires', requireAuth, requireAnalyst, async (request, response) => {
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
    return response.status(400).json({ error: 'Each question needs a prompt up to 500 characters, and choice questions need at least two options.' });
  }

  try {
    const [brief] = await sql`SELECT clerk_user_id, user_email, user_name FROM discovery_briefs WHERE id = ${briefId}`;
    if (!brief) return response.status(404).json({ error: 'Discovery brief not found.' });
    const [analystUser] = await sql`
      SELECT user_email
      FROM analyst_users
      WHERE clerk_user_id = ${request.auth.sub} AND is_active = true
      LIMIT 1
    `;
    const [activeLock] = await sql`
      SELECT analyst_clerk_user_id
      FROM brief_locks
      WHERE brief_id = ${briefId} AND expires_at > now()
      LIMIT 1
    `;
    if (!activeLock || activeLock.analyst_clerk_user_id !== request.auth.sub) {
      return response.status(409).json({ error: 'Lock this brief before drafting or sending a questionnaire.' });
    }
    const [questionnaire] = await sql`
      INSERT INTO questionnaires (brief_id, clerk_user_id, title, questions, status)
      VALUES (${briefId}, ${brief.clerk_user_id}, ${title.trim()}, ${JSON.stringify(cleanQuestions)}::jsonb, ${status})
      RETURNING id, title, status, prepared_at
    `;
    let warning;
    if (status === 'prepared') {
      try {
        await sendEmail({
          to: brief.user_email,
          from: analystUser?.user_email,
          subject: 'Your JCiTL follow-up questionnaire is ready',
          html: `<p>Hello ${brief.user_name || 'there'},</p><p>Your follow-up questionnaire is ready. Sign in to JCiTL Discovery Studio to complete it.</p>`,
        });
      } catch (error) {
        warning = 'Questionnaire was saved, but the notification email could not be sent.';
        console.error('Failed to send questionnaire prepared notification', error);
      }
    }
    return response.status(201).json({ questionnaire, warning });
  } catch (error) {
    console.error('Failed to prepare questionnaire', error);
    return response.status(500).json({ error: 'We could not save this questionnaire.' });
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

    const analystEmails = await sql`
      SELECT user_email
      FROM analyst_users
      WHERE is_active = true AND user_email IS NOT NULL
    `;
    let warning;
    try {
      const recipients = analystEmails.map((analyst) => analyst.user_email).filter(Boolean);
      const sender = recipients[0] || null;
      await sendEmail({
        to: recipients,
        from: sender,
        subject: 'A JCiTL questionnaire has been submitted',
        html: `<p>A follow-up questionnaire for discovery brief #${submitted.brief_id} has been submitted and is ready for review.</p>`,
      });
    } catch (error) {
      warning = 'Your answers were submitted, but analyst notification email could not be sent.';
      console.error('Failed to send questionnaire submitted notification', error);
    }
    response.json({ message: 'Your answers have been submitted. We will be in touch in due course.', warning });
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
