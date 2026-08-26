const companyNameField = document.querySelector('#company-name');
const contextField = document.querySelector('#venture-context');
const charCount = document.querySelector('#char-count');
const stageOptions = document.querySelectorAll('.stage-option');
const fileInput = document.querySelector('#file-upload');
const uploadZone = document.querySelector('.upload-zone');
const uploadLabel = document.querySelector('#upload-label');
const form = document.querySelector('#discovery-form');
const message = document.querySelector('#form-message');
const signInPanel = document.querySelector('#sign-in-panel');
const protectedContent = document.querySelector('#protected-content');
const clerkUserButton = document.querySelector('#clerk-user-button');
const clerkSignIn = document.querySelector('#clerk-sign-in');
const authLoading = document.querySelector('#auth-loading');
const analystContent = document.querySelector('#analyst-content');
const briefCount = document.querySelector('#brief-count');
const briefList = document.querySelector('#brief-list');
const analystMessage = document.querySelector('#analyst-message');
const confirmationContent = document.querySelector('#confirmation-content');
const questionnaireContent = document.querySelector('#questionnaire-content');
const questionnaireTitle = document.querySelector('#questionnaire-title');
const questionnaireForm = document.querySelector('#questionnaire-form');
const questionnaireMessage = document.querySelector('#questionnaire-message');
const questionnaireBuilder = document.querySelector('#questionnaire-builder');
const questionnaireBrief = document.querySelector('#questionnaire-brief');
const selectedBrief = document.querySelector('#selected-brief');
const questionnaireBuilderTitle = document.querySelector('#questionnaire-builder-title');
const questionBuilderList = document.querySelector('#question-builder-list');
const questionnaireBuilderMessage = document.querySelector('#questionnaire-builder-message');
const addQuestion = document.querySelector('#add-question');
const unlockBriefButton = document.querySelector('#unlock-brief');
const analystUsersForm = document.querySelector('#analyst-users-form');
const analystUserIdInput = document.querySelector('#analyst-user-id');
const analystUsersList = document.querySelector('#analyst-users-list');
const analystUsersMessage = document.querySelector('#analyst-users-message');
const analystUsersSection = document.querySelector('#analyst-users-section');
const filePreview = document.querySelector('#file-preview');
const briefFilters = document.querySelectorAll('[data-brief-filter]');
const progressBar = document.querySelector('.progress-track span');
const progressLabels = document.querySelectorAll('[data-progress-step]');
const stepLabelText = document.querySelector('#step-label-text');
const clerkKey = document.querySelector('meta[name="clerk-publishable-key"]')?.content;
let analystBriefs = [];
let activeBriefFilter = 'all';
let authRenderVersion = 0;
let currentUserId = null;
let activeLockedBriefId = null;
let briefLockHeartbeatId = null;
let lastAnalystToken = null;
const ROLE_CACHE_KEY = 'jcitl_role';

const escapeHtml = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function setProgress(step, label) {
  progressBar.style.width = `${(step / 3) * 100}%`;
  stepLabelText.textContent = label;
  progressLabels.forEach((item) => item.classList.toggle('active', Number(item.dataset.progressStep) <= step));
}

function isBriefLockedByCurrentAnalyst(brief) {
  return Boolean(currentUserId && brief.lock_owner_user_id && brief.lock_owner_user_id === currentUserId);
}

function stopBriefLockHeartbeat() {
  if (!briefLockHeartbeatId) return;
  clearInterval(briefLockHeartbeatId);
  briefLockHeartbeatId = null;
}

function updateUnlockBriefButton() {
  if (!unlockBriefButton) return;
  const selectedBriefId = Number(questionnaireBrief.value);
  const selectedBrief = analystBriefs.find((brief) => brief.id === selectedBriefId);
  unlockBriefButton.hidden = !selectedBrief || !isBriefLockedByCurrentAnalyst(selectedBrief);
}

function startBriefLockHeartbeat(briefId) {
  stopBriefLockHeartbeat();
  briefLockHeartbeatId = setInterval(async () => {
    try {
      const token = await window.Clerk.session?.getToken();
      if (!token || !activeLockedBriefId) return;
      await fetch(`/api/analyst/briefs/${briefId}/lock/heartbeat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Ignore heartbeat errors and rely on manual refresh and lock expiry.
    }
  }, 60000);
}

async function releaseAllBriefLocks() {
  if (!lastAnalystToken) return;
  try {
    await fetch('/api/analyst/locks/release-all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lastAnalystToken}` },
      keepalive: true,
    });
  } catch {
    // Ignore logout-time network failures.
  }
  stopBriefLockHeartbeat();
  activeLockedBriefId = null;
}

