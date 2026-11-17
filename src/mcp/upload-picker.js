const form = document.querySelector('#upload-form'), status = document.querySelector('#status');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = document.querySelector('#image').files[0], button = form.querySelector('button');
  if (!file || file.size !== Number(form.dataset.bytes)) {
    status.textContent = `Choose the requested original image (${form.dataset.bytes} bytes).`; return;
  }
  button.disabled = true; status.textContent = 'Uploading image…';
  try {
    const response = await fetch(location.href, { method: 'PUT', body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' }, credentials: 'omit', redirect: 'error' });
    const value = await response.json();
    if (!response.ok) throw new Error('Upload failed. Ask your assistant for a new link and check the original image.');
    const review = new URL(value.operation.reviewUrl);
    if (review.origin !== location.origin || value.operation.status !== 'PENDING_APPROVAL') throw new Error('Check upload status with your assistant.');
    const link = document.querySelector('#review'); link.href = review.href; link.hidden = false;
    status.textContent = 'Image uploaded. Open the review link to inspect the proposal.';
    form.hidden = true;
  } catch {
    status.textContent = 'Upload could not be confirmed. Ask your assistant to check the operation before requesting another link.';
  }
});
