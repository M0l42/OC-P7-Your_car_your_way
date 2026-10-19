import { Injectable, signal } from '@angular/core';

// FR/EN strings (premise 6: no i18n framework). French is the default; `?lang=en` or an English
// browser switches to English.

const fr = {
  appTitle: 'Your Car Your Way — tchat support',
  customerHeading: 'Contacter le support',
  agentHeading: 'Espace conseiller',
  skipToComposer: 'Aller à la saisie du message',
  instance: 'Instance',
  instanceUnknown: 'déconnecté',
  stateIdle: 'Hors ligne',
  stateConnecting: 'Connexion…',
  stateSubscribing: 'Synchronisation…',
  stateReady: 'Connecté',
  stateWaiting: 'Connexion perdue, nouvelle tentative…',
  stateRenewing: 'Renouvellement de la session…',
  stateStopped: 'Déconnecté',
  connectionLost: 'Connexion perdue. Reconnexion en cours…',
  connectionRestored: (n: number) =>
    n === 0 ? 'Connexion rétablie, aucun message manqué' : n === 1 ? 'Connexion rétablie, 1 message récupéré' : `Connexion rétablie, ${n} messages récupérés`,
  historyLoaded: (n: number) => (n === 0 ? 'Conversation ouverte' : n === 1 ? '1 message chargé' : `${n} messages chargés`),
  openIntro: 'Un conseiller vous répond par écrit. Indiquez votre référence de réservation si vous en avez une.',
  reservationLabel: 'Référence de réservation (facultatif)',
  reservationHint: 'Par exemple YCYW-2026-000123',
  openButton: 'Démarrer la conversation',
  opening: 'Ouverture de la conversation…',
  openFailed: 'La conversation n’a pas pu être ouverte. Réessayez.',
  conversationTitle: (id: number) => `Conversation n° ${id}`,
  statusLabel: 'Statut',
  status_en_attente: 'En attente d’un conseiller',
  status_en_cours: 'Prise en charge par un conseiller',
  status_cloturee: 'Clôturée',
  messagesLabel: 'Messages',
  noMessages: 'Aucun message pour l’instant.',
  you: 'Vous',
  customer: 'Client',
  agent: 'Conseiller',
  system: 'Système',
  eventClaimed: 'Un conseiller a pris en charge la conversation.',
  eventClosedBy: (who: string) => `Conversation clôturée par ${who}.`,
  echo_sending: 'envoi…',
  echo_sent: 'envoyé',
  echo_failed: 'non envoyé',
  sendFailed: (reason: string) => `Message non envoyé : ${reason}`,
  dismiss: 'Retirer',
  error_CONVERSATION_CLOSED: 'la conversation est clôturée',
  error_FORBIDDEN: 'action non autorisée',
  error_NOT_FOUND: 'conversation introuvable',
  error_INVALID_CONTENT: 'contenu invalide',
  error_INVALID_REQUEST: 'requête invalide',
  error_ALREADY_CLAIMED: 'déjà prise en charge par un autre conseiller',
  error_generic: 'erreur inattendue',
  composerLabel: 'Votre message',
  composerHint: (max: number) => `Entrée pour envoyer, Maj+Entrée pour aller à la ligne. ${max} caractères maximum.`,
  charCount: (n: number, max: number) => `${n} / ${max} caractères`,
  send: 'Envoyer',
  emptyMessage: 'Le message est vide.',
  tooLong: (max: number) => `Le message dépasse ${max} caractères.`,
  close: 'Clôturer la conversation',
  closing: 'Clôture…',
  closeFailed: (reason: string) => `Clôture impossible : ${reason}`,
  closedNotice: 'Cette conversation est clôturée.',
  newConversation: 'Nouvelle conversation',
  queueHeading: 'File d’attente',
  queueCount: (shown: number, total: number) =>
    total === 0 ? 'Aucune conversation en attente' : shown < total ? `${shown} ${shown === 1 ? 'affichée' : 'affichées'} sur ${total} en attente` : `${total} en attente`,
  queueEmpty: 'Aucune conversation en attente.',
  queueItem: (id: number, ref: string | null) => `Conversation n° ${id}${ref ? `, réservation ${ref}` : ''}`,
  waitingSince: 'en attente depuis',
  claim: 'Prendre en charge',
  claimNamed: (id: number) => `Prendre en charge la conversation n° ${id}`,
  claimed: (id: number) => `Conversation n° ${id} prise en charge`,
  claimLost: (id: number) => `Conversation n° ${id} déjà prise en charge par un autre conseiller`,
  myConversations: 'Mes conversations',
  noMyConversations: 'Aucune conversation prise en charge.',
  openConversation: (id: number) => `Ouvrir la conversation n° ${id}`,
  selectConversation: 'Sélectionnez une conversation pour l’afficher.',
  language: 'English',
  languageSwitch: 'Switch to English',
};

export type Strings = typeof fr;