async function lockBriefForReview(briefId) {
  const token = await window.Clerk.session?.getToken();
  if (!token) throw new Error('Sign in before reviewing briefs.');
  const response = await fetch(`/api/analyst/briefs/${briefId}/lock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 409 && result.lock) {
      const owner = result.lock.user_name || result.lock.user_email || result.lock.analyst_clerk_user_id;
      throw new Error(`This brief is locked by ${owner}.`);
    }
    throw new Error(result.error || 'We could not lock this brief.');
  }
  activeLockedBriefId = Number(briefId);
  startBriefLockHeartbeat(activeLockedBriefId);
  return result;
}

async function unlockBrief(briefId, { silent = false } = {}) {
  const token = await window.Clerk.session?.getToken();
  if (!token) return false;
  const response = await fetch(`/api/analyst/briefs/${briefId}/lock`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const result = await response.json();
  if (!response.ok) {
    if (!silent) analystMessage.textContent = result.error || 'Could not unlock this brief.';
    return false;
  }
  if (Number(briefId) === activeLockedBriefId) {
    activeLockedBriefId = null;
    stopBriefLockHeartbeat();
  }
  if (!silent) analystMessage.textContent = 'Brief unlocked.';
  return true;
}

async function renderAnalystView() {
  const previouslySelectedBriefId = questionnaireBrief.value || (activeLockedBriefId ? String(activeLockedBriefId) : '');
  const token = await window.Clerk.session?.getToken();
  if (token) lastAnalystToken = token;
  const briefsResponse = await fetch('/api/analyst/briefs', { headers: { Authorization: `Bearer ${token}` } });
  if (!briefsResponse.ok) throw new Error('Could not load analyst briefs.');

  const { briefs } = await briefsResponse.json();
  analystBriefs = briefs;
  if (activeLockedBriefId) {
    const activeBrief = analystBriefs.find((brief) => brief.id === activeLockedBriefId);
    if (!activeBrief || !isBriefLockedByCurrentAnalyst(activeBrief)) {
      activeLockedBriefId = null;
      stopBriefLockHeartbeat();
    }
  }
  questionnaireBrief.innerHTML = '<option value="">Select a discovery brief</option>' + briefs.map((brief) => `<option value="${brief.id}">${escapeHtml(brief.company_name || 'Unnamed company')}</option>`).join('');
  if (previouslySelectedBriefId && questionnaireBrief.querySelector(`option[value="${previouslySelectedBriefId}"]`)) {
    questionnaireBrief.value = previouslySelectedBriefId;
    const selectedOption = questionnaireBrief.selectedOptions[0];
    selectedBrief.textContent = selectedOption?.value ? `Selected brief: ${selectedOption.textContent}` : 'Select a brief above or use REVIEW on a submitted brief.';
  }
  renderFilteredBriefs();
  updateUnlockBriefButton();

  if (!analystUsersSection) return;
  analystUsersSection.hidden = false;
  analystUsersMessage.textContent = '';

  try {
    const analystsResponse = await fetch('/api/analyst/users', { headers: { Authorization: `Bearer ${token}` } });
    if (!analystsResponse.ok) throw new Error('Analyst assignment is unavailable. Apply the latest schema migration to enable it.');
    const { analysts } = await analystsResponse.json();
    analystUsersList.innerHTML = analysts.length
      ? analysts.map((analyst) => `<article class="analyst-user-item"><div><strong>${escapeHtml(analyst.user_name || 'Unnamed analyst')}</strong><span>${escapeHtml(analyst.user_email || analyst.clerk_user_id)}</span><small>${escapeHtml(analyst.clerk_user_id)}</small></div><button class="refresh-button remove-analyst" type="button" data-analyst-id="${escapeHtml(analyst.clerk_user_id)}">REMOVE</button></article>`).join('')
      : '<p class="empty-state">No analysts assigned yet.</p>';
  } catch (error) {
    analystUsersSection.hidden = true;
    analystUsersMessage.textContent = error.message;
  }
}

function getBriefState(brief) {
  if (brief.questionnaire_status === 'submitted') return { key: 'answers', label: 'ANSWERS RECEIVED' };
  if (brief.questionnaire_status === 'prepared') return { key: 'questions', label: 'QUESTIONS READY' };
  return { key: 'new', label: 'NEW' };
}

function renderFilteredBriefs() {
  const filteredBriefs = activeBriefFilter === 'all' ? analystBriefs : analystBriefs.filter((brief) => getBriefState(brief).key === activeBriefFilter);
  briefCount.textContent = filteredBriefs.length;
  briefList.innerHTML = filteredBriefs.length
    ? filteredBriefs.map((brief) => {
      const state = getBriefState(brief);
      const lockedByCurrent = isBriefLockedByCurrentAnalyst(brief);
      const isLocked = Boolean(brief.lock_owner_user_id);
      const lockOwner = brief.lock_owner_name || brief.lock_owner_email || brief.lock_owner_user_id;
      const lockLabel = lockedByCurrent ? 'LOCKED BY YOU' : isLocked ? `LOCKED BY ${escapeHtml(lockOwner)}` : 'UNLOCKED';
      const reviewLabel = lockedByCurrent ? 'CONTINUE' : isLocked ? 'LOCKED' : 'REVIEW';
      return `<article class="brief-item"><div class="brief-item-heading"><div><strong>${escapeHtml(brief.company_name || 'Unnamed company')}</strong><span>${escapeHtml(brief.user_email || 'No email')}</span></div><div class="brief-meta"><small>${escapeHtml(brief.stage)}</small><b class="brief-status status-${state.key}">${state.label}</b><b class="brief-lock ${lockedByCurrent ? 'lock-mine' : isLocked ? 'lock-other' : 'lock-open'}">${lockLabel}</b></div></div><p>${escapeHtml(brief.context)}</p><div class="brief-actions"><button class="refresh-button review-brief" type="button" data-brief-id="${brief.id}" ${isLocked && !lockedByCurrent ? 'disabled' : ''}>${reviewLabel}</button>${lockedByCurrent ? `<button class="refresh-button unlock-brief-inline" type="button" data-brief-id="${brief.id}">UNLOCK</button>` : ''}${brief.file_name ? `<button class="refresh-button preview-file" type="button" data-brief-id="${brief.id}" data-file-name="${escapeHtml(brief.file_name)}" data-file-type="${escapeHtml(brief.file_mime_type || '')}">PREVIEW / DOWNLOAD</button>` : '<span class="no-attachment">NO ATTACHMENT</span>'}</div></article>`;
    }).join('')
    : '<p class="empty-state">No discovery briefs submitted yet.</p>';
}

async function previewBriefFile(briefId, fileName, fileType) {
  const token = await window.Clerk.session?.getToken();
  const response = await fetch(`/api/analyst/briefs/${briefId}/file`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('The attachment could not be loaded.');
  const blob = await response.blob();
  const fileUrl = URL.createObjectURL(blob);
  const isPptx = fileType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || fileName.toLowerCase().endsWith('.pptx');
  filePreview.innerHTML = `<div class="preview-heading"><strong>${escapeHtml(fileName)}</strong><button class="refresh-button" type="button" id="close-preview">CLOSE</button></div>${fileType === 'application/pdf' ? `<iframe title="${escapeHtml(fileName)}" src="${fileUrl}"></iframe>` : isPptx ? '<div id="pptx-preview" class="pptx-preview"></div>' : '<p>This file type cannot be previewed in the browser.</p>'}<a class="download-link" href="${fileUrl}" download="${escapeHtml(fileName)}">DOWNLOAD ATTACHMENT ↗</a>`;
  filePreview.hidden = false;
  if (isPptx) {
    try {
      const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('https://cdn.jsdelivr.net/npm/@aiden0z/pptx-renderer@1.2.4/dist/aiden0z-pptx-renderer.browser.es.js');
      await PptxViewer.open(await blob.arrayBuffer(), document.querySelector('#pptx-preview'), {
        zipLimits: RECOMMENDED_ZIP_LIMITS,
        listOptions: { windowed: true, initialSlides: 3, batchSize: 3 },
      });
    } catch (error) {
      document.querySelector('#pptx-preview').innerHTML = `<p class="preview-error">This PPTX could not be rendered in the browser. Use DOWNLOAD ATTACHMENT to open the original file.</p>`;
      console.error('Failed to render PPTX preview', error);
    }
  }
  document.querySelector('#close-preview').addEventListener('click', () => { filePreview.hidden = true; URL.revokeObjectURL(fileUrl); });
}

briefList.addEventListener('click', async (event) => {
  const reviewButton = event.target.closest('.review-brief');
  const previewButton = event.target.closest('.preview-file');
  const unlockButton = event.target.closest('.unlock-brief-inline');
  if (unlockButton) {
    const unlocked = await unlockBrief(unlockButton.dataset.briefId);
    if (unlocked) {
      if (questionnaireBrief.value === unlockButton.dataset.briefId) selectedBrief.textContent = 'Select a brief above or use REVIEW on a submitted brief.';
      await renderAnalystView();
    }
    return;
  }
  if (reviewButton) {
    try {
      await lockBriefForReview(reviewButton.dataset.briefId);
      questionnaireBrief.value = reviewButton.dataset.briefId;
      selectedBrief.textContent = `Selected brief: ${reviewButton.closest('.brief-item').querySelector('strong').textContent}`;
      questionnaireBuilderTitle.focus();
      analystMessage.textContent = 'Brief locked for your review.';
      await renderAnalystView();
    } catch (error) {
      analystMessage.textContent = error.message;
    }
    return;
  }
  if (previewButton) {
    try {
      await previewBriefFile(previewButton.dataset.briefId, previewButton.dataset.fileName, previewButton.dataset.fileType);
    } catch (error) {
      analystMessage.textContent = error.message;
    }
  }
});

analystUsersList?.addEventListener('click', async (event) => {
  const removeButton = event.target.closest('.remove-analyst');
  if (!removeButton) return;

  analystUsersMessage.textContent = '';
  try {
    const token = await window.Clerk.session?.getToken();
    const response = await fetch(`/api/analyst/users/${encodeURIComponent(removeButton.dataset.analystId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await response.json();
    analystUsersMessage.textContent = response.ok ? 'Analyst removed.' : result.error;
    if (response.ok) await renderAnalystView();
  } catch (error) {
    analystUsersMessage.textContent = error.message;
  }
});

briefFilters.forEach((filter) => filter.addEventListener('click', () => {
  activeBriefFilter = filter.dataset.briefFilter;
  briefFilters.forEach((item) => item.classList.toggle('active', item === filter));
  renderFilteredBriefs();
}));

questionnaireBrief.addEventListener('change', () => {
  const option = questionnaireBrief.selectedOptions[0];
  selectedBrief.textContent = option?.value ? `Selected brief: ${option.textContent}` : 'Select a brief above or use REVIEW on a submitted brief.';
  updateUnlockBriefButton();
});

function addQuestionRow() {
  const row = document.createElement('div');
  row.className = 'question-row';
  row.innerHTML = '<input class="question-prompt" maxlength="500" placeholder="Question" required /><select class="question-type"><option value="text">Short answer</option><option value="textarea">Long answer</option><option value="multiple-choice">Multiple choice (single answer)</option><option value="multi-select">Multiple choice (multiple answers)</option></select><input class="question-options" maxlength="1000" placeholder="Options (comma separated)" hidden /><button class="remove-question" type="button" aria-label="Remove question">×</button>';
  questionBuilderList.append(row);
  const typeField = row.querySelector('.question-type');
  const optionsField = row.querySelector('.question-options');
  const updateOptionsVisibility = () => {
    const needsOptions = ['multiple-choice', 'multi-select'].includes(typeField.value);
    optionsField.hidden = !needsOptions;
    optionsField.required = needsOptions;
    if (!needsOptions) optionsField.value = '';
  };
  typeField.addEventListener('change', updateOptionsVisibility);
  updateOptionsVisibility();
  row.querySelector('.remove-question').addEventListener('click', () => row.remove());
}

function getBuilderQuestions() {
  return [...questionBuilderList.querySelectorAll('.question-row')].map((row) => ({
    prompt: row.querySelector('.question-prompt').value.trim(),
    type: row.querySelector('.question-type').value,
    required: true,
    options: [...new Set(
      row.querySelector('.question-options').value
        .split(/[\n,]/)
        .map((option) => option.trim())
        .filter(Boolean),
    )],
  }));
}

function renderQuestionInput(question) {
  const questionId = escapeHtml(question.id);
  if (question.type === 'textarea') return `<textarea data-question-id="${questionId}" data-question-type="textarea" required></textarea>`;
  if (question.type === 'multiple-choice') {
    const options = Array.isArray(question.options) ? question.options : [];
    return `<div class="choice-group" data-question-id="${questionId}" data-question-type="multiple-choice">${options.map((option, index) => `<label><input type="radio" name="question-${questionId}" value="${escapeHtml(option)}" ${index === 0 ? 'required' : ''} /> ${escapeHtml(option)}</label>`).join('')}</div>`;
  }
  if (question.type === 'multi-select') {
    const options = Array.isArray(question.options) ? question.options : [];
    return `<div class="choice-group" data-question-id="${questionId}" data-question-type="multi-select">${options.map((option) => `<label><input type="checkbox" value="${escapeHtml(option)}" /> ${escapeHtml(option)}</label>`).join('')}</div>`;
  }
  return `<input type="text" data-question-id="${questionId}" data-question-type="text" required />`;
}

function collectQuestionnaireAnswers() {
  const answers = {};
  questionnaireForm.querySelectorAll('[data-question-id][data-question-type]').forEach((field) => {
    const questionId = field.dataset.questionId;
    const type = field.dataset.questionType;
    if (type === 'multiple-choice') {
      answers[questionId] = field.querySelector('input:checked')?.value || '';
      return;
    }
    if (type === 'multi-select') {
      answers[questionId] = [...field.querySelectorAll('input:checked')].map((input) => input.value);
      return;
    }
    answers[questionId] = field.value;
  });
  return answers;
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
  questionnaireForm.dataset.questionnaireId = current.id;
  questionnaireForm.innerHTML = current.questions.map((question) => `<div class="field-block"><label class="field-label">${escapeHtml(question.prompt)}</label>${renderQuestionInput(question)}</div>`).join('') + '<button class="primary-button" type="submit">SUBMIT ANSWERS <span>→</span></button>';
  setProgress(3, 'FOLLOW-UP QUESTIONS');
}

async function renderUserDiscoveryState() {
  const token = await window.Clerk.session?.getToken();
  if (!token) return;
  const response = await fetch('/api/discovery-status', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('Could not load your discovery status.');
  const { status } = await response.json();
  if (status?.questionnaire_status === 'prepared') {
    await renderUserQuestionnaire();
    return;
  }
  if (status) {
    protectedContent.hidden = true;
    confirmationContent.hidden = false;
    setProgress(2, 'ANALYST REVIEW');
  }
}

async function startClerk() {
  if (!clerkKey || !window.Clerk) {
    authLoading.textContent = 'Secure sign-in is unavailable.';
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
    afterSignOutUrl: redirectUrl,
  });

  const renderAuthState = ({ user }) => {
    const renderVersion = ++authRenderVersion;
    const signedIn = Boolean(user || window.Clerk.session || window.Clerk.isSignedIn);
    authLoading.hidden = true;
    signInPanel.hidden = signedIn;
    protectedContent.hidden = !signedIn;
    analystContent.hidden = true;
    confirmationContent.hidden = true;
    questionnaireContent.hidden = true;
    if (signedIn) {
      if (!clerkUserButton.hasChildNodes()) {
        window.Clerk.mountUserButton(clerkUserButton, { afterSignOutUrl: redirectUrl });
      }
      window.Clerk.session.getToken().then(async (token) => {
        if (renderVersion !== authRenderVersion) return;
        lastAnalystToken = token;
        const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error('Could not determine account access.');
        const { isAnalyst, userId } = await response.json();
        if (renderVersion !== authRenderVersion) return;
        currentUserId = userId;
        if (isAnalyst) {
          localStorage.setItem(ROLE_CACHE_KEY, 'analyst');
          protectedContent.hidden = true;
          analystContent.hidden = false;
          await renderAnalystView();
        } else {
          localStorage.setItem(ROLE_CACHE_KEY, 'user');
          await renderUserDiscoveryState();
        }
      }).catch((error) => {
        if (renderVersion !== authRenderVersion) return;
        const cachedRole = localStorage.getItem(ROLE_CACHE_KEY);
        if (cachedRole === 'analyst') {
          protectedContent.hidden = true;
          analystContent.hidden = false;
          renderAnalystView().catch(() => {
            analystMessage.textContent = 'Could not refresh analyst briefs. Please retry.';
          });
          return;
        }
        if (cachedRole === 'user') {
          renderUserDiscoveryState().catch(() => {
            message.textContent = 'Could not refresh your discovery status. Please retry.';
          });
          return;
        }
        message.textContent = error.message;
      });
    } else if (!clerkSignIn.hasChildNodes()) {
      if (localStorage.getItem(ROLE_CACHE_KEY) === 'analyst') {
        releaseAllBriefLocks();
      }
      currentUserId = null;
      lastAnalystToken = null;
      activeLockedBriefId = null;
      stopBriefLockHeartbeat();
      localStorage.removeItem(ROLE_CACHE_KEY);
      window.Clerk.mountSignIn(clerkSignIn, {
        routing: 'hash',
        fallbackRedirectUrl: redirectUrl,
        forceRedirectUrl: redirectUrl,
      });
    }
  };

  window.Clerk.addListener(renderAuthState);
  renderAuthState({ user: window.Clerk.user });
}

startClerk().catch(() => {
  authLoading.textContent = 'Secure sign-in could not be loaded.';
});

window.addEventListener('pagehide', () => {
  if (localStorage.getItem(ROLE_CACHE_KEY) === 'analyst') {
    releaseAllBriefLocks();
  }
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
  if (!companyNameField.value.trim()) {
    companyNameField.focus();
    message.textContent = 'Add your company name before continuing.';
    return;
  }
  if (!contextField.value.trim()) {
    contextField.focus();
    message.textContent = 'Add a little context before continuing.';
    return;
  }
  const clerk = window.Clerk;
  if (!clerk) {
    message.textContent = 'Sign in before continuing.';
    return;
  }

  try {
    await clerk.load();
    if (!clerk.session) {
      message.textContent = 'Sign in before continuing.';
      return;
    }
    const token = await clerk.session.getToken();
    const response = await fetch('/api/discovery-briefs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: (() => {
        const data = new FormData();
        data.append('companyName', companyNameField.value.trim());
        data.append('context', contextField.value.trim());
        data.append('stage', document.querySelector('.stage-option.selected').dataset.stage);
        if (fileInput.files[0]) data.append('file', fileInput.files[0]);
        return data;
      })(),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'We could not save your brief.');
    protectedContent.hidden = true;
    confirmationContent.hidden = false;
    setProgress(2, 'ANALYST REVIEW');
  } catch (error) {
    message.textContent = error.message;
  }
});

