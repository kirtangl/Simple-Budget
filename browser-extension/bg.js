// The toolbar button opens the Coles button's page in a tab, which stays open for the whole check.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
