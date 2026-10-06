// Drive Notes: the last script index.html loads, after every other app/*.js. It used to be an inline script
// at the end of index.html; the Content-Security-Policy there refuses inline scripts, so it is a file now.
// The test pages leave it out (tests/helpers.js), so a scenario decides when, and against what, the app
// watches for versions.

// Register Service Worker, and bring a new version to the screen in one opening. Read here,
// before anything else runs: whether a service worker was already in charge of this page.
if ('serviceWorker' in navigator) App.watchVersions(navigator.serviceWorker);