addQuestion.addEventListener('click', addQuestionRow);
addQuestionRow();

questionnaireBuilder.addEventListener('submit', async (event) => {
  event.preventDefault();
  questionnaireBuilderMessage.textContent = '';
  const submitStatus = event.submitter?.dataset.status || 'prepared';
  const questions = getBuilderQuestions();
  const invalidChoiceQuestion = questions.find((question) => ['multiple-choice', 'multi-select'].includes(question.type) && question.options.length < 2);
  if (invalidChoiceQuestion) {
    questionnaireBuilderMessage.textContent = 'Choice questions need at least two options.';
    return;
  }
  const token = await window.Clerk.session?.getToken();
  const response = await fetch('/api/analyst/questionnaires', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ briefId: questionnaireBrief.value, title: questionnaireBuilderTitle.value, questions, status: submitStatus }),
  });
  const result = await response.json();
  questionnaireBuilderMessage.textContent = response.ok
    ? submitStatus === 'draft'
      ? 'Draft questionnaire saved.'
      : 'Questionnaire prepared and user notified.'
    : result.error;
  if (response.ok) {
    if (submitStatus === 'prepared') {
      await unlockBrief(questionnaireBrief.value, { silent: true });
      questionnaireBuilder.reset();
      questionBuilderList.innerHTML = '';
      addQuestionRow();
      selectedBrief.textContent = 'Select a brief above or use REVIEW on a submitted brief.';
    }
    await renderAnalystView();
  }
});

