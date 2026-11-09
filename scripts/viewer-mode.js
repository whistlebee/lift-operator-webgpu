// Run before the upstream engine reads the URL and starts its real-time loop.
(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('simulation')) return;
    url.searchParams.set('simulation', 'true');
    window.history.replaceState(window.history.state, '', url);
})();
