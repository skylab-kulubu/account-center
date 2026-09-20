# Keycloak Account REST 26.7.4 fixture contract

These JSON documents pin the response shapes consumed by Account Center to
Keycloak `26.7.4`. The field inventory is derived from the tagged upstream
implementations and representations:

- `AccountRestService` and `AbstractUserRepresentation` for the profile.
- `AccountCredentialResource.CredentialContainer` and
  `CredentialMetadataRepresentation` for credentials.
- `SessionResource`, `SessionRepresentation`, and `DeviceRepresentation` for
  canonical sessions and optional device hints.

The fixture deliberately contains private profile attributes, IP addresses,
credential IDs, and credential data. Contract tests must prove that none of
those fields survive normalization into Account Center view models.

These fixtures do not replace the production-clone gate. Before release, the
same four responses must be captured from the SKY LAB Keycloak 26.7.4 clone
with the exact `account-center` user-token contract and compared here.
