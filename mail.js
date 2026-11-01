'use strict';
/**
 * E-mails de SERVICE (liés à une commande, un compte ou une demande) : modèles + envoi tracé et dédoublonné.
 * Règle : aucun contenu promotionnel ici. Le marketing passe par une liste distincte (consentement explicite, export vers Brevo).
 * Un envoi échoué ne bloque JAMAIS l'action qui l'a déclenché ; chaque e-mail a une clé unique (jamais envoyé deux fois).
 */
const I = require('./invoicing');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' €';
const planName = (p) => (p === 'premium' ? 'Premium' : 'Essentiel');
const strip = (html) => String(html).replace(/<(br|\/p|\/h\d|\/tr|\/li)\s*\/?>/gi, '\n').replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 : $1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();

function templates({ appUrl, seller = {}, brand = process.env.BRAND_NAME || 'EuroVin', supportEmail = process.env.SUPPORT_EMAIL || '' }) {
  const link = (path) => appUrl + path;
  const button = (url, label) => `<p style="margin:24px 0"><a href="${esc(url)}" style="padding:12px 24px;background:#0b57d0;color:#fff;text-decoration:none;border-radius:6px;display:inline-block">${esc(label)}</a></p>`;
  const rows = (pairs) => `<table style="border-collapse:collapse;margin:16px 0;font-size:15px">${pairs.filter(Boolean).map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join('')}</table>`;
  const wrap = (title, body, extraFooter = '') => `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1b1f24"><div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="font-weight:700;font-size:20px;margin-bottom:16px">${esc(brand)}</div><div style="background:#fff;border-radius:8px;padding:28px"><h2 style="margin:0 0 16px;font-size:20px">${esc(title)}</h2><!--INTRO-->${body}</div><p style="color:#6b7280;font-size:12px;line-height:1.5;margin:16px 4px">Cet e-mail de service est lié à votre commande, à votre compte ou à votre demande ; il ne contient aucune publicité.${extraFooter ? ' ' + extraFooter : ''}<br>${esc([seller.name, seller.address].filter(Boolean).join(' — '))}${supportEmail ? ' — ' + esc(supportEmail) : ''} — <a href="${esc(link('/aide'))}" style="color:#6b7280">Aide</a></p></div></body></html>`;
  const mk = (subject, title, body, extraFooter) => { const html = wrap(title, body, extraFooter); return { subject, html, text: strip(html) }; };
  const invoiceLine = (n) => (n ? `<p>Votre facture n° ${esc(n)} est jointe à ce message (PDF). Elle est aussi disponible à tout moment dans <a href="${esc(link('/compte'))}">Mon espace</a>.</p>` : '');
  const account = `<a href="${esc(link('/compte'))}">Mon espace</a>`;

  return {
    welcome: ({ marketing, unsubUrl }) => mk(`Bienvenue sur ${brand}`, 'Bienvenue !',
      `<p>Votre compte est créé. Vous pouvez dès maintenant vérifier un VIN européen et obtenir la liste des options d’usine, traduites en français.</p>${button(link('/'), 'Vérifier un VIN')}
       <p><b>Vous êtes un professionnel ?</b> Renseignez votre société et votre SIRET dans ${account} › Informations : ils sont nécessaires pour acheter des packs de crédits et figurent sur vos factures (TVA récupérable).</p>
       <p>Besoin d’aide ? Répondez à ce message ou passez par la page <a href="${esc(link('/aide'))}">Aide</a>.</p>`,
      marketing ? `Vous avez accepté de recevoir nos actualités : <a href="${esc(unsubUrl)}" style="color:#6b7280">vous désabonner</a> (ou à tout moment dans Mon espace).` : 'Vous n’avez pas demandé à recevoir nos actualités : vous ne recevrez que des e-mails de service.'),

    reportPaid: ({ plan, vin, ttc, invoiceNumber, cgv }) => mk(`Paiement reçu — rapport ${planName(plan)}`, 'Paiement bien reçu',
      `<p>Merci ! Votre rapport est en cours de préparation ; vous recevrez un second e-mail dès qu’il sera prêt (en général en moins d’une minute).</p>${rows([['Rapport', planName(plan)], ['VIN', vin], ['Montant', eur(ttc) + ' TTC']])}${invoiceLine(invoiceNumber)}
       <p style="color:#555;font-size:13px">Vous avez demandé l’exécution immédiate du service et reconnu perdre votre droit de rétractation (CGV version ${esc(cgv)}) — <a href="${esc(link('/cgv'))}">conditions générales de vente</a>. Remboursement automatique si nous ne pouvons pas établir le rapport.</p>`),

    packPaid: ({ credits, balance, ttc, invoiceNumber, company }) => mk(`${credits} crédits ajoutés à votre compte`, 'Crédits ajoutés',
      `<p>Votre paiement est confirmé et vos crédits sont disponibles.</p>${rows([['Pack', `${credits} crédits`], ['Nouveau solde', balance != null ? `${balance} crédits` : null], ['Montant', eur(ttc) + ' TTC'], company ? ['Facturé à', company] : null])}
       ${invoiceLine(invoiceNumber)}<p>1 crédit = 1 rapport Essentiel · 2 crédits = 1 rapport Premium. Utilisez vos crédits depuis la page <a href="${esc(link('/pro'))}">Pro</a>.</p>
       <p style="color:#555;font-size:13px">La facture mentionne le montant HT, la TVA et le TTC : transmettez-la à votre comptable pour récupérer la TVA.</p>`),

    reportReady: ({ plan, vin, url, ttc, cgv, creditCost, balance }) => mk(`Votre rapport — VIN ${vin}`, 'Votre rapport est disponible',
      `${button(url, 'Consulter le rapport')}${rows([['Rapport', planName(plan)], ['VIN', vin], ttc != null ? ['Montant', eur(ttc) + ' TTC'] : null, creditCost ? ['Crédits débités', String(creditCost)] : null, creditCost && balance != null ? ['Solde restant', `${balance} crédits`] : null])}
       <p>Le rapport PDF est joint à ce message. Il reste consultable en ligne pendant 12 mois.${ttc != null ? ' Votre facture vous a été envoyée avec la confirmation de paiement.' : ''}</p>
       ${ttc != null ? `<p style="color:#555;font-size:13px">Vous avez demandé l’exécution immédiate du service et reconnu perdre votre droit de rétractation (CGV version ${esc(cgv)}). <a href="${esc(link('/cgv'))}">Conditions générales de vente</a>.</p>` : ''}
       <p style="color:#555;font-size:13px">Estimation indicative et non contractuelle, fondée sur des données de tiers. Une erreur dans le rapport ? Signalez-la depuis le rapport, nous corrigeons.</p>`),

    delayNotice: ({ vin }) => mk('Votre rapport prend un peu plus de temps', 'Nous nous en occupons',
      `<p>La préparation du rapport pour le VIN <b>${esc(vin)}</b> prend plus de temps que prévu. Rien à faire de votre côté : nous réessayons automatiquement, et si nous ne parvenons pas à l’établir vous serez remboursé automatiquement.</p>`),

    lowCredits: ({ balance }) => mk(`Il vous reste ${balance} crédit${balance > 1 ? 's' : ''}`, 'Solde de crédits faible',
      `<p>Votre solde est de <b>${balance} crédit${balance > 1 ? 's' : ''}</b> (1 crédit = 1 rapport Essentiel, 2 = 1 Premium).</p>${button(link('/pro'), 'Recharger mes crédits')}<p style="color:#555;font-size:13px">Les crédits n’expirent pas tant que votre compte est actif.</p>`),

    creditNote: ({ amountCents, number }) => mk(`Remboursement de ${eur(amountCents)} — avoir ${number}`, 'Remboursement effectué',
      `<p>Nous avons remboursé <b>${eur(amountCents)} TTC</b> sur le moyen de paiement utilisé pour votre commande. Selon votre banque, le montant apparaît sous quelques jours ouvrés.</p><p>Votre avoir n° ${esc(number)} est joint à ce message (PDF) et disponible dans ${account}.</p>`),

    creditRefund: ({ plan, vin, credits }) => mk('Commande remboursée', 'Votre solde a été recrédité',
      `<p>Nous n’avons pas pu établir votre rapport avec suffisamment de données. Votre commande est annulée et <b>${credits} crédit${credits > 1 ? 's ont' : ' a'} été recrédité${credits > 1 ? 's' : ''}</b> automatiquement ; vous n’avez rien à faire.</p>${rows([['Rapport', planName(plan)], ['VIN', vin]])}`),

    refundNoPayment: () => mk('Commande remboursée', 'Commande annulée', '<p>Nous n’avons pas pu établir votre rapport avec suffisamment de données. Votre commande est annulée ; aucun montant n’a été débité.</p>'),

    paymentFailed: () => mk('Votre paiement n’a pas abouti', 'Paiement non finalisé',
      `<p>Votre paiement n’a pas pu être finalisé et aucun montant ne vous a été débité. Vous pouvez recommencer à tout moment.</p>${button(link('/'), 'Recommencer')}`),

    creditsAdjusted: ({ delta, balance, reason }) => mk(delta > 0 ? `${delta} crédit${delta > 1 ? 's' : ''} ajouté${delta > 1 ? 's' : ''} à votre compte` : 'Ajustement de votre solde de crédits', 'Votre solde a été ajusté',
      `<p>Nous avons ${delta > 0 ? 'ajouté' : 'retiré'} <b>${Math.abs(delta)} crédit${Math.abs(delta) > 1 ? 's' : ''}</b> ${delta > 0 ? 'à' : 'de'} votre compte.</p>${rows([['Motif', reason], balance != null ? ['Nouveau solde', `${balance} crédits`] : null])}`),

    proActivated: () => mk('Votre compte Pro est activé', 'Compte Pro activé',
      `<p>Nous avons vérifié votre société : votre compte est désormais un compte <b>Pro</b>.</p>${button(link('/pro'), 'Accéder à l’espace Pro')}<p>Vous pouvez acheter des packs de crédits (10, 30 ou 100) et générer vos rapports en un clic. Chaque facture mentionne HT, TVA et TTC pour votre comptable.</p>`),

    incompleteInvoice: ({ number, missing }) => mk(`Facture ${number} : informations à compléter`, 'Votre facture est incomplète',
      `<p>Pour que votre facture n° ${esc(number)} soit exploitable par votre comptable (TVA récupérable), il manque : <b>${esc(missing.join(', '))}</b>.</p><p>Complétez ces informations dans ${account} › Informations, puis répondez à ce message : nous vous renverrons une facture corrigée.</p>`),

    ticketReceived: ({ subject, reference }) => mk('Nous avons bien reçu votre message', 'Message reçu',
      `<p>Nous avons bien reçu votre demande et reviendrons vers vous par e-mail, en général sous un jour ouvré.</p>${rows([['Sujet', subject], ['Référence', reference]])}`),

    ticketReply: ({ subject, reference, message }) => mk(`Réponse à votre demande : ${subject}`, 'Réponse du support',
      `<p>Voici notre réponse à votre demande « ${esc(subject)} » (référence ${esc(reference)}) :</p><blockquote style="margin:16px 0;padding:12px 16px;background:#f4f5f7;border-left:3px solid #0b57d0;white-space:pre-wrap">${esc(message)}</blockquote><p>Vous pouvez répondre directement à ce message.</p>`),

    ticketClosed: ({ subject, reference }) => mk('Votre demande est traitée', 'Demande traitée',
      `<p>Nous avons clôturé votre demande « ${esc(subject)} » (référence ${esc(reference)}). Si le problème persiste, répondez simplement à ce message.</p>`),

    profileUpdated: ({ fields }) => mk('Vos informations ont été modifiées', 'Informations mises à jour',
      `<p>Les informations suivantes de votre compte viennent d’être modifiées : <b>${esc(fields.join(', '))}</b>.</p><p>Les factures déjà émises ne changent pas. Si vous n’êtes pas à l’origine de cette modification, <a href="${esc(link('/aide'))}">contactez-nous</a> sans attendre et changez votre mot de passe.</p>`),

    marketingChanged: ({ on, unsubUrl }) => mk(on ? 'Vous êtes inscrit à nos actualités' : 'Vous êtes désabonné de nos actualités', on ? 'Inscription confirmée' : 'Désabonnement confirmé',
      on ? `<p>Vous recevrez de temps en temps nos actualités et offres. Vous pouvez vous désabonner à tout moment : <a href="${esc(unsubUrl)}">me désabonner</a>.</p>` : '<p>Vous ne recevrez plus nos actualités. Vous continuerez à recevoir les e-mails liés à vos commandes et à votre compte.</p>'),

    accountDeleted: () => mk('Votre compte a été supprimé', 'Compte supprimé',
      '<p>Votre compte et vos rapports ont été supprimés. Conformément à la loi, vos factures et avoirs sont conservés 10 ans (obligation comptable), séparés de tout compte.</p><p>Merci d’avoir utilisé ' + esc(brand) + '.</p>'),

    reportExpiring: ({ vin, url, days }) => mk(`Votre rapport ${vin} expire dans ${days} jours`, 'Votre rapport bientôt supprimé',
      `<p>Conformément à notre politique de conservation, votre rapport pour le VIN <b>${esc(vin)}</b> sera supprimé dans ${days} jours. Téléchargez-le si vous souhaitez le conserver.</p>${button(url, 'Ouvrir le rapport')}`),

    recallAlert: ({ vin, items, reportUrl, stopUrl, source, asOf }) => mk(`Nouvelle campagne de rappel pour le VIN ${vin}`, 'Nouvelle campagne de rappel publiée',
      `<p>Vous avez demandé à être prévenu si une campagne de rappel apparaissait pour le VIN <b>${esc(vin)}</b>. ${items.length > 1 ? `${items.length} nouvelles campagnes sont apparues` : 'Une nouvelle campagne est apparue'} dans nos sources depuis votre dernier rapport :</p><ul>${items.map((x) => `<li><b>${esc(x.title || 'Campagne de rappel')}</b>${x.ref ? ` (réf. ${esc(x.ref)})` : ''}${x.date ? `, ${esc(x.date)}` : ''}</li>`).join('')}</ul><p>Ce message est <b>informatif</b> : seul le constructeur ou son réseau peut confirmer si votre véhicule est concerné et organiser la réparation, qui est gratuite. Nous vous conseillons de les contacter avec votre VIN.</p>${rows([['Source', source || 'non précisée'], asOf ? ['Données au', asOf] : null])}${button(reportUrl, 'Ouvrir le rapport')}<p style="color:#6b7280;font-size:13px">Vous ne voulez plus recevoir cette alerte ? <a href="${esc(stopUrl)}" style="color:#6b7280">Désactiver l’alerte pour ce VIN</a>.</p>`),

    adminLogin: ({ email, ip, at }) => mk('Connexion à l’administration', 'Nouvelle connexion à l’administration',
      `<p>Une connexion à la console d’administration vient d’avoir lieu avec votre compte <b>${esc(email)}</b>.</p>${rows([['Date', String(at || '').replace('T', ' ').slice(0, 16) + ' UTC'], ['Adresse IP', ip || 'inconnue']])}<p><b>Ce n’était pas vous ?</b> Changez immédiatement votre mot de passe et prévenez le propriétaire du site pour qu’il révoque vos sessions.</p>`),

    adminLocked: ({ email, ip }) => mk('Compte d’administration verrouillé', 'Compte verrouillé 15 minutes',
      `<p>Après plusieurs tentatives de connexion échouées, le compte <b>${esc(email)}</b> est verrouillé pendant 15 minutes.</p>${rows([['Adresse IP', ip || 'inconnue']])}<p>Si ces tentatives ne sont pas les vôtres, demandez au propriétaire de réinitialiser votre mot de passe.</p>`),

    adminDigest: ({ items, date }) => mk(`À traiter aujourd’hui (${items.length})`, `Points à traiter — ${date}`,
      `<p>Voici ce qui demande votre attention :</p><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${button(link('/admin'), 'Ouvrir l’administration')}`),

    monthlyExport: ({ month, invoices, notes, anomalies }) => mk(`Export comptable ${month}`, `Export comptable — ${month}`,
      `<p>Ci-joint l’export du mois : synthèse de la TVA par pays et détail des pièces (${invoices} facture${invoices > 1 ? 's' : ''}, ${notes} avoir${notes > 1 ? 's' : ''}).</p>${anomalies ? `<p><b>${anomalies} pièce${anomalies > 1 ? 's' : ''} à vérifier</b> (TVA à valider ou envoi Pennylane en erreur) : voir la colonne « Statut Pennylane ».</p>` : '<p>Aucune anomalie détectée.</p>'}`),
  };
}


