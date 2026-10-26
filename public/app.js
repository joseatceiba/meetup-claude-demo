const form = document.getElementById('form');
const input = document.getElementById('url');
const submit = document.getElementById('submit');
const errorEl = document.getElementById('error');
const resultEl = document.getElementById('result');
const linkEl = document.getElementById('short-link');
const copyBtn = document.getElementById('copy');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  resultEl.hidden = true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;

  submit.disabled = true;
  try {
    const res = await fetch('/api/shorten', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input.value }),
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Something went wrong.');

    linkEl.textContent = data.shortUrl;
    linkEl.href = data.shortUrl;
    copyBtn.textContent = 'Copy';
    resultEl.hidden = false;
  } catch {
    showError('Could not reach the server. Please try again.');
  } finally {
    submit.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(linkEl.textContent);
    copyBtn.textContent = 'Copied!';
  } catch {
    // Clipboard API needs a secure context; fall back to selecting the text.
    const range = document.createRange();
    range.selectNodeContents(linkEl);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyBtn.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
});
