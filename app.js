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
const clerkKey = document.querySelector('meta[name="clerk-publishable-key"]')?.content;

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
    const signedIn = Boolean(user || window.Clerk.session || window.Clerk.isSignedIn);
    authLoading.hidden = true;
    signInPanel.hidden = signedIn;
    protectedContent.hidden = !signedIn;
    if (signedIn) {
      if (!clerkUserButton.hasChildNodes()) {
        window.Clerk.mountUserButton(clerkUserButton, { afterSignOutUrl: redirectUrl });
      }
    } else if (!clerkSignIn.hasChildNodes()) {
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
    message.textContent = result.message;
    document.querySelector('.progress-track span').style.width = '66.66%';
  } catch (error) {
    message.textContent = error.message;
  }
});