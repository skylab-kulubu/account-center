# Keycloak Account REST 26.7.4 fixture contract

These JSON documents pin the response shapes consumed by Account Center to
Keycloak `26.7.4`. The field inventory is derived from the tagged upstream
implementations and representations:

- `AccountRestService` and `AbstractUserRepresentation` for the profile.
- `AccountCredentialResource.CredentialContainer` and
  `CredentialMetadataRepresentation` for credentials.
- `SessionResource`, `SessionRepresentation`, and `DeviceRepresentation` for
  canonical sessions and optional device hints.
- `DefaultUserProfile.toRepresentation` and `UserProfileUtil.createUserProfileMetadata`
  (`UserProfileMetadata`, `UserProfileAttributeMetadata`,
  `UserProfileAttributeGroupMetadata`) for the `userProfileMetadata=true` profile.
- `AccountRestService.groupMemberships` with `ModelToRepresentation.toRepresentation(group, full)`
  (`GroupRepresentation`) for `/account/groups?briefRepresentation=false`.
- `LinkedAccountsResource` with `LinkedAccountRepresentation` (Jackson property
  `social` for the `isSocial` field, `guiOrder` ignored) for `/account/linked-accounts`,
  and `AccountLinkUriRepresentation` for the deprecated `/account/linked-accounts/{alias}`
  link URI (404 unless `allow-client-initiated-account-linking` is enabled).

The fixture deliberately contains attributes outside the pinned set
(`skyMail`, `usernameChangedAt`, `locale`), IP addresses, credential IDs,
credential data, and group role mappings. Contract tests must prove that none
of those fields survive normalization into Account Center view models, while
the pinned `schoolEmail`/`personalEmail`/`skyNumber`/`department`/`university`
attributes and the evaluated profile metadata do.

These fixtures do not replace the production-clone gate. Before release, the
same responses must be captured from the SKY LAB Keycloak 26.7.4 clone with
the exact `account-center` user-token contract and compared here.
