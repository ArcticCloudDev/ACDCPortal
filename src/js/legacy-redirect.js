// Legacy entry points (index.html, login.html, interest.html, my-page.html, team-admin.html)
// only forward to the current page. One external script keeps every stub free of inline code
// so the strict Content-Security-Policy can be enforced.
(function () {
    const path = window.location.pathname.toLowerCase();
    const params = new URLSearchParams(window.location.search);
    let target;

    if (path.endsWith('/login.html')) {
        target = '/register.html' + (params.toString() ? '?' + params.toString() : '');
    } else if (path.endsWith('/interest.html')) {
        const eventId = params.get('eventId') || params.get('event');
        target = eventId
            ? `/register.html?intent=interest&eventId=${encodeURIComponent(eventId)}`
            : '/register.html?intent=interest';
    } else if (path.endsWith('/my-page.html') || path.endsWith('/team-admin.html')) {
        target = '/events.html';
    } else {
        // index.html, "/" and every unknown path the static host rewrites to index.html.
        const inviteId = params.get('invite');
        target = inviteId
            ? `/accept-invitation.html?invite=${encodeURIComponent(inviteId)}`
            : `/events.html${window.location.search || ''}${window.location.hash || ''}`;
    }

    window.location.replace(target);
})();
