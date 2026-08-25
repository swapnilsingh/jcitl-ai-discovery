const contextField = document.querySelector('#venture-context');
const charCount = document.querySelector('#char-count');
const stageOptions = document.querySelectorAll('.stage-option');
const fileInput = document.querySelector('#file-upload');
const uploadZone = document.querySelector('.upload-zone');
const uploadLabel = document.querySelector('#upload-label');
const form = document.querySelector('#discovery-form');
const message = document.querySelector('#form-message');
const protectedContent = document.querySelector('#protected-content');
const confirmationContent = document.querySelector('#confirmation-content');
const questionnaireContent = document.querySelector('#questionnaire-content');
const questionnaireTitle = document.querySelector('#questionnaire-title');
const questionnaireForm = document.querySelector('#questionnaire-form');
const questionnaireMessage = document.querySelector('#questionnaire-message');
const analystContent = document.querySelector('#analyst-content');
const analystMessage = document.querySelector('#analyst-message');
const briefCount = document.querySelector('#brief-count');
const briefList = document.querySelector('#brief-list');
const refreshBriefs = document.querySelector('#refresh-briefs');
const questionnaireBuilder = document.querySelector('#questionnaire-builder');
const questionnaireBrief = document.querySelector('#questionnaire-brief');
const questionnaireBuilderTitle = document.querySelector('#questionnaire-builder-title');
const questionBuilderList = document.querySelector('#question-builder-list');
const addQuestion = document.querySelector('#add-question');
const questionnaireBuilderMessage = document.querySelector('#questionnaire-builder-message');
const previewQuestionnaire = document.querySelector('#preview-questionnaire');
const saveQuestionnaire = document.querySelector('#save-questionnaire');
const questionnairePreview = document.querySelector('#questionnaire-preview');
const signInPanel = document.querySelector('#sign-in-panel');
const clerkUserButton = document.querySelector('#clerk-user-button');
const clerkSignIn = document.querySelector('#clerk-sign-in');
const authLoading = document.querySelector('#auth-loading');

const clerkKey = document.querySelector('meta[name="clerk-publishable-key"]')?.content;

const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function renderSubmittedAnswers(questions, answers) {
  if (!answers || !questions) return '';
  return `<div class="submitted-answers"><strong>USER RESPONSES</strong>${questions.map((question) => {
    const answer = answers[question.id];
    const values = Array.isArray(answer) ? answer : [answer];
    return `<div class="submitted-answer"><span>${escapeHtml(question.prompt)}</span><p>${values.filter((value) => value !== undefined && value !== '').map(escapeHtml).join('<br />') || 'No answer provided'}</p></div>`;
  }).join('')}</div>`;
}

