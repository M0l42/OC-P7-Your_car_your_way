# Cahier des charges — Your Car Your Way

> Livrable 1.

## 1. Analyse des besoins utilisateurs

### Profils identifiés et besoins associés

**Profil 1 — Locataire loisir, première utilisation, réservation pour un tiers, location transfrontalière**

Un client réserve un véhicule pour un usage personnel, pour la première fois sur la plateforme, dans un pays différent du sien, au bénéfice d'un proche qui sera le conducteur réel. Cette combinaison révèle plusieurs besoins non couverts par la version initiale du cahier des charges :
- Le parcours de réservation doit permettre de désigner un conducteur distinct de la personne qui réserve et paie.
- Aucune fonctionnalité de création de compte, de connexion ou de récupération de mot de passe n'existe dans la version initiale : il s'agit d'un prérequis fonctionnel fondamental, nécessaire dès la première utilisation.
- Le périmètre géographique de la recherche (villes de départ et de retour) doit explicitement pouvoir couvrir plusieurs pays (voir aussi §3 Internationalisation).

**Profil 2 — Personne à mobilité réduite (utilisatrice de fauteuil roulant)**

Un client en situation de handicap moteur nécessitant un véhicule adapté (accès fauteuil roulant, commandes manuelles, etc.).
- La norme ACRISS (3ᵉ caractère du code véhicule) ne couvre que la transmission, la motricité et le niveau d'autonomie — elle ne permet pas d'identifier un véhicule adapté au handicap.
- Besoin : un critère de recherche et un attribut véhicule dédiés aux véhicules adaptés, distincts de la catégorie ACRISS.

