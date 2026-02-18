const toggle = document.getElementById('extension-toggle');
const label = document.getElementById('toggle-label');

const updateLabel = (enabled) => {
  label.textContent = enabled ? 'Отключить расширение' : 'Включить расширение';
  toggle.checked = enabled;
};

chrome.runtime.sendMessage({ type: 'getExtensionState' }, (response) => {
  const enabled = Boolean(response?.success ? response.enabled : true);
  updateLabel(enabled);
});

toggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'setExtensionEnabled', enabled: toggle.checked }, (response) => {
    updateLabel(Boolean(response?.success ? response.enabled : toggle.checked));
  });
});