unlockBriefButton?.addEventListener('click', async () => {
  if (!questionnaireBrief.value) {
    questionnaireBuilderMessage.textContent = 'Select and lock a brief first.';
    return;
  }
  const unlocked = await unlockBrief(questionnaireBrief.value);
  if (!unlocked) return;
  selectedBrief.textContent = 'Select a brief above or use REVIEW on a submitted brief.';
  questionnaireBrief.value = '';
  updateUnlockBriefButton();
  await renderAnalystView();
});

analystUsersForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  analystUsersMessage.textContent = '';
  try {
    const token = await window.Clerk.session?.getToken();
    const response = await fetch('/api/analyst/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clerkUserId: analystUserIdInput.value.trim() }),
    });
    const result = await response.json();
    analystUsersMessage.textContent = response.ok ? 'Analyst assigned.' : result.error;
    if (response.ok) {
      analystUsersForm.reset();
      await renderAnalystView();
    }
  } catch (error) {
    analystUsersMessage.textContent = error.message;
  }
});

questionnaireForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = await window.Clerk.session?.getToken();
  const answers = collectQuestionnaireAnswers();
  const response = await fetch(`/api/questionnaires/${questionnaireForm.dataset.questionnaireId}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) });
  const result = await response.json();
  questionnaireMessage.textContent = response.ok ? result.message : result.error;
});