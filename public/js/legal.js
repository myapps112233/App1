import { clearLocalGameData } from './records.mjs';

const button = document.getElementById('legal-clear');
const status = document.getElementById('legal-clear-status');

button?.addEventListener('click', () => {
  const confirmed = globalThis.confirm(
    'Remove the personal record and saved display name from this browser? This cannot be undone.',
  );
  if (!confirmed) return;
  const result = clearLocalGameData();
  if (status) {
    status.textContent = result.ok
      ? 'Local game data removed from this browser.'
      : 'This browser blocked storage access, so nothing could be removed here.';
  }
});
