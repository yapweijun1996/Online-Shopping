// No values leave the browser. A changed draft during activation defers reload.
export function draftSignature(root = document) {
  return JSON.stringify([...root.querySelectorAll('input, textarea, select')].map(input => [
    input.name || input.id, input.type === 'checkbox' || input.type === 'radio' ? input.checked : input.value,
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
