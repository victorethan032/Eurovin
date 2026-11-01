/* Démonstration uniquement : lien « Admin » + console d'administration interactive (données fictives, mot de passe de démonstration). */
(function () {
  const D = window.EV_DEMO_DATA || {}; if (!D.adminDoc) return;
  const css = '#adm-b{border:1px solid var(--line,#d2d2d7);background:transparent;color:inherit;border-radius:99px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer;margin-left:10px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}#adm-b:hover{background:var(--fill,#f2f2f4)}#adm-o{position:fixed;inset:0;z-index:100;background:Canvas;display:none;flex-direction:column}#adm-o.o{display:flex}#adm-o .bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(128,128,128,.3);font:600 14px Arial,sans-serif}#adm-o .bar button{border:0;border-radius:99px;background:#0b57d0;color:#fff;padding:8px 16px;font:600 14px Arial,sans-serif;cursor:pointer}#adm-o iframe{flex:1;border:0;width:100%}@media(max-width:700px){#adm-b{margin-left:0;padding:10px 14px;min-height:44px;font-size:14px}#adm-o{padding-top:env(safe-area-inset-top,0px)}#adm-o .bar{padding:8px 12px}#adm-o .bar button{min-height:44px}}';
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const ov = document.createElement('div'); ov.id = 'adm-o'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Administration (démonstration)');
  ov.innerHTML = '<div class="bar"><span>Administration — démonstration · données fictives</span><button type="button" id="adm-x">Retour au site</button></div>';
  document.body.appendChild(ov);
  let fr = null;
  const open = () => {
    if (!fr) { fr = document.createElement('iframe'); fr.title = 'Administration (démonstration)'; fr.setAttribute('sandbox', 'allow-scripts allow-downloads allow-forms'); fr.srcdoc = D.adminDoc; ov.appendChild(fr); }
    ov.classList.add('o'); document.body.style.overflow = 'hidden';
  };
  const close = () => { ov.classList.remove('o'); document.body.style.overflow = ''; if (window.EV_route) window.EV_route(); };
  const btn = document.createElement('button'); btn.id = 'adm-b'; btn.type = 'button'; btn.innerHTML = '<span aria-hidden="true">🔒</span> Admin'; btn.title = 'Accès administrateur (démonstration)'; btn.setAttribute('aria-label', 'Accès administrateur (démonstration)');
  const nav = document.querySelector('.topnav'); if (nav) nav.appendChild(btn);
  btn.onclick = open; document.getElementById('adm-x').onclick = close;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ov.classList.contains('o')) close(); });
  window.addEventListener('message', (e) => {
    if (!fr || e.source !== fr.contentWindow || !e.data || e.data.type !== 'ev-site' || typeof e.data.site !== 'object') return;
    window.EV_DEMO_SITE = e.data.site; if (window.EV_applySite) window.EV_applySite(e.data.site);
  });
})();