/** Modèles dont le texte d'introduction et l'objet sont modifiables par l'administrateur (les e-mails internes ne le sont pas). */
const TEMPLATE_INFO = {
  welcome: 'Bienvenue (création de compte)', reportPaid: 'Paiement reçu — rapport', packPaid: 'Pack de crédits acheté', reportReady: 'Rapport prêt', delayNotice: 'Commande en retard',
  lowCredits: 'Alerte Pro : solde faible', creditNote: 'Remboursement et avoir', creditRefund: 'Crédits recrédités', refundNoPayment: 'Commande remboursée (sans paiement)', paymentFailed: 'Échec de paiement',
  creditsAdjusted: 'Ajustement de crédits', proActivated: 'Compte Pro activé', incompleteInvoice: 'Facture Pro incomplète', ticketReceived: 'Message support reçu', ticketReply: 'Réponse du support',
  ticketClosed: 'Demande support traitée', profileUpdated: 'Profil modifié', marketingChanged: 'Inscription aux actualités', accountDeleted: 'Compte supprimé', reportExpiring: 'Rapport bientôt supprimé', recallAlert: 'Alerte rappel (nouvelle campagne)',
};
const INTERNAL_INFO = { adminLogin: 'Connexion à l’administration', adminLocked: 'Compte d’administration verrouillé', adminDigest: 'Points à traiter (admin)', monthlyExport: 'Export comptable mensuel' };
const SAMPLES = {
  welcome: { marketing: true, unsubUrl: 'https://exemple.fr/desabonnement?t=exemple' }, reportPaid: { plan: 'premium', vin: 'WBA8E9C50GK123456', ttc: 1299, invoiceNumber: 'EV-2026-000001', cgv: 'v1' },
  packPaid: { credits: 10, balance: 10, ttc: 5880, invoiceNumber: 'EV-2026-000002', company: 'Garage Dupont SARL' }, reportReady: { plan: 'premium', vin: 'WBA8E9C50GK123456', url: 'https://exemple.fr/report/exemple', ttc: 1299, cgv: 'v1' },
  delayNotice: { vin: 'WBA8E9C50GK123456' }, lowCredits: { balance: 1 }, creditNote: { amountCents: 1299, number: 'AV-2026-000001' }, creditRefund: { plan: 'premium', vin: 'WBA8E9C50GK123456', credits: 2 },
  refundNoPayment: {}, paymentFailed: {}, creditsAdjusted: { delta: 5, balance: 5, reason: 'Geste commercial' }, proActivated: {}, incompleteInvoice: { number: 'EV-2026-000002', missing: ['SIREN'] },
  ticketReceived: { subject: 'Question', reference: 'A1B2C3D4' }, ticketReply: { subject: 'Question', reference: 'A1B2C3D4', message: 'Bonjour, c’est réglé.' }, ticketClosed: { subject: 'Question', reference: 'A1B2C3D4' },
  profileUpdated: { fields: ['société'] }, marketingChanged: { on: true, unsubUrl: 'https://exemple.fr/desabonnement?t=exemple' }, accountDeleted: {}, reportExpiring: { vin: 'WBA8E9C50GK123456', url: 'https://exemple.fr/report/exemple', days: 7 },
  recallAlert: { vin: 'WBA8E9C50GK123456', items: [{ ref: 'EXEMPLE-01', date: '10/2026', title: 'Campagne d’exemple (démonstration)' }], reportUrl: 'https://exemple.fr/report/exemple', stopUrl: 'https://exemple.fr/rappels/arret?t=exemple', source: 'Source d’exemple', asOf: '07/10/2026' },
};
const cleanOv = (v) => {
  const out = {}; if (!v || typeof v !== 'object') return out;
  for (const k of Object.keys(TEMPLATE_INFO)) {
    const o = v[k]; if (!o || typeof o !== 'object') continue;
    const subject = String(o.subject || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 150), intro = String(o.intro || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, 1200);
    if (subject || intro) out[k] = { subject, intro };
  }
  return out;
};