async function renderUserQuestionnaire() {
  const token = await window.Clerk.session?.getToken();
  if (!token) return;
  const response = await fetch('/api/questionnaires/current', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Could not load your questionnaire.');
  const { questionnaires } = await response.json();
  const current = questionnaires.find((item) => item.status === 'prepared');
  if (!current) return;
  protectedContent.hidden = true;
  questionnaireContent.hidden = false;
  questionnaireTitle.innerHTML = `${escapeHtml(current.title)}<br /><span>for your venture.</span>`;
  questionnaireForm.innerHTML = current.questions.map((question) => `
    <div class="field-block"><span class="field-label">${escapeHtml(question.prompt)}</span>${renderAnswerField(question)}</div>
  `).join('') + `<button class="primary-button" type="submit">SUBMIT ANSWERS <span>→</span></button>`;
  questionnaireForm.dataset.questionnaireId = current.id;
}

function renderAnswerField(question) {
  const required = question.required && question.type !== 'multi-select' ? 'required' : '';
  if (question.type === 'multiple-choice' || question.type === 'multi-select') {
    const inputType = question.type === 'multiple-choice' ? 'radio' : 'checkbox';
    return `<div class="answer-options">${question.options.map((option) => `<label><input type="${inputType}" name="answer-${escapeHtml(question.id)}" value="${escapeHtml(option)}" data-question-id="${escapeHtml(question.id)}" ${required} /> <span>${escapeHtml(option)}</span></label>`).join('')}</div>`;
  }
  return question.type === 'textarea'
    ? `<textarea data-question-id="${escapeHtml(question.id)}" ${required} placeholder="Your answer..."></textarea>`
    : `<input class="answer-text" type="text" data-question-id="${escapeHtml(question.id)}" ${required} placeholder="Your answer..." />`;
}

function addQuestionRow() {
  const row = document.createElement('div');
  row.className = 'question-row';
  row.innerHTML = '<div class="question-row-top"><input class="question-prompt" maxlength="500" placeholder="Question" required /><button class="remove-question" type="button" aria-label="Remove question">×</button></div><div class="question-row-controls"><select class="question-type"><option value="text">Short answer</option><option value="textarea">Long answer</option><option value="multiple-choice">Multiple choice</option><option value="multi-select">Checkboxes</option></select><label class="required-toggle"><input class="question-required" type="checkbox" checked /> Required</label></div><div class="choice-list" hidden></div><button class="add-choice" type="button" hidden>ADD OPTION <span>+</span></button>';
  questionBuilderList.append(row);
  const typeSelect = row.querySelector('.question-type');
  const choiceList = row.querySelector('.choice-list');
  const addChoice = row.querySelector('.add-choice');
  const updateChoiceVisibility = () => {
    const isChoice = ['multiple-choice', 'multi-select'].includes(typeSelect.value);
    choiceList.hidden = !isChoice;
    addChoice.hidden = !isChoice;
    if (isChoice && !choiceList.children.length) addChoiceRow(choiceList);
  };
  typeSelect.addEventListener('change', updateChoiceVisibility);
  addChoice.addEventListener('click', () => addChoiceRow(choiceList));
  row.querySelector('.remove-question').addEventListener('click', () => row.remove());
  updateChoiceVisibility();
}

function addChoiceRow(choiceList) {
  const choice = document.createElement('div');
  choice.className = 'choice-row';
  choice.innerHTML = '<span class="choice-marker">○</span><input class="choice-value" maxlength="200" placeholder="Option" required /><button class="remove-choice" type="button" aria-label="Remove option">×</button>';
  choiceList.append(choice);
  choice.querySelector('.remove-choice').addEventListener('click', () => choice.remove());
}

addQuestion.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  addQuestionRow();
});
addQuestionRow();

questionnaireForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = await window.Clerk.session?.getToken();
  const answers = {};
  questionnaireForm.querySelectorAll('[data-question-id]').forEach((field) => {
    if (field.type === 'checkbox') {
      answers[field.dataset.questionId] = answers[field.dataset.questionId] || [];
      if (field.checked) answers[field.dataset.questionId].push(field.value);
    } else if (field.type !== 'radio' || field.checked) {
      answers[field.dataset.questionId] = field.value;
    }
  });
  questionnaireMessage.textContent = 'Submitting your answers...';
  const response = await fetch(`/api/questionnaires/${questionnaireForm.dataset.questionnaireId}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
  const result = await response.json();
  questionnaireMessage.textContent = response.ok ? result.message : result.error;
});

questionnaireBuilder.addEventListener('submit', async (event) => {
  event.preventDefault();
  await saveQuestionnaireRecord('prepared');
});

function getBuilderQuestions() {
  return [...questionBuilderList.querySelectorAll('.question-row')].map((row) => ({
    prompt: row.querySelector('.question-prompt').value,
    type: row.querySelector('.question-type').value,
    required: row.querySelector('.question-required').checked,
    options: [...row.querySelectorAll('.choice-value')].map((option) => option.value.trim()).filter(Boolean),
  }));
}

async function saveQuestionnaireRecord(status) {
  const token = await window.Clerk.session?.getToken();
  const response = await fetch('/api/analyst/questionnaires', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ briefId: questionnaireBrief.value, title: questionnaireBuilderTitle.value, questions: getBuilderQuestions(), status }) });
  const result = await response.json();
  questionnaireBuilderMessage.textContent = response.ok ? (status === 'draft' ? 'Draft saved.' : 'Questionnaire prepared and user notified.') : result.error;
  if (response.ok && status === 'prepared') await renderSignedInView(window.location.origin + '/');
}

saveQuestionnaire.addEventListener('click', (event) => {
  event.preventDefault();
  saveQuestionnaireRecord('draft');
});

previewQuestionnaire.addEventListener('click', (event) => {
  event.preventDefault();
  const previewQuestions = getBuilderQuestions();
  questionnairePreview.innerHTML = `<strong>${escapeHtml(questionnaireBuilderTitle.value || 'Questionnaire preview')}</strong>${previewQuestions.map((question) => `<div class="preview-question"><b>${escapeHtml(question.prompt || 'Untitled question')}</b><span>${question.type === 'multiple-choice' ? question.options.map(escapeHtml).join(' / ') : question.type === 'multi-select' ? question.options.map(escapeHtml).join(' [ ] ') : question.type}</span></div>`).join('')}`;
  questionnairePreview.hidden = false;
});

async function renderSignedInView(redirectUrl) {
  const token = await window.Clerk.session?.getToken();
  if (!token) return false;

  const meResponse = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!meResponse.ok) throw new Error('Could not determine your account access.');
  const { isAnalyst } = await meResponse.json();
  protectedContent.hidden = true;
  confirmationContent.hidden = true;
  questionnaireContent.hidden = true;
  analystContent.hidden = true;
  if (!isAnalyst) {
    protectedContent.hidden = false;
    return false;
  }

  protectedContent.hidden = true;
  analystContent.hidden = false;
  analystMessage.textContent = 'Loading submitted briefs from Neon...';
  const briefsResponse = await fetch('/api/analyst/briefs', { headers: { Authorization: `Bearer ${token}` } });
  const result = await briefsResponse.json();
  if (!briefsResponse.ok) throw new Error(result.error);
  briefCount.textContent = result.briefs.length;
  analystMessage.textContent = '';
  briefList.innerHTML = result.briefs.map((brief) => `
    <article class="brief-item">
      <div class="brief-item-heading"><span>#${brief.id}</span><strong>${brief.stage}</strong><time>${new Date(brief.created_at).toLocaleString()}</time></div>
      <p>${brief.context.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>
      <small>${escapeHtml(brief.user_name || 'Unknown user')}${brief.user_email ? ` / ${escapeHtml(brief.user_email)}` : ''} / ${escapeHtml(brief.review_status)}</small>
      ${brief.file_name ? `<button class="file-preview-button" type="button" data-brief-id="${brief.id}" data-file-type="${brief.file_mime_type}">PREVIEW ${brief.file_name} <span>↗</span></button>` : '<small class="no-file">No attachment</small>'}
      ${brief.questionnaire_id ? `<small class="questionnaire-status">Questionnaire: ${escapeHtml(brief.questionnaire_title)} / ${escapeHtml(brief.questionnaire_status)}</small>${renderSubmittedAnswers(brief.questionnaire_questions, brief.questionnaire_answers)}` : '<small class="questionnaire-status">No questionnaire prepared</small>'}
    </article>
  `).join('');
  briefList.querySelectorAll('.file-preview-button').forEach((button) => {
    button.addEventListener('click', () => previewFile(button.dataset.briefId, button.dataset.fileType));
  });
  questionnaireBrief.innerHTML = '<option value="">Select a discovery brief</option>' + result.briefs.map((brief) => `<option value="${brief.id}">${brief.id} / ${escapeHtml(brief.user_name || brief.user_email || 'Unknown user')}</option>`).join('');
  return true;
}

async function previewFile(briefId, fileType) {
  const token = await window.Clerk.session?.getToken();
  const response = await fetch(`/api/analyst/briefs/${briefId}/file`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('The attachment could not be loaded.');
  const fileUrl = URL.createObjectURL(await response.blob());
  const preview = document.querySelector('#file-preview');
  preview.innerHTML = fileType === 'application/pdf'
    ? `<iframe title="Attachment preview" src="${fileUrl}"></iframe>`
    : `<p>This file type cannot be previewed in the browser.</p><a href="${fileUrl}" download>Download attachment</a>`;
  preview.hidden = false;
}

refreshBriefs.addEventListener('click', async () => {
  refreshBriefs.disabled = true;
  try {
    await renderSignedInView(window.location.origin + '/');
  } catch (error) {
    analystMessage.textContent = error.message;
  } finally {
    refreshBriefs.disabled = false;
  }
});

async function startClerk() {
  if (!clerkKey) {
    message.textContent = 'Add CLERK_PUBLISHABLE_KEY to the page configuration.';
    return;
  }

  const redirectUrl = window.location.origin + '/';
  await window.Clerk.load({
    publishableKey: clerkKey,
    ui: { ClerkUI: window.__internal_ClerkUICtor },
    signInFallbackRedirectUrl: redirectUrl,
    signInForceRedirectUrl: redirectUrl,
    signUpFallbackRedirectUrl: redirectUrl,
    signUpForceRedirectUrl: redirectUrl,
    signInUrl: redirectUrl,
    signUpUrl: redirectUrl,
    afterSignOutUrl: redirectUrl,
  });
  let userButtonMounted = false;
  const renderAuthState = ({ user }) => {
    const signedIn = Boolean(user || window.Clerk.session || window.Clerk.isSignedIn);
    authLoading.hidden = true;
    signInPanel.hidden = signedIn;
    protectedContent.hidden = !signedIn;
    confirmationContent.hidden = true;
    questionnaireContent.hidden = true;
    if (!signedIn) analystContent.hidden = true;
    if (signedIn && !userButtonMounted) {
      window.Clerk.mountUserButton(clerkUserButton, { afterSignOutUrl: redirectUrl });
      userButtonMounted = true;
      renderSignedInView(redirectUrl).then((isAnalyst) => {
        if (!isAnalyst) return renderUserQuestionnaire();
      }).catch((error) => {
        analystMessage.textContent = error.message;
      });
      return;
    }

    if (!signedIn && !clerkSignIn.hasChildNodes()) {
      signInPanel.hidden = false;
      window.Clerk.mountSignIn(clerkSignIn, {
        routing: 'hash',
        fallbackRedirectUrl: redirectUrl,
        forceRedirectUrl: redirectUrl,
        signUpUrl: redirectUrl,
        signUpFallbackRedirectUrl: redirectUrl,
        signUpForceRedirectUrl: redirectUrl,
      });
    } else if (!signedIn) {
      signInPanel.hidden = false;
    }
  };

  window.Clerk.addListener(renderAuthState);

  renderAuthState({ user: window.Clerk.user, session: window.Clerk.session });
}

startClerk().catch((error) => {
  console.error('Clerk initialization failed', error);
  message.textContent = 'Clerk rejected this app origin. Add http://localhost:3000 to Clerk Dashboard > Domains > Allowed origins, then refresh.';
});

contextField.addEventListener('input', () => {
  charCount.textContent = contextField.value.length;
});

stageOptions.forEach((option) => {
  option.addEventListener('click', () => {
    stageOptions.forEach((item) => item.classList.remove('selected'));
    option.classList.add('selected');
  });
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  uploadLabel.textContent = file.name;
  uploadZone.classList.add('has-file');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!contextField.value.trim()) {
    contextField.focus();
    message.textContent = 'Add a little context before continuing.';
    return;
  }
  const selectedStage = document.querySelector('.stage-option.selected');
  const file = fileInput.files[0];
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  message.textContent = 'Saving your brief...';

  try {
    const token = await window.Clerk.session?.getToken();
    if (!token) throw new Error('missing-session');
    const response = await fetch('/api/discovery-briefs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: (() => {
        const data = new FormData();
        data.append('context', contextField.value);
        data.append('stage', selectedStage.dataset.stage);
        if (file) data.append('file', file);
        return data;
      })(),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    message.textContent = result.message;
    protectedContent.hidden = true;
    confirmationContent.hidden = false;
    document.querySelector('.progress-track span').style.width = '66.66%';
  } catch (error) {
    message.textContent = error.message || 'We could not save your brief. Please try again.';
  } finally {
    submitButton.disabled = false;
  }
});