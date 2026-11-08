// German translation of the app.
//
// The app is written in English. In German, every piece of interface text that
// appears on screen (text, placeholders, labels, toasts, dialogs) is swapped for
// its German version as it appears, using the dictionary and patterns below.
// What people write – messages, names, captions – is never translated.

export type Lang = 'en' | 'de';
export type LangSetting = 'auto' | Lang;

const KEY = 'haven.lang';

export function langSetting(): LangSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'en' || v === 'de' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function currentLang(): Lang {
  const s = langSetting();
  if (s !== 'auto') return s;
  return (navigator.languages?.[0] || navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function setLangSetting(v: LangSetting) {
  try {
    if (v === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch { /* fine */ }
}

// ------------------------------------------------------------------ dictionary

const DE: Record<string, string> = {
  // Tabs, titles, common
  'Today': 'Heute', 'Chats': 'Chats', 'Settings': 'Einstellungen', 'Vlog your Day': 'Vlog your Day', 'Main': 'Navigation',
  'Cancel': 'Abbrechen', 'Done': 'Fertig', 'Save': 'Sichern', 'Continue': 'Weiter', 'Back': 'Zurück', 'Close': 'Schließen', 'Delete': 'Löschen',
  'Edit': 'Bearbeiten', 'Remove': 'Entfernen', 'Skip': 'Überspringen', 'Later': 'Später', 'Not now': 'Nicht jetzt', 'Try again': 'Erneut versuchen',
  'Copy': 'Kopieren', 'Copied': 'Kopiert', 'Could not copy': 'Konnte nicht kopieren', 'Share': 'Teilen', 'Search': 'Suchen', 'Send': 'Senden',
  'Create': 'Erstellen', 'Creating…': 'Wird erstellt…', 'Start': 'Starten', 'Start again': 'Neu starten', 'Loading': 'Lädt', 'Options': 'Optionen',
  'Info': 'Info', 'Off': 'Aus', 'On': 'An', 'Turn on': 'Einschalten', 'Turn off': 'Ausschalten', 'Accept': 'Annehmen', 'Review': 'Prüfen',
  'Restore': 'Wiederherstellen', 'Post': 'Posten', 'Earlier': 'Früher', 'Yesterday': 'Gestern', 'Reply': 'Antworten', 'Pin': 'Anpinnen',
  'Unpin': 'Lösen', 'Pinned': 'Angepinnt', 'Encrypted': 'Verschlüsselt', 'Find': 'Finden', 'Link': 'Verknüpfen', 'Tap': 'Tippe', 'Name': 'Name',
  'Something went wrong': 'Etwas ist schiefgelaufen', 'Something went wrong.': 'Etwas ist schiefgelaufen.',
  'You appear to be offline.': 'Du scheinst offline zu sein.', 'You are offline.': 'Du bist offline.', 'Connecting…': 'Verbinde…',

  // Welcome & sign-in
  'Private conversations, on your terms.': 'Private Gespräche, zu deinen Bedingungen.',
  'End-to-end': 'Ende-zu-Ende', 'Every message is encrypted on your device.': 'Jede Nachricht wird auf deinem Gerät verschlüsselt.',
  'Delete on delivery': 'Gelöscht nach Zustellung', 'The server forgets messages once they arrive.': 'Der Server vergisst Nachrichten, sobald sie angekommen sind.',
  'Verified': 'Verifiziert', 'Compare safety numbers with the people you talk to.': 'Vergleiche Sicherheitsnummern mit deinen Kontakten.',
  'Get started': 'Los geht’s', 'Link to an existing account': 'Mit bestehendem Konto verknüpfen', 'Use another number': 'Andere Nummer verwenden',
  'You were signed out. Sign in again to keep your chats on this device.': 'Du wurdest abgemeldet. Melde dich wieder an, um deine Chats auf diesem Gerät zu behalten.',
  'Your phone number': 'Deine Handynummer', 'Phone number': 'Handynummer', 'Country': 'Land', 'Search countries': 'Länder suchen',
  'Please enter a valid mobile number.': 'Bitte gib eine gültige Handynummer ein.', 'Please enter a valid number.': 'Bitte gib eine gültige Nummer ein.',
  'Share my phone number': 'Meine Nummer teilen', 'This confirmation expired.': 'Diese Bestätigung ist abgelaufen.', 'Please start again.': 'Bitte starte neu.',
  'This number is protected with a PIN. Enter it to sign in on this device.': 'Diese Nummer ist mit einer PIN geschützt. Gib sie ein, um dich auf diesem Gerät anzumelden.',
  'Your profile': 'Dein Profil', 'Profile': 'Profil', 'Your name': 'Dein Name', 'Add a name and a photo so people know it’s you.': 'Füge einen Namen und ein Foto hinzu, damit man dich erkennt.',
  'Choose profile photo': 'Profilbild wählen', 'Change profile photo': 'Profilbild ändern', 'Move and Scale': 'Bewegen und skalieren',
  'Choose': 'Wählen', 'Zoom': 'Zoom', 'Invitation': 'Einladung',
  'Get started, and you can join right after.': 'Leg los – danach kannst du direkt beitreten.',
  'Tap Share, then “Add to Home Screen”.': 'Tippe auf Teilen und dann „Zum Home-Bildschirm“.',
  'Open Haven from your Home Screen and sign up.': 'Öffne Haven vom Home-Bildschirm und registriere dich.',
  'Tap “I already have a friend group” and paste this link.': 'Tippe auf „Ich habe schon eine Freundesgruppe“ und füge diesen Link ein.',
  'Copy invite link': 'Einladungslink kopieren',

  // Today / Vlog your Day
  'Today it’s': 'Heute ist dran', 'Today it’s you': 'Heute bist du dran', 'Vlog your day': 'Vlogge deinen Tag', 'Your day is vlogged': 'Dein Tag ist gevloggt',
  'Thanks for sharing. Your friends can follow your day now.': 'Danke fürs Teilen. Deine Freunde können deinen Tag jetzt verfolgen.',
  'Share up to 3 videos (6 minutes in total) or 6 photos, or mix them.': 'Teile bis zu 3 Videos (insgesamt 6 Minuten) oder 6 Fotos – oder mische sie.',
  'A video counts as 2 photos.': 'Ein Video zählt wie 2 Fotos.', 'Take video': 'Video aufnehmen', 'Choose video': 'Video wählen',
  'Take photo': 'Foto aufnehmen', 'Choose photo': 'Foto wählen', '6 min used': '6 Min. verbraucht', 'No room for a video': 'Kein Platz für ein Video',
  'Friend group': 'Freundesgruppe', 'Invite': 'Einladen', 'Group chat': 'Gruppenchat', 'You': 'Du',
  'Vlogs are end-to-end encrypted. The server deletes them after a week; your devices keep them.': 'Vlogs sind Ende-zu-Ende-verschlüsselt. Der Server löscht sie nach einer Woche, deine Geräte behalten sie.',
  'Your friends’ day, every day': 'Der Tag deiner Freunde – jeden Tag',
  'Pick the friends in your group. Every day one of you is chosen at random to vlog their day:': 'Wähle die Freunde für deine Gruppe. Jeden Tag wird einer von euch zufällig ausgewählt und vloggt seinen Tag:',
  '3 videos (6 minutes)': '3 Videos (6 Minuten)', '6 photos': '6 Fotos', '. Everyone else follows along.': '. Alle anderen schauen zu.', 'or': 'oder',
  'Choose your friend group': 'Wähle deine Freundesgruppe', 'Get a push when it’s your turn': 'Bekomme eine Push-Nachricht, wenn du dran bist',
  'Share your day, end-to-end encrypted': 'Teile deinen Tag, Ende-zu-Ende-verschlüsselt', 'Choose friends': 'Freunde wählen',
  'I already have a friend group': 'Ich habe schon eine Freundesgruppe',
  'Waiting for friends': 'Warte auf Freunde', 'Invite at least one friend': 'Lade mindestens einen Freund ein',
  'As soon as your group has two people, someone gets picked every day.': 'Sobald eure Gruppe zwei Leute hat, wird jeden Tag jemand ausgewählt.',
  'Invite friends': 'Freunde einladen', 'Share invite link': 'Einladungslink teilen', 'Add from your contacts': 'Aus deinen Kontakten hinzufügen',
  'Invite link': 'Einladungslink', 'Copy link': 'Link kopieren', 'Link copied': 'Link kopiert', 'Make a new link': 'Neuen Link erstellen',
  'Make a new link?': 'Neuen Link erstellen?', 'New link': 'Neuer Link', 'New link ready': 'Neuer Link erstellt',
  'The current link stops working. People who already joined stay in the group.': 'Der aktuelle Link funktioniert dann nicht mehr. Wer schon beigetreten ist, bleibt in der Gruppe.',
  'Join your friend group': 'Tritt deiner Freundesgruppe bei', 'Ask for the invite link': 'Frag nach dem Einladungslink',
  'Ask the person who created your friend group for the invite link. Open it, and you can join right away.': 'Frag die Person, die eure Freundesgruppe erstellt hat, nach dem Einladungslink. Öffne ihn, und du kannst direkt beitreten.',
  'Paste invite link': 'Einladungslink einfügen', '…or paste the link here': '…oder füge den Link hier ein', 'Invite link ': 'Einladungslink',
  'No invite link on the clipboard': 'Kein Einladungslink in der Zwischenablage', 'Paste the link into the field': 'Füge den Link in das Feld ein',
  'That’s not an invite link': 'Das ist kein Einladungslink', 'You’re already in this group': 'Du bist schon in dieser Gruppe',
  'You’re already in another friend group. For now you can be in one group at a time.': 'Du bist schon in einer anderen Freundesgruppe. Im Moment geht nur eine Gruppe gleichzeitig.',
  'created this friend group.': 'hat diese Freundesgruppe erstellt.', 'member': 'Mitglied', 'members': 'Mitglieder',
  '. Every day one of you vlogs their day.': '. Jeden Tag vloggt einer von euch seinen Tag.',
  'Your friend group': 'Deine Freundesgruppe', 'Friend group created': 'Freundesgruppe erstellt',
  'Every day one person from this group is picked at random and vlogs their day for the others: 3 videos (6 minutes) or 6 photos.': 'Jeden Tag wird eine Person aus dieser Gruppe zufällig ausgewählt und vloggt ihren Tag für die anderen: 3 Videos (6 Minuten) oder 6 Fotos.',
  'Only your friend group can see it.': 'Nur deine Freundesgruppe sieht es.', 'Post to your vlog': 'In deinen Vlog posten', 'Add a caption': 'Bildunterschrift hinzufügen',
  'Delete post': 'Post löschen', 'Delete this post?': 'Diesen Post löschen?', 'It will be removed for everyone in your friend group.': 'Er wird für alle in deiner Freundesgruppe entfernt.',
  'No posts on this day.': 'An diesem Tag gibt es keine Posts.', 'post': 'Post', 'posts': 'Posts', 'no posts': 'keine Posts', 'Former member': 'Ehemaliges Mitglied',
  'Notifications': 'Benachrichtigungen', 'No notifications yet': 'Noch keine Benachrichtigungen',
  'When someone reacts to your messages or vlogs, or a friend posts their day, you’ll see it here.': 'Wenn jemand auf deine Nachrichten oder Vlogs reagiert oder ein Freund seinen Tag postet, siehst du es hier.',
  'just vlogged': 'hat gerade gevloggt', 'joined your friend group': 'ist deiner Freundesgruppe beigetreten', 'mentioned you': 'hat dich erwähnt',
  'A new day has started. Check who vlogs today.': 'Ein neuer Tag hat begonnen. Schau, wer heute vloggt.',
  'Add a reaction': 'Reaktion hinzufügen', 'Reaction': 'Reaktion', 'Reactions': 'Reaktionen', 'Search emoji': 'Emoji suchen', 'No emoji found.': 'Kein Emoji gefunden.',
  'Recently used': 'Zuletzt verwendet', 'Smileys & Emotion': 'Smileys & Emotionen', 'People & Body': 'Menschen & Körper', 'Animals & Nature': 'Tiere & Natur',
  'Food & Drink': 'Essen & Trinken', 'Travel & Places': 'Reisen & Orte', 'Activities': 'Aktivitäten', 'Objects': 'Objekte', 'Symbols': 'Symbole', 'Flags': 'Flaggen',
  'Emoji categories': 'Emoji-Kategorien', 'The emoji could not be loaded. Check your connection and try again.': 'Die Emojis konnten nicht geladen werden. Prüfe deine Verbindung und versuche es erneut.',
  'Play video': 'Video abspielen', 'Open photo': 'Foto öffnen', 'posting…': 'wird gepostet…', 'not sent': 'nicht gesendet',

  // Chats list & chat
  'Search chats': 'Chats durchsuchen', 'New chat': 'Neuer Chat', 'No chats yet': 'Noch keine Chats', 'Start a chat': 'Chat starten',
  'Mark as read': 'Als gelesen markieren', 'Delete chat': 'Chat löschen', 'Messages in this chat will be deleted from this device.': 'Die Nachrichten in diesem Chat werden von diesem Gerät gelöscht.',
  'Message': 'Nachricht', 'Sending is paused': 'Senden ist pausiert', 'Share photo, video, location and more': 'Foto, Video, Standort und mehr teilen',
  'Record voice message': 'Sprachnachricht aufnehmen', 'Send voice message': 'Sprachnachricht senden', 'Cancel recording': 'Aufnahme abbrechen', 'Cancel reply': 'Antwort abbrechen',
  'Hold on a little longer to record.': 'Halte etwas länger gedrückt, um aufzunehmen.', 'Voice messages are not supported in this browser.': 'Sprachnachrichten werden in diesem Browser nicht unterstützt.',
  'Haven needs microphone access to record. You can allow it in your settings.': 'Haven braucht Zugriff aufs Mikrofon. Du kannst ihn in deinen Einstellungen erlauben.',
  'Messages are end-to-end encrypted. Only the people in this chat can read them, not even Haven.': 'Nachrichten sind Ende-zu-Ende-verschlüsselt. Nur die Personen in diesem Chat können sie lesen, nicht einmal Haven.',
  'End-to-end encrypted': 'Ende-zu-Ende-verschlüsselt', 'online': 'online', 'typing…': 'schreibt…',
  'Copy ': 'Kopieren', 'Edit message': 'Nachricht bearbeiten', 'Everyone in the chat sees the new text, marked as edited.': 'Alle im Chat sehen den neuen Text, markiert als bearbeitet.',
  'edited': 'bearbeitet', 'Delete for everyone': 'Für alle löschen', 'Delete for everyone?': 'Für alle löschen?', 'Delete for me': 'Für mich löschen',
  'This message will be deleted for everyone in this chat.': 'Diese Nachricht wird für alle in diesem Chat gelöscht.',
  'This message was deleted': 'Diese Nachricht wurde gelöscht', 'You deleted this message': 'Du hast diese Nachricht gelöscht',
  'This message could not be decrypted on this device.': 'Diese Nachricht konnte auf diesem Gerät nicht entschlüsselt werden.',
  'That message is no longer on this device.': 'Diese Nachricht ist nicht mehr auf diesem Gerät.', 'Could not delete': 'Konnte nicht löschen', 'Could not react': 'Konnte nicht reagieren',
  'Could not pin': 'Konnte nicht anpinnen', 'Could not unpin': 'Konnte nicht lösen', 'Try again ': 'Erneut versuchen',
  'You are no longer a member of this group.': 'Du bist kein Mitglied dieser Gruppe mehr.', 'This chat is no longer available.': 'Dieser Chat ist nicht mehr verfügbar.',
  'This account has been deleted.': 'Dieses Konto wurde gelöscht.', 'Accept new safety number': 'Neue Sicherheitsnummer annehmen', 'Tag someone': 'Jemanden markieren',
  'Photo': 'Foto', 'Video': 'Video', 'Voice message': 'Sprachnachricht', 'Location': 'Standort', 'Contact': 'Kontakt', 'Poll': 'Umfrage', 'Camera': 'Kamera',
  'Photo or video': 'Foto oder Video', 'View once': 'Einmal ansehen', 'Photo · view once': 'Foto · einmal ansehen',
  'Opens once. It disappears when you close it.': 'Öffnet sich einmal. Verschwindet, wenn du es schließt.',
  'View once: opens one time, then disappears.': 'Einmal ansehen: öffnet sich einmal, dann verschwindet es.',
  'Send in HD': 'In HD senden', 'HD: full resolution. Takes longer to send and uses more data.': 'HD: volle Auflösung. Dauert länger und braucht mehr Daten.',
  'Standard quality. Tap HD for full resolution.': 'Normale Qualität. Tippe auf HD für volle Auflösung.', 'No caption for view-once photos': 'Keine Bildunterschrift bei Einmal-Fotos',
  'Caption': 'Bildunterschrift', 'Opened': 'Geöffnet', 'Tap to view': 'Zum Ansehen tippen',
  'Please choose a photo or video.': 'Bitte wähle ein Foto oder Video.', 'Please choose a photo.': 'Bitte wähle ein Foto.', 'Please choose a picture.': 'Bitte wähle ein Bild.',
  'Please choose a video.': 'Bitte wähle ein Video.', 'View-once works with photos.': 'Einmal ansehen funktioniert nur mit Fotos.',
  'This file is larger than 48 MB.': 'Diese Datei ist größer als 48 MB.', 'Videos can be up to 48 MB.': 'Videos dürfen bis zu 48 MB groß sein.',
  'This file is no longer available.': 'Diese Datei ist nicht mehr verfügbar.', 'The file is no longer on this device.': 'Die Datei ist nicht mehr auf diesem Gerät.',
  'Could not load this file.': 'Diese Datei konnte nicht geladen werden.', 'Could not prepare the picture.': 'Das Bild konnte nicht vorbereitet werden.',
  'This picture could not be opened.': 'Dieses Bild konnte nicht geöffnet werden.', 'This picture could not be prepared.': 'Dieses Bild konnte nicht vorbereitet werden.',
  'This picture is too large.': 'Dieses Bild ist zu groß.', 'This video could not be opened.': 'Dieses Video konnte nicht geöffnet werden.',
  'This video could not be compressed.': 'Dieses Video konnte nicht verkleinert werden.', 'This video is too large. Please choose a shorter one.': 'Dieses Video ist zu groß. Bitte wähle ein kürzeres.',
  'This video is still too large. Please choose a shorter one.': 'Dieses Video ist immer noch zu groß. Bitte wähle ein kürzeres.',
  'The length of this video could not be read.': 'Die Länge dieses Videos konnte nicht gelesen werden.', 'The upload failed. Please try again.': 'Das Hochladen ist fehlgeschlagen. Bitte versuche es erneut.',
  'Upload failed': 'Hochladen fehlgeschlagen', 'Download failed': 'Download fehlgeschlagen', 'Not uploaded yet': 'Noch nicht hochgeladen',
  'Haven needs location access. You can allow it in your settings.': 'Haven braucht Zugriff auf deinen Standort. Du kannst ihn in deinen Einstellungen erlauben.',
  'Location is not available on this device.': 'Standort ist auf diesem Gerät nicht verfügbar.', 'Your location could not be found.': 'Dein Standort konnte nicht gefunden werden.',
  'Share contact': 'Kontakt teilen', 'Choose from contacts': 'Aus Kontakten wählen', 'New poll': 'Neue Umfrage', 'Question': 'Frage', 'Allow several answers': 'Mehrere Antworten erlauben',
  'vote': 'Stimme', 'votes': 'Stimmen',

  // Info screens
  'Chat theme': 'Chat-Thema', 'Everyone in this chat sees the theme you choose.': 'Alle in diesem Chat sehen das Thema, das du wählst.',
  'The theme could not be changed.': 'Das Thema konnte nicht geändert werden.', 'Standard': 'Standard', 'Hey, what’s up?': 'Hey, was geht?',
  'Vlogging today': 'Vlogge heute', 'Nice': 'Cool',
  'Disappearing messages': 'Verschwindende Nachrichten', '1 hour': '1 Stunde', '24 hours': '24 Stunden', '7 days': '7 Tage',
  'New messages in this chat disappear for everyone after this time. Messages sent before stay.': 'Neue Nachrichten in diesem Chat verschwinden nach dieser Zeit für alle. Ältere Nachrichten bleiben.',
  'Could not change this': 'Konnte das nicht ändern', 'Change group name': 'Gruppennamen ändern', 'Group name': 'Gruppenname', 'Name the group': 'Gruppe benennen',
  'Group photo': 'Gruppenbild', 'Choose new photo': 'Neues Foto wählen', 'Remove photo': 'Foto entfernen', 'View photo': 'Foto ansehen',
  'Add people': 'Leute hinzufügen', 'Admin': 'Admin', 'Make group admin': 'Zum Admin machen', 'Remove as admin': 'Als Admin entfernen', 'Remove from group': 'Aus der Gruppe entfernen',
  'Clear chat': 'Chat leeren', 'Chat cleared': 'Chat geleert', 'Leave group': 'Gruppe verlassen',
  'All messages in this chat will be deleted from this device.': 'Alle Nachrichten in diesem Chat werden von diesem Gerät gelöscht.',
  'All messages in this group will be deleted from this device.': 'Alle Nachrichten in dieser Gruppe werden von diesem Gerät gelöscht.',
  'Block': 'Blockieren', 'Unblock': 'Freigeben', 'Blocked': 'Blockiert', 'Unblocked': 'Freigegeben', 'Save contact name': 'Kontaktnamen speichern',
  'Edit contact name': 'Kontaktnamen bearbeiten', 'Contact name': 'Kontaktname', 'Contact saved': 'Kontakt gespeichert', 'Name reset': 'Name zurückgesetzt',
  'Safety number': 'Sicherheitsnummer', 'View safety number': 'Sicherheitsnummer ansehen', 'Mark as verified': 'Als verifiziert markieren', 'Not verified': 'Nicht verifiziert',
  'Safety number copied': 'Sicherheitsnummer kopiert', 'Safety number, tap to copy': 'Sicherheitsnummer, tippen zum Kopieren',
  'Compare safety numbers in person or on a call to make sure no one is listening in.': 'Vergleiche Sicherheitsnummern persönlich oder in einem Anruf, um sicherzugehen, dass niemand mithört.',
  'No keys': 'Keine Schlüssel', 'No keys for this person yet.': 'Für diese Person gibt es noch keine Schlüssel.',

  // New chat
  'New group': 'Neue Gruppe', 'Add by number': 'Per Nummer hinzufügen', 'People on Haven': 'Leute auf Haven', 'People': 'Leute', 'No matches': 'Keine Treffer',
  'Invite to Haven': 'Zu Haven einladen', 'Add people by their phone number.': 'Füge Leute per Handynummer hinzu.',
  'Send an invite. Once they join, you can write to them here.': 'Schick eine Einladung. Sobald sie dabei sind, kannst du ihnen hier schreiben.',
  'Some people could not be added.': 'Einige Personen konnten nicht hinzugefügt werden.',
  'Friends who aren’t on Haven yet can be invited by their number. You can add more people any time.': 'Freunde, die noch nicht auf Haven sind, kannst du per Nummer einladen. Du kannst jederzeit mehr Leute hinzufügen.',
  'Group names and members are visible to the server. Messages are end-to-end encrypted.': 'Gruppennamen und Mitglieder sind für den Server sichtbar. Nachrichten sind Ende-zu-Ende-verschlüsselt.',

  // Settings
  'Privacy & security': 'Datenschutz & Sicherheit', 'Preferences': 'Einstellungen', 'Registration lock': 'Registrierungssperre', 'Read receipts': 'Lesebestätigungen',
  'Last seen & online': 'Zuletzt online', 'Blocked people': 'Blockierte Personen', 'Linked devices': 'Verknüpfte Geräte', 'How Haven protects you': 'So schützt dich Haven',
  'With read receipts off, others don’t see when you read their messages. With last seen & online off, others don’t see when you were online, and you don’t see it for them either.': 'Ohne Lesebestätigungen sehen andere nicht, wann du ihre Nachrichten gelesen hast. Ohne „Zuletzt online“ sehen andere nicht, wann du online warst – und du siehst es bei ihnen auch nicht.',
  'Chat backup': 'Chat-Backup', 'Appearance': 'Darstellung', 'Auto': 'Auto', 'Light': 'Hell', 'Dark': 'Dunkel', 'Haptics': 'Haptik', 'App icon': 'App-Icon',
  'black': 'schwarz', 'white': 'weiß', 'red': 'rot', 'Language': 'Sprache',
  'Icon saved. On iPhone it appears with the next install. Don’t remove Haven just for this: that deletes the chats on this phone.': 'Icon gespeichert. Auf dem iPhone erscheint es erst bei der nächsten Installation. Entferne Haven nicht nur dafür: Das löscht die Chats auf diesem Handy.',
  'Sign out': 'Abmelden', 'Delete account': 'Konto löschen', 'Haven · end-to-end encrypted': 'Haven · Ende-zu-Ende-verschlüsselt',
  'Your name and photo are visible to people who have your number.': 'Dein Name und dein Foto sind für Leute sichtbar, die deine Nummer haben.',
  'About': 'Info', 'A few words about you': 'Ein paar Worte über dich',
  'Registration lock is on': 'Registrierungssperre ist an', 'Registration lock turned off': 'Registrierungssperre ausgeschaltet', 'Choose a PIN': 'Wähle eine PIN',
  'Current PIN': 'Aktuelle PIN', 'New PIN': 'Neue PIN', 'Repeat PIN': 'PIN wiederholen', 'PIN': 'PIN', 'Protect your number': 'Schütze deine Nummer',
  '4 to 12 digits. Don’t use your phone’s unlock code.': '4 bis 12 Ziffern. Nutze nicht den Entsperrcode deines Handys.',
  'Enter your current PIN to turn the lock off.': 'Gib deine aktuelle PIN ein, um die Sperre auszuschalten.',
  'Signing in to your number on a new device needs your PIN, even with the SMS code. This protects you if someone takes over your phone number.': 'Die Anmeldung mit deiner Nummer auf einem neuen Gerät braucht deine PIN. Das schützt dich, falls jemand deine Nummer übernimmt.',
  'An optional PIN stops anyone who takes over your phone number from registering it on another device.': 'Eine optionale PIN verhindert, dass jemand, der deine Nummer übernimmt, sie auf einem anderen Gerät registriert.',
  'With a PIN, nobody can register your number on another device, even if they receive your SMS codes. The lock ends after 7 days without activity, so you can’t be locked out forever.': 'Mit einer PIN kann niemand deine Nummer auf einem anderen Gerät registrieren. Die Sperre endet nach 7 Tagen ohne Aktivität, damit du dich nicht für immer aussperrst.',
  'Forgot it? The lock ends by itself after 7 days without activity on your account.': 'Vergessen? Die Sperre endet von selbst nach 7 Tagen ohne Aktivität.',
  'No one is blocked': 'Niemand ist blockiert', 'Blocked people can’t message you or add you to groups.': 'Blockierte Personen können dir nicht schreiben und dich nicht zu Gruppen hinzufügen.',
  'Message notifications': 'Nachrichten-Benachrichtigungen', 'Show name and message': 'Name und Nachricht anzeigen',
  'Messages are decrypted on this phone just for the notification. Apple’s and Google’s push servers never see names or text.': 'Nachrichten werden nur für die Benachrichtigung auf diesem Handy entschlüsselt. Die Push-Server von Apple und Google sehen nie Namen oder Text.',
  'Notifications are turned off for Haven in your device settings.': 'Benachrichtigungen für Haven sind in deinen Geräteeinstellungen ausgeschaltet.',
  'This browser does not support notifications.': 'Dieser Browser unterstützt keine Benachrichtigungen.',
  'To get notifications on iPhone, add Haven to your Home Screen: tap Share, then “Add to Home Screen”, and open it from there.': 'Für Benachrichtigungen auf dem iPhone füge Haven zum Home-Bildschirm hinzu: Tippe auf Teilen, dann „Zum Home-Bildschirm“, und öffne Haven von dort.',
  'Security': 'Sicherheit',
  'Your private keys are created on this device and stored so that not even Haven’s own code can export them.': 'Deine privaten Schlüssel werden auf diesem Gerät erstellt und so gespeichert, dass nicht einmal Havens eigener Code sie exportieren kann.',
  'Every message is signed by its sender. Haven checks the signature before showing a message, so the server can’t forge or alter one.': 'Jede Nachricht wird vom Absender signiert. Haven prüft die Signatur, bevor eine Nachricht angezeigt wird – der Server kann keine fälschen oder verändern.',
  'If a contact’s keys change, you’ll see a notice in the chat. Verify the safety number in person to rule out anyone listening in.': 'Wenn sich die Schlüssel eines Kontakts ändern, siehst du einen Hinweis im Chat. Prüfe die Sicherheitsnummer persönlich, um Mithören auszuschließen.',
  'The server only holds encrypted messages until they are delivered, at most 30 days. Your chat history lives on your device.': 'Der Server hält verschlüsselte Nachrichten nur bis zur Zustellung, höchstens 30 Tage. Dein Chatverlauf liegt auf deinem Gerät.',
  'The server knows your phone number, name, photo and who is in which chat, because it needs them to deliver messages. It never sees message content.': 'Der Server kennt deine Nummer, deinen Namen, dein Foto und wer in welchem Chat ist, weil er das zum Zustellen braucht. Nachrichteninhalte sieht er nie.',
  'Delete your account': 'Konto löschen', 'Delete your account permanently?': 'Konto endgültig löschen?', 'Confirm with your phone number': 'Mit deiner Handynummer bestätigen',
  'Your profile, photo and undelivered messages are deleted from the server, you leave all groups, and everything on this device is erased. This can’t be undone.': 'Dein Profil, dein Foto und nicht zugestellte Nachrichten werden vom Server gelöscht, du verlässt alle Gruppen, und alles auf diesem Gerät wird entfernt. Das lässt sich nicht rückgängig machen.',

  // Devices
  'Devices': 'Geräte', 'This device': 'Dieses Gerät', 'Link a device': 'Gerät verknüpfen', 'Link this device': 'Dieses Gerät verknüpfen', 'Link this device?': 'Dieses Gerät verknüpfen?',
  'Use Haven on more devices': 'Haven auf mehreren Geräten nutzen', 'No devices': 'Keine Geräte', 'Remove device?': 'Gerät entfernen?', 'Device removed': 'Gerät entfernt',
  'Each device has its own keys, so messages stay end-to-end encrypted on every one of them.': 'Jedes Gerät hat eigene Schlüssel, deshalb bleiben Nachrichten auf jedem Ende-zu-Ende-verschlüsselt.',
  'Removing a device signs it out and deletes its keys. Your contacts see that your safety number changed when you add or remove a device.': 'Ein entferntes Gerät wird abgemeldet und seine Schlüssel gelöscht. Deine Kontakte sehen eine geänderte Sicherheitsnummer, wenn du ein Gerät hinzufügst oder entfernst.',
  'It will be able to read and send messages. Only link devices you own.': 'Es kann dann Nachrichten lesen und senden. Verknüpfe nur deine eigenen Geräte.',
  'Link and transfer chats': 'Verknüpfen und Chats übertragen', 'Link without chats': 'Ohne Chats verknüpfen', 'Scan code': 'Code scannen', 'QR code': 'QR-Code',
  'Point your camera at the QR code on the other device.': 'Richte die Kamera auf den QR-Code auf dem anderen Gerät.', 'Or enter the code': 'Oder gib den Code ein',
  'Or type this code': 'Oder tippe diesen Code', 'Pairing code': 'Kopplungscode', 'Show a new code': 'Neuen Code anzeigen', 'This code expired.': 'Dieser Code ist abgelaufen.',
  'On your phone, open Haven →': 'Öffne Haven auf deinem Handy →', 'and scan this code.': 'und scanne diesen Code.',
  'Haven needs camera access to scan. You can type the code below instead.': 'Haven braucht Kamerazugriff zum Scannen. Du kannst den Code stattdessen unten eintippen.',
  'Transferring': 'Übertrage', 'Transferring your chats': 'Deine Chats werden übertragen', 'Importing your chats…': 'Deine Chats werden importiert…',
  'Waiting for your chats from your other device…': 'Warte auf deine Chats vom anderen Gerät…',
  'Your chats are encrypted on this phone so only your new device can open them. Keep Haven open until this is done.': 'Deine Chats werden auf diesem Handy so verschlüsselt, dass nur dein neues Gerät sie öffnen kann. Lass Haven offen, bis es fertig ist.',
  'Device linked, but the chats could not be transferred.': 'Gerät verknüpft, aber die Chats konnten nicht übertragen werden.',
  'This device is removed from your account. Its keys and chats are deleted from it.': 'Dieses Gerät wird von deinem Konto entfernt. Seine Schlüssel und Chats werden gelöscht.',

  // Backup
  'Never lose your chats': 'Verliere nie deine Chats', 'New backup PIN': 'Neue Backup-PIN', 'Backup PIN': 'Backup-PIN', 'Repeat backup PIN': 'Backup-PIN wiederholen',
  'Haven keeps an encrypted copy of your chats, so they come back on a new phone or after removing the app. Only your backup PIN can unlock it – not even Haven can read it.': 'Haven speichert eine verschlüsselte Kopie deiner Chats, damit sie auf einem neuen Handy oder nach dem Löschen der App zurückkommen. Nur deine Backup-PIN kann sie öffnen – nicht einmal Haven kann sie lesen.',
  'At least 6 digits. Write it down: without it the backup can’t be opened.': 'Mindestens 6 Ziffern. Schreib sie auf: Ohne sie lässt sich das Backup nicht öffnen.',
  'At least 6 digits.': 'Mindestens 6 Ziffern.', 'The PINs don’t match.': 'Die PINs stimmen nicht überein.',
  'Turn on backup': 'Backup einschalten', 'Save PIN': 'PIN sichern', 'Backup PIN changed': 'Backup-PIN geändert', 'Backup is on. Your chats are safe.': 'Backup ist an. Deine Chats sind sicher.',
  'Restore chats': 'Chats wiederherstellen', 'Welcome back': 'Willkommen zurück', 'Backup restored': 'Backup wiederhergestellt', 'Skip restoring?': 'Wiederherstellen überspringen?',
  'Your chats stay in the backup. To use backups on this phone you would set a new PIN, which replaces the old backup.': 'Deine Chats bleiben im Backup. Um Backups auf diesem Handy zu nutzen, müsstest du eine neue PIN festlegen, die das alte Backup ersetzt.',
  'Backup is on': 'Backup ist an', 'Backup is off': 'Backup ist aus', 'Backup not on this phone': 'Backup nicht auf diesem Handy',
  'An encrypted copy of your chats is saved automatically. Only your backup PIN can unlock it.': 'Eine verschlüsselte Kopie deiner Chats wird automatisch gesichert. Nur deine Backup-PIN kann sie öffnen.',
  'Without a backup, your chats are gone if you remove Haven or lose your phone.': 'Ohne Backup sind deine Chats weg, wenn du Haven löschst oder dein Handy verlierst.',
  'Backs up every few minutes while Haven is open and when you leave it. Photos and videos stay available for 30 days.': 'Sichert alle paar Minuten, solange Haven offen ist, und wenn du die App verlässt. Fotos und Videos bleiben 30 Tage verfügbar.',
  'Last backup': 'Letztes Backup', 'Back up now': 'Jetzt sichern', 'Backed up': 'Gesichert', 'Change backup PIN': 'Backup-PIN ändern', 'Turn off backup': 'Backup ausschalten',
  'Turn off backup?': 'Backup ausschalten?', 'The encrypted backup is deleted from the server. Your chats stay on this phone.': 'Das verschlüsselte Backup wird vom Server gelöscht. Deine Chats bleiben auf diesem Handy.',
  'Set a new backup PIN': 'Neue Backup-PIN festlegen', 'never': 'nie', 'There is no backup for this account.': 'Für dieses Konto gibt es kein Backup.',
  'This backup could not be unlocked.': 'Dieses Backup konnte nicht entsperrt werden.', 'The backup could not be downloaded. Try again.': 'Das Backup konnte nicht heruntergeladen werden. Versuche es erneut.',
  'The backup could not be uploaded.': 'Das Backup konnte nicht hochgeladen werden.',

  // App problems
  'Haven could not open. Your chats and keys are safe on this device.': 'Haven konnte nicht öffnen. Deine Chats und Schlüssel sind auf diesem Gerät sicher.',
  'Haven is taking unusually long to start.': 'Haven braucht ungewöhnlich lange zum Starten.', 'Repair app': 'App reparieren',
  '“Repair app” reloads the newest version of Haven. It does not delete your chats.': '„App reparieren“ lädt die neueste Version von Haven. Deine Chats werden nicht gelöscht.',

  // Server messages
  'Please sign in again.': 'Bitte melde dich erneut an.', 'Too many attempts. Please wait a moment.': 'Zu viele Versuche. Bitte warte einen Moment.',
  'Wrong PIN.': 'Falsche PIN.', 'Wrong backup PIN.': 'Falsche Backup-PIN.', 'Too many wrong PINs. Try again in 24 hours.': 'Zu viele falsche PINs. Versuche es in 24 Stunden erneut.',
  'Too many wrong PINs. Try again later.': 'Zu viele falsche PINs. Versuche es später erneut.',
  'This invite link is not valid anymore. Ask for a new one.': 'Dieser Einladungslink ist nicht mehr gültig. Frag nach einem neuen.',
  'You are already in a friend group. Leave it first to join another one.': 'Du bist schon in einer Freundesgruppe. Verlasse sie zuerst, um einer anderen beizutreten.',
  'You are already in a friend group.': 'Du bist schon in einer Freundesgruppe.', 'Add your name first.': 'Füge zuerst deinen Namen hinzu.',
  'It’s not your turn to vlog today.': 'Du bist heute nicht mit Vloggen dran.', 'This chat does not exist or you are no longer a member.': 'Diesen Chat gibt es nicht, oder du bist kein Mitglied mehr.',
  'Something went wrong on our side. Please try again.': 'Bei uns ist etwas schiefgelaufen. Bitte versuche es erneut.',
  'This picture could not be used.': 'Dieses Bild konnte nicht verwendet werden.', 'Only admins can change the group photo.': 'Nur Admins können das Gruppenbild ändern.',
  'Only admins can make a new link.': 'Nur Admins können einen neuen Link erstellen.', 'This person is not on Haven.': 'Diese Person ist nicht auf Haven.',
  'That is your own number.': 'Das ist deine eigene Nummer.', 'Add at least one person.': 'Füge mindestens eine Person hinzu.', 'Please give the group a name.': 'Bitte gib der Gruppe einen Namen.',
  'Please enter a name.': 'Bitte gib einen Namen ein.', 'The devices in this chat changed.': 'Die Geräte in diesem Chat haben sich geändert.',

  'Disappearing messages ·': 'Verschwindende Nachrichten ·', 'Read': 'Gelesen', 'Unread': 'Ungelesen', 'Group created': 'Gruppe erstellt', 'Say hello': 'Sag Hallo',
  'You: ': 'Du: ', 'You are no longer a member': 'Du bist kein Mitglied mehr', 'Message could not be decrypted': 'Nachricht konnte nicht entschlüsselt werden',
  'Play': 'Abspielen', 'Pause': 'Pause', 'black icon': 'Schwarzes Icon', 'white icon': 'Weißes Icon', 'red icon': 'Rotes Icon', 'Navigation': 'Navigation',
  'Say hi on the Today screen.': 'Sag Hallo auf der Heute-Seite.', 'Photo · HD': 'Foto · HD', 'Sending…': 'Wird gesendet…',
  // Guide & what's new
  'Welcome to Haven': 'Willkommen bei Haven', 'Next': 'Weiter', 'Let’s go': 'Los geht’s', 'What’s new': 'Was ist neu', 'New in Haven': 'Neu in Haven', 'Got it': 'Verstanden',
  'A private messenger for you and your friends. Every message, photo and vlog is end-to-end encrypted.': 'Ein privater Messenger für dich und deine Freunde. Jede Nachricht, jedes Foto und jeder Vlog ist Ende-zu-Ende-verschlüsselt.',
  'Every day one friend from your group is picked at random to vlog their day. Everyone else follows along on the Today tab.': 'Jeden Tag wird ein Freund aus deiner Gruppe zufällig ausgewählt und vloggt seinen Tag. Alle anderen schauen auf der Heute-Seite zu.',
  'When it’s your turn': 'Wenn du dran bist',
  'You get a push in the morning. Share up to 3 videos or 6 photos during the day – your friends react with emoji.': 'Du bekommst morgens eine Push-Nachricht. Teile über den Tag bis zu 3 Videos oder 6 Fotos – deine Freunde reagieren mit Emojis.',
  'Create your group and share its invite link. Got a link from a friend? Open it and join their group.': 'Erstelle deine Gruppe und teile ihren Einladungslink. Hast du einen Link von einem Freund? Öffne ihn und tritt seiner Gruppe bei.',
  'Haven is now available in German. Change it in Settings → Language.': 'Haven gibt es jetzt auf Deutsch. Ändern kannst du das unter Einstellungen → Sprache.',
  'Every friend group has one invite link. Whoever opens it is asked whether to join.': 'Jede Freundesgruppe hat einen festen Einladungslink. Wer ihn öffnet, wird gefragt, ob er beitreten möchte.',
  'Zoom into vlog and chat photos with two fingers or a double tap.': 'Zoome mit zwei Fingern oder Doppeltippen in Vlog- und Chat-Fotos.',
  'The camera opens right away. Decide after taking a photo whether it’s view once.': 'Die Kamera öffnet sich sofort. Ob ein Foto nur einmal ansehbar ist, entscheidest du nach der Aufnahme.',
  'The newest vlog posts are on top, and today’s vlogger gets a reminder at 6 pm.': 'Die neuesten Vlog-Posts stehen oben, und wer heute dran ist, wird um 18 Uhr erinnert.',
  'Friend groups': 'Freundesgruppen', 'New friend group': 'Neue Freundesgruppe', 'Join with an invite link': 'Mit Einladungslink beitreten',
  'The Today screen shows one group at a time. Your chats stay the same.': 'Die Heute-Seite zeigt immer eine Gruppe. Deine Chats bleiben gleich.',
  'Add a friend group': 'Freundesgruppe hinzufügen', 'You can be in up to 10 friend groups.': 'Du kannst in bis zu 10 Freundesgruppen sein.',
  'You can be in several friend groups. Switch or add one with the button next to the bell.': 'Du kannst in mehreren Freundesgruppen sein. Wechseln oder hinzufügen geht mit dem Button neben der Glocke.',
  // Passkeys & usernames
  'Voice call': 'Sprachanruf',
  'Calling…': 'Ruft an…',
  'Haven voice call': 'Haven-Sprachanruf',
  'Call ended': 'Anruf beendet',
  'Decline': 'Ablehnen',
  'Mute': 'Stumm',
  'Unmute': 'Ton an',
  'End': 'Auflegen',
  'No answer': 'Keine Antwort',
  'Missed call': 'Verpasster Anruf',
  'Call failed': 'Anruf fehlgeschlagen',
  'Declined': 'Abgelehnt',
  'Busy': 'Besetzt',
  'Connection lost': 'Verbindung verloren',
  'Couldn’t connect': 'Keine Verbindung möglich',
  'Answered on another device': 'Auf einem anderen Gerät angenommen',
  'Allow Haven to use the microphone to call.': 'Erlaube Haven den Zugriff aufs Mikrofon, um zu telefonieren.',
  'No microphone found.': 'Kein Mikrofon gefunden.',
  'Couldn’t start the call.': 'Der Anruf konnte nicht gestartet werden.',
  'End call': 'Auflegen',
  'Call people in one-to-one chats: tap the phone at the top. End-to-end encrypted and free.': 'Telefoniere in Einzelchats: Tippe oben auf den Hörer. Ende-zu-Ende-verschlüsselt und kostenlos.',
  'Join group': 'Gruppe beitreten',
  'Every day one of you is picked to vlog their day. Private and end-to-end encrypted.': 'Jeden Tag wird eine*r von euch ausgelost und vloggt den Tag. Privat und Ende-zu-Ende verschlüsselt.',
  'Every day one of you is picked to vlog their day.': 'Jeden Tag wird eine*r von euch ausgelost und vloggt den Tag.',
  'Joined': 'Beigetreten',
  'Open Haven from your Home Screen – the group is already there.': 'Öffne Haven vom Home-Bildschirm – die Gruppe ist schon da.',
  'Use Haven here in Safari instead': 'Haven stattdessen hier in Safari nutzen',
  'Using Haven here signs out Haven on your Home Screen.': 'Wenn du Haven hier nutzt, wird Haven auf deinem Home-Bildschirm abgemeldet.',
  'Join with passkey': 'Mit Passkey beitreten',
  'Add to Home Screen': 'Zum Home-Bildschirm',
  'Put Haven on your Home Screen so you get notifications and it opens like an app.': 'Leg Haven auf deinen Home-Bildschirm, dann bekommst du Mitteilungen und es öffnet sich wie eine App.',
  'Tap Share at the bottom of Safari': 'Tippe unten in Safari auf Teilen',
  'Tap “Add to Home Screen”': 'Tippe auf „Zum Home-Bildschirm“',
  'Open Haven there and tap “I already have an account”': 'Öffne Haven dort und tippe auf „Ich habe schon ein Konto“',
  'This browser can’t use passkeys. On iPhone, update to iOS 16 or newer.': 'Dieser Browser unterstützt keine Passkeys. Aktualisiere dein iPhone auf iOS 16 oder neuer.',
  'No phone number': 'Keine Handynummer',
  'Your account is protected with a passkey: Face ID or Touch ID.': 'Dein Konto ist mit einem Passkey geschützt: Face ID oder Touch ID.',
  'Sign in with passkey': 'Mit Passkey anmelden',
  'Start over': 'Neu beginnen',
  'I already have an account': 'Ich habe schon ein Konto',
  'Create your account': 'Konto erstellen',
  'Haven protects your account with a passkey: Face ID, Touch ID or your device code. No phone number, no password.': 'Haven schützt dein Konto mit einem Passkey: Face ID, Touch ID oder dein Gerätecode. Keine Handynummer, kein Passwort.',
  'Create passkey': 'Passkey erstellen',
  'The passkey is saved in your iCloud Keychain or Google Password Manager, so you can sign in on a new phone too. Haven never sees your face or fingerprint.': 'Der Passkey wird in deinem iCloud-Schlüsselbund oder im Google Passwortmanager gespeichert, so kannst du dich auch auf einem neuen Handy anmelden. Haven sieht nie dein Gesicht oder deinen Fingerabdruck.',
  'Open Haven from your Home Screen and create your account.': 'Öffne Haven vom Home-Bildschirm und erstelle dein Konto.',
  'username (optional)': 'Benutzername (optional)',
  'Username': 'Benutzername',
  '@username': '@benutzername',
  'Friends can find you by your username. Or they send you an invite link.': 'Freunde finden dich über deinen Benutzernamen. Oder sie schicken dir einen Einladungslink.',
  'Passkey': 'Passkey',
  'Not set up': 'Nicht eingerichtet',
  'Your name and photo are visible to people you chat with.': 'Dein Name und Foto sind für die Leute sichtbar, mit denen du chattest.',
  'Friends can find you by your username. 3–20 letters, numbers, dots or underscores.': 'Freunde finden dich über deinen Benutzernamen. 3–20 Buchstaben, Zahlen, Punkte oder Unterstriche.',
  'From your old sign-in. People who have it can still find you.': 'Von deiner alten Anmeldung. Wer sie hat, findet dich weiterhin.',
  'Your account has a passkey': 'Dein Konto hat einen Passkey',
  'Secure your account': 'Sichere dein Konto',
  'You sign in with Face ID, Touch ID or your device code. The passkey is stored in your iCloud Keychain or Google Password Manager, so it also works on a new phone.': 'Du meldest dich mit Face ID, Touch ID oder deinem Gerätecode an. Der Passkey liegt in deinem iCloud-Schlüsselbund oder im Google Passwortmanager und funktioniert so auch auf einem neuen Handy.',
  'Without a passkey you can’t sign in again if you are signed out or get a new phone. It takes one tap with Face ID.': 'Ohne Passkey kannst du dich nicht wieder anmelden, wenn du abgemeldet wirst oder ein neues Handy hast. Es braucht nur einen Tipp mit Face ID.',
  'Add another one, for example if you also use an Android phone or a second Apple account.': 'Füge einen weiteren hinzu, zum Beispiel wenn du auch ein Android-Handy oder einen zweiten Apple-Account nutzt.',
  'Passkeys on this account': 'Passkeys für dieses Konto',
  'Add another passkey': 'Weiteren Passkey hinzufügen',
  'Passkey saved': 'Passkey gespeichert',
  'Passkey saved. Your account is secure.': 'Passkey gespeichert. Dein Konto ist gesichert.',
  'Haven no longer uses Telegram or your phone number to sign in. Create a passkey now – one tap with Face ID. Without it you can’t sign in again on a new phone or after being signed out.': 'Haven nutzt kein Telegram und keine Handynummer mehr zur Anmeldung. Erstelle jetzt einen Passkey – ein Tipp mit Face ID. Ohne ihn kannst du dich auf einem neuen Handy oder nach einer Abmeldung nicht wieder anmelden.',
  'Saved in your iCloud Keychain or Google Password Manager. Haven never sees your face or fingerprint.': 'Gespeichert in deinem iCloud-Schlüsselbund oder im Google Passwortmanager. Haven sieht nie dein Gesicht oder deinen Fingerabdruck.',
  'Passkey sign-in': 'Anmeldung per Passkey',
  'Your account is protected by a passkey. Signing in needs Face ID, Touch ID or your device code; there is no password or SMS code anyone could steal.': 'Dein Konto ist mit einem Passkey geschützt. Zum Anmelden braucht es Face ID, Touch ID oder deinen Gerätecode; es gibt kein Passwort und keinen SMS-Code, den jemand stehlen könnte.',
  'The server knows your name, username, photo and who is in which chat, because it needs them to deliver messages. No phone number is needed. It never sees message content.': 'Der Server kennt deinen Namen, Benutzernamen, dein Foto und wer in welchem Chat ist, weil er das zum Zustellen braucht. Eine Handynummer ist nicht nötig. Nachrichteninhalte sieht er nie.',
  '@username or phone number': '@benutzername oder Handynummer',
  'Username or phone number': 'Benutzername oder Handynummer',
  'Enter a @username (3–20 letters, numbers, dots or underscores) or a phone number.': 'Gib einen @benutzernamen (3–20 Buchstaben, Zahlen, Punkte oder Unterstriche) oder eine Handynummer ein.',
  'Enter a @username or a phone number.': 'Gib einen @benutzernamen oder eine Handynummer ein.',
  'Check the spelling, or send an invite. Once they join, you can write to them here.': 'Prüfe die Schreibweise oder schick eine Einladung. Sobald die Person beitritt, kannst du ihr hier schreiben.',
  'Add people by their @username.': 'Füge Leute über ihren @benutzernamen hinzu.',
  'Invite copied': 'Einladung kopiert',
  'No more Telegram: you sign in with a passkey (Face ID). No phone number needed.': 'Kein Telegram mehr: Du meldest dich mit einem Passkey (Face ID) an. Keine Handynummer nötig.',
  'Pick a @username in your profile, so friends can find you.': 'Wähle in deinem Profil einen @benutzernamen, damit Freunde dich finden.',
  'Friends who aren’t on Haven yet can join with the invite link. You can add more people any time.': 'Freunde, die noch nicht auf Haven sind, können über den Einladungslink beitreten. Du kannst jederzeit mehr Leute hinzufügen.',
  'This took too long. Please try again.': 'Das hat zu lange gedauert. Bitte versuche es nochmal.',
  'The passkey could not be set up. Please try again.': 'Der Passkey konnte nicht eingerichtet werden. Bitte versuche es nochmal.',
  'This passkey is not linked to a Haven account (any more).': 'Dieser Passkey gehört (nicht mehr) zu einem Haven-Konto.',
  'Sign-in with this passkey failed. Please try again.': 'Die Anmeldung mit diesem Passkey ist fehlgeschlagen. Bitte versuche es nochmal.',
  'This passkey belongs to an account that no longer exists.': 'Dieser Passkey gehört zu einem Konto, das es nicht mehr gibt.',
  'Usernames have 3–20 letters, numbers, dots or underscores.': 'Benutzernamen haben 3–20 Buchstaben, Zahlen, Punkte oder Unterstriche.',
  'This username is already taken.': 'Dieser Benutzername ist schon vergeben.',
  'That is your own username.': 'Das ist dein eigener Benutzername.',
  // System lines
  'You joined the group': 'Du bist der Gruppe beigetreten', 'You changed the group photo': 'Du hast das Gruppenbild geändert', 'You removed the group photo': 'Du hast das Gruppenbild entfernt',
};

type Pattern = [RegExp, (m: RegExpMatchArray) => string];

const PATTERNS: Pattern[] = [
  [/^(.*, )?You(, .*)?$/, (m) => (m[1] || m[2] ? `${m[1] ?? ''}Du${m[2] ?? ''}` : 'Du')],
  [/^(.+) invites you to “(.+)”\.$/, (m) => `${m[1] === 'A friend' ? 'Ein Freund' : m[1]} lädt dich zu „${m[2]}“ ein.`],
  [/^ Get started, and you can join right after\.$/, () => ' Leg los – danach kannst du direkt beitreten.'],
  [/^Friend group: (.+)\. Switch or add$/, (m) => `Freundesgruppe: ${m[1]}. Wechseln oder hinzufügen`],
  [/^(.+) just vlogged$/, (m) => `${m[1]} hat gerade gevloggt`],
  [/^(.+) hasn’t posted yet\. You’ll see it here as soon as they do\.$/, (m) => `${m[1] === 'They' ? 'Es wurde' : `${m[1]} hat`} noch nichts gepostet. Du siehst es hier, sobald es so weit ist.`],
  [/^(\d+) (post|posts) so far\. Follow their day below\.$/, (m) => `Bisher ${m[1]} ${m[1] === '1' ? 'Post' : 'Posts'}. Verfolge den Tag unten.`],
  [/^You joined “(.+)”$/, (m) => `Du bist „${m[1]}“ beigetreten`],
  [/^Call · (.+)$/, (m) => `Anruf · ${m[1]}`],
  [/^Call with (.+)$/, (m) => `Anruf mit ${m[1]}`],
  [/^You’re in “(.+)”!$/, (m) => `Du bist jetzt in „${m[1]}“!`],
  [/^Join “(.+)”\?$/, (m) => `„${m[1]}“ beitreten?`],
  [/^Join “(.+)”$/, (m) => `„${m[1]}“ beitreten`],
  [/^You created “(.+)”$/, (m) => `Du hast „${m[1]}“ erstellt`],
  [/^(.+) added you to “(.+)”$/, (m) => `${m[1]} hat dich zu „${m[2]}“ hinzugefügt`],
  [/^(.+) added (.+)$/, (m) => `${m[1]} hat ${m[2].replace(/\band\b/g, 'und').replace(/\byou\b/g, 'dich')} hinzugefügt`],
  [/^(.+) removed (.+)$/, (m) => (m[2] === 'the group photo' ? `${m[1]} hat das Gruppenbild entfernt` : `${m[1]} hat ${m[2].replace(/\band\b/g, 'und').replace(/\byou\b/g, 'dich')} entfernt`)],
  [/^(.+) left$/, (m) => `${m[1]} hat die Gruppe verlassen`],
  [/^(.+) changed the group photo$/, (m) => `${m[1]} hat das Gruppenbild geändert`],
  [/^(.+) joined with an invite link$/, (m) => `${m[1]} ist über den Einladungslink beigetreten`],
  [/^(.+) renamed the group to “(.+)”$/, (m) => `${m[1]} hat die Gruppe in „${m[2]}“ umbenannt`],
  [/^(.+) changed the chat theme to “(.+)”$/, (m) => `${m[1] === 'You' ? 'Du hast' : `${m[1]} hat`} das Chat-Thema zu „${m[2]}“ geändert`],
  [/^(.+) pinned a message$/, (m) => `${m[1] === 'You' ? 'Du hast' : `${m[1]} hat`} eine Nachricht angepinnt`],
  [/^(.+) unpinned a message$/, (m) => `${m[1] === 'You' ? 'Du hast' : `${m[1]} hat`} eine Nachricht gelöst`],
  [/^(.+) turned off disappearing messages$/, (m) => `${m[1] === 'You' ? 'Du hast' : `${m[1]} hat`} verschwindende Nachrichten ausgeschaltet`],
  [/^(.+) turned on disappearing messages \((.+)\)$/, (m) => `${m[1] === 'You' ? 'Du hast' : `${m[1]} hat`} verschwindende Nachrichten eingeschaltet (${tr(m[2]) ?? m[2]})`],
  [/^Your safety number with (.+) changed\. Tap to verify\.$/, (m) => `Deine Sicherheitsnummer mit ${m[1]} hat sich geändert. Tippe zum Prüfen.`],
  [/^Disappearing messages · (.+)$/, (m) => `Verschwindende Nachrichten · ${tr(m[1]) ?? m[1]}`],
  [/^(.+) is typing…$/, (m) => `${m[1]} schreibt…`],
  [/^(.+) and (.+) are typing…$/, (m) => `${m[1]} und ${m[2]} schreiben…`],
  [/^(\d+) people are typing…$/, (m) => `${m[1]} Personen schreiben…`],
  [/^last seen today at (.+)$/, (m) => `zuletzt online heute um ${m[1]}`],
  [/^last seen yesterday at (.+)$/, (m) => `zuletzt online gestern um ${m[1]}`],
  [/^last seen (.+)$/, (m) => `zuletzt online ${m[1] === 'just now' ? 'gerade eben' : m[1]}`],
  [/^Group · (\d+) members$/, (m) => `Gruppe · ${m[1]} Mitglieder`],
  [/^(\d+) members$/, (m) => `${m[1]} Mitglieder`],
  [/^(.+) reacted (.+) to your (vlog|message)$/, (m) => `${m[1]} hat mit ${m[2]} auf ${m[3] === 'vlog' ? 'deinen Vlog' : 'deine Nachricht'} reagiert`],
  [/^Reacted (.+) to your vlog$/, (m) => `Hat mit ${m[1]} auf deinen Vlog reagiert`],
  [/^Reacted (.+)$/, (m) => `Hat mit ${m[1]} reagiert`],
  [/^React (.+)$/, (m) => `Mit ${m[1]} reagieren`],
  [/^React with (.+)$/, (m) => `Mit ${m[1]} reagieren`],
  [/^Send to (.+)$/, (m) => `An ${m[1]} senden`],
  [/^(\d+) messages restored$/, (m) => `${m[1]} Nachrichten wiederhergestellt`],
  [/^There is an encrypted backup of your chats from (.+)\. Enter your backup PIN to bring them back\.$/, (m) => `Es gibt ein verschlüsseltes Backup deiner Chats vom ${m[1]}. Gib deine Backup-PIN ein, um sie zurückzuholen.`],
  [/^This video is (.+) long\. You have (.+) left today\.$/, (m) => `Dieses Video ist ${m[1]} lang. Du hast heute noch ${m[2]}.`],
  [/^(.+) isn’t on Haven yet\.$/, (m) => `${m[1]} ist noch nicht auf Haven.`],
  [/^(.+) won’t be able to message you or add you to groups\. They won’t be told\.$/, (m) => `${m[1]} kann dir dann nicht mehr schreiben und dich nicht zu Gruppen hinzufügen. Es wird nicht mitgeteilt.`],
  [/^You will stop receiving messages from “(.+)”\.$/, (m) => `Du bekommst dann keine Nachrichten mehr von „${m[1]}“.`],
  [/^(.+) will be signed out\.$/, (m) => `${m[1] === 'This device' ? 'Dieses Gerät' : m[1]} wird abgemeldet.`],
  [/^Link valid for (.+)\.$/, (m) => `Link gültig für ${m[1]}.`],
  [/^If (.+)’s safety number changes, Haven will pause sending until you check it again\.$/, (m) => `Wenn sich die Sicherheitsnummer von ${m[1]} ändert, pausiert Haven das Senden, bis du sie erneut prüfst.`],
  [/^(.+) is already in this group\.$/, (m) => `${m[1]} ist schon in dieser Gruppe.`],
  [/^(.+), show info$/, (m) => `${m[1]}, Info anzeigen`],
  [/^Continue as (.+)$/, (m) => `Weiter als ${m[1]}`],
  [/^Sent (\d+) messages? to (.+) again$/, (m) => `${m[1]} Nachrichten erneut an ${m[2]} gesendet`],
  [/^ · room for (\d+) more (photo|photos)(?: or (\d+) (video|videos))?$/, (m) => ` · Platz für ${m[1]} ${m[1] === '1' ? 'weiteres Foto' : 'weitere Fotos'}${m[3] ? ` oder ${m[3]} ${m[3] === '1' ? 'Video' : 'Videos'}` : ''}`],
  [/^(\d+) (photo|photos)$/, (m) => `${m[1]} ${m[1] === '1' ? 'Foto' : 'Fotos'}`],
  [/^(\d+) (video|videos) \((.+)\)$/, (m) => `${m[1]} ${m[1] === '1' ? 'Video' : 'Videos'} (${m[3]})`],
  [/^(\d+) (vote|votes)$/, (m) => `${m[1]} ${m[1] === '1' ? 'Stimme' : 'Stimmen'}`],
  [/^Everyone who opens this link can join “(.+)”\. It’s the same link for everyone, so send it to all your friends – but only to them\.$/, (m) => `Alle, die diesen Link öffnen, können „${m[1]}“ beitreten. Es ist für alle derselbe Link – schick ihn an alle deine Freunde, aber nur an sie.`],
];

const cache = new Map<string, string | null>();

/** The German text for an English one, or null if there is none. */
export function tr(text: string): string | null {
  if (cache.has(text)) return cache.get(text)!;
  let out: string | null = DE[text] ?? null;
  if (out === null) {
    for (const [re, fn] of PATTERNS) {
      const m = text.match(re);
      if (m) { out = fn(m); break; }
    }
  }
  if (cache.size > 5000) cache.clear();
  cache.set(text, out);
  return out;
}

/** Translate for code that builds text itself (share texts, push previews). */
export function t(text: string): string {
  return currentLang() === 'de' ? tr(text) ?? text : text;
}

// ------------------------------------------------------------------ live translation of the screen

// Where people's own words appear: never translate these.
const USER_CONTENT = [
  '.bubble-text', '.caption', '.quote-text', '.quote-name', '.bubble-sender', '.chat-row-title', '.chat-row-preview:not(.typing)', '.chat-header-title',
  '.pinned-text span', '.activity-snippet', '.vlog-item-caption', '.vlog-card-title', '.reply-bar-text', '.poll-question', '.poll-option-text',
  '.contact-card', '.hero h1', '.profile-card-name', '.cell-title.person', '.mention', '.viewer-caption', 'input', 'textarea', '[contenteditable]', '[data-no-i18n]',
  '.photo-viewer-top', '.friend-name', '.chat-row-preview', '.mention-option span', '.emoji-cell', '.vlog-reaction', '.tp-bubble',
].join(',');

const ATTRS = ['placeholder', 'aria-label', 'title'];

function translateText(node: Text) {
  const raw = node.data;
  const text = raw.trim();
  if (!text || !/[A-Za-z]/.test(text)) return;
  const parent = node.parentElement;
  if (!parent || parent.closest(USER_CONTENT)) return;
  const de = tr(text);
  if (de && de !== text) node.data = raw.replace(text, de);
}

function translateAttrs(el: Element) {
  if (el.closest('[data-no-i18n]')) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const de = tr(v.trim());
    if (de && de !== v) el.setAttribute(a, de);
  }
}

function translateTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) { translateText(root as Text); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  translateAttrs(el);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n: Node | null = walker.nextNode();
  while (n) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text);
    else translateAttrs(n as Element);
    n = walker.nextNode();
  }
}

/** Show the app in German if that is the chosen (or the phone's) language. */
export function startTranslation() {
  const lang = currentLang();
  document.documentElement.lang = lang;
  if (lang !== 'de') return;
  translateTree(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateText(r.target as Text);
      else if (r.type === 'attributes') translateAttrs(r.target as Element);
      else r.addedNodes.forEach(translateTree);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