**Profil 3 — Personne non-voyante (utilisatrice de lecteur d'écran)**

Un client ne pouvant pas utiliser visuellement l'interface, s'appuyant sur un lecteur d'écran ou une navigation intégralement au clavier.
- Ce besoin est transverse : il ne concerne pas une fonctionnalité isolée mais l'ensemble du parcours utilisateur.
- Voir §2 Accessibilité.

**Profil 4 — Voyageur d'affaires / client entreprise**

Un client réservant dans un cadre professionnel, avec des besoins potentiels de facturation et de fiscalité différents d'un client particulier.
- La génération de facture conforme (mentions légales, numérotation, obligations fiscales par pays) a été étudiée et volontairement écartée du périmètre : une simple confirmation de paiement (reçu Stripe) est jugée suffisante, pour éviter de transformer l'application en un produit de facturation réglementé à part entière.
- Besoin retenu : possibilité, pour un client entreprise, de renseigner un statut de TVA/exonération au moment du paiement, pris en charge nativement par le prestataire de paiement (Stripe Tax : numéro de TVA du client et statut exonéré ou autoliquidation portés par le client Stripe).

### Besoins fonctionnels complémentaires identifiés (hors périmètre initial)

- Création de compte, connexion, réinitialisation de mot de passe.
- Désignation d'un conducteur distinct du réservataire sur une réservation.
- Ajout d'options/extras à une réservation (ex. siège enfant).
- Attribut "véhicule adapté" pour les profils à mobilité réduite, utilisable comme critère de recherche.
- Statut de TVA/exonération fiscale pour les profils professionnels, délégué au prestataire de paiement.
- Contact du service client par tchat en direct, accessible aux clients connectés comme aux invités (référence de réservation + email), et utilisable au clavier et au lecteur d'écran (cf. §2 Accessibilité).

## 2. Considérations transverses

### Accessibilité

L'ensemble de l'interface (formulaires, résultats de recherche, parcours de paiement) doit être utilisable sans dépendre de la souris et compatible avec les lecteurs d'écran (structure sémantique, navigation clavier, libellés explicites). Cette exigence s'applique à l'intégralité du parcours, et non à une fonctionnalité isolée.

### Sécurité

- Aucune pièce d'identité ou permis de conduire n'est collectée ni stockée par l'application : leur vérification a lieu physiquement en agence lors de la prise du véhicule, ce qui réduit la sensibilité des données hébergées.
- La suppression d'un compte entraîne la suppression des données personnelles, à l'exception des données dont la conservation est légalement obligatoire (historique de facturation), conservées pour la durée imposée par la réglementation applicable (durée propre à chaque pays, à préciser avec le service juridique).
- L'accès du personnel d'agence aux données clients est limité à leur périmètre géographique/agence (principe du moindre privilège) ; aucun accès global par défaut.
- Aucune donnée de paiement n'est stockée par l'application : la gestion du paiement est intégralement déléguée à un prestataire externe (Stripe), réduisant d'autant le périmètre de conformité (PCI-DSS notamment).
- **Résidence des données :** obligation légale ou non de résidence régionale des données selon les pays d'exploitation. *Tranché à l'étape 3 (proposition d'architecture, §2.1, « Résidence des données ») : pas d'obligation de localisation identifiée dans les 7 pays ; les transferts hors UE sont encadrés (clauses contractuelles types, adéquation canadienne) et une évaluation est requise pour les données des clients québécois (loi 25). Vérification sur sources secondaires, à faire valider par un juriste.*

### Internationalisation

- La recherche d'offre n'est pas limitée à un seul pays : les villes de départ et de retour peuvent appartenir à des pays différents.
- La devise d'une location est déterminée par le pays de la ville de départ (lieu de prise en charge du véhicule et du contrat) ; toute conversion vers la devise de paiement du client est prise en charge nativement par le prestataire de paiement.
- La langue de l'interface est un choix libre de l'utilisateur, indépendant du pays de location. Socle de langues au lancement : français, anglais, allemand, espagnol, italien — architecture conçue pour permettre l'ajout d'autres langues ultérieurement. **Point ouvert :** obligations linguistiques spécifiques à certaines juridictions (ex. Québec, Charte de la langue française) à vérifier.

## 3. Spécifications fonctionnelles — user stories

### Décidées, avec critères d'acceptation

**US — Réservation sans compte complet**
En tant que visiteur, je veux pouvoir réserver une voiture sans créer de compte complet au préalable, afin de finaliser ma réservation rapidement.
- Étant donné que je ne suis pas connecté, quand je complète une réservation avec mon email, alors ma réservation est confirmée et accessible via ma référence de réservation + mon email.
- Étant donné que je ne me suis jamais inscrit, quand je veux modifier/annuler cette réservation plus tard, alors je peux y accéder sans connexion, via cette même référence + email.

**US — Activation d'un compte**
En tant qu'utilisateur ayant déjà réservé sans compte, je veux m'inscrire avec le même email, afin que mes réservations passées soient automatiquement rattachées à mon compte.
- Étant donné que j'ai déjà réservé avec un email donné, quand je m'inscris avec ce même email, alors mes réservations passées apparaissent dans mon historique.

**US — Modifier ses informations personnelles**
En tant qu'utilisateur, je veux modifier les informations de mon profil, afin de garder le contrôle de mes données.
- Étant donné que je suis connecté à mon compte, quand je modifie mon nom/prénom/date de naissance/adresse et que j'enregistre, alors mon profil reflète les nouvelles informations.
- Étant donné que je laisse un champ obligatoire vide, quand j'essaie d'enregistrer, alors je vois une erreur de validation et rien n'est enregistré.

**US — Filtrer les véhicules accessibles en fauteuil roulant**
En tant que personne à mobilité réduite, je veux filtrer les véhicules disponibles selon leur accessibilité (ex. accès fauteuil roulant), afin de louer un véhicule compatible avec mes besoins.
- Étant donné que je recherche un véhicule, quand je sélectionne le filtre "véhicule accessible en fauteuil roulant", alors seuls les véhicules possédant cet attribut apparaissent dans les résultats.
- *(Le cas "aucun résultat" est couvert par le comportement général de recherche — voir US "Rechercher une offre" — pas par un critère spécifique à ce filtre.)*

**US — Réserver pour quelqu'un d'autre**
En tant que client réservant au nom d'un tiers (ami, collègue, supérieur...), je veux désigner un conducteur différent de moi-même sur la réservation, afin que la personne qui conduira réellement le véhicule soit correctement identifiée.
- Étant donné que je complète une réservation, quand je choisis de désigner un conducteur différent de moi-même, alors je renseigne son nom et sa date de naissance, et cette personne est enregistrée comme conductrice — je reste le/la payeur(se). (Vérification d'identité/permis faite physiquement en agence, cf. §2 Sécurité — la date de naissance ici sert uniquement à éviter de réserver une catégorie que le conducteur ne pourra pas légalement conduire.)
- Étant donné que je ne précise aucun conducteur différent, quand je finalise la réservation, alors je suis enregistré par défaut comme conducteur.
- Étant donné qu'une réservation existe déjà, quand je la modifie, alors je peux changer la personne désignée comme conductrice.

**US — Rechercher une offre**
En tant qu'utilisateur, je veux rechercher des offres de location selon mes critères, afin de trouver un véhicule correspondant à mes besoins.
- Étant donné que je renseigne ville de départ, ville de retour (pouvant appartenir à des pays différents), dates/heures de départ et de retour, et catégorie de véhicule (norme ACRISS), quand je lance la recherche, alors les offres correspondantes s'affichent.
- Étant donné que je sélectionne le filtre "véhicule accessible en fauteuil roulant", quand la recherche s'exécute, alors seuls les véhicules possédant cet attribut apparaissent.
- Étant donné qu'aucune offre ne correspond à mes critères, quand la recherche s'exécute, alors je vois un message clair indiquant l'absence de résultat, avec une suggestion d'élargir la zone géographique ou la période.

**US — Réserver une offre**
En tant qu'utilisateur, je veux réserver une offre, afin de louer le véhicule correspondant.
- Étant donné que j'ai sélectionné une offre, quand je finalise ma réservation, alors je renseigne mes informations personnelles (pré-remplies depuis mon profil si disponibles), je désigne éventuellement un conducteur différent de moi-même (cf. US "Réserver pour quelqu'un d'autre"), je sélectionne mes extras/options (ex. siège enfant), et j'effectue le paiement via le prestataire externe (Stripe).
- Étant donné que je suis un client entreprise, quand je finalise le paiement, alors je peux renseigner un statut de TVA/exonération, pris en charge par le prestataire de paiement.
- Étant donné que le paiement est confirmé, quand la réservation est créée, alors je reçois une confirmation et la réservation apparaît dans mon historique (ou est accessible via référence + email si je n'ai pas de compte).

**US — Modifier/annuler une réservation**
En tant qu'utilisateur, je veux modifier ou annuler une réservation existante, afin de l'adapter à un changement de situation.
- Étant donné que je modifie le conducteur désigné ou mes informations de contact, quand je valide, alors la modification est appliquée sans frais, à tout moment avant le début de la location.
- Étant donné que je modifie mes extras/options (ex. siège enfant), quand je valide plus de 2h avant le début de la location, alors la modification est appliquée sans frais ; quand je valide à moins de 2h du début, alors des frais supplémentaires s'appliquent (identiques à une modification sur place en agence).
- Étant donné que je souhaite modifier la date, l'heure ou la ville de départ/retour, quand je suis à moins de 48h du début de la location, alors la modification n'est pas possible.
- Étant donné que j'annule ma réservation à moins d'une semaine du début de la location, quand l'annulation est confirmée, alors seul 25% du montant total est remboursé (règle distincte du délai de modification des 48h).

**US — Supprimer son compte**
En tant qu'utilisateur, je veux supprimer mon compte, afin de ne plus avoir de présence active sur la plateforme.
- Étant donné que je confirme la suppression avec mon mot de passe, quand la suppression est validée, alors mes données personnelles et mes identifiants sont supprimés.
- Étant donné que j'ai une réservation en cours ou à venir au moment de la suppression, quand la suppression est validée, alors mon compte est ramené à un état "invité" : la réservation reste accessible via référence + email, sans accès à un compte complet.
- Étant donné que des données doivent être légalement conservées (ex. historique de facturation), quand mon compte est supprimé, alors ces données sont conservées pour la durée imposée par la réglementation applicable, sans être rattachées à un profil actif.

**US — Contacter le support par tchat**
En tant que client (connecté, ou invité via ma référence de réservation + mon email), je veux échanger en direct avec un agent du service client, afin d'obtenir de l'aide sur ma réservation sans passer par un appel téléphonique.
- Étant donné que je suis connecté, ou identifié comme invité par ma référence de réservation + mon email, quand j'ouvre une conversation (en indiquant éventuellement une référence de réservation), alors la conversation est créée "en attente" et apparaît dans la file des agents.
- Étant donné que ma conversation est prise en charge par un agent, quand nous échangeons des messages, alors chacun voit les messages de l'autre en direct, dans le même ordre, et chacun de mes messages affiche son état ("envoi…", "envoyé", "non envoyé").
- Étant donné que ma connexion est coupée (réseau, ou panne d'un serveur), quand elle est rétablie, alors je retrouve automatiquement les messages reçus pendant la coupure et mes messages non confirmés sont renvoyés — aucun message n'est perdu, dupliqué ou affiché dans le désordre.
- Étant donné que j'utilise un lecteur d'écran, quand un nouveau message arrive, alors il est annoncé ; quand la connexion est rétablie, alors seul un résumé est annoncé ("Connexion rétablie, N messages récupérés") et non chaque message récupéré un par un.
- Étant donné que ma conversation n'est pas encore prise en charge, quand je la clôture, alors elle quitte la file des agents.

**US — Prendre en charge une conversation (agent du service client)**
En tant qu'agent du service client, je veux voir les conversations en attente et en prendre une en charge, afin de répondre aux clients dans l'ordre d'arrivée.
- Étant donné que des conversations sont en attente, quand j'ouvre la file, alors je les vois de la plus ancienne à la plus récente, mise à jour en direct.
- Étant donné que deux agents prennent en charge la même conversation au même moment, quand les deux demandes arrivent, alors un seul agent l'obtient ; l'autre est informé qu'elle est déjà prise et elle disparaît de sa file.
- Étant donné que j'ai pris en charge une conversation, quand je la clôture, alors le client voit qu'elle est clôturée et ne peut plus y écrire.
- Étant donné que je ne suis pas l'agent en charge d'une conversation, quand je tente d'y écrire, alors ma demande est refusée.

### Simples, sans critères d'acceptation détaillés

**US — Consulter son profil**
En tant qu'utilisateur, je veux consulter mon profil, afin de voir les informations que j'ai renseignées.
- Étant donné que je suis connecté, quand j'accède à la page de profil, alors je vois mes informations personnelles (nom, prénom, date de naissance, adresse) et mon email de compte.

**US — Consulter la liste des agences**
En tant qu'utilisateur, je veux consulter la liste des agences de location, afin de connaître les points de prise en charge disponibles.
- Étant donné que je consulte la liste des agences, quand la page se charge, alors je vois l'ensemble des agences disponibles, avec leur localisation.

**US — Consulter le détail d'une offre**
En tant qu'utilisateur, je veux consulter le détail d'une offre, afin de connaître ses caractéristiques avant de réserver.
- Étant donné que je consulte une offre depuis les résultats de recherche, quand j'ouvre son détail, alors je vois ville de départ/retour, dates/heures, catégorie de véhicule, tarif, extras/options disponibles, et le statut "véhicule adapté" le cas échéant.

**US — Consulter l'historique des réservations**
En tant qu'utilisateur, je veux consulter l'historique de mes réservations, afin de suivre mes locations passées et en cours.
- Étant donné que je suis connecté, quand j'accède à mon historique, alors je vois toutes mes réservations passées et en cours.
- Étant donné que j'ai réservé en tant qu'invité (sans compte), quand je ne suis pas connecté, alors ces réservations n'apparaissent pas ici — uniquement via référence + email (cf. US "Réservation sans compte complet").

*Note : le statut de TVA/exonération fiscale (profil entreprise) ne fait pas l'objet d'une story séparée — intégré directement dans "Réserver une offre" ci-dessus.*
