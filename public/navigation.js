const routes = new Set(['home', 'solo', 'championship', 'stats', 'history', 'race']);

// Hash routes keep navigation inside this document, preserving the live connection.
export function createNavigation({ beforeNavigate, onChange }) {
  let current = null;
  const readRoute = (hash = location.hash) => {
    if (['#run-ranking', '#statistics'].includes(hash)) return 'stats';
    const route = hash.replace(/^#\/?/, '');
    return routes.has(route) ? route : 'home';
  };
  function go(route, { replace = false, force = false, fromHistory = false } = {}) {
    if (!routes.has(route)) route = 'home';
    if (!force && route !== current && !beforeNavigate(route)) {
      if (fromHistory) history.replaceState(null, '', `#/${current}`);
      return;
    }
    const changed = current !== route;
    current = route;
    if (location.hash !== `#/${route}`) history[replace || fromHistory ? 'replaceState' : 'pushState'](null, '', `#/${route}`);
    document.querySelectorAll('[data-app-view]').forEach(view => { view.hidden = !view.dataset.appView.split(' ').includes(route); });
    document.querySelectorAll('.menu-link').forEach(link => {
      if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    onChange(route);
    if (changed) {
      const heading = document.querySelector('[data-app-view]:not([hidden]) [data-view-heading]');
      (heading && !heading.closest('[hidden]') ? heading : document.querySelector('main')).focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }
  document.addEventListener('click', event => {
    if (event.target.closest('.skip-link')) {
      event.preventDefault();
      document.querySelector('main').focus();
      return;
    }
    const link = event.target.closest('a[data-route]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(link.dataset.route);
  });
  window.addEventListener('hashchange', event => go(readRoute(new URL(event.newURL).hash), { fromHistory: true }));
  // A timing packet may arrive before a queued hashchange. Refresh the view
  // without replacing that pending navigation or adding a history entry.
  return { get current() { return current; }, go, start() { go(readRoute(), { force: true, replace: true }); }, refresh() { onChange(current); } };
}