function createMailer({ supabase, resend, from, appUrl, env = process.env, log = console, overrides = () => ({}) }) {
  const seller = I.sellerFromEnv(env), brand = env.BRAND_NAME || 'EuroVin';
  const base = templates({ appUrl, seller, brand, supportEmail: env.SUPPORT_EMAIL || '' });
  // Textes personnalisés (objet et paragraphe d'introduction) : toujours échappés, jamais de HTML saisi.
  const render = (k, a, o) => {
    const t = base[k](...a); let html = t.html, subject = t.subject;
    if (o && TEMPLATE_INFO[k]) {
      if (o.subject) subject = o.subject.replace(/\{marque\}/gi, brand);
      if (o.intro) html = html.replace('<!--INTRO-->', o.intro.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''));
    }
    html = html.replace('<!--INTRO-->', '');
    return { subject, html, text: strip(html) };
  };
  const T = {};
  for (const k of Object.keys(base)) T[k] = (...a) => render(k, a, (overrides() || {})[k]);

  const MAX = 3;

  /**
   * Envoie un e-mail de service. key = identifiant unique de l'événement (dédoublonnage).
   * Ne lève jamais. Renvoie 'sent' | 'skipped' (déjà envoyé / en cours / trop d'essais) | 'failed'.
   */
  async function send({ key, kind, to, tpl, attachments, userId, headers, maxAttempts = MAX }) {
    const rcpt = [].concat(to).filter(Boolean);
    if (!rcpt.length) return 'skipped';
    const nowIso = () => new Date().toISOString();
    let logged = true;
    try {
      const ins = await supabase.from('email_log').insert({ dedupe_key: key, kind, to_email: rcpt.join(','), subject: tpl.subject, status: 'sending', attempts: 1, user_id: userId || null, attempted_at: nowIso() });
      if (ins && ins.error) {
        if (ins.error.code !== '23505') logged = false;                        // journal indisponible : on envoie quand même
        else {
          const { data: ex } = await supabase.from('email_log').select('status,attempts,attempted_at').eq('dedupe_key', key).maybeSingle();
          if (!ex || ex.status === 'sent' || ex.attempts >= maxAttempts) return 'skipped';
          const stale = ex.status === 'sending' && Date.parse(ex.attempted_at || 0) < Date.now() - 10 * 60e3;   // envoi interrompu (arrêt du serveur) : on reprend
          if (ex.status === 'sending' && !stale) return 'skipped';
          const { data: claimed } = await supabase.from('email_log').update({ status: 'sending', attempts: ex.attempts + 1, attempted_at: nowIso() }).eq('dedupe_key', key).eq('status', ex.status).select();
          if (!claimed || !claimed.length) return 'skipped';
        }
      }
    } catch (e) { logged = false; }
    try {
      await resend.emails.send({ from, to: rcpt, subject: tpl.subject, html: tpl.html, text: tpl.text, ...(env.SUPPORT_EMAIL ? { reply_to: env.SUPPORT_EMAIL } : {}), ...(attachments && attachments.length ? { attachments } : {}), ...(headers ? { headers } : {}) });
      if (logged) await supabase.from('email_log').update({ status: 'sent', sent_at: nowIso(), error: null }).eq('dedupe_key', key);
      return 'sent';
    } catch (e) {
      log.error(`E-mail « ${kind} » non envoyé :`, e.message);
      if (logged) await supabase.from('email_log').update({ status: 'failed', error: String(e.message).slice(0, 300) }).eq('dedupe_key', key).then(() => {}, () => {});
      return 'failed';
    }
  }
  return { send, T, esc, eur, base, render };
}

module.exports = { createMailer, templates, esc, eur, strip, TEMPLATE_INFO, INTERNAL_INFO, SAMPLES, cleanOv };