const en: Strings = {
  appTitle: 'Your Car Your Way — support chat',
  customerHeading: 'Contact support',
  agentHeading: 'Agent workspace',
  skipToComposer: 'Skip to message input',
  instance: 'Instance',
  instanceUnknown: 'disconnected',
  stateIdle: 'Offline',
  stateConnecting: 'Connecting…',
  stateSubscribing: 'Synchronising…',
  stateReady: 'Connected',
  stateWaiting: 'Connection lost, retrying…',
  stateRenewing: 'Renewing session…',
  stateStopped: 'Disconnected',
  connectionLost: 'Connection lost. Reconnecting…',
  connectionRestored: (n) =>
    n === 0 ? 'Connection restored, no message missed' : n === 1 ? 'Connection restored, 1 message recovered' : `Connection restored, ${n} messages recovered`,
  historyLoaded: (n) => (n === 0 ? 'Conversation opened' : n === 1 ? '1 message loaded' : `${n} messages loaded`),
  openIntro: 'An agent will answer you in writing. Give your booking reference if you have one.',
  reservationLabel: 'Booking reference (optional)',
  reservationHint: 'For example YCYW-2026-000123',
  openButton: 'Start the conversation',
  opening: 'Opening the conversation…',
  openFailed: 'The conversation could not be opened. Please try again.',
  conversationTitle: (id) => `Conversation #${id}`,
  statusLabel: 'Status',
  status_en_attente: 'Waiting for an agent',
  status_en_cours: 'Handled by an agent',
  status_cloturee: 'Closed',
  messagesLabel: 'Messages',
  noMessages: 'No messages yet.',
  you: 'You',
  customer: 'Customer',
  agent: 'Agent',
  system: 'System',
  eventClaimed: 'An agent took over the conversation.',
  eventClosedBy: (who) => `Conversation closed by ${who}.`,
  echo_sending: 'sending…',
  echo_sent: 'sent',
  echo_failed: 'not sent',
  sendFailed: (reason) => `Message not sent: ${reason}`,
  dismiss: 'Remove',
  error_CONVERSATION_CLOSED: 'the conversation is closed',
  error_FORBIDDEN: 'action not allowed',
  error_NOT_FOUND: 'conversation not found',
  error_INVALID_CONTENT: 'invalid content',
  error_INVALID_REQUEST: 'invalid request',
  error_ALREADY_CLAIMED: 'already taken by another agent',
  error_generic: 'unexpected error',
  composerLabel: 'Your message',
  composerHint: (max) => `Enter to send, Shift+Enter for a new line. ${max} characters maximum.`,
  charCount: (n, max) => `${n} / ${max} characters`,
  send: 'Send',
  emptyMessage: 'The message is empty.',
  tooLong: (max) => `The message is longer than ${max} characters.`,
  close: 'Close the conversation',
  closing: 'Closing…',
  closeFailed: (reason) => `Cannot close: ${reason}`,
  closedNotice: 'This conversation is closed.',
  newConversation: 'New conversation',
  queueHeading: 'Queue',
  queueCount: (shown, total) =>
    total === 0 ? 'No conversation waiting' : shown < total ? `${shown} shown of ${total} waiting` : `${total} waiting`,
  queueEmpty: 'No conversation waiting.',
  queueItem: (id, ref) => `Conversation #${id}${ref ? `, booking ${ref}` : ''}`,
  waitingSince: 'waiting since',
  claim: 'Take over',
  claimNamed: (id) => `Take over conversation #${id}`,
  claimed: (id) => `Conversation #${id} taken over`,
  claimLost: (id) => `Conversation #${id} was already taken by another agent`,
  myConversations: 'My conversations',
  noMyConversations: 'No conversation taken over.',
  openConversation: (id) => `Open conversation #${id}`,
  selectConversation: 'Select a conversation to display it.',
  language: 'Français',
  languageSwitch: 'Passer en français',
};

export type Lang = 'fr' | 'en';

export function detectLang(search: string, navigatorLang: string | undefined): Lang {
  const q = new URLSearchParams(search).get('lang');
  if (q === 'en' || q === 'fr') return q;
  return navigatorLang?.toLowerCase().startsWith('en') ? 'en' : 'fr';
}

@Injectable({ providedIn: 'root' })
export class I18n {
  readonly lang = signal<Lang>(
    typeof window !== 'undefined' ? detectLang(window.location.search, window.navigator?.language) : 'fr',
  );

  get t(): Strings {
    return this.lang() === 'en' ? en : fr;
  }

  constructor() {
    this.applyDocumentLang();
  }

  toggle(): void {
    this.lang.set(this.lang() === 'en' ? 'fr' : 'en');
    this.applyDocumentLang();
  }

  /** Maps a server/client error code to a readable reason. */
  reason(code: string | undefined): string {
    const key = `error_${code}` as keyof Strings;
    const v = code ? this.t[key] : undefined;
    return typeof v === 'string' ? v : this.t.error_generic;
  }

  private applyDocumentLang(): void {
    if (typeof document !== 'undefined') document.documentElement.lang = this.lang();
  }
}
