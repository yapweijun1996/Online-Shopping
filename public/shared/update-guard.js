// No values leave the browser. A changed draft during activation defers reload.
// Private draft inputs opt into a caller-maintained non-secret revision, even when their type changes to text.
export function draftSignature(root = document) {
  return JSON.stringify([...root.querySelectorAll('input, textarea, select')].map(input => [
    input.name || input.id, input.dataset?.privateDraft === 'true'
      ? ['private', input.dataset.privateDraftRevision || '0']
      : input.type === 'checkbox' || input.type === 'radio' ? input.checked : input.value,
    input.files ? [...input.files].map(file => [file.name, file.size, file.lastModified]) : null,
  ]));
}

let pendingMutations = 0;
export const mutationsBusy = () => pendingMutations > 0;
export function beginMutation() {
  pendingMutations++;
  document.dispatchEvent(new Event('updateguardchange'));
  let ended = false;
  return () => {
    if (ended) return;
    ended = true; pendingMutations--;
    document.dispatchEvent(new Event('updateguardchange'));
  };
}
