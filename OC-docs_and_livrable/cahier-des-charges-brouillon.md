# Cahier des charges — Your Car Your Way (brouillon de travail)

> Document de travail, rempli progressivement au fil des décisions (AN01 → AN04). Ne pas considérer comme final tant que chaque section n'est pas explicitement validée.

## 1. Analyse des besoins utilisateurs (AN01)

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
- Besoin retenu : possibilité, pour un client entreprise, de renseigner un statut de TVA/exonération au moment du paiement, pris en charge nativement par le prestataire de paiement (Stripe Tax — *capacité exacte à vérifier dans la documentation Stripe avant rédaction finale*).

### Besoins fonctionnels complémentaires identifiés (hors périmètre initial)

- Création de compte, connexion, réinitialisation de mot de passe.
- Désignation d'un conducteur distinct du réservataire sur une réservation.
- Ajout d'options/extras à une réservation (ex. siège enfant).
- Attribut "véhicule adapté" pour les profils à mobilité réduite, utilisable comme critère de recherche.
- Statut de TVA/exonération fiscale pour les profils professionnels, délégué au prestataire de paiement.

## 2. Considérations transverses (AN02)

### Accessibilité

L'ensemble de l'interface (formulaires, résultats de recherche, parcours de paiement) doit être utilisable sans dépendre de la souris et compatible avec les lecteurs d'écran (structure sémantique, navigation clavier, libellés explicites). Cette exigence s'applique à l'intégralité du parcours, et non à une fonctionnalité isolée.

### Sécurité

- Aucune pièce d'identité ou permis de conduire n'est collectée ni stockée par l'application : leur vérification a lieu physiquement en agence lors de la prise du véhicule, ce qui réduit la sensibilité des données hébergées.
- La suppression d'un compte entraîne la suppression des données personnelles, à l'exception des données dont la conservation est légalement obligatoire (historique de facturation), conservées pour la durée imposée par la réglementation applicable (*durée exacte à vérifier par pays*).
- L'accès du personnel d'agence aux données clients est limité à leur périmètre géographique/agence (principe du moindre privilège) ; aucun accès global par défaut.
- Aucune donnée de paiement n'est stockée par l'application : la gestion du paiement est intégralement déléguée à un prestataire externe (Stripe), réduisant d'autant le périmètre de conformité (PCI-DSS notamment).
- **Point ouvert, à trancher avant l'architecture (étape 3) :** obligation légale ou non de résidence régionale des données selon les pays d'exploitation — à vérifier, ne pas supposer.

### Internationalisation

- La recherche d'offre n'est pas limitée à un seul pays : les villes de départ et de retour peuvent appartenir à des pays différents.
- La devise d'une location est déterminée par le pays de la ville de départ (lieu de prise en charge du véhicule et du contrat) ; toute conversion vers la devise de paiement du client est prise en charge nativement par le prestataire de paiement.
- La langue de l'interface est un choix libre de l'utilisateur, indépendant du pays de location. Socle de langues au lancement : français, anglais, allemand, espagnol, italien — architecture conçue pour permettre l'ajout d'autres langues ultérieurement. **Point ouvert :** obligations linguistiques spécifiques à certaines juridictions (ex. Québec, Charte de la langue française) à vérifier.

## 3. Spécifications fonctionnelles — user stories (AN04)

### Décidées, avec critères d'acceptation

**US — Réservation sans compte complet**
En tant que visiteur, je veux pouvoir réserver une voiture sans créer de compte complet au préalable, afin de finaliser ma réservation rapidement.
- Given je ne suis pas connecté, when je complète une réservation avec mon email, then ma réservation est confirmée et accessible via ma référence de réservation + mon email.
- Given je ne me suis jamais inscrit, when je veux modifier/annuler cette réservation plus tard, then je peux y accéder sans connexion, via cette même référence + email.

**US — Activation d'un compte**
En tant qu'utilisateur ayant déjà réservé sans compte, je veux m'inscrire avec le même email, afin que mes réservations passées soient automatiquement rattachées à mon compte.
- Given j'ai déjà réservé avec un email donné, when je m'inscris avec ce même email, then mes réservations passées apparaissent dans mon historique.

**US — Modifier ses informations personnelles**
En tant qu'utilisateur, je veux modifier les informations de mon profil, afin de garder le contrôle de mes données.
- Given je suis connecté à mon compte, when je modifie mon nom/prénom/date de naissance/adresse et que j'enregistre, then mon profil reflète les nouvelles informations.
- Given je laisse un champ obligatoire vide, when j'essaie d'enregistrer, then je vois une erreur de validation et rien n'est enregistré.

**US — Filtrer les véhicules accessibles en fauteuil roulant**
En tant que personne à mobilité réduite, je veux filtrer les véhicules disponibles selon leur accessibilité (ex. accès fauteuil roulant), afin de louer un véhicule compatible avec mes besoins.
- Given je recherche un véhicule, when je sélectionne le filtre "véhicule accessible en fauteuil roulant", then seuls les véhicules possédant cet attribut apparaissent dans les résultats.
- *(Le cas "aucun résultat" est couvert par le comportement général de recherche — voir US "Rechercher une offre" — pas par un critère spécifique à ce filtre.)*

**US — Réserver pour quelqu'un d'autre**
En tant que client réservant au nom d'un tiers (ami, collègue, supérieur...), je veux désigner un conducteur différent de moi-même sur la réservation, afin que la personne qui conduira réellement le véhicule soit correctement identifiée.
- Given je complète une réservation, when je choisis de désigner un conducteur différent de moi-même, then je renseigne son nom et sa date de naissance, et cette personne est enregistrée comme conductrice — je reste le/la payeur(se). (Vérification d'identité/permis faite physiquement en agence, cf. §2 Sécurité — la date de naissance ici sert uniquement à éviter de réserver une catégorie que le conducteur ne pourra pas légalement conduire.)
- Given je ne précise aucun conducteur différent, when je finalise la réservation, then je suis enregistré par défaut comme conducteur.
- Given une réservation existe déjà, when je la modifie, then je peux changer la personne désignée comme conductrice.

**US — Rechercher une offre**
En tant qu'utilisateur, je veux rechercher des offres de location selon mes critères, afin de trouver un véhicule correspondant à mes besoins.
- Given je renseigne ville de départ, ville de retour (pouvant appartenir à des pays différents), dates/heures de départ et de retour, et catégorie de véhicule (norme ACRISS), when je lance la recherche, then les offres correspondantes s'affichent.
- Given je sélectionne le filtre "véhicule accessible en fauteuil roulant", when la recherche s'exécute, then seuls les véhicules possédant cet attribut apparaissent.
- Given aucune offre ne correspond à mes critères, when la recherche s'exécute, then je vois un message clair indiquant l'absence de résultat, avec une suggestion d'élargir la zone géographique ou la période.

**US — Réserver une offre**
En tant qu'utilisateur, je veux réserver une offre, afin de louer le véhicule correspondant.
- Given j'ai sélectionné une offre, when je finalise ma réservation, then je renseigne mes informations personnelles (pré-remplies depuis mon profil si disponibles), je désigne éventuellement un conducteur différent de moi-même (cf. US "Réserver pour quelqu'un d'autre"), je sélectionne mes extras/options (ex. siège enfant), et j'effectue le paiement via le prestataire externe (Stripe).
- Given je suis un client entreprise, when je finalise le paiement, then je peux renseigner un statut de TVA/exonération, pris en charge par le prestataire de paiement.
- Given le paiement est confirmé, when la réservation est créée, then je reçois une confirmation et la réservation apparaît dans mon historique (ou est accessible via référence + email si je n'ai pas de compte).

**US — Modifier/annuler une réservation**
En tant qu'utilisateur, je veux modifier ou annuler une réservation existante, afin de l'adapter à un changement de situation.
- Given je modifie le conducteur désigné ou mes informations de contact, when je valide, then la modification est appliquée sans frais, à tout moment avant le début de la location.
- Given je modifie mes extras/options (ex. siège enfant), when je valide plus de 2h avant le début de la location, then la modification est appliquée sans frais ; when je valide à moins de 2h du début, then des frais supplémentaires s'appliquent (identiques à une modification sur place en agence).
- Given je souhaite modifier la date, l'heure ou la ville de départ/retour, when je suis à moins de 48h du début de la location, then la modification n'est pas possible.
- Given j'annule ma réservation à moins d'une semaine du début de la location, when l'annulation est confirmée, then seul 25% du montant total est remboursé (règle distincte du délai de modification des 48h).

**US — Supprimer son compte**
En tant qu'utilisateur, je veux supprimer mon compte, afin de ne plus avoir de présence active sur la plateforme.
- Given je confirme la suppression avec mon mot de passe, when la suppression est validée, then mes données personnelles et mes identifiants sont supprimés.
- Given j'ai une réservation en cours ou à venir au moment de la suppression, when la suppression est validée, then mon compte est ramené à un état "invité" : la réservation reste accessible via référence + email, sans accès à un compte complet.
- Given des données doivent être légalement conservées (ex. historique de facturation), when mon compte est supprimé, then ces données sont conservées pour la durée imposée par la réglementation applicable, sans être rattachées à un profil actif.

### Simples, rédigées — à relire/corriger

**US — Consulter son profil**
En tant qu'utilisateur, je veux consulter mon profil, afin de voir les informations que j'ai renseignées.
- Given je suis connecté, when j'accède à la page de profil, then je vois mes informations personnelles (nom, prénom, date de naissance, adresse) et mon email de compte.

**US — Consulter la liste des agences**
En tant qu'utilisateur, je veux consulter la liste des agences de location, afin de connaître les points de prise en charge disponibles.
- Given je consulte la liste des agences, when la page se charge, then je vois l'ensemble des agences disponibles, avec leur localisation.

**US — Consulter le détail d'une offre**
En tant qu'utilisateur, je veux consulter le détail d'une offre, afin de connaître ses caractéristiques avant de réserver.
- Given je consulte une offre depuis les résultats de recherche, when j'ouvre son détail, then je vois ville de départ/retour, dates/heures, catégorie de véhicule, tarif, extras/options disponibles, et le statut "véhicule adapté" le cas échéant.

**US — Consulter l'historique des réservations**
En tant qu'utilisateur, je veux consulter l'historique de mes réservations, afin de suivre mes locations passées et en cours.
- Given je suis connecté, when j'accède à mon historique, then je vois toutes mes réservations passées et en cours.
- Given j'ai réservé en tant qu'invité (sans compte), when je ne suis pas connecté, then ces réservations n'apparaissent pas ici — uniquement via référence + email (cf. US "Réservation sans compte complet").

*Note : le statut de TVA/exonération fiscale (profil entreprise) ne fait pas l'objet d'une story séparée — intégré directement dans "Réserver une offre" ci-dessus.*
